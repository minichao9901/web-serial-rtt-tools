// Read-only planner; firmware owns the clock transition and hardware readback.
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
  const bytes=(o.timestamps===false?5:9)*o.coreHz/o.periodCycles,need=bytes*10/.8;
  if(!o.autoBaud){const baud=o.coreHz/Math.max(1,Math.round(o.coreHz/o.baudRate));return {...o,receiverEstimate:receiverCandidate(baud,o.receiverMode,sources)};}
  const choices=[];for(let d=1;d<=8192;d++){const baud=o.coreHz/d;if(baud>30e6||baud<need||baud<1)continue;const c=receiverCandidate(baud,o.receiverMode,sources);if(c&&c.error<=.005)choices.push({baud,c});}
  choices.sort((a,b)=>Number(a.c.retune)-Number(b.c.retune)||a.c.error-b.c.error||a.baud-b.baud);
  if(!choices.length)throw Error(`预计需 ${(need/1e6).toFixed(3)} Mbps（留 20% 余量），请降低目标主频、增大间隔或关闭时间戳`);
  const {baud,c}=choices[0];return {...o,baudRate:baud,allowBaudRounding:true,receiverEstimate:c};
}
