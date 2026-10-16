import { Cdp } from '../../../tools/selftest/cdp-lib.mjs';
import { writeFileSync } from 'node:fs';

// 定位"产品层比裸帧慢 ~14%"的开销：把 write()/read() 拆成 造帧+交换、以及 flushWrites，
// 并对比"连续两次写"与"写完立刻读"的差别（管线预热/交错效应）。
const out = new URL('./', import.meta.url);
const c = new Cdp(undefined, 240000);
const report = {};
const EVAL = `
const {WebUsbDapProbe:P}=await import('./app/rtt/dap-webusb.js');
const {SramBenchTransfer,prepareSramClock}=await import('./app/flash/sram-transfer.js');
const p=await P.open((await P.authorized())[0],{clockKhz:1000});
const out={};
try{
  await p.halt();
  await prepareSramClock(p,60000000);
  const t=await SramBenchTransfer.create(p);
  const TOTAL=20480, ADDR=0x20000000;
  const data=new Uint8Array(TOTAL);for(let i=0;i<TOTAL;i++)data[i]=(i*73^i>>>3^i>>>11)&0xff;
  out.transport='depth='+t.depth+'/'+t.packetSize+'B';
  let exch=0,exchN=0;
  const orig=t._exchange.bind(t);
  t._exchange=async(r,consume)=>{const t0=performance.now();try{return await orig(r,consume);}finally{exch+=performance.now()-t0;exchN++;}};
  const seq=[];
  for(let rep=0;rep<3;rep++){
    exch=0;exchN=0;
    let t0=performance.now(); await t.write(ADDR,data); const wTotal=performance.now()-t0;
    const wExch=exch, wFrames=wTotal-wExch;
    exch=0;
    t0=performance.now(); await t.write(ADDR,data); const w2Total=performance.now()-t0;
    const w2Exch=exch, w2Frames=w2Total-w2Exch;
    exch=0;
    t0=performance.now(); await t.read(ADDR,TOTAL); const rTotal=performance.now()-t0;
    const rExch=exch, rFrames=rTotal-rExch;
    let t1=performance.now(); await p.flushWrites(); const flush=performance.now()-t1;
    seq.push({rep,
      writeTotal:+wTotal.toFixed(2),writeExch:+wExch.toFixed(2),writeFrames:+wFrames.toFixed(2),
      write2Total:+w2Total.toFixed(2),write2Exch:+w2Exch.toFixed(2),write2Frames:+w2Frames.toFixed(2),
      readTotal:+rTotal.toFixed(2),readExch:+rExch.toFixed(2),readFrames:+rFrames.toFixed(2),flush:+flush.toFixed(2),
      writeMBs:+(TOTAL/wTotal*1000/1e6).toFixed(3), write2MBs:+(TOTAL/w2Total*1000/1e6).toFixed(3), readMBs:+(TOTAL/rTotal*1000/1e6).toFixed(3)});
  }
  out.seq=seq;
  return out;
}finally{ try{ await p.setClock?.(1000000); }catch(e){} try{ await p.disconnect(); }catch(e){} }
`;
try {
  await c.connect();
  await c.send('Page.navigate', { url: 'http://127.0.0.1:8899/index.html?ovh=' + Date.now() + '#flash' });
  for (let i = 0; i < 200; i++) { if (await c.eval('return !!window.__tools?.flash;').catch(() => false)) break; await new Promise(r => setTimeout(r, 100)); }
  await c.eval(`await __tools.probeManager.releaseOthers(null,'SRAM 产品层开销'); return true;`);
  report.result = await c.eval(EVAL);
  for (const s of report.result.seq) console.log(JSON.stringify(s));
} catch (e) {
  report.error = e.stack;
  process.exitCode = 1;
  console.error(e.stack);
} finally {
  writeFileSync(new URL('overhead.json', out), JSON.stringify(report, null, 2));
  c.close();
}
