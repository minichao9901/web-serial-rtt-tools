/** STM32F1 target profile. External oscillator frequency is board data, not a register. */
export function stm32f1Info({cpuid,device,cfgr,cr,dwt=0,hseHz=null,coreHz=null,autoClock=false}){
  if(((cpuid>>>4)&4095)!==0xc23)throw Error('当前 SWO 目标配置支持 STM32F103 Cortex-M3；此内核尚未适配');
  if(![0x410,0x414,0x430].includes(device&4095))throw Error('目标不是已支持的 STM32F103/F1 系列');
  if(dwt&(1<<25))throw Error('该目标未实现 DWT 周期计数，不能开启 PC 采样');
  const sws=(cfgr>>>2)&3,hpre=(cfgr>>>4)&15,divs=[1,1,1,1,1,1,1,1,2,4,8,16,64,128,256,512];
  if(sws===3||((sws===0||sws===2&&!(cfgr&(1<<16)))&&(!(cr&1)||!(cr&2)))||(sws===1&&!(cr&(1<<17)))||(sws===2&&!(cr&(1<<25))))throw Error('RCC 时钟读回无效或尚未稳定，请重新识别目标');
  if(hseHz!==null&&(!Number.isFinite(hseHz)||hseHz<1000000||hseHz>25000000))throw Error('HSE 输入频率须为 1–25 MHz');
  const external=sws===1||sws===2&&!!(cfgr&(1<<16));
  const mul=Math.min(16,((cfgr>>>18)&15)+2),source=sws===0?'HSI':sws===1?'HSE':external?'HSE → PLL':'HSI/2 → PLL';
  let knownHz=sws===0?8000000:sws===1?hseHz:external?hseHz===null?null:hseHz/((cfgr&(1<<17))?2:1)*mul:4000000*mul;
  if(knownHz!==null)knownHz/=divs[hpre];
  if(autoClock&&knownHz===null)throw Error('目标使用外部 HSE；请填写板上 HSE 频率，或关闭自动主频并手动填写核心频率');
  const frequency=autoClock?knownHz:(coreHz??knownHz);
  if(frequency!=null&&(!Number.isFinite(frequency)||frequency<1000000||frequency>72000000))throw Error('F103 核心频率须为 1–72 MHz');
  if(!autoClock&&knownHz!==null&&coreHz!=null&&knownHz!==coreHz)throw Error('核心频率与 RCC 配置不符：实读 '+knownHz/1e6+' MHz');
  return {profile:'stm32f1',name:'STM32F1 (DEV 0x'+(device&4095).toString(16)+')',core:'Cortex-M3',cpuid,device,cfgr,cr,dwt,source,external,hseHz,knownHz,coreHz:frequency,frequencyBasis:external?(hseHz===null?'manual-core':'RCC + user HSE'):'RCC + nominal HSI',swoPin:'PB3',protocol:'NRZ / 8N1'};
}
