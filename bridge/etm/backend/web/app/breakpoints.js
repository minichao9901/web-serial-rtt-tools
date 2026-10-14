import {decodeFpCtrl,encodeComparator,canBreak,compAddr} from './shared/dbg/bp.js';

/** 只租用空闲 FPB 槽位；挂起保留列表，删除/断开恢复原寄存器。 */
export class Breakpoints {
  constructor(target){this.target=target;this.items=[];this.originalEnabled=null;this.capacity=null;}
  add(item){let bp=this.items.find(b=>b.address===item.address);if(!bp){bp={...item,enabled:true,status:'待下发',lease:null};this.items.push(bp);}return bp;}
  async arm(bp){
    if(!bp.enabled||bp.lease)return;
    const t=this.target,caps=decodeFpCtrl(await t.read(0xe0002000));this.capacity=caps.numCode;
    if(!canBreak(bp.address,caps.rev))throw Error('该地址不支持硬件断点');
    let free=null,foreign=false;
    const ours=new Set(this.items.filter(b=>b.lease).map(b=>b.lease.slot));
    for(let i=0;i<caps.numCode;i++){const slot=compAddr(i),value=await t.read(slot);if(value&1){if(!ours.has(slot))foreign=true;}else if(!free)free={slot,before:value};}
    if(!caps.enabled&&foreign)throw Error('FPB 关闭但保留了其他页面的断点，不能擅自启用');
    if(!free)throw Error('没有空闲硬件断点槽位；请禁用或删除一个断点');
    if(this.originalEnabled===null)this.originalEnabled=caps.enabled;
    const encoded=encodeComparator(bp.address,caps.rev);bp.lease={...free,encoded};
    try{await t.write(free.slot,encoded);await t.write(0xe0002000,3,false);bp.status='已生效';}
    catch(e){
      const actual=await t.read(free.slot);
      if(actual===free.before){bp.lease=null;bp.status='待下发';if(!this.items.some(b=>b.lease))this.originalEnabled=null;}
      else await this.disarm(bp);
      throw e;
    }
  }
  async disarm(bp){
    if(!bp.lease)return;
    const t=this.target,l=bp.lease;
    if(await t.read(l.slot)!==l.encoded)throw Error('本页断点槽位被其他工具改变，拒绝覆盖');
    await t.write(l.slot,l.before);bp.lease=null;bp.status=bp.enabled?'待下发':'已禁用';
    if(!this.items.some(b=>b.lease)&&this.originalEnabled!==null){
      const c=decodeFpCtrl(await t.read(0xe0002000));let active=false;
      for(let i=0;i<c.numCode;i++)if(await t.read(compAddr(i))&1)active=true;
      if(!this.originalEnabled&&!active)await t.write(0xe0002000,2,false);
      this.originalEnabled=null;
    }
  }
  async suspend(){for(const b of this.items)await this.disarm(b);}
  async resume(items=this.items){for(const b of items)if(b.enabled&&this.items.includes(b))await this.arm(b);}
  async remove(bp){await this.disarm(bp);this.items=this.items.filter(b=>b!==bp);}
  async clear(){await this.suspend();this.items=[];}
  hit(pc){for(const b of this.items)if(b.lease)b.status=b.address===pc?'已命中':'已生效';}
}
