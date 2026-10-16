import { Cdp } from '../../../tools/selftest/cdp-lib.mjs';

// 抢救探针：open → USB 端口复位（等价拔插数据线）→ close。超大帧/挂起传输把探针惹毛时用。
const c = new Cdp(undefined, 120000);
await c.connect();
const res = await c.eval(`return (async()=>{
  const log=[];
  for (const d of await navigator.usb.getDevices()){
    const tag = d.vendorId.toString(16)+':'+d.productId.toString(16)+' '+(d.productName||'');
    try{ if(!d.opened) await d.open(); await d.reset(); log.push(tag+' → open+reset ✓'); }
    catch(e){ log.push(tag+' → ERR '+e.message); }
    finally{ try{ await d.close(); }catch(e){} }
  }
  return log.length?log:['没有已授权设备'];
})()`);
console.log(res);
c.close();
