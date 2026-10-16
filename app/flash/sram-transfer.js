/** SRAM-only bulk path. A standard DAP_Transfer contains TAR then DRW;
 * a failed TAR stops that packet before its data. General debugger unchanged. */
import { withTimeout } from '../rtt/dap-webusb.js';

/** Qualify a clock before SRAM writes. Retry DP/AP setup, never test data.
 * No target reset, target clock change, or execution is involved. */
export async function prepareSramClock(p, hz){
  if (!p.setClock) return {attempts:0};
  if (typeof p._transfer !== 'function' || !p.idcode || p._dapPort === 2){
    await p.setClock(hz); return {attempts:1};
  }
  await p.flushWrites();
  const cpuid=(await p._transfer([{ap:true,rnw:false,addr:4,data:0xe000ed00},
    {ap:true,rnw:true,addr:12}]))[0]>>>0;
  const readId=async()=>{
    const id=(await p._transfer([{ap:false,rnw:true,addr:0}]))[0]>>>0;
    if(id!==(p.idcode>>>0))throw new Error('SWD 切档后的 DP ID 不一致');
  };
  if(hz>20000000){
    await p.setClock(20000000);
    if(!(await p.abort()))throw new Error('SWD 切档前清错失败');
    await readId();
  }
  await p.setClock(hz);
  const failures=[];
  for(let attempt=0;attempt<3;attempt++){
    try {
      if(attempt){await p.swdActivation();await p.setClock(hz);}
      await readId();
      if(!(await p.abort()))throw new Error('SWD 切档后清错失败');
      await p._transfer([{ap:false,rnw:false,addr:4,data:0x50000000}]);
      await p._transfer([{ap:false,rnw:false,addr:8,data:(p.apIndex<<24)>>>0}]);
      await p._transfer([{ap:true,rnw:false,addr:0,data:p.csw}]);
      const got=(await p._transfer([{ap:true,rnw:false,addr:4,data:0xe000ed00},
        {ap:true,rnw:true,addr:12}]))[0]>>>0;
      if(got!==cpuid)throw new Error('SWD 切档后的 CPUID 不一致');
      p._posted=false;p._faulted=false;
      return {attempts:attempt+1,failures};
    }catch(e){failures.push(e.message);}
  }
  p._faulted=true;
  throw new Error(`SWD ${hz/1e6} MHz 初始化未通过：${failures.at(-1)}`);
}

export class SramBenchTransfer {
  constructor(probe,depth=1,packetSize=probe.pkt){
    this.probe=probe;this.depth=depth;this.packetSize=packetSize;
  }
  static async create(probe){
    const size=await probe.info(0xff);
    const advertised=(size[0]||0)|((size[1]||0)<<8);
    if(advertised<64||advertised>32768)return null;
    const count=await probe.info(0xfe);
    return new SramBenchTransfer(probe,Math.max(1,Math.min(4,count[0]||1)),Math.min(1024,advertised));
  }
  async _exchange(requests,consume){
    const p=this.probe,results=[];
    let next=0,stopped=false,usbFailed=false;
    const worker=async()=>{
      while(!stopped&&next<requests.length){
        const index=next++,req=requests[index];
        const frame=new Uint8Array(p._framing==='pad'?this.packetSize:req.length);
        frame.set(req);
        // FIFO submissions; refill a completed slot without a four-packet barrier.
        const settled=await Promise.allSettled([
          p.device.transferOut(p.epOut,frame),p.device.transferIn(p.epIn,this.packetSize),
        ]);
        try {
          if(settled.some(r=>r.status==='rejected'||r.value?.status!=='ok')){
            usbFailed=true;throw new Error('SRAM USB 传输失败');
          }
          const data=settled[1].value.data;
          if(!data||data.byteLength<3)throw new Error('SRAM USB 响应不完整');
          const res=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
          if(res[0]!==5)throw new Error('SRAM USB 响应命令不匹配');
          if(consume)consume(res,index);else results[index]=res;
        }catch(e){stopped=true;throw e;}
      }
    };
    let settled;
    try{
      settled=await withTimeout(Promise.allSettled(Array.from({length:Math.min(this.depth,requests.length)},worker)),15000,'SRAM USB 流水传输');
    }catch(e){stopped=true;await p._onXferTimeout('SRAM USB 流水传输');throw e;}
    const failure=settled.find(r=>r.status==='rejected');
    if(usbFailed)await p._onXferTimeout('SRAM USB 传输失败');
    if(failure)throw failure.reason;
    return results;
  }
  async read(addr,size){return await this._move(addr,new Uint8Array(size),true);}
  async write(addr,bytes){await this._move(addr,bytes,false);}
  async _move(addr,bytes,read){
    if((addr&3)||(bytes.length&3))throw new Error('SRAM 批量测试要求字对齐');
    const p=this.probe;
    try{return await p._withLock(async()=>{
      await p.flushWrites();
      const maxWords=Math.min(254,Math.floor((this.packetSize-(read?3:8))/(read?4:5)));
      if(maxWords<1)throw new Error('探针包长不足');
      const batch=[];
      for(let offset=0;offset<bytes.length;){
        const address=(addr+offset)>>>0;
        const words=Math.min(maxWords,(bytes.length-offset)/4,(1024-(address&1023))/4);
        const req=new Uint8Array(8+(read?words:words*5));
        req.set([5,0,1+words,5]);new DataView(req.buffer).setUint32(4,address,true);
        if(read)req.fill(15,8);
        else for(let i=0;i<words;i++){
          req[8+i*5]=13;req.set(bytes.subarray(offset+i*4,offset+i*4+4),9+i*5);
        }
        batch.push({req,offset,words});offset+=words*4;
      }
      await this._exchange(batch.map(b=>b.req),(res,k)=>{
        const {offset,words}=batch[k],status=res[2];
        if(res[1]!==1+words||status!==1){
          const reason=status&8?'SWD 协议错误':({1:'传输数量不完整',2:'目标 WAIT 超时',4:'目标 FAULT',7:'目标未应答'}[status&7]||`异常 ACK 0x${status.toString(16).padStart(2,'0')}`);
          throw new Error(`SRAM ${read?'读取':'写入'}失败 @0x${(addr+offset).toString(16)}：${reason}（完成 ${res[1]}/${1+words} 条）`);
        }
        if(read){
          if(res.length<3+words*4)throw new Error('SRAM 批量传输不完整');
          bytes.set(res.subarray(3,3+words*4),offset);
        }
      });
      p._posted=false;p.lastOkAt=Date.now();
      return bytes;
    });}catch(e){p._posted=false;p._faulted=true;throw e;}
  }
}
