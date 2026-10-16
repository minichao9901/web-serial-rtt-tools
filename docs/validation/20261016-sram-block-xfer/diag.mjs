import { Cdp } from '../../../tools/selftest/cdp-lib.mjs';

// 探针 vendor(bulk) 接口体检：能不能打开/认领/清端点/拿到 DAP_Info 响应。
const c = new Cdp(undefined, 120000);
await c.connect();
const res = await c.eval(`return (async()=>{
  const log=[];
  const devs=await navigator.usb.getDevices();
  log.push('devices='+devs.length);
  for (const d of devs){
    const tag=d.vendorId.toString(16)+':'+d.productId.toString(16);
    if(d.opened) log.push(tag+' already opened');
    try{ if(!d.opened) await d.open(); }catch(e){ log.push(tag+' open ERR '+e.message); continue; }
    log.push(tag+' opened ✓');
    try{ if(!d.configuration) await d.selectConfiguration(1); }catch(e){ log.push('selectConfiguration ERR '+e.message); }
    const iface=(d.configuration?.interfaces||[]).find(i=>i.alternate.interfaceClass===0xff && (i.alternate.endpoints||[]).length===2);
    if(!iface){ log.push('没有 class=0xFF 且 2 端点的接口'); }
    else {
      const n=iface.interfaceNumber;
      try{ await d.claimInterface(n); log.push('claim '+n+' ✓'); }catch(e){ log.push('claim '+n+' ERR '+e.message); }
      const eps=iface.alternate.endpoints;
      const epIn=eps.find(e=>e.direction==='in')?.endpointNumber, epOut=eps.find(e=>e.direction==='out')?.endpointNumber;
      log.push('epIn='+epIn+' epOut='+epOut);
      for(const [dir,ep] of [['in',epIn],['out',epOut]]){
        try{ await d.clearHalt(dir,ep); log.push('clearHalt '+dir+' ✓'); }catch(e){ log.push('clearHalt '+dir+' ERR '+e.message); }
      }
      // 试探一条 DAP_Info(id=0)：不 pad，短帧
      const race=(p,ms)=>Promise.race([p,new Promise(r=>setTimeout(()=>r({timeout:true}),ms))]);
      try{
        await race(d.transferOut(epOut,new Uint8Array([0,0])),800);
        const r=await race(d.transferIn(epIn,1024),800);
        if(r.timeout) log.push('DAP_Info 超时（IN 无响应）');
        else { const b=new Uint8Array(r.data.buffer,r.data.byteOffset,r.data.byteLength); log.push('DAP_Info resp='+Array.from(b.slice(0,8)).join(',')); }
      }catch(e){ log.push('DAP_Info ERR '+e.message); }
      // 再吃掉几个陈旧包
      for(let i=0;i<3;i++){ const r=await race(d.transferIn(epIn,1024),300); if(r.timeout)break; const b=new Uint8Array(r.data.buffer,r.data.byteOffset,r.data.byteLength); log.push('stale['+i+']='+Array.from(b.slice(0,6)).join(',')); }
      try{ await d.releaseInterface(n); log.push('release ✓'); }catch(e){ log.push('release ERR '+e.message); }
    }
    try{ await d.close(); log.push('closed'); }catch(e){ log.push('close ERR '+e.message); }
  }
  return log;
})()`);
console.log(res.join('\n'));
c.close();
