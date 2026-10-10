/* Runs before the trading module, including in older mobile wallet WebViews. */
(function(){
 'use strict';
 if(typeof BigInt!=='function'){show('当前钱包浏览器版本过旧，请升级欧易 App 或用最新版钱包浏览器打开。');return;}
 if(!Array.prototype.at)Object.defineProperty(Array.prototype,'at',{value:function(i){i=Math.trunc(i)||0;if(i<0)i+=this.length;return this[i];},configurable:true,writable:true});
 if(!Promise.withResolvers)Promise.withResolvers=function(){var resolve,reject,promise=new Promise(function(a,b){resolve=a;reject=b;});return{promise:promise,resolve:resolve,reject:reject};};
 if(window.AbortSignal&&!AbortSignal.timeout)AbortSignal.timeout=function(ms){var c=new AbortController();setTimeout(function(){c.abort(new DOMException('Timed out','TimeoutError'));},ms);return c.signal;};
 if(window.AbortSignal&&!AbortSignal.any)AbortSignal.any=function(signals){var c=new AbortController(),listeners=[];function finish(s){if(c.signal.aborted)return;c.abort(s.reason);listeners.forEach(function(p){p[0].removeEventListener('abort',p[1]);});}signals.forEach(function(s){if(s.aborted)finish(s);else if(!c.signal.aborted){var f=function(){finish(s);};listeners.push([s,f]);s.addEventListener('abort',f,{once:true});}});return c.signal;};
 function show(text){var p=document.getElementById('boot-status');if(p)p.textContent=text;}
 var timer=setTimeout(function(){if(!document.querySelector('.shell'))show('交易界面未能加载，请点“重新加载”。若仍失败，请升级欧易 App 或更换网络后打开。');},15000);
 window.addEventListener('error',function(e){if(!document.querySelector('.shell'))show('交易界面加载失败。请重新加载，或升级欧易 App 后再试。');});
 window.addEventListener('nomtf:ready',function(){clearTimeout(timer);});
 document.addEventListener('DOMContentLoaded',function(){var b=document.getElementById('boot-retry');if(b)b.addEventListener('click',function(){location.reload();});});
})();
