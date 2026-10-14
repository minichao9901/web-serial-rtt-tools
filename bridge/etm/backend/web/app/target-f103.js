// F103ZE ETM-M3: no H7 funnel/ETF and no writes to reserved trace options.
export const F103_ETM=0xe0041000,F103_TPIU=0xe0040000;
const ITM=0xe0000000,DEMCR=0xe000edfc,DBG=0xe0042004;

export async function inspectF103(t){
  await t.set(DEMCR,1<<24,1<<24);
  const idr=await t.read(F103_ETM+0x1e4);
  if(((idr>>>8)&15)!==2)throw Error('未识别到 F103 ETMv3；请核对芯片与 Trace 能力');
  const config={protocol:'ETMv3',idr,ctrl:await t.read(F103_ETM),ccer:await t.read(F103_ETM+0x1e8),traceid:await t.read(F103_ETM+0x200)};
  return {config,width:await t.read(F103_TPIU+4)};
}

async function programming(t){
  await t.unlock(F103_ETM);
  // TRACE_IOEN supplies HCLK to the F103 TPIU. After flash/reset this gate
  // can be off; enable it before draining/awaiting the programming state.
  await t.set(DBG,0xe0,0xe0);
  // Power-down must be cleared before the other ETM fields can be written.
  await t.set(F103_ETM,1,0);
  await t.set(F103_ETM,0x800,0);
  await t.set(F103_ETM,0x400,0x400);
  await t.wait(F103_ETM+0x10,2,2);
}

export async function stopF103(t){
  await t.set(DEMCR,1<<24,1<<24);
  await programming(t);
}

export async function configureF103(t,{traceid=2,branchBroadcast=false,returnStack=false,cycleCount=false,pinSpeed=3}={}){
  if(returnStack||cycleCount)throw Error('F103 ETM-M3 未实现返回栈压缩/周期准确模式；请取消这些选项');
  if(pinSpeed!==3)throw Error('F103ZE 当前验收要求 50 MHz 高速 GPIO 输出');
  await t.halt();await t.inspect();
  if(t.info.clockError||!t.info.clocks?.coreHz)throw Error(t.info.clockError||'请先填写实际 HSE 并核对时钟');
  await programming(t);
  await t.unlock(F103_TPIU);await t.unlock(ITM);
  await t.set(0x40021018,1<<6,1<<6);
  await t.set(0x40011800,0x0fffff00,0x0bbbbb00); // PE2..6 AF push-pull, 50 MHz.
  await t.managed(F103_ETM+8,0);
  await t.managed(F103_ETM+0x20,0x6f);
  await t.set(F103_ETM+0x24,1<<25,0); // Only start/stop enable is implemented.
  await t.managed(F103_ETM+0x2c,0);
  await t.set(F103_ETM+0x200,0x7f,traceid);
  if(!((await t.read(F103_TPIU))&8))throw Error('TPIU 不支持当前 4 位 DDR 的 8-bit 输入配置');
  await t.managed(F103_TPIU+4,8);
  // Switching to SWO and back stalled this target in prior experiments.
  // Keep the port in parallel mode across captures; never restore SPPR=1/2.
  await t.write(F103_TPIU+0xf0,0);
  await t.set(F103_TPIU+0x304,2,2);
  await t.set(DBG,0xe0,0xe0);
  await t.set(0xe0000e80,0x7fffff,0x1000d);
  await t.set(0xe0001000,1,1);
  // Keep branch broadcast off: forcing every direct branch address overflowed
  // the CDC initialization at both 72/36 and 48/24 MHz. Direct branches are
  // reconstructed from the matched ELF; no address/time filter or CPU stall.
  // M3 ETMCR bit12 and bit29 are reserved.
  await t.set(F103_ETM,0x10000b80,branchBroadcast?0x100:0);
  await t.set(F103_ETM,0xc00,0x800);
  await t.wait(F103_ETM+0x10,2,0);
  const info=await t.inspect();
  info.tracePins={pinSpeed:3,crl:await t.read(0x40011800)};
  t.log('F103 ETMv3 / TPIU 已配置并回读；目标保持暂停，并行协议在会话中保持为 0');
  return info;
}

export async function restoreF103(t){
  if(!t.saved.size)return;
  t.assertTransport();const running=!(await t.isHalted());await t.halt();
  const cr=t.saved.get(F103_ETM);
  if(cr){
    await t.unlock(F103_ETM);
    await t.write(F103_ETM,(await t.read(F103_ETM)&~0x801)|0x400,false);
    await t.wait(F103_ETM+0x10,2,2);
  }
  if(t.saved.has(ITM+0xe80))await t.unlock(ITM);
  const last=[F103_ETM,0x40011800,0x40021018,DBG,DEMCR];
  const restoreOne=async addr=>{const s=t.saved.get(addr);if(s)await t.write(addr,((await t.read(addr)&~s.mask)|(s.before&s.mask))>>>0);};
  for(const addr of [...t.saved.keys()].reverse())if(!last.includes(addr))await restoreOne(addr);
  if(cr){
    const current=await t.read(F103_ETM),value=((current&~cr.mask)|(cr.before&cr.mask))>>>0;
    await t.write(F103_ETM,value&~1,false);await t.write(F103_ETM,value,false);
  }
  for(const addr of last.slice(1))await restoreOne(addr);
  for(const [base,locked]of t.locks)if(locked)await t.write(base+0xfb0,0,false);
  t.saved.clear();t.locks.clear();t.config=null;
  if(running)await t.run();
  t.log('已恢复采集前 ETM/引脚/同步设置；F103 TPIU 保持并行模式，避免动态切换 SWO');
}
