import assert from 'node:assert/strict';
import { captureFault, decodeArm, decodeRiscv, faultData } from '../../app/dbg/fault.js';
import { ARM_ARCH } from '../../app/dbg/thumb.js';
import { backtrace } from '../../app/dbg/backtrace.js';
import { WebUsbDapProbe } from '../../app/rtt/dap-webusb.js';
import { DiagnosticHistory, makeReport, reportMarkdown } from '../../app/diagnostics/report.js';
import { scopeQuality, rttQuality } from '../../app/diagnostics/quality.js';

const word=v=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,v,true);return b;};
function arm({lr=0xfffffffd,cfsr=0,pc=0x08000100,extended=false,failAt=null}={}){
  const memory=new Map([[0xe000edf0,1<<17],[0xe000ed00,0x410fc231],[0xe000ed08,0x08000000],
    [0xe000ed28,cfsr],[0xe000ed2c,1<<30],[0x0800000c,pc|1],[0xe000ed34,0xdeadbeef],[0xe000ed38,0xfeed0000]]);
  const regs={15:pc,14:lr,16:0x01000003,13:0x20000100,17:0x20000100,18:0x20000200};
  const base=regs[lr&4?18:17]+(extended?72:0);
  [1,2,3,4,12,0x08000201,0x08000180,0x01000200].forEach((v,i)=>memory.set(base+i*4,v));
  const accesses=[];
  const s={arch:ARM_ARCH,connected:true,halted:true,sym:null,
    halt(){throw Error('must not halt');},reset(){throw Error('must not reset');},readReg(){throw Error('unsafe readReg');},memRead(){throw Error('unsafe memRead');},
    probe:{readMemDiagnostic:async(a,n)=>{
      accesses.push([a,n]);if(a===failAt)throw Error('injected transport fault');
      const out=new Uint8Array(n); for(let i=0;i<n;i+=4)out.set(word(memory.get(a+i)||0),i);return out;
    },regReadDiagnostic:async sel=>regs[sel]??0}};
  return {s,memory,regs,accesses,base};
}
{
  const {s,accesses,base}=arm({cfsr:(1<<9)|(1<<15)}), r=await captureFault(s);
  assert.equal(r.error,null);assert.equal(r.frame.stack,'PSP');assert.equal(r.frame.validated,true);
  assert.equal(r.frame.pc,0x08000180);assert.equal(r.frame.sp,base+36);assert.equal(r.frames.length,1);
  assert.ok(r.findings.some(x=>/有效 BFAR/.test(x.text)));assert.ok(!r.findings.some(x=>/有效 MMFAR/.test(x.text)));
  assert.ok(accesses.length<25);assert.equal(s.halted,true);
}
{
  const {s,base,memory}=arm({lr:0xffffffed,extended:true});memory.set(0xe000ed00,0x410fc241); const r=await captureFault(s);
  assert.equal(r.frame.extended,true);assert.equal(r.frame.sp,base+36);
}
{
  const {s,accesses}=arm({cfsr:1<<12}), r=await captureFault(s);
  assert.equal(r.frame,null);assert.ok(!accesses.some(([a])=>a>=0x20000000 && a<0x40000000));
  assert.match(r.findings.map(x=>x.text).join(),/停止恢复硬件异常帧/);
}
{
  const {s,regs,base}=arm(); regs[15]+=4;
  const r=await captureFault(s); assert.equal(r.frame.validated,false);assert.equal(r.frames.length,0);
  assert.equal(r.frame.base,base);assert.match(r.findings.map(x=>x.text).join(),/候选/);
}
{
  const {s,memory}=arm();memory.set(0x2000021c,0); const r=await captureFault(s);
  assert.equal(r.frame,null);assert.match(r.findings.map(x=>x.text).join(),/校验/);
}
{
  const {s,accesses}=arm({failAt:0xe000ed28}), r=await captureFault(s);
  assert.match(r.error,/injected/);assert.deepEqual(accesses.at(-1),[0xe000ed28,4]);assert.equal(r.raw.BFAR,undefined);
}
{
  // Handler has pushed r4/LR, so current LR is a normal function return address.
  // EHABI must restore its saved EXC_RETURN before selecting the hardware stack.
  const {s,memory,regs}=arm({lr:0x08000131,pc:0x08000104,cfsr:1<<9});
  const tab=0x08000800, code=0x08000100, data=new Uint8Array(16),dv=new DataView(data.buffer);
  dv.setUint32(0,(code-tab)&0x7fffffff,true);dv.setUint32(4,0x80a8b0b0,true);
  dv.setUint32(8,(code+0x100-tab-8)&0x7fffffff,true);dv.setUint32(12,1,true);
  s.sym={elf:{section:n=>n==='.ARM.exidx'?{addr:tab}:null,data:()=>data,
    sections:()=>[{addr:code,size:0x400,flags:6},{addr:0x20000000,size:0x1000,flags:3}]},
    at:()=>({file:'fault.c',line:10}),nameOf:()=> 'function'};
  memory.set(regs[13],4);memory.set(regs[13]+4,0xfffffff9);
  [1,2,3,4,12,0x08000301,0x08000220,0x01000000].forEach((v,i)=>memory.set(regs[13]+8+i*4,v));
  const r=await captureFault(s);assert.equal(r.error,null);assert.equal(r.frame.validated,true);assert.equal(r.frame.pc,0x08000220);
  assert.equal(r.frame.stack,'MSP');assert.equal(r.frame.unwound,true);assert.equal(r.frames[0].sp,regs[13]+40);assert.match(r.unwindReason,/CANTUNWIND/);
  assert.deepEqual(r.frames[0].known,[0,1,2,3,12,13,14,15]);
}
{
  const {s,memory,accesses}=arm();memory.set(0xe000ed00,0x410fc201);const r=await captureFault(s);
  assert.equal(r.raw.CFSR,undefined);assert.equal(accesses.length,2);assert.match(r.findings[0].text,/不属于/);
}
{
  const {s,memory,accesses}=arm();memory.set(0xe000edf0,0);const r=await captureFault(s);
  assert.match(r.error,/目标已运行/);assert.equal(accesses.length,1);
}
{
  const reads=[];const s={connected:true,halted:true,arch:{name:'riscv'},_pollHalted:async()=>true,
    readReg(){throw Error('unsafe would halt');},dm:{readReg:async n=>{reads.push(n);return ({0x7b1:0x80001234,0x342:0x80000007,0x341:0x80001200,0x343:0})[n]??0;}}};
  const r=await captureFault(s);assert.equal(r.error,null);assert.ok(r.findings.some(x=>/M 定时器/.test(x.text)));
  assert.ok(!reads.some(n=>n>=0xe0000000));assert.equal(r.frame,null);
  s._pollHalted=async()=>false;reads.length=0;const bad=await captureFault(s);assert.match(bad.error,/未暂停/);assert.equal(reads.length,0);
}
{
  const regs=new Array(16).fill(0);regs[13]=0x20000100;regs[14]=0x08000001;regs[15]=0x08000100;
  const trace=await backtrace({arch:ARM_ARCH,halted:true,sym:null,refresh(){throw Error('unsafe refresh');},readReg(){throw Error('unsafe register');}},
    {initial:{regs,known:[0,1,2,3,12,13,14,15]}});
  assert.equal(trace.frames.length,1);assert.equal(trace.frames[0].pc,regs[15]);
}
assert.ok(decodeArm({CPUID:0x410fc231,CFSR:1<<10,HFSR:0}).some(x=>/不能当成准确/.test(x.text)));
assert.ok(decodeRiscv({mcause:2,mtval:0x13}).some(x=>/指令位/.test(x.text)));
assert.ok(!faultData({arch:'arm',at:'test',raw:{CFSR:0,BFAR:0xdead},findings:[],frames:[]}).metrics.find(x=>x.name==='BFAR').note.includes('有效地址'));
{
  const poisoned={_faulted:true,_healIfFaulted(){throw Error('must not heal');}};
  await assert.rejects(()=>WebUsbDapProbe.prototype.readMemDiagnostic.call(poisoned,0,4),/未重新初始化/);
  await assert.rejects(()=>WebUsbDapProbe.prototype.regReadDiagnostic.call(poisoned,15),/未重新初始化/);
  const raced={_withLock(fn){this._faulted=true;return fn();},_readMemLocked(){throw Error('must not read after pending fault');}};
  await assert.rejects(()=>WebUsbDapProbe.prototype.readMemDiagnostic.call(raced,0,4),/未重新初始化/);
  const writes=[];const healthy={_withLock:fn=>fn(),_writeMemLocked:async(a,b)=>writes.push([a,...b]),_readMemLocked:async a=>word(a===0xe000edf0 ? (1<<17)|(1<<16) : 0x08000100)};
  assert.equal(await WebUsbDapProbe.prototype.regReadDiagnostic.call(healthy,15),0x08000100);
  assert.deepEqual(writes,[[0xe000edf4,15,0,0,0]]);
  let demcr=0x01000001;const bitWrites=[];
  const control={_withLock:fn=>fn(),_readMemLocked:async()=>word(demcr),_writeMemLocked:async(a,b)=>{
    assert.equal(a,0xe000edfc);demcr=new DataView(b.buffer,b.byteOffset,4).getUint32(0,true);bitWrites.push(demcr);
  }};
  const original=await WebUsbDapProbe.prototype.setHardFaultCatch.call(control,true);
  assert.equal(original,false);assert.equal(demcr,0x01000401);
  await WebUsbDapProbe.prototype.setHardFaultCatch.call(control,original);assert.equal(demcr,0x01000001);assert.equal(bitWrites.length,2);
}
{
  const s={state:'采集中',running:true,_metricsAt:10000,probeMetrics:{produced:90,skipped:10,usb:0,errors:0,yields:4},
    lost:2,decodeErr:0,stream:{resyncs:0},store:{count:90,overrun:3,rate:()=>9000},_qualityConfig:{请求周期_us:100}};
  const metric=(r,name)=>r.metrics.find(m=>m.name===name);
  let r=scopeQuality(s,10000);assert.equal(metric(r,'跳拍率').value,10);assert.equal(metric(r,'包序号缺口').unit,'包');assert.equal(metric(r,'网页缓冲溢出').unit,'样本');
  s.probeMetrics.usb=5;r=scopeQuality(s,10000);assert.equal(metric(r,'跳拍率').value,null);
  s.probeMetrics.usb=0;s._qualityCounterRolled=true;assert.equal(metric(scopeQuality(s,10000),'跳拍率').value,null);
  r=scopeQuality(s,20000);assert.equal(metric(r,'探针跳拍').value,null);assert.ok(r.findings.some(x=>x.confidence==='证据不足'));
  s.running=false;assert.equal(metric(scopeQuality(s,20000),'探针跳拍').value,10);
  s._qualityReplay=true;assert.equal(metric(scopeQuality(s,20000),'探针跳拍').value,null);
  s._qualityReplay=false;s.running=true;s._statAt=20000;s._qualityStat={usbErr:4,swdErr:2};r=scopeQuality(s,20000);
  assert.equal(metric(r,'USB 包缓冲丢样').value,4);assert.equal(metric(r,'探针跳拍').value,null);
}
{
  const v={s:{isOpen:true,opts:{owner:'rtt'}},rxc:{total:100,rate:()=>50},rx:{rawBytes:20,truncated:true},suppressed:true,
    rec:{backlog:()=>5*1024*1024,written:10},$:()=>null};
  const r=rttQuality(v,null,20000);assert.ok(r.findings.some(x=>/误码率/.test(x.text)));
  assert.equal(r.metrics.find(x=>x.name==='目标读取失败').value,null);assert.ok(r.findings.some(x=>/历史/.test(x.text)));
  const dev={connected:true,device:{}}, bridge={dev,_statusAt:20000,_engineGen:1,last:{running:true,cbAddr:0x20000000,moved:10,rdErr:3,wrErr:0,dapYield:0}};
  bridge._statusSource={dev,device:dev.device,generation:1};
  assert.equal(rttQuality(v,bridge,20000).metrics.find(x=>x.name==='目标读取失败').value,3);
  bridge.dev={connected:true,device:{}};assert.equal(rttQuality(v,bridge,20000).metrics.find(x=>x.name==='目标读取失败').value,null);
}
{
  const history=new DiagnosticHistory(128);for(let i=0;i<200;i++)history.note('test',i);
  assert.equal(history.events.length,128);assert.equal(history.omitted,72);
  const data={settings:{variable:'x|y'},metrics:[{name:'读错',value:null,unit:'次',source:'探针',note:''}],findings:[],notes:[]};
  const r=makeReport('test','测试报告',data,history);data.metrics[0].value=99;assert.equal(r.metrics[0].value,null);
  const md=reportMarkdown(r);assert.match(md,/未知／不可用/);assert.match(md,/更早的 72 条/);assert.ok(!md.includes('x|y'));
}
console.log('diagnostics: ARM basic/FP/invalid stack, RV traps, read-only failures, seeded unwind, counter units/freshness and bounded reports OK');
