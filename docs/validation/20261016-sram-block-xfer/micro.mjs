import { Cdp } from '../../../tools/selftest/cdp-lib.mjs';
import { writeFileSync } from 'node:fs';

/**
 * SRAM 传输方式微基准（2026-10-16）：为"把网页端传输优化回来"选型。
 *   wordsWrite  现状 DAP_Transfer(0x05)：帧内写 TAR + 逐字写（0x0D，5B/字），每帧 ≤203 字
 *   blockWrite  DAP_TransferBlock(0x06)：每页 TAR + 254 字块 + 余字块（4B/字）
 *   wordsRead   现状：帧内 TAR + 逐字读（0x0F，1B/字），每帧 ≤254 字
 *   blockRead   DAP_TransferBlock：每页 TAR + 块读
 * 另测 TAR 自增是否真的在 1KB 边界回绕（决定能不能连续块传输而不用每页重写 TAR）。
 * 帧长上限 = 探针 info 广告的 1024B；超长帧会把探针惹毛（本次踩到过）。
 */
const out = new URL('./', import.meta.url);
const c = new Cdp(undefined, 300000);
const report = {};
const EVAL = `
const {WebUsbDapProbe:P}=await import('./app/rtt/dap-webusb.js');
const {prepareSramClock}=await import('./app/flash/sram-transfer.js');
const p=await (async()=>{ for(let i=0;i<4;i++){ try{ return await P.open((await P.authorized())[0],{clockKhz:1000}); }
  catch(e){ try{ for(const d of await P.authorized()){ try{ await d.reset(); }catch(e2){} try{ await d.close(); }catch(e2){} } }catch(e2){}
    await new Promise(r=>setTimeout(r,900)); if(i===3)throw e; } } })();
const out={};
try{
  await p.halt();
  out.clock=await prepareSramClock(p,60000000);
  const infoSize=await p.info(0xff); const advertised=(infoSize[0]||0)|((infoSize[1]||0)<<8);
  const infoCnt=await p.info(0xfe);
  const packetSize=Math.min(1024,advertised), depth=Math.max(1,Math.min(4,infoCnt[0]||1));
  out.transport={advertised,depth,packetSize,framing:p._framing};
  const u32=v=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,v>>>0,true);return b;};
  const bytes=n=>{const b=new Uint8Array(n);for(let i=0;i<n;i++)b[i]=(i*73^i>>>3^i>>>11)&0xff;return b;};
  const send1=async f=>{const frame=new Uint8Array(p._framing==='pad'?packetSize:f.length);frame.set(f);
    const [o,i]=await Promise.all([p.device.transferOut(p.epOut,frame),p.device.transferIn(p.epIn,packetSize)]);
    if(o.status!=='ok'||i.status!=='ok')throw new Error('usb status');
    const res=new Uint8Array(i.data.buffer,i.data.byteOffset,i.data.byteLength);
    return {reqLen:f.length,res:Array.from(res.slice(0,12)),len:res.byteLength};};
  const exchange=async(frames,d=1)=>{
    let next=0,err=null;
    const worker=async()=>{while(!err&&next<frames.length){const f=frames[next++];
      const frame=new Uint8Array(p._framing==='pad'?packetSize:f.length);frame.set(f);
      if(frame.length>packetSize){err=new Error('frame too big '+frame.length);return;}
      const [o,i]=await Promise.all([p.device.transferOut(p.epOut,frame),p.device.transferIn(p.epIn,packetSize)]);
      if(err)return;
      if(o.status!=='ok'||i.status!=='ok'){err=new Error('usb status');return;}
      const res=new Uint8Array(i.data.buffer,i.data.byteOffset,i.data.byteLength);
      if(res[0]!==f[0]){err=new Error('cmd echo '+res[0]+' != '+f[0]);return;}
      const ack=f[0]===6?(res[3]&7):(res[2]&7);
      if(ack!==1){err=new Error('ack 0x'+ack.toString(16)+' (cmd '+f[0]+')');return;}
    }};
    await Promise.all(Array.from({length:Math.min(d,frames.length)},worker));
    if(err)throw err;
  };
  const ADDR=0x20000000, PAGE=1024, TOTAL=20480;
  out.limits={writeWordsPerFrame:Math.floor((packetSize-8)/5),readWordsPerFrame:Math.min(254,packetSize-8),
    blockWordsPerFrame:Math.min(254,Math.floor((packetSize-5)/4))};
  const mkTar=a=>Uint8Array.from([5,0,1,5,...u32(a)]);
  const mkWordsWrite=(a,n,data)=>{const f=new Uint8Array(8+5*n);f.set([5,0,(1+n)&0xff,5]);f.set(u32(a),4);
    for(let i=0;i<n;i++){f[8+i*5]=13;f.set(data.subarray(i*4,i*4+4),9+i*5);}return f;};
  const mkBlockWrite=(n,data)=>{const f=new Uint8Array(5+4*n);f.set([6,0,n&0xff,(n>>8)&0xff,13]);f.set(data.subarray(0,4*n),5);return f;};
  const mkWordsRead=(a,n)=>{const f=new Uint8Array(8+n);f.set([5,0,(1+n)&0xff,5]);f.set(u32(a),4);f.fill(15,8);return f;};
  const mkBlockRead=n=>Uint8Array.from([6,0,n&0xff,(n>>8)&0xff,15]);
  // ---------- A) 帧探针 ----------
  const probeData=bytes(16);
  out.frameProbe=[];
  for(const [name,frame] of [['tar',mkTar(ADDR)],['wordsWrite-4',mkWordsWrite(ADDR,4,probeData)],
      ['wordsRead-4',mkWordsRead(ADDR,4)],['blockWrite-4',mkBlockWrite(4,probeData)],['blockRead-4',mkBlockRead(4)]]){
    try{ out.frameProbe.push({name,...await send1(frame)}); }catch(e){ out.frameProbe.push({name,error:e.message}); }
  }
  // ---------- B) TAR 自增是否跨 1KB 边界 ----------
  try{
    const A=new Uint8Array(1016).fill(0x11);      // 254 字图案
    await exchange([mkTar(ADDR),mkBlockWrite(254,A)]);
    await exchange([mkBlockWrite(2,Uint8Array.from([0xBB,0xBB,0xBB,0xBB,0xCC,0xCC,0xCC,0xCC]))]); // 不重写 TAR
    const tail=new Uint8Array(await p.readMem(ADDR+1016,8));
    const head=new Uint8Array(await p.readMem(ADDR,8));
    out.wrapTest={tail8:Array.from(tail),head8:Array.from(head),
      readme: tail[0]===0xBB&&tail[4]===0xCC ? '无回绕（跨 1KB 继续自增）' : '在 1KB 边界回绕',
      headFirst:Array.from(new Uint8Array(await p.readMem(ADDR,4)))};
  }catch(e){ out.wrapTest={error:e.message}; }
  // ---------- C) 计时矩阵 ----------
  const data=bytes(TOTAL);
  const pages=()=>{const r=[];for(let off=0;off<TOTAL;off+=PAGE){r.push({a:ADDR+off,n:Math.min(PAGE,TOTAL-off)/4});}return r;};
  const W=out.limits.writeWordsPerFrame, R=out.limits.readWordsPerFrame, B=out.limits.blockWordsPerFrame;
  const wordsWriteFrames=()=>{const f=[];for(const {a,n} of pages()){for(let i=0;i<n;i+=W){const cnt=Math.min(W,n-i);
    f.push(mkWordsWrite(a+i*4,cnt,data.subarray(a-ADDR+i*4,a-ADDR+i*4+cnt*4)));}}return f;};
  const blockWriteFrames=()=>{const f=[];for(const {a,n} of pages()){f.push(mkTar(a));for(let i=0;i<n;i+=B){const cnt=Math.min(B,n-i);
    f.push(mkBlockWrite(cnt,data.subarray(a-ADDR+i*4,a-ADDR+i*4+cnt*4)));}}return f;};
  // 链式块：TAR 只写一次（wrapTest 已证明跨 1KB 继续自增），之后一路 254 字块
  const chainFrames=(write)=>{const f=[];f.push(mkTar(ADDR));
    for(let off=0;off<TOTAL;off+=B*4){const cnt=Math.min(B,(TOTAL-off)/4);
      f.push(write?mkBlockWrite(cnt,data.subarray(off,off+cnt*4)):mkBlockRead(cnt));}return f;};
  const wordsReadFrames=()=>{const f=[];for(const {a,n} of pages()){for(let i=0;i<n;i+=R){const cnt=Math.min(R,n-i);f.push(mkWordsRead(a+i*4,cnt));}}return f;};
  const blockReadFrames=()=>{const f=[];for(const {a,n} of pages()){f.push(mkTar(a));for(let i=0;i<n;i+=B){const cnt=Math.min(B,n-i);f.push(mkBlockRead(cnt));}}return f;};
  const variants={wordsWrite:wordsWriteFrames,blockWrite:blockWriteFrames,chainWrite:()=>chainFrames(true),
    wordsRead:wordsReadFrames,blockRead:blockReadFrames,chainRead:()=>chainFrames(false)};
  out.timings={};
  for(const d of [4,8,12]){
    for(const name of Object.keys(variants)){
      const runs=[];
      for(let r=0;r<3;r++){
        const frames=variants[name]();
        try{ const t0=performance.now(); await exchange(frames,d); const dt=(performance.now()-t0)/1000;
          runs.push({dt:+dt.toFixed(4),MBs:+(TOTAL/dt/1e6).toFixed(3),cmds:frames.length,cmdPerS:Math.round(frames.length/dt),bytesOut:frames.reduce((s,f)=>s+f.length,0)});
        }catch(e){ runs.push({error:e.message}); try{ await p.resync(); }catch(e2){} }
      }
      const ok=runs.filter(x=>!x.error);
      out.timings[name+'|d'+d]={mean:ok.length?{MBs:+(ok.reduce((s,x)=>s+x.MBs,0)/ok.length).toFixed(3),cmdPerS:Math.round(ok.reduce((s,x)=>s+x.cmdPerS,0)/ok.length),
          cmds:ok[0].cmds,bytesOut:ok[0].bytesOut}:null, runs};
    }
  }
  // ---------- D) 链式块写 + 逐字节校验 ----------
  try{
    await exchange(chainFrames(true),1);
    const back=new Uint8Array(await p.readMem(ADDR,TOTAL));
    let diff=-1;for(let i=0;i<TOTAL;i++){if(back[i]!==data[i]){diff=i;break;}}
    out.chainWriteVerified={ok:diff<0,firstDiff:diff};
  }catch(e){ out.chainWriteVerified={error:e.message}; }
  return out;
}finally{ try{ await p.setClock?.(1000000); }catch(e){} try{ await p.disconnect(); }catch(e){} }
`;
try {
  await c.connect();
  await c.send('Page.navigate', { url: 'http://127.0.0.1:8899/index.html?micro=' + Date.now() + '#flash' });
  for (let i = 0; i < 200; i++) { if (await c.eval('return !!window.__tools?.flash;').catch(() => false)) break; await new Promise(r => setTimeout(r, 100)); }
  await c.eval(`await __tools.probeManager.releaseOthers(null,'SRAM 传输微基准'); return true;`);
  report.result = await c.eval(EVAL);
  const r = report.result;
  console.log('transport', JSON.stringify(r.transport), 'limits', JSON.stringify(r.limits));
  for (const f of r.frameProbe) console.log('probe', JSON.stringify(f));
  console.log('wrapTest', JSON.stringify(r.wrapTest));
  for (const [k, v] of Object.entries(r.timings)) console.log(k, JSON.stringify(v.mean), JSON.stringify(v.runs.map(x => x.MBs || x.error)));
  console.log('chainWriteVerified', JSON.stringify(r.blockWriteVerified));
} catch (e) {
  report.error = e.stack;
  process.exitCode = 1;
  console.error(e.stack);
} finally {
  writeFileSync(new URL('micro.json', out), JSON.stringify(report, null, 2));
  c.close();
}
