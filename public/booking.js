'use strict';
const $=BV.el;let config,selected='',generation=0,submitting=false;
const bytes=crypto.getRandomValues(new Uint8Array(32));
const token=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const requestKey=crypto.randomUUID();
async function availability(){
  if(!config)return;const current=++generation,previous=selected;selected='';$('submit').disabled=true;$('slots').replaceChildren(BV.node('span','slots-note','Checking availability…'));
  $('group-note').hidden=Number($('guests').value)<8;
  try{
    const data=await BV.api('/api/availability?'+new URLSearchParams({date:$('date').value,guests:$('guests').value}));
    if(current!==generation)return;
    $('closed').hidden=data.accepting;$('slots').replaceChildren();
    for(const t of data.slots){const button=BV.node('button','slot',t);button.type='button';button.setAttribute('aria-pressed','false');button.onclick=()=>{selected=t;document.querySelectorAll('.slot').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));$('submit').disabled=false;};$('slots').append(button);if(t===previous)button.click();}
    if(!data.slots.length)$('slots').append(BV.node('span','slots-note',data.accepting?'No times available for this date and group size. Try another day or call us.':'Online bookings are currently paused.'));
  }catch(e){if(current===generation){$('slots').replaceChildren(BV.node('span','slots-note',e.message));}}
}
async function init(){try{config=await BV.api('/api/config');$('date').min=config.minDate;$('date').max=config.maxDate;$('date').value=config.minDate;for(let n=1;n<=config.maxParty;n++){const option=BV.node('option','',n+' guest'+(n===1?'':'s'));option.value=n;$('guests').append(option);}$('guests').value=Math.min(2,config.maxParty);$('closed').hidden=config.accepting;await availability();}catch(e){$('error').textContent=e.message;}}
$('date').addEventListener('change',availability);$('guests').addEventListener('change',availability);
$('booking-form').addEventListener('submit',async event=>{
  event.preventDefault();if(submitting)return;if(!selected){$('error').textContent='Choose an available time.';return;}
  submitting=true;$('submit').disabled=true;$('error').textContent='';$('submit').textContent='Sending your request…';
  try{const data=await BV.api('/api/bookings',{method:'POST',body:JSON.stringify({requestKey,token,date:$('date').value,time:selected,guests:Number($('guests').value),name:$('name').value,phone:$('phone').value,email:$('email').value,notes:$('notes').value,website:$('website').value,acknowledged:$('acknowledged').checked})});location.assign('/booking-status#'+data.id+'.'+token);}
  catch(e){$('error').textContent=e.message;submitting=false;$('submit').textContent='Request a table ↗';$('submit').disabled=!selected;if(e.status===409)await availability();}
});
init();
