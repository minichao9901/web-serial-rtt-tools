// Read-only planner; firmware owns the clock transition and hardware readback.
import {bandwidth,tracePlan,LEGAL_PERIODS} from './planning.js';
export const DEFAULT_SOURCES=[24000000,720000000,600000000,400000000,800000000,666666666,500000000,266666666];
export function receiverCandidate(baud,mode=1,sources=DEFAULT_SOURCES){
  let best=null;
  for(let source=0;source<8;source++)for(let sysdiv=1;sysdiv<=256;sysdiv++){
    if(mode===0&&(source!==1||sysdiv!==3))continue;
    const uartHz=Math.floor(sources[source]/sysdiv);if(uartHz>240e6||uartHz<baud*8)continue;
    for(let osr=8;osr<=30;osr+=2){const div=Math.round(uartHz/(baud*osr));if(div<1||div>65535)continue;const actualBaud=Math.floor(uartHz/(osr*div)),error=Math.abs(actualBaud-baud)/baud;
      if(!best||error<best.error)best={source,sysdiv,uartHz,osr,div,actualBaud,error,retune:false};if(best.error===0)return best;}
  }
  if(mode===2&&best?.error)for(let osr=30;osr>=8;osr-=2){const uartHz=baud*osr;if(uartHz>240e6)continue;for(let sysdiv=4;sysdiv<=16;sysdiv+=2){const pllHz=uartHz*sysdiv;if(pllHz>=400e6&&pllHz<=1000e6)return {source:4,sysdiv,uartHz,osr,div:1,actualBaud:baud,error:0,retune:true,pllHz};}}
  return best;
}
export function matchedOptions(o,sources=DEFAULT_SOURCES){
  const traceHz=o.traceHz??o.coreHz,need=bandwidth(o).requiredBaud,mode=o.receiverMode??2;
  if(!o.autoBaud){const p=tracePlan({...o,traceHz});return {...o,traceHz,receiverEstimate:receiverCandidate(p.baudRate,mode,sources)};}
  const choices=[];for(let d=1;d<=8192;d++){const baud=traceHz/d;if(baud>30e6||baud<need||baud<1)continue;const c=receiverCandidate(baud,mode,sources);if(c&&c.error<=.005)choices.push({baud,c});}
  choices.sort((a,b)=>Number(a.c.retune)-Number(b.c.retune)||a.c.error-b.c.error||a.baud-b.baud);
  if(!choices.length){
    const maxTargetBaud=traceHz/Math.max(1,Math.ceil(traceHz/30e6));
    const detail=`预计需 ${(need/1e6).toFixed(3)} Mbps；Trace ${traceHz/1e6} MHz 下目标最高 ${(maxTargetBaud/1e6).toFixed(3)} Mbps，探针上限 30 Mbps。`;
    if(need>30e6)throw Error(detail+'请由目标降低主频、增大间隔或减少事件。');
    if(need>maxTargetBaud){
      const nextPeriod=LEGAL_PERIODS.find(n=>bandwidth({...o,periodCycles:n}).requiredBaud<=maxTargetBaud);
      throw Error(detail+(nextPeriod?`可尝试 ${nextPeriod} 周期；`:'')+'请增大间隔、减少时间戳 / 事件，或由目标调整 CPU / Trace 时钟。');
    }
    throw Error(detail+'当前探针时钟无法匹配可用的目标分频，请检查接收时钟与分频配置。');
  }
  const {baud,c}=choices[0];return {...o,traceHz,baudRate:baud,allowBaudRounding:true,receiverEstimate:c};
}
export function simulate(o,sources=DEFAULT_SOURCES){
  const budget=bandwidth(o),maxCoreHz=Math.max(0,(30e6*budget.occupancy/10-budget.otherBytes)/budget.bytesPerSample*o.periodCycles);
  let matched=null,error=null;try{matched=matchedOptions({...o,seconds:1,receiverMode:2,autoBaud:true},sources);}catch(e){error=e.message;}
  const attainableMax=o.traceHz/Math.max(1,Math.ceil(o.traceHz/30e6));
  const nextPeriod=LEGAL_PERIODS.find(n=>bandwidth({...o,periodCycles:n}).requiredBaud<=attainableMax);
  return {budget,maxCoreHz,nextPeriod,matched,plan:matched?tracePlan(matched):null,error};
}
