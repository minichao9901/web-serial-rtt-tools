/** STM32 SWO ports: board oscillator values are inputs, never inferred from CPUID. */
export const COMMON_TARGETS=[
  {id:'stm32f1',name:'STM32F103',core:'Cortex-M3',part:0xc23,devices:[0x410,0x414,0x430],maxCoreHz:72e6,rcc:0x40021000,clockRegisters:{cr:0,cfgr:4},traceRelation:'HCLK = CPU',traceDiv:1},
  {id:'stm32f4',name:'STM32F407 / F405',core:'Cortex-M4',part:0xc24,devices:[0x413],maxCoreHz:168e6,rcc:0x40023800,clockRegisters:{cr:0,pll:4,cfgr:8},traceRelation:'HCLK = CPU',traceDiv:1},
  {id:'stm32h743',name:'STM32H743 / H742 / H750 / H753',core:'Cortex-M7',part:0xc27,devices:[0x450],maxCoreHz:480e6,rcc:0x58024400,clockRegisters:{cr:0,cfgr:0x10,domain:0x18,pllSource:0x28,pllConfig:0x2c,pllDiv:0x30,pllFrac:0x34},traceRelation:'SWO 输入：HSI / CSI / HSE / PLL1_R，由 RCC SW 选择；独立于 CPU / HCLK 分频',traceDiv:null},
  {id:'stm32h7b0',name:'STM32H7B0 / H7A3 / H7B3',core:'Cortex-M7',part:0xc27,devices:[0x480],maxCoreHz:280e6,rcc:0x58024400,clockRegisters:{cr:0,cfgr:0x10,domain:0x18,pllSource:0x28,pllConfig:0x2c,pllDiv:0x30,pllFrac:0x34},traceRelation:'SWO 的 TRACEPORTCK：HSI / CSI / HSE / PLL1_R；CPU 另经 CDCPRE 分频',traceDiv:null}
];
export const targetPort=id=>COMMON_TARGETS.find(p=>p.id===id);
export const clockDivider=n=>[1,1,1,1,1,1,1,1,2,4,8,16,64,128,256,512][n&15];
const stable=(condition)=>{if(!condition)throw Error('RCC 时钟配置无效或尚未稳定，请重新识别目标');};
export function decodeClocks(port,r,hseHz=null){
  if(hseHz!==null&&(!Number.isFinite(hseHz)||hseHz<1e6||hseHz>50e6))throw Error('外部时钟须为 1–50 MHz，请按板上实际值填写');
  let hz=null,external=false,source='',path='',coreDiv=1,busDiv=1,traceHz=null,tracePath='',traceReady=true;
  if(port.id==='stm32f1'){
    const sws=(r.cfgr>>>2)&3;stable(sws<3);external=sws===1||sws===2&&!!(r.cfgr&(1<<16));
    const mul=Math.min(16,((r.cfgr>>>18)&15)+2),pre=(r.cfgr&(1<<17))?2:1;
    source=sws===0?'HSI':sws===1?'HSE':external?'HSE → PLL':'HSI/2 → PLL';
    stable(sws===2?!!(r.cr&(1<<25)):sws===1?!!(r.cr&(1<<17)):!!(r.cr&2));
    if(sws===2)stable(external?!!(r.cr&(1<<17)):!!(r.cr&2));
    hz=sws===0?8e6:sws===1?hseHz:external?hseHz===null?null:hseHz/pre*mul:4e6*mul;
    busDiv=clockDivider(r.cfgr>>>4);hz=hz===null?null:hz/busDiv;
    path=(external?`HSE ${hseHz===null?'待填写':hseHz/1e6+' MHz'}`:'HSI 8 MHz')+(sws===2?` ÷${external?pre:2} ×${mul}`:'')+` → AHB ÷${busDiv}`;
  }else if(port.id==='stm32f4'){
    const sws=(r.cfgr>>>2)&3;stable(sws<3);external=sws===1||sws===2&&!!(r.pll&(1<<22));
    stable(sws===2?!!(r.cr&(1<<25)):sws===1?!!(r.cr&(1<<17)):!!(r.cr&2));
    const input=external?hseHz:16e6,m=r.pll&63,n=(r.pll>>>6)&511,p=2*(((r.pll>>>16)&3)+1);
    if(sws===2){stable(m>=2&&n>=50);stable(external?!!(r.cr&(1<<17)):!!(r.cr&2));}
    hz=sws===0?16e6:sws===1?hseHz:input===null?null:input/m*n/p;
    busDiv=clockDivider(r.cfgr>>>4);hz=hz===null?null:hz/busDiv;
    source=sws===0?'HSI':sws===1?'HSE':external?'HSE → PLL':'HSI → PLL';
    path=(external?`HSE ${hseHz===null?'待填写':hseHz/1e6+' MHz'}`:'HSI 16 MHz')+(sws===2?` ÷M${m} ×N${n} ÷P${p}`:'')+` → AHB ÷${busDiv}`;
  }else{
    const sws=(r.cfgr>>>3)&7,pllSrc=r.pllSource&3,src=sws===3?pllSrc:sws;stable(sws<=3&&src<3);
    const hsiDiv=2**((r.cr>>>3)&3),input=src===0?64e6/hsiDiv:src===1?4e6:hseHz;
    external=src===2;stable(!!(r.cr&(src===0?4:src===1?256:1<<17)));if(sws===3)stable(!!(r.cr&(1<<25))&&!!(r.pllConfig&(1<<16)));
    const m=(r.pllSource>>>4)&63,n=(r.pllDiv&511)+1,p=((r.pllDiv>>>9)&127)+1,frac=(r.pllConfig&1)?((r.pllFrac>>>3)&8191)/8192:0;
    if(sws===3)stable(m>0);
    const vco=input===null?null:input/m*(n+frac),rdiv=((r.pllDiv>>>24)&127)+1,sys=input===null?null:sws===3?vco/p:input;
    stable((r.cfgr&7)===sws);
    traceHz=input===null?null:sws===3?vco/rdiv:input;traceReady=sws!==3||!!(r.pllConfig&(1<<18));
    tracePath=(sws===3?`PLL1 VCO ÷R${rdiv}`:src===0?`HSI 64 MHz ÷${hsiDiv}`:src===1?'CSI 4 MHz':'HSE')+' → SWO 输入'+(traceReady?'':'（PLL1 R 输出未启用）');
    coreDiv=clockDivider(r.domain>>>8);busDiv=clockDivider(r.domain);hz=sys===null?null:sys/coreDiv;
    source=(src===0?'HSI':src===1?'CSI':'HSE')+(sws===3?' → PLL1':'');
    path=(src===0?`HSI 64 MHz ÷${hsiDiv}`:src===1?'CSI 4 MHz':`HSE ${hseHz===null?'待填写':hseHz/1e6+' MHz'}`)+(sws===3?` ÷M${m} ×(${n}${frac?' + '+frac:''}) ÷P${p}`:'')+` → CPU ÷${coreDiv} → HCLK ÷${busDiv}`;
  }
  if(hz!==null&&(!Number.isFinite(hz)||hz<=0||hz>port.maxCoreHz+.5))throw Error(`${port.name} 推算核心频率超出范围，请核对外部时钟和 RCC`);
  if(!port.id.startsWith('stm32h7')){traceHz=hz;tracePath='HCLK → SWO 输入（与 CPU 相同）';}
  return {knownHz:hz,knownTraceHz:traceHz,coreHz:hz,traceHz,external,source,path,tracePath,traceReady,busDivider:busDiv,coreDivider:coreDiv,traceRelation:port.traceRelation};
}
