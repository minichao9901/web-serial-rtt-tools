import {WebUsbDapProbe} from './shared/rtt/dap-webusb.js';
import {ProbeBus} from './shared/core/probe-bus.js';
import {identifyTarget,completeClocks} from './clock.js';
import {Breakpoints} from './breakpoints.js';
import {withCleanup} from './operation.js';
import {decodeFpCtrl,encodeComparator,canBreak,compAddr} from './shared/dbg/bp.js';
import {inspectF103,stopF103,configureF103,restoreF103} from './target-f103.js';
import {traceCapabilities} from './trace-options.js';
import {waitMs as sleep} from './shared/core/pace.js';

const ETM=0xe0041000,FUNNEL=0x5c013000,ETF=0x5c014000,TPIU=0x5c015000;
const hex=n=>'0x'+(n>>>0).toString(16).padStart(8,'0');

export class EtmTarget {
  constructor(log=()=>{},{host=null}={}){this.probe=null;this.log=log;this.embedded=!!host;this.canRelease=()=>true;this.Probe=host?.probeType||WebUsbDapProbe;this.bus=host?{requestRelease:async()=>{},close:()=>{}}:new ProbeBus('etm');this.bus.onRelease=()=>{if(!this.canRelease())throw Error('ETM 正在操作目标或采集，请先停止后再切换探针');return this.disconnect();};this.config=null;this.saved=new Map();this.locks=new Map();this.hseHz=null;this.osLocked=null;this.info=null;this.profile='auto';this.breakpoints=new Breakpoints(this);}
  async connect(){
    if(this.probe)return this.inspect();
    await this.bus.requestRelease({why:'ETM 页面连接'});
    const devices=(await this.Probe.authorized()).filter(d=>d.vendorId===0x0d28);
    if(!this.Probe.supported())throw Error('请用支持 WebUSB 的桌面 Chrome / Edge 打开页面');
    let device=devices.length===1?devices[0]:null;
    if(!device){let timer;try{device=await Promise.race([navigator.usb.requestDevice({filters:[{vendorId:0x0d28}]}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('浏览器仍在等待 USB 设备选择；请选中探针后重新连接')),30000);})]);}finally{clearTimeout(timer);}}
    this.probe=await this.Probe.open(device,{clockKhz:1000});
    this.debugFault=false;this.probe.onLog=this.log;
    try{return await this.inspect();}catch(e){try{await this.disconnect();}catch(cleanup){this.log('连接失败后的清理错误（保留首次错误）：'+cleanup.message);}throw e;}
  }
  async disconnect(){const probe=this.probe;if(!probe)return;return withCleanup(async()=>{await this.clearEntryBreak();if(this.breakpoints.items.some(b=>b.lease)){const running=!(await this.isHalted());await this.halt();await this.breakpoints.suspend();if(running)await this.probe.run();}await this.restore();},async()=>{try{await probe.disconnect();}finally{this.probe=null;this.config=null;}},e=>this.log('USB 断开失败：'+e.message));}
  get transportFault(){return !!(this.debugFault||this.probe?._faulted||this.probe?._recovering);}
  assertTransport(){if(this.transportFault)throw Error('SWD 已故障，已保留现场；请点击“恢复调试口”后重试');}
  accessError(e,operation,address){if(e.ack===4||this.probe?._faulted)this.debugFault=true;const wrapped=new Error(`${operation} ${hex(address)}：${e.message}`,{cause:e});wrapped.ack=e.ack;return wrapped;}
  async read(addr){if(!this.probe)throw Error('请先连接探针');this.assertTransport();try{const bytes=await this.probe.readMemDiagnostic(addr>>>0,4);return new DataView(bytes.buffer,bytes.byteOffset,4).getUint32(0,true);}catch(e){throw this.accessError(e,'读寄存器',addr);}}
  async write(addr,value,verify=true){this.assertTransport();if(!this.probe?.writeMemDiagnostic)throw Error(this.embedded?'主页面探针驱动缺少安全控制写接口，请先刷新整个主页面；仍缺少时更新完整 ETM 桥包':'探针驱动缺少安全控制写接口，请更新完整 ETM 桥包后重试');const bytes=new Uint8Array(4);new DataView(bytes.buffer).setUint32(0,value>>>0,true);try{await this.probe.writeMemDiagnostic(addr>>>0,bytes);}catch(e){throw this.accessError(e,'写寄存器',addr);}if(verify&&await this.read(addr)!==(value>>>0))throw Error(`寄存器回读不匹配 ${hex(addr)}`);}
  async recoverDebugPort(){
    if(!this.probe?.recoverDebugPort)throw Error('当前连接不支持调试口恢复，请重新连接探针');
    this.log('正在恢复 SWD 调试口；不复位、不自动继续 CPU');
    await this.probe.recoverDebugPort();this.debugFault=false;await this.halt();
    await this.clearEntryBreak();await this.restore();
    const info=await this.inspect();this.log('调试口恢复完成，目标保持暂停；原采集未自动重试');return info;
  }
  async set(addr,mask,value,verify=true){
    const current=await this.read(addr),saved=this.saved.get(addr);
    if(saved){saved.before=(saved.before|(current&mask&~saved.mask))>>>0;saved.mask=(saved.mask|mask)>>>0;}
    else this.saved.set(addr,{before:current&mask,mask:mask>>>0});
    const next=((current&~mask)|(value&mask))>>>0;
    await this.write(addr,next,false);
    if(verify&&((await this.read(addr)^next)&mask)!==0)throw Error(`配置回读不匹配 ${hex(addr)}`);
  }
  async managed(addr,value,verify=true){return this.set(addr,0xffffffff,value,verify);}
  async unlock(base){if(!this.locks.has(base))this.locks.set(base,!!((await this.read(base+0xfb4))&2));await this.write(base+0xfb0,0xc5acce55,false);if((await this.read(base+0xfb4))&2)throw Error('CoreSight 解锁失败');}
  async stopFifo(){
    // Arm DDI0461B: flush/stop while enabled, wait Ready, then clear CTL.
    // The downstream TPIU must accept the FIFO's remaining trace.
    if((await this.read(ETF+0x20))&1){
      await this.managed(TPIU+0x304,3);
      await this.managed(ETF+0x304,(await this.read(ETF+0x304))|0x1000);
      await this.managed(ETF+0x304,(await this.read(ETF+0x304))|0x40,false);
      await this.wait(ETF+0x304,0x40,0);await this.wait(ETF+0xc,4,4);
    }
    await this.managed(ETF+0x20,0);await this.wait(ETF+0xc,4,4);
  }
  async stopTrace(){
    await this.halt();await this.inspect();
    if(!this.info.traceSupported)return;
    if(this.info.profile==='stm32f103ze')return stopF103(this);
    for(const base of [ETM,FUNNEL,ETF,TPIU])await this.unlock(base);
    if(this.osLocked===null)this.osLocked=!!((await this.read(ETM+0x314))&2);
    await this.write(ETM+0x310,0,false);
    await this.managed(ETM+4,0);await this.wait(ETM+0xc,1,1);
    await this.stopFifo();
    if(!(await this.read(TPIU+0x300)&2)){
      await this.managed(TPIU+0x304,(await this.read(TPIU+0x304))|0x1040,false);
      await this.wait(TPIU+0x300,2,2);
    }
  }
  async restore(){
    if(!this.saved.size)return;
    if(this.traceFamily==='f103')return restoreF103(this);
    this.assertTransport();
    const running=!(await this.isHalted());await this.halt();
    await this.write(0x5c001004,(await this.read(0x5c001004))|0x700000);
    for(const base of this.locks.keys())await this.write(base+0xfb0,0xc5acce55,false);
    const restoreOne=async(addr)=>{const s=this.saved.get(addr);if(s){await this.write(addr,((await this.read(addr)&~s.mask)|(s.before&s.mask))>>>0);}};
    if(this.saved.has(ETM+4)){await this.write(ETM+0x310,0,false);await this.write(ETM+4,0);await this.wait(ETM+0xc,1,1);}
    if(this.saved.has(ETF+0x20))await this.stopFifo();
    const last=[ETF+0x20,ETM+4,0x580244e0,0xe000edfc,0x5c001004];
    for(const addr of [...this.saved.keys()].reverse())if(!last.includes(addr))await restoreOne(addr);
    await restoreOne(ETF+0x20);await restoreOne(ETM+4);
    if(this.osLocked!==null)await this.write(ETM+0x310,this.osLocked?1:0,false);
    for(const [base,locked]of this.locks)if(locked)await this.write(base+0xfb0,0,false);
    for(const addr of last.slice(2))await restoreOne(addr);
    this.saved.clear();this.locks.clear();this.osLocked=null;this.config=null;
    if(running)await this.run();this.log('已恢复采集前的 trace 配置与引脚状态');
  }
  async wait(addr,mask,value){for(let i=0;i<80;i++){if((await this.read(addr)&mask)===value)return;await sleep(10);}throw Error(`等待寄存器超时 ${hex(addr)}`);}
  async inspect(){
    const cpuid=await this.read(0xe000ed00),part=(cpuid>>>4)&4095;
    if(![0xc23,0xc24,0xc27].includes(part))throw Error('当前仅支持 STM32 Cortex-M3/M4/M7');
    const device=await this.read(part===0xc27?0x5c001000:0xe0042000);
    const port=identifyTarget(cpuid,device,this.profile);
    if(!port)throw Error(`未预置此芯片：CPUID ${hex(cpuid)} / DEV_ID ${hex(device&4095)}`);
    const traceSupported=!!(port.traceValidated||port.traceImplemented);
    const config={};let width=null;
    if(traceSupported&&port.id==='stm32f103ze'){
      this.traceFamily='f103';const f=await inspectF103(this);Object.assign(config,f.config);width=f.width;
    }else if(traceSupported){
      this.traceFamily='h7';
      await this.set(0x5c001004,0x700000,0x700000);await this.set(0xe000edfc,0x1000000,0x1000000);
      for(const [name,offset]of Object.entries({idr0:0x1e0,idr1:0x1e4,idr2:0x1e8,idr8:0x180,idr9:0x184,idr10:0x188,idr11:0x18c,idr12:0x190,idr13:0x194,config:0x10,traceid:0x40}))config[name]=await this.read(ETM+offset);
      width=await this.read(TPIU+4);
    }else{
      config.debugControl=await this.read(part===0xc27?0x5c001004:0xe0042004);
      if(part===0xc27)config.traceClockGates=(config.debugControl>>>20)&7;
      else{config.traceIoEnabled=!!(config.debugControl&(1<<5));config.traceMode=(config.debugControl>>>6)&3;}
    }
    this.config=traceSupported?config:null;
    const rcc={};for(const [name,offset]of Object.entries(port.clockRegisters))rcc[name]=await this.read(port.rcc+offset);
    let clocks=null,clockError=null;try{
      for(const [name,offset]of Object.entries(port.clockRegisters))if(await this.read(port.rcc+offset)!==rcc[name])throw Error('RCC 正在变化，请暂停或重新读取');
      clocks=completeClocks(port,rcc,this.hseHz);
    }catch(e){clockError=e.message;}
    this.breakpoints.capacity=decodeFpCtrl(await this.read(0xe0002000)).numCode;
    this.info={cpuid,device,profile:port.id,name:port.name,core:port.core,etmVersion:port.etmVersion,traceSupported,
      traceStatus:traceSupported?port.id==='stm32f103ze'?'F103ZE 48/24 MHz Kingst 联动与 ETMv3 解码已验收；封装须有 PE2～PE6':port.id==='stm32h743'?'H743 ETMv4 实验适配：推荐 CPU 60 / TRACECLK 30 MHz；同组其他型号未验收':'H7B0 70/35 MHz 已验收；同组其他型号仍需实测':'型号/时钟/断点可用；本型号 trace 配置与解码尚未验收',
      flashLimit:port.id==='stm32h7b0'?0x08020000:port.flashLimit,traceOptions:traceCapabilities(port.id,config),
      config,halted:await this.isHalted(),rcc,clocks,clockError,hseHz:this.hseHz,width};return this.info;
  }

  async isHalted(){return this.probe?.readMemDiagnostic?!!(await this.read(0xe000edf0)&(1<<17)):this.probe.isHalted();}
  async halt(){this.assertTransport();await this.probe.halt();await this.wait(0xe000edf0,1<<17,1<<17);}
  async run(){
    this.assertTransport();
    if(this.breakpoints.items.some(b=>b.lease)&&await this.isHalted()){
      const pc=await this.pc(),bp=this.breakpoints.items.find(b=>b.lease&&b.address===pc);
      if(bp){
        await this.breakpoints.disarm(bp);
        try{
          // MASKINTS changes while halted; stepping clears C_HALT (pyOCD CortexM.step).
          await this.write(0xe000edf0,0xa05f000b,false);
          await this.write(0xe000edf0,0xa05f000d,false);
          await this.wait(0xe000edf0,1<<17,1<<17);
          if(await this.pc()===pc)throw Error('硬件单步未推进 PC；目标保持暂停，可禁用该断点再继续');
        }finally{await this.halt();await this.write(0xe000edf0,0xa05f0003,false);await this.breakpoints.arm(bp);}
      }
    }
    await this.probe.run();
    if(await this.isHalted()){
      const pc=await this.pc();
      if(this.breakpoints.items.some(b=>b.lease&&b.address===pc)){this.breakpoints.hit(pc);this.log(`已命中硬件断点 ${hex(pc)}`);}
      else if (await this.clearStaleComparator(pc)) {
        // 🚨 2026-10 真机定因（H743 + 包路径，连续 3 次可复现）：
        //    PC 正好停在入口、DFSR=0x3（断点命中）、DHCSR.S_HALT=1、同地址断点"未租用"。
        //    也就是说 reset({address}) 为停在业务起点而临时装的入口比较器**没被摘掉**
        //    （这颗探针的 PPB 写偶发丢失，文档里记过），于是放行瞬间又命中同一地址。
        //    这里做一次防御性自愈：清掉该地址上无人认领的比较器，再放行一次。
        this.log(`已在 ${hex(pc)} 上清掉残留比较器，重新放行`);
        await this.probe.run();
        if (await this.isHalted()) {
          const pc2 = await this.pc();
          if (this.breakpoints.items.some(b => b.lease && b.address === pc2)) { this.breakpoints.hit(pc2); this.log(`已命中硬件断点 ${hex(pc2)}`); }
          else throw Error(`目标仍暂停：PC ${hex(pc2)}（已清掉 ${hex(pc)} 的残留比较器仍未跑起来）；请检查其他断点或异常`);
        }
      }
      else {
        // 诊断：把 PC / 停机原因 / 该地址是否有未租用的断点一并报出来，
        // 否则只知道"未命中"，分不清是入口比较器没摘干净、还是有别的断点/异常在拦。
        const dhcsr = await this.read(0xe000edf0), dfsr = await this.read(0xe000ed30), demcr = await this.read(0xe000edfc);
        const hits = this.breakpoints.items.filter(b => b.enabled && b.address === pc)
          .map(b => `${hex(b.address)}${b.lease ? '(已租用)' : '(未租用)'}`);
        throw Error(`目标仍暂停，未命中本页断点：PC ${hex(pc)}，DFSR ${hex(dfsr)}，DHCSR ${hex(dhcsr)}，DEMCR ${hex(demcr)}` +
          (hits.length ? `；同地址断点：${hits.join('、')}` : '；该地址没有本页断点') + '；请检查其他断点或异常');
      }
    }
  }
  /**
   * 清掉某个地址上"无人认领"的 FPB 比较器（入口临时比较器残留时用）；返回是否清过。
   * 比较器个数/编码都按 FP_CTRL 现场回读，rev1/rev2 通吃；地址比较忽略 match 位与使能位。
   */
  async clearStaleComparator(pc){
    const caps = decodeFpCtrl(await this.read(0xe0002000));
    const want = encodeComparator(pc & ~1, caps.rev) & 0x1ffffffc;
    let cleared = false;
    for (let i = 0; i < caps.numCode; i++){
      const slot = compAddr(i), v = await this.read(slot);
      if (!(v & 1) || ((v & 0x1ffffffc) !== want)) continue;
      await this.write(slot, 0, false);
      if ((await this.read(slot)) & 1) await this.write(slot, 0, false);   // 这颗探针 PPB 写偶发丢，补一次
      this.log(`清掉残留比较器：槽 ${i} @ ${hex(pc)}`);
      cleared = true;
    }
    return cleared;
  }

  async pc(){await this.write(0xe000edf4,15,false);await this.wait(0xe000edf0,1<<16,1<<16);return (await this.read(0xe000edf8))&~1;}
  async unexpectedHalt(pc,address,label){
    const dhcsr=await this.read(0xe000edf0),dfsr=await this.read(0xe000ed30),demcr=await this.read(0xe000edfc);
    const reasons=['暂停请求/单步','断点','数据观察点','异常捕获','外部调试请求'].filter((_,i)=>dfsr&(1<<i));
    return Error(`${label}停在 ${hex(pc)}，未到达起点 ${hex(address)}；停机原因：${reasons.join('、')||'未记录'}（DHCSR ${hex(dhcsr)}，DFSR ${hex(dfsr)}，DEMCR ${hex(demcr)}）。目标保持暂停`);
  }
  async clearEntryBreak(){
    if(!this.entryBreak)return;
    const owned=this.entryBreak;await this.halt();
    if(await this.read(owned.slot)!==owned.encoded)throw Error('起点断点槽位已被其他调试操作改变，拒绝覆盖');
    await this.write(owned.slot,owned.before);
    const control=await this.read(0xe0002000);
    // Disable only if we enabled FPB and no other active comparator needs it.
    let other=false;for(let i=0;i<owned.capacity;i++)if(await this.read(compAddr(i))&1)other=true;
    if(!owned.enabled&&!other)await this.write(0xe0002000,2|(control&~1),false);
    this.entryBreak=null;
    this.log('本次起点断点已清理');
  }
  async runTo(address,{timeout=15000}={}){
    this.cancelEntry=false;
    address=(Number(address)>>>0)&~1;if(address<0x08000000||address>=(this.info?.flashLimit||0x08200000))throw Error('断点须在目标内部 Flash');
    await this.clearEntryBreak();await this.stopTrace();
    if(await this.pc()===address)return this.inspect();
    const caps=decodeFpCtrl(await this.read(0xe0002000));if(!canBreak(address,caps.rev))throw Error('FPB 不支持该地址');
    let slot=null,before=0,retained=false;for(let i=0;i<caps.numCode;i++){const a=compAddr(i),v=await this.read(a);if(v&1)retained=true;else if(slot===null){slot=a;before=v;}}
    if(!caps.enabled&&retained)throw Error('FPB 当前关闭且保留了其他比较器；拒绝启用并触发不属于本页面的断点');
    if(slot===null)throw Error('没有空闲硬件断点；请先释放一个槽位');
    const encoded=encodeComparator(address,caps.rev);this.entryBreak={slot,before,encoded,capacity:caps.numCode,enabled:caps.enabled};
    this.log('正在使用一次性硬件断点等待函数入口');
    return withCleanup(async()=>{
      await this.write(slot,encoded);await this.write(0xe0002000,3,false);await this.probe.run();const until=Date.now()+timeout;
      while(!(await this.isHalted())){if(this.cancelEntry)throw Error('已取消运行至函数');if(Date.now()>until)throw Error('运行至函数超时；已暂停并清理本次起点断点');await sleep(25);}
      const pc=await this.pc();if(pc!==address)throw await this.unexpectedHalt(pc,address,'目标');
      await this.clearEntryBreak();const info=await this.inspect();info.entryPC=pc;this.log(`已停在函数入口 ${hex(pc)}，一次性断点已移除`);return info;
    },async()=>{if(this.entryBreak)await this.clearEntryBreak();},e=>this.log('起点清理失败（保留首次错误）：'+e.message));
  }
  async reset({address=null,timeout=15000}={}){
    this.assertTransport();this.cancelEntry=false;
    if(address===null)throw Error('请先选择初始化后的业务起点；复位入口捕获尚未验收');
    address=(Number(address)>>>0)&~1;
    if(address<0x08000000||address>=(this.info?.flashLimit||0x08200000))throw Error('起点必须在 STM32 内部 Flash');
    await this.clearEntryBreak();await this.stopTrace();
    const demcr=await this.read(0xe000edfc),caps=decodeFpCtrl(await this.read(0xe0002000));
    let free=null,retained=false;
    for(let i=0;i<caps.numCode;i++){const slot=compAddr(i),v=await this.read(slot);if(v&1)retained=true;else if(!free)free={slot,before:v};}
    if(!caps.enabled&&retained)throw Error('FPB 关闭但保留了其他断点，拒绝擅自启用');
    if(!free)throw Error('没有空闲硬件断点，无法可靠停在业务入口');
    const encoded=encodeComparator(address,caps.rev);
    this.entryBreak={...free,encoded,capacity:caps.numCode,enabled:caps.enabled};
    return withCleanup(async()=>{
      // Install the business breakpoint before reset. Never halt at Reset_Handler.
      await this.write(free.slot,encoded);await this.write(0xe0002000,3,false);
      await this.write(0xe000edfc,demcr&~1);
      this.log(`已预置复位后的业务起点 ${hex(address)}；正在请求一次软件复位`);
      // AIRCR is keyed/self-clearing: no generic memory verification or rewrite.
      await this.write(0xe000ed0c,0x05fa0004,false);await sleep(60);
      const until=Date.now()+timeout;
      while(!(await this.read(0xe000edf0)&(1<<17))){if(this.cancelEntry)throw Error('已取消等待起点');if(Date.now()>until)throw Error('复位后未命中业务起点；目标将暂停');await sleep(25);}
      const pc=await this.pc();if(pc!==address)throw await this.unexpectedHalt(pc,address,'复位后');
      const info=await this.inspect();info.entryPC=pc;return info;
    },async()=>{await this.clearEntryBreak();await this.write(0xe000edfc,demcr);},e=>this.log('复位后的清理失败（保留首次错误）：'+e.message));
  }
  async verifyElf(info){
    await this.halt();
    let checked=0;
    for(const segment of info.segments){
      const expected=Uint8Array.from(atob(segment.data),c=>c.charCodeAt(0));
      for(let i=0;i<expected.length;i+=512){
        const length=Math.min(512,expected.length-i);
        // 🚨 2026-10 真机定因：SWD 链路偶发单字节读错（用户现场：线刚接回就报 0x08000298，
        //    而三份候选 ELF 在该地址的字节完全相同——说明是**读错**，不是 ELF 选错）。
        //    原实现"首个不一致即抛"会把偶发读错报成"你的 ELF 不对"。
        //    这里改成**整块重读最多 4 次**：只有持续不一致才判定不匹配，并给出两边字节。
        let lastBad=-1, lastValue=null, done=false, lastError=null;
        for(let attempt=0;attempt<4&&!done;attempt++){
          let actual;
          try{ actual=await this.probe.readMemDiagnostic((segment.address+i)>>>0,length); }
          catch(e){ lastError=e; if(attempt<3){ await new Promise(r=>setTimeout(r,20)); continue; } throw this.accessError(e,'校验 Flash',segment.address+i); }
          lastError=null;
          lastBad=-1;
          for(let j=0;j<length;j++){ if(actual[j]!==expected[i+j]){ lastBad=j; lastValue=actual[j]; break; } }
          if(lastBad<0) done=true;
          else if(attempt<3) await new Promise(r=>setTimeout(r,20));
        }
        if(!done){
          const at=(segment.address+i+lastBad)>>>0;
          const want=expected[i+lastBad].toString(16).padStart(2,'0');
          const got=(lastValue??0).toString(16).padStart(2,'0');
          throw Error(`目标机器码与 ELF 不匹配：${hex(at)}（重读 4 次仍不一致：ELF ${want} ≠ 目标 ${got}）`);
        }
        checked+=length;
      }
    }
    this.log(`ELF 校验通过：${checked} 字节目标 Flash 一致`);
    return checked;
  }
  async configure({traceid=2,branchBroadcast=false,returnStack=false,cycleCount=false,pinSpeed=3}={}){
    await this.inspect();if(!this.info.traceSupported)throw Error(this.info.traceStatus);
    if(!Number.isInteger(traceid)||traceid<1||traceid>0x6f)throw Error('Trace ID 范围为 1~111');
    if(!Number.isInteger(pinSpeed)||pinSpeed<1||pinSpeed>3)throw Error('trace 引脚速度范围为 1~3');
    if(this.info.profile==='stm32f103ze')return configureF103(this,{traceid,branchBroadcast,returnStack,cycleCount,pinSpeed});
    for(const [option,enabled]of Object.entries({branchBroadcast,returnStack,cycleCount})){
      if(enabled&&!this.info.traceOptions[option])throw Error('当前 ETM 未实现所选选项：'+option);
    }
    await this.halt();await this.inspect();
    if(this.info.clockError)throw Error(this.info.clockError);if(!this.info.clocks.traceReady)throw Error('PLL1 R 输出没有启用，请由目标固件配置');
    await this.set(0x580244e0,1<<4,1<<4);
    const gpio=0x58021000,mask=0x3ff0;
    await this.set(gpio,mask,0x2aa0);await this.set(gpio+4,0x7c,0);await this.set(gpio+8,mask,pinSpeed*0x1550);await this.set(gpio+12,mask,0);await this.set(gpio+0x20,0x0fffff00,0);
    for(const base of [ETM,FUNNEL,ETF,TPIU])await this.unlock(base);
    if(this.osLocked===null)this.osLocked=!!((await this.read(ETM+0x314))&2);
    await this.write(ETM+0x310,0,false);await this.wait(ETM+0x314,2,0);
    await this.managed(ETM+4,0);await this.wait(ETM+0xc,1,1);
    await this.managed(FUNNEL,0x301);await this.stopFifo();
    await this.managed(ETF+0x28,2);await this.managed(ETF+0x304,3);await this.managed(ETF+0x20,1);
    if(!(await this.read(TPIU+0x300)&2)){await this.managed(TPIU+0x304,(await this.read(TPIU+0x304))|0x1040,false);await this.wait(TPIU+0x300,2,2);}
    await this.managed(TPIU+0x204,0);await this.managed(TPIU+4,8);await this.managed(TPIU+0x400,256,false);await this.managed(TPIU+0x304,3);
    // ETM-M7 CONFIGR bit 0 is RES1; preserve fixed bits (not INSTP0).
    const fixed=(await this.read(ETM+0x10))&~0x1018;
    await this.managed(ETM+0x10,fixed|(branchBroadcast?1<<3:0)|(returnStack?1<<12:0)|(cycleCount?1<<4:0));
    // ETM-M7 instruction-only trace broadcasts across the whole memory map.
    // BBCTLR exists only in instruction+data implementations (DDI0494D 3.4.11).
    if(branchBroadcast&&(this.info.config.idr0&0x18)===0x18)await this.managed(ETM+0x3c,0);
    if(cycleCount)await this.managed(ETM+0x38,256);
    await this.managed(ETM+0x20,0);await this.managed(ETM+0x24,0);await this.managed(ETM+0x2c,0);
    await this.managed(ETM+0x40,traceid);await this.managed(ETM+0x88,0);await this.managed(ETM+0x8c,0);await this.managed(ETM+0x80,0x201);await this.managed(ETM+4,1);
    const info=await this.inspect();info.tracePins={pinSpeed,mode:await this.read(gpio),speed:await this.read(gpio+8),alternate:await this.read(gpio+0x20)};this.log('ETM 已配置并回读，目标保持暂停');await sleep(100);return info;
  }
}
