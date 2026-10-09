const wait=ms=>new Promise(r=>setTimeout(r,ms));
export class TargetClock {
  constructor(capture,elf){this.capture=capture;this.symbols=Object.fromEntries(elf?.symbols().filter(s=>s.isObject&&s.size===4&&s.addr>=0x20000000&&s.addr<0x20005000).map(s=>[s.name,s.addr])||[]);this.originalHz=null;}
  async value(name){const a=this.symbols[name];if(!a)throw Error('目标调频需要配套的可调时钟测试程序和匹配 ELF');let previous;for(let n=0;n<5;n++){const value=await this.capture.read(a);if(n&&value===previous)return value;previous=value;}throw Error('目标协作调频状态读回不稳定：'+name);}
  async validate(){for(const name of ['g_clock_magic','g_clock_request_hz','g_clock_seq','g_clock_hz','g_clock_error'])if(!this.symbols[name])throw Error('目标调频需要配套的可调时钟测试程序和匹配 ELF');if(await this.value('g_clock_magic')!==0x5357434b)throw Error('目标没有启用协作调频接口');this.originalHz=await this.value('g_clock_hz');}
  async change(hz){if(!Number.isInteger(hz/4e6)||hz<16e6||hz>72e6)throw Error('测试程序主频须为 16–72 MHz 的 4 MHz 倍数');const seq=await this.value('g_clock_seq');await this.capture.write(this.symbols.g_clock_request_hz,hz);for(let n=0;n<60;n++){await wait(30);if(await this.value('g_clock_seq')!==seq){const error=await this.value('g_clock_error'),actual=await this.value('g_clock_hz');if(error)throw Error(`目标 PLL 调整失败 (${error}，当前 ${actual} Hz)`);if(actual===hz)return;}}throw Error('目标协作调频超时');}
  async restore(){if(this.originalHz!==null){await this.change(this.originalHz);this.originalHz=null;}}
}
