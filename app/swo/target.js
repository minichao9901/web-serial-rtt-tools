import {CPUID_PART} from '../flash/devid.js';
import {COMMON_TARGETS,targetPort,decodeClocks} from './ports.js';
export function coreInfo(cpuid){const part=(cpuid>>>4)&4095;return {cpuid,part,core:CPUID_PART[part]||'未知内核',supportedCore:[0xc23,0xc24,0xc27].includes(part)};}
export function selectPort(cpuid,device,requested='auto'){
  const part=coreInfo(cpuid).part,p=COMMON_TARGETS.find(p=>p.part===part&&p.devices.includes(device&4095));
  if(requested!=='auto'&&(!p||p.id!==requested))throw Error('所选型号与目标 CPUID / DEV_ID 不符，请改为自动识别');
  return p||null;
}
export function targetInfo({cpuid,device=0,registers={},dwt=0,hseHz=null,coreHz=null,traceHz=null,autoClock=false,profile='auto'}){
  const identity=coreInfo(cpuid),port=selectPort(cpuid,device,profile);
  const clock=port?decodeClocks(port,registers,hseHz):{knownHz:null,knownTraceHz:null,source:'未适配的时钟树',external:false,path:'请手动提供 CPU 与 SWO 输入频率',traceRelation:'未知，不能从内核型号推断'};
  if(autoClock&&(clock.knownHz===null||clock.knownTraceHz===null))throw Error(clock.external?'目标使用外部时钟；请填写板上频率，或改用手动频率':'目标时钟尚未解析，请填写 CPU 和 SWO 输入频率');
  for(const [label,input,known]of [['核心',coreHz,clock.knownHz],['Trace',traceHz,clock.knownTraceHz]]){
    if(input!==null&&input!==undefined&&(!Number.isFinite(input)||input<=0))throw Error(label+'频率必须为正数');
    if(!autoClock&&known!==null&&input!=null&&Math.abs(input-known)>.5)throw Error(`${label}频率与 RCC 配置不符：实读 ${known/1e6} MHz`);
  }
  return {...identity,device,dwt,profile:port?.id||'unknown',name:port?.name||identity.core+'（芯片未适配）',registers,...registers,...clock,hseHz,coreHz:autoClock?clock.knownHz:coreHz??clock.knownHz,traceHz:autoClock?clock.knownTraceHz:traceHz??clock.knownTraceHz,swoPin:port?'PB3':'请查阅芯片手册',protocol:'NRZ / 8N1',frequencyBasis:clock.external?'RCC + 板级外部频率':'RCC + 内部标称频率',captureSupported:!!port&&identity.supportedCore&&!(dwt&(1<<25))};
}
// Compatibility for historical samples/tests. Live access uses the port registry.
export function stm32f1Info(o){const info=targetInfo({...o,registers:{cr:o.cr,cfgr:o.cfgr},profile:'stm32f1'});if(o.dwt&(1<<25))throw Error('该目标未实现 DWT 周期计数，不能开启 PC 采样');return info;}
export function recomputeTarget(target,hseHz){return targetInfo({...target,profile:target.profile==='unknown'?'auto':target.profile,registers:target.registers||{cr:target.cr,cfgr:target.cfgr},hseHz,coreHz:null,traceHz:null,autoClock:false});}
export async function inspectTarget(read,readStable,options={}){
  const cpuid=await read(0xe000ed00),identity=coreInfo(cpuid);let device=0;
  try{if(identity.part===0xc27)device=await read(0x5c001000);else if(identity.part===0xc23||identity.part===0xc24)device=await read(0xe0042000);}catch{device=0;}
  const port=selectPort(cpuid,device,options.profile||'auto'),registers={};
  if(port)for(const [name,offset]of Object.entries(port.clockRegisters))registers[name]=await (name==='cr'?read:readStable)(port.rcc+offset);
  const dwt=identity.supportedCore?await read(0xe0001000):0;
  return targetInfo({...options,hseHz:options.hseForProfile&&options.hseForProfile!==port?.id?null:options.hseHz,cpuid,device,registers,dwt});
}
export {targetPort};
