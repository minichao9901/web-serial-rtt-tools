/** Browser startup timing in an isolated CDP tab; never opens hardware. */
import {Cdp,sleep} from './cdp-lib.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
const args=process.argv.slice(2),arg=(name,fallback)=>args.find(s=>s.startsWith('--'+name+'='))?.slice(name.length+3)??fallback;
if(args.includes('--help')){console.log('node tools/selftest/page-load-bench.mjs --url=https://.../index.html [--compare --runs=2 --latency=200 --mbps=8 --warm --background --out=tmp/page-load.json]');process.exit(0);}
const url=arg('url','https://minichao9901.github.io/web-serial-rtt-tools/index.html'),out=resolve(arg('out','tmp/page-load.json'));
const runs=Number(arg('runs','1')),latency=Number(arg('latency','0')),mbps=Number(arg('mbps','0'));
if(!Number.isInteger(runs)||runs<1||runs>10||!Number.isFinite(latency)||latency<0||!Number.isFinite(mbps)||mbps<0)throw Error('Invalid run count or network settings');
const c=new Cdp(process.env.CDP||'http://127.0.0.1:9333',20000),rows=[];let targetId;
try{
 await c.connect();({targetId}=await c.sendBrowser('Target.createTarget',{url:'about:blank',background:args.includes('--background')}));
 const tab=(await(await fetch(c.base+'/json/list')).json()).find(t=>t.id===targetId);
 c.ws.close();c.ws=await c._open(tab.webSocketDebuggerUrl,(ws,m)=>c._dispatch(m));
 await c.send('Page.enable');await c.send('Runtime.enable');await c.send('Network.enable');
 if(latency||mbps)await c.send('Network.emulateNetworkConditions',{offline:false,latency,downloadThroughput:mbps?mbps*1e6/8:-1,uploadThroughput:-1,connectionType:'wifi'});
 await c.send('Page.addScriptToEvaluateOnNewDocument',{source:`
 window.__loadBench={ready:null,seen:false,errors:[]};
 new MutationObserver(()=>{const b=window.__loadBench;if(document.getElementById('boot-mask'))b.seen=true;
 else if(b.seen&&b.ready===null&&window.__tools)b.ready=performance.now();}).observe(document,{childList:true,subtree:true});
 window.addEventListener('error',e=>__loadBench.errors.push(e.message||e.target?.src||'resource failure'),true);
 window.addEventListener('unhandledrejection',e=>__loadBench.errors.push(String(e.reason?.message||e.reason)));
 `});
 const modes=args.includes('--compare')?['source','bundle']:[arg('mode','auto')];
 for(let run=0;run<runs;run++)for(const mode of modes){
  const destination=new URL(url),warm=args.includes('--warm')&&run>0;
  if(mode!=='auto')destination.searchParams.set('modules',mode);
  const failures=[];c.onEvent=m=>{if(m.method==='Network.loadingFailed')failures.push({url:m.params.requestId,error:m.params.errorText});};
  await c.send('Network.setCacheDisabled',{cacheDisabled:!warm});if(!warm)await c.send('Network.clearBrowserCache');
  if(!args.includes('--background'))await c.send('Page.bringToFront');await c.send('Page.navigate',{url:destination.href});
  console.log(`Loading ${mode} / ${warm?'warm':'cold'} / run ${run+1}`);
  let ready=false;for(let n=0;n<480;n++){ready=await c.eval('return window.__loadBench?.ready!=null;').catch(()=>false);if(ready)break;if(n&&n%80===0)console.log(`Still waiting: ${n/4}s`);await sleep(250);}
  if(ready)await sleep(600);
  const page=await c.eval(`const b=window.__loadBench||{},n=performance.getEntriesByType('navigation')[0],r=performance.getEntriesByType('resource');return {url:location.href,readyMs:b.ready,errors:b.errors,entry:document.documentElement.dataset.bootEntry,visibility:document.visibilityState,tools:!!window.__tools,toolErrors:window.__tools?.errors,domMs:n?.domContentLoadedEventEnd,loadMs:n?.loadEventEnd,ttfbMs:n?.responseStart,resources:r.map(x=>({url:x.name,start:x.startTime,ms:x.duration,transfer:x.transferSize,encoded:x.encodedBodySize,decoded:x.decodedBodySize,protocol:x.nextHopProtocol}))};`);
  const row={run:run+1,mode,warm,latencyMs:latency,mbps,page,failures};rows.push(row);
  mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify({at:new Date().toISOString(),rows},null,2));
  console.log(JSON.stringify({mode,warm,readyMs:page.readyMs,jsRequests:page.resources.filter(r=>/\.m?js(?:\?|$)/.test(r.url)).length,transfer:page.resources.reduce((n,r)=>n+r.transfer,0),errors:page.errors,failed:failures.length}));
  if(!ready||page.errors?.length||failures.length)process.exitCode=1;
 }
}finally{if(targetId)try{await c.sendBrowser('Target.closeTarget',{targetId});}catch{}c.close();}
