// Real BMP/page -> USB -> SPI output benchmark. No attached display is required;
// counters prove bridge completion, not the appearance or electrical integrity of a screen.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {Cdp,sleep} from '../selftest/cdp-lib.mjs';
const arg=(key,fallback)=>process.argv.find(x=>x.startsWith(`--${key}=`))?.slice(key.length+3)??fallback;
const out=resolve(arg('out','tmp/spi-image-rate.json'));
const rounds=Number(arg('rounds','12'));
const clocks=String(arg('clocks','20,40,60,75')).split(',').map(Number);
const batches=String(arg('batches','512,8192,32768')).split(',').map(Number);
const panels=String(arg('panels','axs15352,st77916')).split(',');
const fullPanel=arg('full-panel','true')==='true';
assert.ok(Number.isInteger(rounds)&&rounds>0&&rounds<=100);
assert.ok(clocks.every(x=>x>0&&x<=75));assert.ok(batches.every(x=>x>=512&&x<=61440));
assert.ok(panels.every(x=>['axs15352','st77916'].includes(x)));
const c=new Cdp(process.env.CDP||'http://127.0.0.1:9333');
const report={startedAt:new Date().toISOString(),app:process.env.APP||'http://127.0.0.1:8899/index.html',rounds,clocks,batches,panels,fullPanel,displayAttached:false,rows:[]};
mkdirSync(dirname(out),{recursive:true});
const save=()=>writeFileSync(out,JSON.stringify(report,null,2)+'\n');
let original=null, failure;
try{
 await c.connect();
 await c.send('Network.enable');await c.send('Network.setCacheDisabled',{cacheDisabled:true});
 await c.send('Page.navigate',{url:report.app+'?image-rate='+Date.now()+'#panel'});
 for(let i=0;i<100;i++){if(await c.eval('return !!__tools?.panel').catch(()=>false))break;await sleep(50);}
 original=await c.eval(`
 const s=__tools.spiSession;await s.setMock(false);await s.connectHid(false);await s.connectUsb(false);
 if(!s.connected||!s.dataReady)throw Error('Probe USB/HID permission missing');
 return {cfg:{...s.cfg},profile:{...s.profile},enabled:s.enabled};`);
 assert.equal(original.enabled,false,'start with an idle SPI bridge');report.original=original;
 report.probe=await c.eval('return __tools.spiSession.hid?.label;');
 // Install lightweight spans around the production methods, keeping the actual
 // image loader, RGB565 conversion, packing, USB scheduler and reply matcher.
 await c.eval(`
 window.__imageRate={};const s=__tools.spiSession,t=s.transport,p=__tools.panel;
 const sendFrames=s.sendFrames.bind(s),sendPacks=t.sendPacks.bind(t),sendRaw=t.sendRaw.bind(t);
 s.sendFrames=async(...a)=>{const m=__imageRate.current;const t0=performance.now();try{return await sendFrames(...a);}finally{if(m)m.framesMs+=performance.now()-t0;}};
 t.sendPacks=async(...a)=>{const m=__imageRate.current;const t0=performance.now();try{return await sendPacks(...a);}finally{if(m)m.usbMs+=performance.now()-t0;}};
 t.sendRaw=async(...a)=>{const m=__imageRate.current;if(m){m.calls++;m.wireBytes+=a[0].byteLength;}return sendRaw(...a);};
 const u=new Uint8Array(await(await fetch('samples/test_images/gradient.bmp')).arrayBuffer());
 __imageRate.bmp=u;await p.pickImage(new File([u],'gradient.bmp',{type:'image/bmp'}));
 if(!p.src||p.src.name!=='gradient.bmp')throw Error('BMP load failed');
 __imageRate.bmpSource={w:p.src.w,h:p.src.h,bytes:u.length};
 const P=await import('./app/spi/protocol.js');__imageRate.P=P;
 const I=await import('./app/spi/image.js');__imageRate.I=I;
 `);
 report.bmp=await c.eval('return __imageRate.bmpSource;');
 for(const panel of panels){
  await c.eval(`document.getElementById('pn-preset').value=${JSON.stringify(panel)};await __tools.panel.applyPreset();
    document.getElementById('pn-partial').checked=false;document.getElementById('pn-level').value='255';
    document.getElementById('pn-fit').value='stretch';if(!await __tools.spiSession.setEnabled(true))throw Error('SPI enable failed');`);
  const selected=await c.eval('return {profile:__tools.spiSession.profile.profile,geometry:__tools.panel.geometry()};');
  assert.equal(selected.profile,panel==='axs15352'?1:2,'preset profile must apply');
  assert.equal(selected.geometry.w,panel==='axs15352'?240:360,'preset width must apply');
  assert.equal(selected.geometry.h,panel==='axs15352'?296:360,'preset height must apply');
  if(fullPanel)await c.eval(`
    const p=__tools.panel,I=__imageRate.I,g=p.geometry();
    const src=I.parseBMP(__imageRate.bmp),rgba=I.composeImage(src.rgba,src.w,src.h,g.w,g.h,{mode:'stretch'}).rgba;
    const stride=(g.w*3+3)&~3,bmp=new Uint8Array(54+stride*g.h),d=new DataView(bmp.buffer);
    bmp.set([66,77]);d.setUint32(2,bmp.length,true);d.setUint32(10,54,true);d.setUint32(14,40,true);
    d.setInt32(18,g.w,true);d.setInt32(22,g.h,true);d.setUint16(26,1,true);d.setUint16(28,24,true);
    d.setUint32(34,stride*g.h,true);
    for(let y=0;y<g.h;y++)for(let x=0;x<g.w;x++){
      const a=(y*g.w+x)*4,b=54+(g.h-1-y)*stride+x*3;bmp[b]=rgba[a+2];bmp[b+1]=rgba[a+1];bmp[b+2]=rgba[a];
    }
    __imageRate.bmp=bmp;await p.pickImage(new File([bmp],'gradient-'+g.w+'x'+g.h+'.bmp',{type:'image/bmp'}));`);
  for(const clock of clocks){
   await c.eval(`const s=__tools.spiSession;const r=await s.applyConfig({...s.cfg,sclkHz:${clock}*1000000});if(r.diffs.length)throw Error(r.diffs.join(','));`);
   for(const batch of batches){
    const row=await c.eval(`
     const s=__tools.spiSession,p=__tools.panel,P=__imageRate.P,I=__imageRate.I;
     document.getElementById('pn-batch').value=String(${batch});
     if(p.batchBytes()!==${batch})throw Error('Batch selector mismatch');
     const g=p.geometry(),opt={geometry:g,x:0,y:0,fit:'stretch',profile:s.profile.profile,lines:g.lines,swap:false,littleEndian:false,level:255};
     // CPU stages are measured independently; they do not replace page sends below.
     const cpu={decodeMs:0,composeMs:0,itemsMs:0,packMs:0,batchMs:0};let wireBytes=0,protocolFrames=0;
     for(let i=0;i<20;i++){
      let a=performance.now();const d=I.parseBMP(__imageRate.bmp);cpu.decodeMs+=performance.now()-a;
      a=performance.now();const cw=I.composeWindow(d.rgba,d.w,d.h,opt);cpu.composeMs+=performance.now()-a;
      a=performance.now();const items=I.itemsForWindow(cw.px,cw.win,opt);cpu.itemsMs+=performance.now()-a;
      a=performance.now();const packs=P.packFrames(items.map(it=>P.frame(it.type,it.payload,{flags:it.flags,seq:(it.flags&P.F.RSP)?1:0})));cpu.packMs+=performance.now()-a;
      a=performance.now();const b=P.batchPacks(packs,${batch});cpu.batchMs+=performance.now()-a;
      wireBytes=b.reduce((n,v)=>n+v.bytes,0);protocolFrames=items.length;
     }
     for(const k of Object.keys(cpu))cpu[k]/=20;
     await p.sendImage();await p.sendImage();
     const before=await s.pollStatus(true);const runs=[];
     for(let i=0;i<${rounds};i++){
      const m={framesMs:0,usbMs:0,calls:0,wireBytes:0};__imageRate.current=m;
      const previous=p.lastRun;
      const a=performance.now();await p.sendImage();const wallMs=performance.now()-a;__imageRate.current=null;
      const r=p.lastRun;if(!r||r===previous||r.badRsp)throw Error('Image send failed');
      runs.push({...r,...m,wallMs});
     }
     const after=await s.pollStatus(true),delta=Object.fromEntries(['framesOk','framesErr','bytesTx','bytesRx','outOverrun','inDrop','txDma','txPoll'].map(k=>[k,(after[k]-before[k])>>>0]));
     return {kind:'bmp-page',panel:${JSON.stringify(panel)},clockMHz:${clock},batchBytes:${batch},geometry:g,actualSclkHz:after.actualSclkHz,protocolFrames,wireBytes,cpu,runs,before,after,delta};`);
    assert.equal(row.actualSclkHz,clock*1e6);assert.equal(row.delta.framesErr,0);assert.equal(row.delta.outOverrun,0);assert.equal(row.delta.inDrop,0);
    assert.equal(row.delta.framesOk,row.protocolFrames*rounds,'all expected frames must execute');
    if(fullPanel)assert.ok(row.runs.every(r=>r.bytes===row.geometry.w*row.geometry.h*2),'full panel pixel count');
    const sum=row.runs.reduce((n,r)=>n+r.ms,0);row.MBps=row.runs.reduce((n,r)=>n+r.bytes,0)/sum/1000;
    row.wallMBps=row.runs.reduce((n,r)=>n+r.bytes,0)/row.runs.reduce((n,r)=>n+r.wallMs,0)/1000;
    report.rows.push(row);save();console.log(JSON.stringify({panel,clock,batch,MBps:row.MBps,wallMBps:row.wallMBps,frames:row.delta.framesOk,cpu:row.cpu}));
   }
  }
 }
 // Equal-sized protocol slots with no SPI transaction isolate USB receive,
 // parser and main-loop overhead. A final response fences actual execution.
 for(const batch of batches){
  const row=await c.eval(`
   const s=__tools.spiSession,P=__imageRate.P;const count=4096;
   const payload=new Uint8Array(504);for(let i=0;i<payload.length;i++)payload[i]=(i*31+7)&255;
   const items=Array.from({length:count},(_,i)=>({type:P.T.PING,payload,flags:i===count-1?P.F.RSP:0}));
   const before=await s.pollStatus(true);const m={framesMs:0,usbMs:0,calls:0,wireBytes:0};__imageRate.current=m;
   const a=performance.now();const r=await s.sendFrames(items,{quiet:true,timeoutMs:10000,batchBytes:${batch}});const ms=performance.now()-a;__imageRate.current=null;
   if(r.failed||!r.rsps.at(-1)||r.rsps.at(-1).status!==P.ST.OK)throw Error('USB-only fence failed');
   const after=await s.pollStatus(true);return {kind:'usb-only',batchBytes:${batch},ms,...m,before,after,count};`);
  assert.equal((row.after.framesOk-row.before.framesOk)>>>0,row.count);assert.equal(row.after.framesErr,row.before.framesErr);assert.equal(row.after.bytesTx,row.before.bytesTx);
  row.MBps=row.wireBytes/row.ms/1000;report.rows.push(row);save();console.log(JSON.stringify({kind:row.kind,batch,MBps:row.MBps,calls:row.calls}));
 }
}catch(e){failure=e;report.error=e.stack||String(e);save();throw e;}
finally{
 try{if(original)await c.eval(`const s=__tools.spiSession;await s.setEnabled(false);await s.applyProfile(${JSON.stringify(original.profile)});await s.applyConfig(${JSON.stringify(original.cfg)});await s.teardown();return true;`);}
 catch(e){report.cleanupError=String(e);save();if(!failure)throw e;}
 finally{c.close();}
}
report.finishedAt=new Date().toISOString();save();console.log('Saved '+out);
