import assert from 'node:assert/strict';
import {targetPort,decodeClocks} from '../../app/swo/ports.js';
import {coreInfo,targetInfo,inspectTarget} from '../../app/swo/target.js';
import {tracePlan,bandwidth,periodForRate} from '../../app/swo/planning.js';
import {simulate} from '../../app/swo/matching.js';
import {SwoCapture} from '../../app/swo/capture.js';
import {WebUsbDapProbe} from '../../app/rtt/dap-webusb.js';
const f4={cr:0x03020003,cfgr:0xa,pll:8|(336<<6)|(1<<22)};
const h7={cr:0x03020005,cfgr:0x1b,domain:8,pllSource:2|(4<<4),pllConfig:(1<<16)|(1<<18),pllDiv:479|(1<<9)|(5<<24),pllFrac:0};
assert.equal(coreInfo(0x410fc241).core,'Cortex-M4');assert.equal(coreInfo(0x410fc271).core,'Cortex-M7');
const c4=decodeClocks(targetPort('stm32f4'),f4,8e6);assert.equal(c4.coreHz,168e6);assert.equal(c4.traceHz,168e6);
const c7=decodeClocks(targetPort('stm32h743'),h7,8e6);assert.equal(c7.coreHz,480e6);assert.equal(c7.traceHz,160e6);assert.equal(c7.busDivider,2);
assert.equal(decodeClocks(targetPort('stm32h743'),{...h7,domain:8|(8<<8)},8e6).coreHz,240e6);
assert.equal(decodeClocks(targetPort('stm32h743'),{...h7,domain:8|(8<<8)},8e6).traceHz,160e6,'SWO clock does not follow core / AHB divisors');
const frac=decodeClocks(targetPort('stm32h743'),{...h7,pllDiv:399|(1<<9)|(5<<24),pllConfig:h7.pllConfig|1,pllFrac:4096<<3},8e6);assert.equal(frac.coreHz,400500000);assert.equal(frac.traceHz,133500000);
const b0={...h7,pllSource:2|(5<<4),pllDiv:111|(1<<9)|(3<<24)};
assert.equal(decodeClocks(targetPort('stm32h7b0'),b0,25e6).coreHz,280e6);assert.equal(decodeClocks(targetPort('stm32h7b0'),b0,25e6).traceHz,140e6);
assert.equal(decodeClocks(targetPort('stm32h743'),h7).knownHz,null);assert.equal(decodeClocks(targetPort('stm32h743'),{...h7,pllConfig:1<<16},8e6).traceReady,false);
assert.throws(()=>decodeClocks(targetPort('stm32h743'),{...h7,cfgr:0x18},8e6),/尚未稳定/);
assert.throws(()=>targetInfo({cpuid:0x410fc241,device:0x413,registers:f4,hseHz:8e6,traceHz:84e6}),/Trace频率与 RCC/);
assert.throws(()=>targetInfo({cpuid:0x410fc241,device:0x413,registers:f4,profile:'stm32f1'}),/所选型号/);
let reads=[];const unknown=await inspectTarget(async a=>{reads.push(a);return a===0xe000ed00?0x410fc241:0;},()=>assert.fail('unknown chips must not use STM32 RCC'),{});assert.equal(unknown.core,'Cortex-M4');assert.equal(unknown.captureSupported,false);
assert.deepEqual(reads,[0xe000ed00,0xe0042000,0xe0001000]);
const inaccessible=await inspectTarget(async a=>{if(a===0xe0042000)throw Error('not STM32');return a===0xe000ed00?0x410fc241:0;},()=>assert.fail('unknown chips must not use RCC'),{});assert.equal(inaccessible.captureSupported,false);assert.equal(inaccessible.core,'Cortex-M4');
const p=tracePlan({coreHz:480e6,traceHz:160e6,baudRate:20e6,periodCycles:4096});assert.equal(p.acpr,7);assert.equal(p.samplesHz,117187.5);
assert.throws(()=>tracePlan({coreHz:31e6,traceHz:31e6,baudRate:30e6,periodCycles:512,allowBaudRounding:true}),/实际 SWO 波特率超过/);
assert.equal(periodForRate(72e6,100000),768);
assert.equal(bandwidth({coreHz:72e6,periodCycles:512,timestamps:false}).estimatedBytes,703125);
assert.equal(bandwidth({coreHz:72e6,periodCycles:512,timestamps:true,exceptions:true,exceptionEvents:200,itm:true,itmBytes:1000}).otherBytes,2600);
assert.equal(simulate({coreHz:480e6,traceHz:160e6,periodCycles:4096,timestamps:true}).matched.baudRate,16e6);

