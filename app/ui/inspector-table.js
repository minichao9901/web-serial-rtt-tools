/** Display-only tables: shared columns, persistent resizing and transient value flashes. */
import { store } from '../core/store.js';

export class InspectorTable {
  constructor(root, columns, label){
    this.root=root;this.columns=columns;this.key=`inspector.${root.id}.widths`;
    const saved=store.get(this.key,[]);
    this.widths=columns.map((c,i)=>Number.isFinite(saved?.[i])?Math.min(800,Math.max(c.min,saved[i])):null);
    root.classList.add('inspector-table');root.setAttribute('role','table');root.setAttribute('aria-label',label);
    root.replaceChildren();
    this.head=document.createElement('div');this.head.className='table-head table-row';this.head.setAttribute('role','row');
    this.body=document.createElement('div');this.body.className='table-body';this.body.setAttribute('role','rowgroup');
    root.append(this.head,this.body);
    columns.forEach((c,i)=>{
      const cell=document.createElement('div');cell.className='table-col';cell.setAttribute('role','columnheader');cell.textContent=c.label;
      this.head.append(cell);
      if(c.resize===false)return;
      const grip=document.createElement('span');grip.className='column-grip';grip.tabIndex=0;
      grip.setAttribute('role','separator');grip.setAttribute('aria-orientation','vertical');
      grip.setAttribute('aria-label',`调整${c.label}列宽`);grip.setAttribute('aria-valuemin',c.min);grip.setAttribute('aria-valuemax','800');
      grip.title='拖动调整列宽；方向键微调，双击恢复本表默认列宽';cell.append(grip);
      let drag=null;
      const save=()=>store.set(this.key,this.widths.slice());
      const move=e=>{if(drag&&e.pointerId===drag.id)this.setWidth(i,drag.width+e.clientX-drag.x);};
      const finish=commit=>{
        if(!drag)return;
        const previous=drag.previous;drag=null;
        window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);
        window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel);
        if(commit)save();else{this.widths[i]=previous;this.apply();}
      };
      const up=e=>{if(drag&&e.pointerId===drag.id)finish(true);};
      const cancel=e=>{if(drag&&(e.type==='blur'||e.pointerId===drag.id))finish(false);};
      grip.addEventListener('pointerdown',e=>{
        if(e.button!==0||drag)return;
        drag={x:e.clientX,width:cell.getBoundingClientRect().width,id:e.pointerId,previous:this.widths[i]};
        // Window listeners also survive capture loss when the browser changes focus.
        window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);
        window.addEventListener('pointercancel',cancel);window.addEventListener('blur',cancel);
        e.preventDefault();
      });
      grip.addEventListener('dblclick',()=>{this.widths.fill(null);this.apply();save();});
      grip.addEventListener('keydown',e=>{
        if(!['ArrowLeft','ArrowRight'].includes(e.key))return;
        this.setWidth(i,cell.getBoundingClientRect().width+(e.key==='ArrowLeft'?-1:1)*(e.shiftKey?32:8));save();e.preventDefault();e.stopPropagation();
      });
    });
    this.apply();
  }
  setWidth(i,width){this.widths[i]=Math.round(Math.min(800,Math.max(this.columns[i].min,width)));this.apply();}
  apply(){
    const min=this.columns.reduce((n,c,i)=>n+(this.widths[i]??(c.fixed?c.width:c.min)),0)+4*(this.columns.length-1)+8;
    const template=this.columns.map((c,i)=>this.widths[i]!=null?`${this.widths[i]}px`:c.fixed?`${c.width}px`:`minmax(${c.min}px,${c.width}fr)`).join(' ');
    this.root.style.setProperty('--table-cols',template);this.root.style.setProperty('--table-min',`${min}px`);
    this.head.querySelectorAll('.column-grip').forEach(g=>{const i=[...this.head.children].indexOf(g.parentElement);g.setAttribute('aria-valuenow',Math.round(this.widths[i]??this.columns[i].width));});
  }
  clear(){this.body.replaceChildren();return this.body;}
  row(el){el.classList.add('table-row');el.setAttribute('role','row');return el;}
  cell(el){el.setAttribute('role','cell');return el;}
}

export function flashValue(cell){
  for(const a of cell.getAnimations())a.cancel();
  cell.animate([{backgroundColor:'#b88b3266'},{backgroundColor:'transparent'}],{duration:1400,easing:'ease-out'});
}
