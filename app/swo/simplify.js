import {sourceTokens} from '../dbg/source-syntax.js';

/** Keep physical line numbers while removing comments, including multiline ones. */
export function codeLines(text,path){
  const lines=text.split(/\r?\n/),tokens=sourceTokens(lines,path);
  return tokens?tokens.map(row=>row.map(t=>t.kind==='comment'?' ':t.text).join('').trimEnd()):null;
}

/** Collapse adjacent repeated source locations and blocks, with bounded memory. */
export class CodeOutline {
  constructor(emit,maxBlock=64){this.emit=emit;this.maxBlock=maxBlock;this.pending=[];this.emitted=0;this.removed=0;this.separator=false;}
  push(key,text){
    if(this.pending.at(-1)?.key===key){this.removed++;return;}
    this.pending.push({key,text});
    const n=this.pending.length;
    for(let size=2;size<=Math.min(this.maxBlock,Math.floor(n/2));size++){
      if(this.pending[n-1].key!==this.pending[n-1-size].key)continue;
      let equal=true;for(let i=0;i<size;i++)if(this.pending[n-1-i].key!==this.pending[n-1-size-i].key){equal=false;break;}
      if(equal){this.pending.splice(n-size,size);this.removed+=size;break;}
    }
    if(this.pending.length>this.maxBlock*2)this.write(this.pending.shift());
  }
  write(line){if(this.separator){this.emit('\n');this.separator=false;}this.emit(line.text+'\n');this.emitted++;}
  boundary(){this.flush();if(this.emitted)this.separator=true;}
  flush(){for(const line of this.pending)this.write(line);this.pending=[];}
}
