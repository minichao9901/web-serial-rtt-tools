/** Real F103 SPI fixture load for hss-web-bench. SCOPE_ELF must match its ELF.
 * Set SCOPE_LOAD_HOOK=tools/selftest/spi-scope-load.mjs; requires the probe's
 * SPI2 wiring and a granted CDC port. SPI data integrity is checked in full.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const repo=process.env.PROBE_REPO||'E:/Share/github/akaLinkPro';
function target(run){
 const code='import sys,json;sys.path.insert(0,sys.argv[1]+"/script_test");from spi_cdc_hw import target,symbols;print(json.dumps(target(symbols(),int(sys.argv[2]),1,1)))';
 return JSON.parse(execFileSync('py',['-c',code,repo,String(+run)],{encoding:'utf8',timeout:25000,windowsHide:true}));
}
export async function setup(c){
 target(false);
 await c.eval(`
 const t=__tools;await t.spiCdc.session.connect(false);await t.spiCdc.stream.refreshPorts();await t.spiCdc.stream.connect();
 if(!t.session.isOpen)throw Error('CDC permission/open failed');await t.spiCdc.session.start({mode:0,lsb:false});
 globalThis.spiLoad={bytes:0,frames:0,gaps:0,bad:0,reversed:0,last:null,tail:new Uint8Array()};
 window.__benchLoadSnap=async()=>{const s=spiLoad;return {time:performance.now(),bytes:s.bytes,frames:s.frames,gaps:s.gaps,bad:s.bad,reversed:s.reversed,status:await __tools.spiCdc.session.status()};};
 spiLoad.off=t.session.on('data',b=>{
 const s=spiLoad;s.bytes+=b.length;const a=new Uint8Array(s.tail.length+b.length);a.set(s.tail);a.set(b,s.tail.length);let p=0;
 while(a.length-p>=64){if(a[p]!==83||a[p+1]!==80||a[p+2]!==73||a[p+3]!==67){s.bad++;p++;continue;}
 const q=new DataView(a.buffer).getUint32(p+4,true);let good=true;
 for(let i=8;i<64;i++)if(a[p+i]!==(((q+17*i)^0x5a)&255)){good=false;break;}
 if(!good){s.bad++;p++;continue;}if(s.last!==null){const gap=(q-s.last-1)>>>0;if(gap<0x80000000)s.gaps+=gap;else s.reversed++;}
 s.last=q;s.frames++;p+=64;}s.tail=a.slice(p);
 });`);
 const clocks=target(true);assert.equal(clocks.g_core_hz,72000000);assert.equal(clocks.g_spi_hz,18000000);return clocks;
}
export async function snapshot(c){
 return c.eval(`return window.__benchLoadSnap();`);
}
export async function check(c,before,window){
 const whole={before,after:await snapshot(c)};
 const after=window?.after||whole.after;before=window?.before||before;
 const MBps=(after.bytes-before.bytes)/(after.time-before.time)/1000;
 assert.ok(after.status.running,'SPI load remained active');
 const delta=Object.fromEntries(['gaps','bad','reversed'].map(k=>[k,after[k]-before[k]]));
 const probeDelta=Object.fromEntries(['dropped','fifoOverflows','dmaErrors'].map(k=>[k,(after.status[k]-before.status[k])>>>0]));
 // Stress measurements must retain losses instead of aborting before the
 // slower sampling cases can locate the contention threshold.
 return {MBps,delta,probeDelta,lossless:Object.values(delta).every(v=>v===0)&&Object.values(probeDelta).every(v=>v===0),before,after,whole};
}
export async function cleanup(c){
 await c.eval(`globalThis.spiLoad?.off?.();await __tools.spiCdc.session.disconnect();await __tools.session.close();await __tools.probeManager.releaseOthers(null,'SPI 并行测速收尾');`);
 target(false);
}
