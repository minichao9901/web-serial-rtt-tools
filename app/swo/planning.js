export const LEGAL_PERIODS=[...new Set([...Array.from({length:16},(_,i)=>(i+1)*64),...Array.from({length:16},(_,i)=>(i+1)*1024)])].sort((a,b)=>a-b);
export function bandwidth(o){
  const samplesHz=o.coreHz/o.periodCycles,bytesPerSample=o.timestamps===false?5:9,occupancy=o.occupancy??.8;
  const exceptionEvents=o.exceptions?(o.exceptionEvents??1000):0,itmPayload=o.itm?(o.itmBytes??10000):0,extra=o.extraBytes??0;
  for(const v of [exceptionEvents,itmPayload,extra])if(!Number.isFinite(v)||v<0)throw Error('事件率与数据量必须为非负数');
  if(!Number.isFinite(occupancy)||occupancy<=0||occupancy>.95)throw Error('线路占用率须大于 0 且不超过 95%');
  const exceptionBytes=exceptionEvents*3,itmBytes=itmPayload*2; // 8-bit ITM writes: one header per payload byte, conservative input budget.
  const otherBytes=exceptionBytes+itmBytes+extra,estimatedBytes=bytesPerSample*samplesHz+otherBytes;
  return {samplesHz,bytesPerSample,exceptionBytes,itmBytes,otherBytes,estimatedBytes,occupancy,requiredBaud:estimatedBytes*10/occupancy,pcMinimumBaud:50*samplesHz};
}
export function tracePlan(o={}){
  const {coreHz,traceHz=coreHz,baudRate:requestedBaudRate,periodCycles=4096,seconds=5,itm=false,exceptions=false,timestamps=true,allowBaudRounding=false}=o;
  for(const [name,v]of Object.entries({coreHz,traceHz,baudRate:requestedBaudRate,periodCycles,seconds}))if(!Number.isFinite(v)||v<=0)throw Error(name+' 必须为正数');
  if(coreHz>1e9||traceHz>1e9||seconds>120)throw Error('CPU / Trace 频率最高 1000 MHz，时长至多 120 秒');
  const tap=periodCycles<=1024&&periodCycles%64===0?0:1,unit=tap?1024:64,n=periodCycles/unit;
  if(!Number.isInteger(n)||n<1||n>16)throw Error('采样间隔必须为 64 或 1024 周期的 1–16 倍');
  if(requestedBaudRate>30e6)throw Error('SWO 波特率最高为 30 Mbps');
  const exact=traceHz/requestedBaudRate,divider=allowBaudRounding?Math.round(exact):exact;
  if(!Number.isInteger(divider)||divider<1||divider>8192)throw Error('Trace 输入时钟必须能整除 SWO 波特率（分频 1–8192），或允许分频近似');
  const baudRate=traceHz/divider,baudError=(baudRate-requestedBaudRate)/requestedBaudRate;
  if(baudRate>30e6)throw Error('目标分频后的实际 SWO 波特率超过 30 Mbps');
  if(Math.abs(baudError)>.05)throw Error('目标 SWO 与请求波特率偏差超过 5%，请调整请求波特率');
  const budget=bandwidth({...o,coreHz,periodCycles,timestamps,itm,exceptions});
  return {coreHz,traceHz,baudRate,requestedBaudRate,baudError,periodCycles,seconds,itm:!!itm,exceptions:!!exceptions,timestamps:!!timestamps,tap,post:n-1,acpr:divider-1,...budget,wireBytes:baudRate/10};
}
export function periodForRate(coreHz,desiredRate){
  if(!Number.isFinite(desiredRate)||desiredRate<=0)throw Error('期望 PC/s 必须为正数');
  const period=LEGAL_PERIODS.find(n=>coreHz/n<=desiredRate);if(!period)throw Error('期望采样率低于 DWT 最大间隔可实现的采样率');return period;
}
export function receiverChain(c,sources){
  if(!c)return '没有可用的接收分频';
  const names=['CLK_24M','PLL0CLK0','PLL0CLK1','PLL0CLK2','PLL1CLK0','PLL1CLK1','PLL1CLK2','PLL1CLK3'];
  const div=c.systemDivider??c.sysdiv,osr=c.osr,uartDiv=c.uartDivider??c.div,root=c.retune?c.pllHz:sources?.[c.source]??c.uartHz*div;
  return `${names[c.source]} ${(root/1e6).toFixed(6)} MHz ÷ SYSCTL ${div} → UART ${(c.uartHz/1e6).toFixed(6)} MHz ÷ OSR ${osr} ÷ DIV ${uartDiv} → ${(c.actualBaud/1e6).toFixed(6)} Mbps`+(c.source<4?'；PLL1 未用于接收':c.retune?'；需调整 PLL1，最终以探针回读为准':'；使用当前 PLL1 输出');
}
