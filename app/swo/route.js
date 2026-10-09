/** Reversible trace gate/pin setup. No target PLL, CPU divider or SysTick writes. */
export class TraceRoute {
  constructor(io,profile){this.io=io;this.profile=profile;this.saved=[];this.locks=[];this.h7=profile.startsWith('stm32h7');this.dbg=this.h7?0x5c001004:0xe0042004;}
  async set(address,mask,value){const before=await this.io.read(address);this.saved.push({address,mask,before});await this.io.write(address,(before&~mask)|(value&mask));if(((await this.io.read(address))&mask)!==(value&mask))throw Error('目标 trace 时钟 / 引脚配置回读失败');}
  async unlock(base){const lsr=await this.io.read(base+0xfb4);if(lsr&1){this.locks.push({base,locked:!!(lsr&2)});await this.io.write(base+0xfb0,0xc5acce55);}}
  async prepare(){
    // H7 APB-D components must be clocked before their snapshots can be read.
    if(this.h7){await this.set(this.dbg,0x700000,0x700000);await this.unlock(0x5c003000);if(this.profile==='stm32h743')await this.unlock(0x5c004000);await this.unlock(0xe0001000);}
  }
  async enable(){
    if(!this.h7)await this.set(this.dbg,0xe0,0x20);
    if(this.profile==='stm32f1')return;
    const gate=this.h7?0x580244e0:0x40023830,gpio=this.h7?0x58020400:0x40020400;
    await this.set(gate,2,2);await this.set(gpio,3<<6,2<<6);await this.set(gpio+4,1<<3,0);await this.set(gpio+8,3<<6,3<<6);await this.set(gpio+12,3<<6,0);await this.set(gpio+0x20,15<<12,0);
    if(this.profile==='stm32h743')await this.set(0x5c004000,3,1); // CM7 ITM input; do not mix the CM4 stream.
  }
  async restore(){
    // Keep snapshots until every readback succeeds so a failed release can be retried.
    const restore=async({address,mask,before})=>{const value=await this.io.read(address);await this.io.write(address,(value&~mask)|(before&mask));if(((await this.io.read(address))&mask)!==(before&mask))throw Error('目标 trace 引脚 / 时钟恢复回读失败');};
    await this.ensureAccess();
    for(const state of [...this.saved].reverse())if(state.address!==this.dbg)await restore(state);
    for(const {base,locked}of this.locks)if(locked)await this.io.write(base+0xfb0,0);
    for(const state of this.saved)if(state.address===this.dbg)await restore(state);
    this.saved=[];this.locks=[];
  }
  async ensureAccess(){
    if(this.h7&&this.saved.some(s=>s.address===this.dbg))await this.io.write(this.dbg,(await this.io.read(this.dbg))|0x700000);
    const gpioGate=this.h7?0x580244e0:0x40023830;
    if(this.saved.some(s=>s.address===gpioGate))await this.io.write(gpioGate,(await this.io.read(gpioGate))|2);
    for(const {base}of this.locks)await this.io.write(base+0xfb0,0xc5acce55);
  }
}
