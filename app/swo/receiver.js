import {AkaLinkHid,ascii} from '../hid/probe.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
export function receiverWords(bytes,action){
  if(bytes.length<59||bytes[0]!==58||bytes[1]!==0x19||bytes[2]!==action)throw Error('探针未支持 SWO 时钟会话，请更新配套固件');
  const v=new DataView(bytes.buffer,bytes.byteOffset+3,56),w=Array.from({length:14},(_,i)=>v.getUint32(i*4,true));
  if(w[0]!==1)throw Error('SWO 时钟协议版本不兼容');
  return w;
}
export function receiverStatus(w){return {version:w[0],rc:w[1]|0,token:w[2],mode:w[3]-1,requestedBaud:w[4],actualBaud:w[5],uartHz:w[6],systemDivider:w[7],source:w[8],osr:w[9],uartDivider:w[10],pll1Hz:w[11],leaseMs:w[12],blocker:w[13]};}
function check(s){if(s.rc<0)throw Error(`探针 SWO 配置失败 (${s.rc})`+(s.rc===-4?`：共享时钟节点 ${s.blocker} 无法保持原频率`:'：未启用目标 trace'));return s;}
export class SwoReceiver {
  constructor(hid=new AkaLinkHid()){this.hid=hid;this.token=0;}
  async open(serial){const dev=AkaLinkHid.pick(await navigator.hid.getDevices());if(!dev)throw Error('请先点“授权探针时钟配置”');await this.hid.open(dev);if(serial&&ascii((await this.hid.xfer(0x11)).subarray(2))!==serial){await this.hid.close();throw Error('SWD 与时钟配置必须选择同一探针');}}
  async command(action,arg=0,mode=0){const data=new Uint8Array(9),v=new DataView(data.buffer);data[0]=action;v.setUint32(1,arg,true);v.setUint32(5,mode,true);return receiverWords(await this.hid.xfer(0x19,data),action);}
  async status(){return check(receiverStatus(await this.command(0)));}
  async diagnostics(){const w=await this.command(6);return Object.fromEntries(['overrun','framing','parity','lineBreak','droppedBytes'].map((key,i)=>[key,w[i+2]]));}
  async sources(){const w=await this.command(5);return {frequencies:w.slice(2,10),cpuClock:w[10],mfi:w[11],mfn:w[12],mfd:w[13]};}
  async prepare(baud,mode=1){const first=check(receiverStatus(await this.command(1,Math.round(baud),mode)));this.token=first.token;return this.settled(true);}
  async settled(active){for(let i=0;i<30;i++){await wait(30);const s=await this.status();if(s.rc!==1){if(active&&(!s.token||s.token!==this.token||s.mode<0))throw Error('探针 SWO 会话已失效');if(!active&&s.token)throw Error('探针时钟仍被占用');return s;}}throw Error('探针时钟切换超时');}
  async heartbeat(){const s=check(receiverStatus(await this.command(3,this.token)));if(!this.token||s.token!==this.token||s.mode<0)throw Error('探针 SWO 时钟会话已失效');return s;}
  async release(){if(this.token){check(receiverStatus(await this.command(2,this.token)));await this.settled(false);this.token=0;}}
  async close(){await this.release();await this.hid.close();}
}
