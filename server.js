'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { openDatabase } = require('./database');
const scrypt = promisify(crypto.scrypt);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const liveStatuses = ['pending', 'accepted', 'arrived'];
const allowedStatuses = [...liveStatuses, 'declined', 'cancelled', 'completed', 'no_show'];
const defaults = {
  accepting: false, openingDate: '2026-11-03', capacity: 52, maxParty: 12,
  duration: 120, interval: 30, notice: 60, horizon: 180,
  weekly: Array.from({length:7}, () => ({open:true, first:'12:00', last:'21:30', close:'23:30'}))
};
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function minute(t) { if (typeof t !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) fail(400,'Choose a valid time.'); return +t.slice(0,2)*60 + +t.slice(3); }
function time(m) { return String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0'); }
function validDate(d) { if (typeof d!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d+'T12:00:00Z')) || new Date(d+'T12:00:00Z').toISOString().slice(0,10)!==d) fail(400,'Choose a valid date.'); return d; }
function int(v, lo, hi, label) { if (!Number.isInteger(v) || v<lo || v>hi) fail(400,`${label} must be between ${lo} and ${hi}.`); return v; }
function textField(v, max, label, required=false) { if (typeof v!=='string' || v.length>max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) fail(400,`Check ${label}.`); const s=v.trim(); if(required&&!s) fail(400,`Enter ${label}.`); return s; }
function london(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`, minute:+p.hour*60 + +p.minute};
}
function shiftedDate(d, days) { return new Date(Date.parse(d+'T12:00:00Z')+days*86400000).toISOString().slice(0,10); }
function londonEpoch(date,start) {
  const target=Date.parse(date+'T00:00:00Z')+start*60000;let candidate=target;
  for(let n=0;n<3;n++){const local=london(candidate),actual=Date.parse(local.date+'T00:00:00Z')+local.minute*60000;if(actual===target)return candidate;candidate+=target-actual;}
  return NaN;
}
function validateSettings(s) {
  if(typeof s.accepting!=='boolean') fail(400,'Choose whether bookings are open.');
  validDate(s.openingDate); int(s.capacity,1,200,'Capacity'); int(s.maxParty,1,s.capacity,'Maximum party');
  int(s.duration,30,240,'Table duration'); int(s.notice,0,10080,'Notice'); int(s.horizon,1,365,'Booking window');
  if(![15,30,60].includes(s.interval)) fail(400,'Choose a 15, 30 or 60 minute interval.');
  if(!Array.isArray(s.weekly)||s.weekly.length!==7) fail(400,'Complete all seven days.');
  const weekly=s.weekly.map(d=>{
    if(typeof d.open!=='boolean') fail(400,'Check opening days.');
    const first=minute(d.first),last=minute(d.last),close=minute(d.close);
    if(first>last||last>=close||first+s.duration>close) fail(400,'Check first arrival, last arrival and closing times.');
    if(d.open && last+s.duration>close) fail(400,'Last arrival plus table duration must fit before closing.');
    return {open:d.open,first:d.first,last:d.last,close:d.close};
  });
  return {...Object.fromEntries(Object.keys(defaults).filter(k=>k!=='weekly').map(k=>[k,s[k]])),weekly};
}

async function createApp(options={}) {
  const password=options.password || process.env.ADMIN_PASSWORD;
  if(typeof password!=='string'||password.length<14) throw new Error('Set ADMIN_PASSWORD to a unique password of at least 14 characters in your hosting environment.');
  const production=options.production ?? process.env.NODE_ENV==='production';
  const appOrigin=options.origin || process.env.APP_ORIGIN || '';
  if(production && (!appOrigin.startsWith('https://') || new URL(appOrigin).origin!==appOrigin)) throw new Error('Set APP_ORIGIN to the exact HTTPS origin, with no path or trailing slash.');
  const now=options.now || Date.now;
  const db=await openDatabase(options.database,defaults);
  const bookingsTable=db.bookingsTable;
  const salt=crypto.randomBytes(16), key=await scrypt(password,salt,64), fingerprint=hash(password);
  await db.prepare('DELETE FROM bv_sessions WHERE expires < ?').run(now());
  const settings=async()=>{const row=await db.prepare('SELECT * FROM bv_settings WHERE id=1').get();return {...JSON.parse(row.value),version:row.version};};
  const log=async(action,ref='')=>await db.prepare('INSERT INTO bv_audit(`at`,action,ref) VALUES(?,?,?)').run(now(),action,ref);
  const transaction=fn=>db.transaction(fn);
  async function rate(key, max, windowMs) {
    await transaction(async()=>{
      const t=now();await db.prepare('DELETE FROM bv_limits WHERE resets < ?').run(t);
      const row=await db.prepare('SELECT * FROM bv_limits WHERE `key`=?').get(key);
      if(row&&row.count>=max) fail(429,'Too many attempts. Please wait and try again.');
      await db.prepare('INSERT INTO bv_limits(`key`,`count`,resets) VALUES(?,1,?) ON DUPLICATE KEY UPDATE `count`=`count`+1').run(key,t+windowMs);
    });
  }
  async function occupancy(date,start,end,exclude='') {
    const rows=await db.prepare(`SELECT \`start\`,\`end\`,guests FROM ${bookingsTable} WHERE \`date\`=? AND status IN ('pending','accepted','arrived') AND \`start\`<? AND \`end\`>? AND id!=?`).all(date,end,start,exclude);
    const points=rows.flatMap(b=>[[Math.max(start,b.start),b.guests],[Math.min(end,b.end),-b.guests]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    let active=0,max=0;for(const [,delta] of points){active+=delta;max=Math.max(max,active);}return max;
  }
  async function slotAvailable(s,date,start,guests,exclude='') {
    const clock=london(now()), day=new Date(date+'T12:00:00Z').getUTCDay(),hours=s.weekly[day];
    if(!s.accepting||date<s.openingDate||date<clock.date||date>shiftedDate(clock.date,s.horizon)||!hours.open) return false;
    const first=minute(hours.first),last=minute(hours.last);
    if(start<first||start>last||(start-first)%s.interval||start+s.duration>minute(hours.close)) return false;
    const distance=(londonEpoch(date,start)-now())/60000;
    if(!Number.isFinite(distance)||distance<s.notice) return false;
    if(await db.prepare('SELECT id FROM bv_closures WHERE `date`=? AND `start`<=? AND `end`>?').get(date,start,start)) return false;
    return (await occupancy(date,start,start+s.duration,exclude))+guests<=s.capacity;
  }
  function publicBooking(b) { return {id:b.id,reference:'BV-'+b.id.slice(0,8).toUpperCase(),date:b.date,time:time(b.start),guests:b.guests,status:b.status,updated:b.updated}; }
  async function requireSession(req) {
    const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('bv_session='))?.slice(11);
    if(!token) fail(401,'Please sign in.');
    const sess=await db.prepare('SELECT * FROM bv_sessions WHERE token=? AND expires>? AND fingerprint=?').get(hash(token),now(),fingerprint);
    if(!sess) fail(401,'Please sign in again.');
    if(!['GET','HEAD'].includes(req.method)&&req.headers['x-csrf-token']!==sess.csrf) fail(403,'Refresh the page and try again.');
    return sess;
  }
  async function body(req) {
    if(!(req.headers['content-type']||'').startsWith('application/json')) fail(415,'JSON required.');
    let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>12000) fail(413,'Request too large.');}
    let parsed;try{parsed=JSON.parse(data);}catch{fail(400,'Invalid request.');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)) fail(400,'Invalid request.');return parsed;
  }
  const staticFiles={
    '/':'index.html','/index.html':'index.html','/script.js':'script.js','/style.css':'style.css',
    '/book':'book.html','/booking.css':'booking.css','/booking.js':'booking.js','/common.js':'common.js',
    '/admin':'admin.html','/admin.js':'admin.js','/booking-status':'status.html','/status.js':'status.js','/privacy':'privacy.html'
  };
  const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8'};
  async function handler(req,res) {
    const url=new URL(req.url,'http://localhost'),route=url.pathname;
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Cache-Control','no-store');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    const legacy=route==='/'||route==='/index.html';
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'${legacy?" 'unsafe-inline'":''}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'`);
    if(production) res.setHeader('Strict-Transport-Security','max-age=31536000');
    const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    try {
      if(!['GET','HEAD','POST','PATCH','DELETE'].includes(req.method)) fail(405,'Method not allowed.');
      if(route.startsWith('/api/')&&!['GET','HEAD'].includes(req.method)) {
        if(req.headers['x-bv-request']!=='1') fail(403,'Invalid request.');
        const expected=appOrigin||`http://${req.headers.host}`;
        if(req.headers.origin && req.headers.origin!==expected) fail(403,'This request must come from the restaurant website.');
      }
      // Trust a proxy header only when the host is explicitly configured to overwrite it.
      const ip=process.env.TRUST_PROXY==='1' ? String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',')[0].trim() : req.socket.remoteAddress;
      if(route==='/api/config'&&req.method==='GET') {
        const s=await settings(),clock=london(now());return json(200,{accepting:s.accepting,openingDate:s.openingDate,minDate:[clock.date,s.openingDate].sort().at(-1),maxDate:shiftedDate(clock.date,s.horizon),maxParty:s.maxParty,duration:s.duration});
      }
      if(route==='/api/availability'&&req.method==='GET') {
        const date=validDate(url.searchParams.get('date')),s=await settings(),guests=int(Number(url.searchParams.get('guests')),1,s.maxParty,'Guests');
        const h=s.weekly[new Date(date+'T12:00:00Z').getUTCDay()],slots=[];
        for(let start=minute(h.first);start<=minute(h.last);start+=s.interval) if(await slotAvailable(s,date,start,guests)) slots.push(time(start));
        return json(200,{slots,accepting:s.accepting});
      }
      if(route==='/api/bookings'&&req.method==='POST') {
        await rate('book:'+hash(ip),12,3600000);
        const b=await body(req);
        if(b.website) fail(400,'Unable to submit this request.');
        if(!/^[a-f0-9-]{36}$/.test(b.requestKey||'')||!/^[A-Za-z0-9_-]{43}$/.test(b.token||'')) fail(400,'Refresh this form and try again.');
        const booking=await transaction(async()=>{
          const existing=await db.prepare(`SELECT * FROM ${bookingsTable} WHERE request_key=?`).get(b.requestKey);
          if(existing){if(existing.token_hash!==hash(b.token)) fail(409,'Request already used.');return existing;}
          const s=await settings(),date=validDate(b.date),start=minute(b.time),guests=int(b.guests,1,s.maxParty,'Guests');
          const name=textField(b.name,100,'your name',true),phone=textField(b.phone,40,'your phone number',true),email=textField(b.email,254,'your email',true).toLowerCase();
          if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400,'Enter a valid email address.');
          if(phone.replace(/\D/g,'').length<7) fail(400,'Enter a valid phone number.');
          const notes=textField(b.notes||'',1000,'special requests'),menu=textField(b.menu||'À la carte',100,'menu');
          if(b.acknowledged!==true) fail(400,'Please acknowledge that this is a request, not a confirmed booking.');
          if(!(await slotAvailable(s,date,start,guests))) fail(409,'That time is no longer available. Please choose another.');
          const id=crypto.randomUUID(),stamp=now();
          await db.prepare(`INSERT INTO ${bookingsTable}(id,token_hash,request_key,\`date\`,\`start\`,\`end\`,guests,name,phone,email,notes,menu,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,hash(b.token),b.requestKey,date,start,start+s.duration,guests,name,phone,email,notes,menu,'pending',stamp,stamp);
          await log('request',id);return await db.prepare(`SELECT * FROM ${bookingsTable} WHERE id=?`).get(id);
        });
        return json(201,publicBooking(booking));
      }
      if(route==='/api/status'&&req.method==='POST') {
        await rate('status:'+hash(ip),240,60000);const b=await body(req);
        if(typeof b.id!=='string'||typeof b.token!=='string') fail(404,'Booking not found.');
        const result=await transaction(async()=>{
          let booking=await db.prepare(`SELECT * FROM ${bookingsTable} WHERE id=? AND token_hash=?`).get(b.id,hash(b.token));
          if(!booking) fail(404,'Booking not found.');
          if(b.cancel===true){
            const c=london(now());if(booking.date<c.date || (booking.date===c.date&&booking.start<=c.minute)) fail(409,'Please call the restaurant to change this booking.');
            if(!['pending','accepted'].includes(booking.status)) fail(409,'This booking cannot be cancelled online.');
            await db.prepare(`UPDATE ${bookingsTable} SET status='cancelled',version=version+1,updated=? WHERE id=?`).run(now(),booking.id);await log('guest_cancel',booking.id);
            booking=await db.prepare(`SELECT * FROM ${bookingsTable} WHERE id=?`).get(booking.id);
          }
          return publicBooking(booking);
        });return json(200,result);
      }
      if(route==='/api/login'&&req.method==='POST') {
        await rate('login:'+hash(ip),8,900000);const b=await body(req);
        if(typeof b.password!=='string'||b.password.length>200) fail(401,'Incorrect password.');
        const candidate=await scrypt(b.password,salt,64);
        if(!crypto.timingSafeEqual(candidate,key)) fail(401,'Incorrect password.');
        const token=random(),csrf=random();
        await db.prepare('INSERT INTO bv_sessions(token,csrf,expires,fingerprint) VALUES(?,?,?,?)').run(hash(token),csrf,now()+12*3600000,fingerprint);
        res.setHeader('Set-Cookie',`bv_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${production?'; Secure':''}`);return json(200,{csrf});
      }
      if(route.startsWith('/api/admin/')) {
        const session=await requireSession(req);
        if(route==='/api/admin/session'&&req.method==='GET') return json(200,{csrf:session.csrf});
        if(route==='/api/admin/logout'&&req.method==='POST') {await db.prepare('DELETE FROM bv_sessions WHERE token=?').run(session.token);res.setHeader('Set-Cookie','bv_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'+(production?'; Secure':''));return json(200,{ok:true});}
        if(route==='/api/admin/settings'&&req.method==='GET') return json(200,await settings());
        if(route==='/api/admin/settings'&&req.method==='PATCH') {
          const b=await body(req);const value=validateSettings(b);
          await transaction(async()=>{const result=await db.prepare('UPDATE bv_settings SET `value`=?,version=version+1 WHERE id=1 AND version=?').run(JSON.stringify(value),b.version);if(!result.changes) fail(409,'Settings changed in another window. Reload and try again.');await log('settings');});return json(200,await settings());
        }
        if(route==='/api/admin/bookings'&&req.method==='GET') {
          const date=url.searchParams.get('date'),view=url.searchParams.get('view');
          const columns='id,`date`,`start`,`end`,guests,name,phone,email,notes,menu,status,created,updated,version';
          const rows=view==='pending'?await db.prepare(`SELECT ${columns} FROM ${bookingsTable} WHERE status='pending' ORDER BY \`date\`,\`start\` LIMIT 1000`).all():await db.prepare(`SELECT ${columns} FROM ${bookingsTable} WHERE \`date\`=? ORDER BY \`start\`,created`).all(validDate(date));
          return json(200,{bookings:rows.map(b=>({...b,time:time(b.start),reference:'BV-'+b.id.slice(0,8).toUpperCase()})),pending:(await db.prepare(`SELECT COUNT(*) AS n FROM ${bookingsTable} WHERE status='pending'`).get()).n});
        }
        const match=route.match(/^\/api\/admin\/bookings\/([a-f0-9-]{36})$/);
        if(match&&req.method==='PATCH') {
          const b=await body(req);if(!allowedStatuses.includes(b.status)) fail(400,'Choose a valid booking status.');
          await transaction(async()=>{
            const row=await db.prepare(`SELECT * FROM ${bookingsTable} WHERE id=?`).get(match[1]);if(!row) fail(404,'Booking not found.');
            if(row.version!==b.version) fail(409,'This booking changed. Refresh before trying again.');
            if(liveStatuses.includes(b.status)&&!liveStatuses.includes(row.status)&&await occupancy(row.date,row.start,row.end,row.id)+row.guests>(await settings()).capacity) fail(409,'There are not enough seats to reopen this booking.');
            await db.prepare(`UPDATE ${bookingsTable} SET status=?,version=version+1,updated=? WHERE id=?`).run(b.status,now(),row.id);await log('status_'+b.status,row.id);
          });return json(200,{ok:true});
        }
        if(route==='/api/admin/closures'&&req.method==='GET') return json(200,{closures:await db.prepare('SELECT * FROM bv_closures WHERE `date`>=? ORDER BY `date`,`start`').all(london(now()).date)});
        if(route==='/api/admin/closures'&&req.method==='POST') {
          const b=await body(req),date=validDate(b.date),start=b.allDay?0:minute(b.start),end=b.allDay?1440:minute(b.end);
          if(start>=end) fail(400,'End time must be after start time.');
          const reason=textField(b.reason||'',120,'closure note'),id=crypto.randomUUID();
          await transaction(async()=>{await db.prepare('INSERT INTO bv_closures(id,`date`,`start`,`end`,reason) VALUES(?,?,?,?,?)').run(id,date,start,end,reason);await log('close',id);});return json(201,{id});
        }
        const cm=route.match(/^\/api\/admin\/closures\/([a-f0-9-]{36})$/);
        if(cm&&req.method==='DELETE') {await transaction(async()=>{await db.prepare('DELETE FROM bv_closures WHERE id=?').run(cm[1]);await log('reopen',cm[1]);});return json(200,{ok:true});}
        if(route==='/api/admin/export'&&req.method==='GET') {
          const columns=['id','date','start','end','guests','name','phone','email','notes','menu','status','created','updated'];
          const rows=await db.prepare('SELECT '+columns.map(k=>'`'+k+'`').join(',')+' FROM '+bookingsTable+' ORDER BY `date`,`start`').all();
          const cell=v=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
          res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="Bella_Vista_Bookings.csv"'});
          return res.end('\ufeff'+[columns,...rows.map(r=>columns.map(k=>['start','end'].includes(k)?time(r[k]):r[k]))].map(row=>row.map(cell).join(',')).join('\r\n'));
        }
        if(route==='/api/admin/backup'&&req.method==='GET') {
          res.setHeader('Content-Disposition','attachment; filename="Bella_Vista_Data_Backup.json"');
          const result=await transaction(async()=>({format:1,exportedAt:new Date(now()).toISOString(),settings:await settings(),bookings:await db.prepare(`SELECT * FROM ${bookingsTable} ORDER BY \`date\`,\`start\``).all(),closures:await db.prepare('SELECT * FROM bv_closures').all()}));return json(200,result);
        }
        fail(404,'Not found.');
      }
      if(['GET','HEAD'].includes(req.method)&&staticFiles[route]) {
        const file=path.join(__dirname,'public',staticFiles[route]);res.writeHead(200,{'Content-Type':types[path.extname(file)]});
        return res.end(req.method==='HEAD'?undefined:fs.readFileSync(file));
      }
      fail(404,'Not found.');
    } catch(e) {
      if(!e.status) console.error('Request failed:',e.code||e.name);
      if(!res.headersSent) json(e.status||500,{error:e.status?e.message:'Unable to complete the request. Please try again or call the restaurant.'});else res.end();
    }
  }
  return {handler,db,close:()=>db.close()};
}
if(require.main===module) createApp().then(app=>{
  const server=http.createServer(app.handler);server.requestTimeout=15000;server.headersTimeout=15000;
  server.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('Bella Vista booking server v1.1.1 ready; hosted MySQL connected.'));
  const shutdown=()=>server.close(async()=>{await app.close();process.exit(0);});process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={createApp,london,londonEpoch,minute,time,validateSettings};