// Simulate physically gated H7 registers. Restore must finish before closing debug gates.
const original={authorized:WebUsbDapProbe.authorized,open:WebUsbDapProbe.open};
try{for(const id of ['stm32f4','stm32h743','stm32h7b0']){
  const h=id.startsWith('stm32h7'),port=targetPort(id),registers=id==='stm32f4'?f4:id==='stm32h743'?h7:b0,memory=new Map(),writes=[];
  memory.set(0xe000ed00,h?0x410fc271:0x410fc241);memory.set(h?0x5c001000:0xe0042000,id==='stm32f4'?0x413:id==='stm32h743'?0x450:0x480);
  for(const [name,offset]of Object.entries(port.clockRegisters))memory.set(port.rcc+offset,registers[name]);
  for(const a of [0xe000edfc,0xe0001000,0xe0001004,0xe0000e80,0xe0000e00,0xe0000e40,0xe0040010,0xe00400f0,0xe0040304,0xe0042004,0x5c001004,0x5c003010,0x5c0030f0,0x5c004000,0x580244e0,0x40023830])memory.set(a,0);
  const gpio=h?0x58020400:0x40020400;for(const off of [0,4,8,12,32])memory.set(gpio+off,0xa5a5a5a5);
  const before=new Map(memory);let failed=false,closed=0;
  const read=async a=>{if(h&&a>=0x5c003000&&a<0x5c005000&&!(memory.get(0x5c001004)&0x400000))throw Error('debug gate closed');const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,memory.get(a)||0,true);return b;};
  const probe={device:{serialNumber:'test'},isHalted:async()=>false,readMemDiagnostic:read,writeMem:async(a,b)=>{if(failed&&a===(h?0x5c003010:0xe0040010))throw Error('injected restore failure');writes.push(a);memory.set(a,new DataView(b.buffer,b.byteOffset,4).getUint32(0,true));},disconnect:async()=>closed++};
  WebUsbDapProbe.authorized=async()=>[{}];WebUsbDapProbe.open=async()=>probe;
  const capture=new SwoCapture();capture.serial.open=async()=>capture.serial.isOpen=true;capture.serial.close=async()=>capture.serial.isOpen=false;
  await capture.start({autoClock:true,hseHz:id==='stm32h7b0'?25e6:8e6,baudRate:h?20e6:14e6,periodCycles:4096,seconds:1,port:{}});
  assert.equal(capture.running,true);assert.equal(capture.metadata.plan.traceHz,id==='stm32h7b0'?140e6:id==='stm32h743'?160e6:168e6);
  assert.ok(!writes.some(a=>Object.values(port.clockRegisters).some(off=>a===port.rcc+off)),'target CPU/PLL configuration is read-only');
  assert.equal(writes.includes(0x5c004000),id==='stm32h743','H7B0 has no SWO funnel');
  // A target may change unrelated GPIO bits while recording; release only owns PB3.
  memory.set(gpio,memory.get(gpio)^1);failed=true;await assert.rejects(capture.stop(),/恢复失败/);assert.equal(closed,0);if(h)assert.equal(memory.get(0x5c001004)&0x700000,0x700000);
  failed=false;await capture.stop();assert.equal(capture.metadata.restored,true);assert.equal(closed,1);assert.equal(memory.get(gpio),(before.get(gpio)^1)>>>0);
  for(const [a,v]of before)if(a!==gpio)assert.equal(memory.get(a),v,`${id} restore ${a.toString(16)}`);
}}
finally{Object.assign(WebUsbDapProbe,original);}
console.log('SWO ports: F407/H743/H7B0 clocks, fractional PLL, independent PLL1_R, unknown chips, bandwidth and gated restore/retry PASS');
