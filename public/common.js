'use strict';
window.BV={
  csrf:'',
  async api(url,options={}) {
    const headers={'Content-Type':'application/json','X-BV-Request':'1',...options.headers};
    if(BV.csrf) headers['X-CSRF-Token']=BV.csrf;
    let response;
    try{response=await fetch(url,{credentials:'same-origin',...options,headers});}catch{throw new Error('Connection lost. Check your internet and try again.');}
    let data;try{data=await response.json();}catch{throw new Error('The booking server could not respond. Please try again.');}
    if(!response.ok){const e=new Error(data.error||'Unable to complete request.');e.status=response.status;throw e;}return data;
  },
  el(id){return document.getElementById(id);},
  date(d){return new Date(d+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',timeZone:'Europe/London'});},
  today(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());},
  time(n){return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');},
  node(tag,cls,value){const el=document.createElement(tag);if(cls)el.className=cls;if(value!==undefined)el.textContent=value;return el;},
  toast(message){let el=document.getElementById('toast');if(!el){el=BV.node('div','toast');el.id='toast';el.setAttribute('role','status');document.body.append(el);}el.textContent=message;el.hidden=false;clearTimeout(BV.timer);BV.timer=setTimeout(()=>el.hidden=true,5000);}
};
