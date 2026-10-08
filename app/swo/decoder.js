/** ITM/DWT byte stream decoder. Source order is observed order, never an instruction trace.
 * Protocol: Armv7-M Appendix D4. NRZ/unformatted ITM only (TPIU formatter disabled).
 * Unknown encodings or transport gaps require a real sync before emitting further PCs. */
export class SwoDecoder {
  constructor({aligned=false,emit=()=>{}}={}){
    this.emit=emit;this.synced=aligned;this.offset=0;this.zeroes=0;this.state=null;
    this.page=0;this.segment=0;this.cycles=0;this.timeKnown=false;this.pending=[];
    this.stats={bytes:0,packets:0,pc:0,sleep:0,itm:0,exceptions:0,sync:0,overflow:0,malformed:0,skippedBytes:0,truncated:0};
  }
  event(e){this.emit({...e,segment:this.segment,offset:e.offset??this.offset,cycles:null});}
  flush(cycles=null,quality='unavailable'){
    for(const e of this.pending)this.emit({...e,cycles,timeQuality:quality});this.pending=[];
  }
  gap(reason){this.flush();this.event({kind:'gap',reason});this.segment++;this.cycles=0;this.needsTimeBase=true;this.timeKnown=false;this.synced=false;this.state=null;this.zeroes=0;}
  source(h,data,offset){
    const size=data.length,addr=h>>>3,hardware=!!(h&4);let value=0;for(let i=0;i<size;i++)value+=data[i]*2**(i*8);value>>>=0;
    let e;
    if(!hardware){this.stats.itm++;e={kind:'itm',port:this.page*32+addr,value,size};}
    else if(addr===2&&(size===4||(size===1&&value===0))){const kind=size===4?'pc':'sleep';e={kind,pc:value};this.stats[kind]++;}
    else if(addr===1&&size===2&&((value>>>12)&3)>=1){this.stats.exceptions++;e={kind:'exception',exception:value&511,action:['','enter','exit','resume'][(value>>>12)&3]};}
    else e={kind:'hardware',source:addr,value,size};
    this.pending.push({...e,offset,segment:this.segment});
    // Timestamps are optional; cap pending events without inventing a cycle count.
    if(this.pending.length>=1024)this.flush();
  }
  feed(bytes){for(const byte of bytes){
    const offset=this.offset++;this.stats.bytes++;
    // Sync detection must operate even while recovering from an interrupted payload.
    if(byte===0)this.zeroes++;else{
      if(byte===0x80&&this.zeroes>=5){this.flush();this.synced=true;this.state=null;this.page=0;this.stats.sync++;this.zeroes=0;this.event({kind:'sync',offset});continue;}
      this.zeroes=0;
    }
    if(!this.synced){this.stats.skippedBytes++;continue;}
    if(this.state){
      const s=this.state;s.data.push(byte);
      if(s.kind==='source'){if(s.data.length===s.size){this.source(s.header,s.data,s.offset);this.stats.packets++;this.state=null;}continue;}
      if(s.data.length>s.max){this.stats.malformed++;this.gap('协议续字节过长');continue;}
      if(byte&0x80)continue;
      this.stats.packets++;this.state=null;
      let value=0;for(let i=0;i<s.data.length;i++)value+=(s.data[i]&127)*2**(7*i);
      if(s.kind==='timestamp'){
        if(this.needsTimeBase){this.cycles=0;this.needsTimeBase=false;this.flush();continue;}this.cycles+=value;this.timeKnown=true;const tc=(s.header>>>4)&3;
        this.flush(this.cycles,tc?'delayed':'local');
      }else if(s.kind==='extension'&&!(s.header&4))this.page=value;
      // Global/reserved packets have a defined length, but their timestamps are unsupported.
      else if(s.kind==='global')this.flush(null,'unsupported-global');
      continue;
    }
    if(byte===0)continue;
    if(byte===0x70){this.stats.overflow++;this.flush();this.event({kind:'gap',reason:'ITM 溢出：中间事件可能丢失',offset});this.segment++;this.cycles=0;this.needsTimeBase=true;this.timeKnown=false;continue;}
    if(byte&3){this.state={kind:'source',header:byte,size:[0,1,2,4][byte&3],data:[],offset};continue;}
    if((byte&15)===0&&byte!==0x80){
      if(byte&0x80)this.state={kind:'timestamp',header:byte,data:[],max:4,offset};
      else{if(this.needsTimeBase){this.needsTimeBase=false;this.cycles=0;this.flush();}else{this.cycles+=byte>>>4;this.timeKnown=true;this.flush(this.cycles,'local');}this.stats.packets++;}
      continue;
    }
    if(byte===0x94||byte===0xb4){this.state={kind:'global',header:byte,data:[],max:6,offset};continue;}
    if((byte&8)&&byte!==8){
      if(byte&0x80)this.state={kind:'extension',header:byte,data:[],max:4,offset};
      else if(!(byte&4))this.page=(byte>>>4)&7;
      continue;
    }
    // Do not scan payload bytes for 0x17 and silently fabricate PC packets.
    this.stats.malformed++;this.gap('未知 ITM 头部 0x'+byte.toString(16).padStart(2,'0'));
  }}
  finish(){if(this.state){this.stats.truncated++;this.flush();this.event({kind:'gap',reason:'记录末尾截断了一个数据包'});this.state=null;}else this.flush();return {...this.stats};}
}
