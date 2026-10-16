/** Benchmark-only CMSIS-DAP atomic bulk path. Keep the general debugger's
 * conservative register access unchanged. Each packet sets TAR explicitly and
 * stays within a 1KiB auto-increment page; every response count/ACK is checked. */
import { withTimeout } from '../rtt/dap-webusb.js';

export class SramBenchTransfer {
  constructor(probe,depth=1){ this.probe=probe; this.depth=depth; }
  static async create(probe){
    const caps=await probe.info(0xf0);
    if (!(caps[0]&16)) return null;
    const count=await probe.info(0xfe);
    return new SramBenchTransfer(probe,Math.max(1,Math.min(4,count[0]||1)));
  }
  async _exchange(requests){
    const p=this.probe;
    if(this.depth===1)return [await p._ctrl(0x7f,requests[0])];
    // Queue OUT and IN in the same order. CMSIS-DAP responses are FIFO and have
    // no transaction ID; never interleave this window with ordinary _ctrl calls.
    const outs=requests.map(req=>{
      const frame=new Uint8Array(p._framing==='pad'?p.pkt:1+req.length);
      frame[0]=0x7f;frame.set(req,1);
      return p.device.transferOut(p.epOut,frame);
    });
    const ins=requests.map(()=>p.device.transferIn(p.epIn,p.pkt));
    let settled;
    try {settled=await withTimeout(Promise.allSettled([...outs,...ins]),15000,'SRAM USB 流水传输');}
    catch(e){await p._onXferTimeout('SRAM USB 流水传输');throw e;}
    const failed=settled.find(r=>r.status==='rejected'||r.value?.status!=='ok');
    if(failed){await p._onXferTimeout('SRAM USB 传输失败');throw new Error('SRAM USB 传输失败');}
    return settled.slice(outs.length).map(r=>{
      const data=r.value.data;
      if(!data||data.byteLength<2)throw new Error('SRAM USB 响应为空');
      const frame=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
      if(frame[0]!==0x7f)throw new Error('SRAM USB 响应命令不匹配');
      return frame.subarray(1);
    });
  }
  async read(addr,size){ return await this._move(addr,new Uint8Array(size),true); }
  async write(addr,bytes){ await this._move(addr,bytes,false); }
  async _move(addr,bytes,read){
    if ((addr&3)||(bytes.length&3))throw new Error('SRAM 批量测试要求字对齐');
    const p=this.probe;
    try { return await p._withLock(async()=>{
      await p.flushWrites();
      const maxWords=Math.min(120,Math.floor((p.pkt-15)/4));
      if(maxWords<1)throw new Error('探针包长不足');
      for(let offset=0;offset<bytes.length;){
        const batch=[];
        for(let k=0;k<this.depth&&offset<bytes.length;k++){
          const address=(addr+offset)>>>0;
          const words=Math.min(maxWords,(bytes.length-offset)/4,(1024-(address&1023))/4);
          // ExecuteCommands(2): Transfer(write TAR), TransferBlock(read/write DRW).
          const req=new Uint8Array(14+(read?0:words*4));
          req.set([2,5,0,1,5]);new DataView(req.buffer).setUint32(5,address,true);
          req.set([6,0,words&255,words>>>8,read?15:13],9);
          if(!read)req.set(bytes.subarray(offset,offset+words*4),14);
          batch.push({req,offset,words});offset+=words*4;
        }
        const replies=await this._exchange(batch.map(b=>b.req));
        for(let k=0;k<batch.length;k++){
          const {offset,words}=batch[k],res=replies[k];
          if(res.length<8||res[0]!==2||res[1]!==5||res[4]!==6)
            throw new Error('SRAM 批量传输响应格式错误');
          const fail = (stage, status) => {
            const reason = status & 8 ? 'SWD 协议错误'
              : ({1:'传输数量不完整',2:'目标 WAIT 超时',4:'目标 FAULT',7:'目标未应答'}[status & 7] || `异常 ACK 0x${status.toString(16).padStart(2,'0')}`);
            throw new Error(`SRAM ${stage}失败 @0x${(addr+offset).toString(16)}：${reason}；可降低 SWD 时钟后重试（命令/ACK：${Array.from(res.subarray(0,8),v=>v.toString(16).padStart(2,'0')).join(' ')}）`);
          };
          if(res[2]!==1||res[3]!==1) fail('地址设置/完成检查',res[3]);
          if(res[7]!==1) fail(read ? '块读取' : '块写入',res[7]);
          const got=res[5]|(res[6]<<8);
          if(got!==words||(read&&res.length<8+words*4))throw new Error('SRAM 批量传输不完整');
          if(read)bytes.set(res.subarray(8,8+words*4),offset);
        }
      }
      p._posted=false;
      p.lastOkAt=Date.now();
      return bytes;
    }); } catch(e){ p._posted=false; p._faulted=true; throw e; }
  }
}
