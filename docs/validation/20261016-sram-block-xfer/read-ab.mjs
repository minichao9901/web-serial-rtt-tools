import { Cdp } from '../../../tools/selftest/cdp-lib.mjs';
import { writeFileSync } from 'node:fs';

// 同一会话里交替测「产品读路径（SramBenchTransfer.read）」与「裸帧读（同样帧、同样流水）」，
// 判断产品层在读方向上还剩多少可回收开销。
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
  out.transport='depth='+t.depth+'/'+t.packetSize+'B';
  const packetSize=t.packetSize, depth=t.depth;
  const exchange=async(frames,d=depth)=>{
    let next=0,err=null;
    const worker=async()=>{while(!err&&next<frames.length){const f=frames[next++];
      const frame=new Uint8Array(p._framing==='pad'?packetSize:f.length);frame.set(f);
      const [o,i]=await Promise.all([p.device.transferOut(p.epOut,frame),p.device.transferIn(p.epIn,packetSize)]);
      if(err)return;
      if(o.status!=='ok'||i.status!=='ok'){err=new Error('usb status');return;}
      const res=new Uint8Array(i.data.buffer,i.data.byteOffset,i.data.byteLength);
      if(res[0]!==5){err=new Error('cmd echo '+res[0]);return;}
      if((res[2]&7)!==1){err=new Error('ack');return;}
    }};
    await Promise.all(Array.from({length:Math.min(d,frames.length)},worker));
    if(err)throw err;
  };
  const bareReadFrames=()=>{const f=[];const maxW=Math.min(254,Math.floor((packetSize-3)/4));
    for(let off=0;off<TOTAL;){const a=(ADDR+off)>>>0;
      const words=Math.min(maxW,(TOTAL-off)/4,(1024-(a&1023))/4);
      const req=new Uint8Array(8+words);req[0]=5;req[1]=0;req[2]=(1+words)&0xff;req[3]=5;
      req[4]=a&0xff;req[5]=(a>>>8)&0xff;req[6]=(a>>>16)&0xff;req[7]=(a>>>24)&0xff;
      req.fill(15,8);f.push(req);off+=words*4;}
    return f;};
  out.pairs=[];
  for(let rep=0;rep<4;rep++){
    let t0=performance.now(); await t.read(ADDR,TOTAL); const pR=(performance.now()-t0)/1000;
    t0=performance.now(); await exchange(bareReadFrames()); const bR=(performance.now()-t0)/1000;
    out.pairs.push({rep,productMBs:+(TOTAL/pR/1e6).toFixed(3),bareMBs:+(TOTAL/bR/1e6).toFixed(3),
      productMs:+(pR*1000).toFixed(2),bareMs:+(bR*1000).toFixed(2)});
  }
  const m=k=>+(out.pairs.reduce((s,x)=>s+x[k],0)/out.pairs.length).toFixed(3);
  out.mean={productMBs:m('productMBs'),bareMBs:m('bareMBs')};
  return out;
}finally{ try{ await p.setClock?.(1000000); }catch(e){} try{ await p.disconnect(); }catch(e){} }
`;
try {
  await c.connect();
  await c.send('Page.navigate', { url: 'http://127.0.0.1:8899/index.html?readab=' + Date.now() + '#flash' });
  for (let i = 0; i < 200; i++) { if (await c.eval('return !!window.__tools?.flash;').catch(() => false)) break; await new Promise(r => setTimeout(r, 100)); }
  await c.eval(`await __tools.probeManager.releaseOthers(null,'读路径 A/B'); return true;`);
  report.result = await c.eval(EVAL);
  for (const s of report.result.pairs) console.log(JSON.stringify(s));
  console.log('MEAN ' + JSON.stringify(report.result.mean));
} catch (e) {
  report.error = e.stack;
  process.exitCode = 1;
  console.error(e.stack);
} finally {
  writeFileSync(new URL('read-ab.json', out), JSON.stringify(report, null, 2));
  c.close();
}
