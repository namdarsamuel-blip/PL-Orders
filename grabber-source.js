(function(){
if(window.__ttc){window.__ttc.style.display='block';return;}
var got=new Map(),timer=null,still=0,lastN=0;
var BLOCK=/^(block|flex|grid|list-item|table)/;
function txt(n){
 if(n.nodeType===3)return n.nodeValue;
 if(n.nodeType!==1)return '';
 if(n.tagName==='IMG'){var a=n.alt||'';return /^:[\w~+-]+:$/.test(a)?'':a;}
 if(n.tagName==='BR')return '\n';
 var cs=getComputedStyle(n);if(cs.display==='none')return '';
 var s='';for(var c=n.firstChild;c;c=c.nextSibling)s+=txt(c);
 return BLOCK.test(cs.display)?'\n'+s+'\n':s;
}
function scan(){
 document.querySelectorAll('li[id^="chat-messages-"]').forEach(function(li){
  if(got.has(li.id))return;
  var t=txt(li);
  if(t.indexOf('TICKETS SOLD')<0||t.indexOf('Prime Lion Inc')<0)return;
  got.set(li.id,t.replace(/[ \t]+\n/g,'\n').replace(/\n{2,}/g,'\n').trim());
 });
 info.textContent='Sales collected: '+got.size;
}
function scroller(){
 var el=document.querySelector('li[id^="chat-messages-"]');
 while(el&&!(el.scrollHeight>el.clientHeight+10&&/auto|scroll/.test(getComputedStyle(el).overflowY)))el=el.parentElement;
 return el;
}
function autoUp(){
 if(timer){clearInterval(timer);timer=null;bAuto.textContent='Auto-scroll up';return;}
 var sc=scroller();if(!sc){alert('Open the sales channel first.');return;}
 still=0;lastN=got.size;bAuto.textContent='Stop scrolling';
 timer=setInterval(function(){
  sc.scrollTop=0;scan();
  if(got.size===lastN)still++;else{still=0;lastN=got.size;}
  if(still>=20){clearInterval(timer);timer=null;bAuto.textContent='Auto-scroll up';info.textContent='Reached the top. Sales collected: '+got.size;}
 },1500);
}
function copyAll(){
 scan();
 var all=Array.from(got.values()).join('\n\n');
 function done(){bCopy.textContent='Copied '+got.size+' sales!';setTimeout(function(){bCopy.textContent='Copy all';},2500);}
 function fallback(){var ta=document.createElement('textarea');ta.value=all;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();done();}
 if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(all).then(done,fallback);else fallback();
}
var box=document.createElement('div');window.__ttc=box;
box.style.cssText='position:fixed;right:20px;bottom:90px;z-index:2147483647;background:#111827;color:#fff;padding:14px;border-radius:10px;font:14px Arial,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5);width:230px';
var title=document.createElement('div');title.textContent='Sales Grabber';title.style.cssText='font-weight:bold;margin-bottom:6px';
var info=document.createElement('div');info.style.marginBottom='10px';
function btn(label,fn,bg){var b=document.createElement('button');b.textContent=label;b.onclick=fn;b.style.cssText='display:block;width:100%;margin-top:6px;padding:8px;border:0;border-radius:6px;cursor:pointer;color:#fff;font:bold 13px Arial;background:'+bg;return b;}
var bAuto=btn('Auto-scroll up',autoUp,'#4f46e5');
var bCopy=btn('Copy all',copyAll,'#16a34a');
var bClose=btn('Close',function(){if(timer){clearInterval(timer);timer=null;}box.style.display='none';},'#4b5563');
box.append(title,info,bAuto,bCopy,bClose);document.body.appendChild(box);
scan();setInterval(scan,800);
})();
