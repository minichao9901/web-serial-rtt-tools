/** Separate running-change expiry from comparisons between halted snapshots. */
export class SvdValueState {
  constructor(fadeMs=2000){this.fadeMs=fadeMs;this.entries=new Map();}
  clear(){this.entries.clear();}
  sample(key,raw,{running=false,stopToken=null,now=performance.now()}={}){
    let e=this.entries.get(key);
    if(!e){e={last:null,stopped:null,stopReference:null,stopToken:undefined,liveChanges:[]};this.entries.set(key,e);}
    const value=BigInt(raw);
    if(running){
      if(e.last!==null&&e.last!==value)e.liveChanges.push({mask:e.last^value,until:now+this.fadeMs});
      e.liveChanges=e.liveChanges.filter(c=>c.until>now);
    }else{
      if(e.stopToken!==stopToken){e.stopReference=e.stopped;e.stopToken=stopToken;}
      e.stopped=value;
    }
    e.last=value;return this.highlight(key,{running,now});
  }
  highlight(key,{running=false,now=performance.now()}={}){
    const e=this.entries.get(key);if(!e)return {mask:0n,nextExpiry:null};
    if(!running)return {mask:e.stopReference===null?0n:e.stopped^e.stopReference,nextExpiry:null};
    e.liveChanges=e.liveChanges.filter(c=>c.until>now);
    return {mask:e.liveChanges.reduce((mask,c)=>mask|c.mask,0n),nextExpiry:e.liveChanges.length?Math.min(...e.liveChanges.map(c=>c.until)):null};
  }
}

export function svdAutoReadReason(register){
  if(['write-only','writeOnce'].includes(register?.access))return '只写寄存器不自动读取';
  if(register?.readAction||register?.fields?.some(f=>f.readAction))return '该寄存器读取有副作用，请手动读取';
  return '';
}
