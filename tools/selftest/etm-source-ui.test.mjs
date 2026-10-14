import test from 'node:test';
import assert from 'node:assert/strict';
import {bindFunctionTimeline} from '../../bridge/etm/backend/web/app/function-timeline.js';
import {HistoryView} from '../../bridge/etm/backend/web/app/history.js';

test('timeline wheel zoom uses selected cursor rather than pointer position',()=>{
  globalThis.window={devicePixelRatio:1};globalThis.ResizeObserver=class{observe(){}disconnect(){}};const events=new Map(),ranges=[];
  const canvas={hidden:false,dataset:{},style:{},getContext:()=>new Proxy({},{get:()=>()=>{}}),getBoundingClientRect:()=>({left:0,width:1000}),setAttribute(){},addEventListener:(name,fn)=>events.set(name,fn)};
  const chart=bindFunctionTimeline(canvas,{onRange:r=>ranges.push(r),onSelect(){},onError:e=>{throw e;}});
  chart.setData({range:{start:0,end:100,totalStart:0,totalEnd:100},binCount:1,lanes:[],markers:[]});chart.setCursor(25);
  events.get('wheel')({ctrlKey:true,clientX:950,deltaY:-1,preventDefault(){}});assert.deepEqual(ranges,[{start:12,end:62}]);chart.destroy();
});

test('hovering an ETM marker works at original and resized plot geometry',()=>{
  globalThis.window={devicePixelRatio:1};globalThis.ResizeObserver=class{observe(){}disconnect(){}};
  const events=new Map();let width=800;
  const canvas={hidden:false,dataset:{},style:{},getContext:()=>new Proxy({},{get:()=>()=>{}}),getBoundingClientRect:()=>({left:40,width}),setAttribute(){},addEventListener:(name,fn)=>events.set(name,fn)};
  const plot=bindFunctionTimeline(canvas,{onRange(){},onSelect(){},onError:error=>{throw error;}});
  plot.setData({range:{start:0,end:100,totalStart:0,totalEnd:100},binCount:2,lanes:[{name:'main',records:10,bins:[5,5]}],markers:[{seq:50,type:9}]});
  const hoverMarker=()=>events.get('pointermove')({clientX:40+Number(canvas.dataset.plotLeft)+50/101*Number(canvas.dataset.plotWidth)});
  assert.doesNotThrow(hoverMarker);assert.match(canvas.title,/中断进入/);
  width=400;plot.redraw();assert.doesNotThrow(hoverMarker);assert.match(canvas.title,/中断进入/);plot.destroy();
});

class Element{
  constructor(){this.children=[];this.value='instruction';this.offsetTop=0;this.classList={toggle(){},add(){},remove(){}};this._text='';}
  set textContent(text){this._text=text;this.children=[];}get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  append(...children){this.children.push(...children);}replaceChildren(...children){this._text='';this.children=children.flatMap(c=>c.fragment?c.children:[c]);}
  querySelectorAll(){return [];}querySelector(){return null;}
}
test('selected mapped source refreshes from an empty cache; libc remains unmapped and can navigate to source',async()=>{
  const elements=new Map();globalThis.document={getElementById:id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement:()=>new Element(),createDocumentFragment:()=>Object.assign(new Element(),{fragment:true})};
  document.getElementById('nav-mode');
  let available='';const file='E:/build/src/main.c';const calls=[];
  const history=Object.assign(Object.create(HistoryView.prototype),{range:null,view:'instructions',result:{},sid:'sample',selectRevision:0,sources:new Map(),timelineChart:{setCursor(){}},render:async()=>{},onError:error=>{throw error;},api:async path=>{
    calls.push(path);
    if(path.includes('/navigate?'))return {seq:1};
    if(path.includes('/source?'))return {text:available};
    const mapped=path.endsWith('/1');return {stackBasis:'trace',callPath:[],event:{seq:mapped?1:0,kind:'instruction',pc:mapped?0x8000802:0x8003d86,function:mapped?'main':'memset',file:mapped?file:'',line:mapped?2:null,bytes:'00',mnemonic:'nop',operands:'',executed:true}};
  }});
  await history.select(1);assert.match(elements.get('source-code').textContent,/尚未载入/);
  available='int main(void) {\n  return 0;\n}';await history.refreshSources();assert.match(elements.get('source-code').textContent,/return 0/);
  const firstLine=elements.get('source-code').children[0];await history.select(1);assert.equal(elements.get('source-code').children[0],firstLine);
  await history.select(0);const box=elements.get('source-code');assert.match(box.textContent,/memset.*没有 DWARF/);assert.doesNotMatch(box.textContent,/return 0/);
  await box.children[1].children[1].onclick();assert.match(calls.findLast(path=>path.includes('/navigate?')),/mode=source/);assert.match(box.textContent,/return 0/);
  assert.equal(elements.get('nav-mode').value,'instruction');
});
test('hidden timeline skips drawing and a cursor move reuses its canvas allocation',()=>{
 globalThis.window={devicePixelRatio:1};globalThis.ResizeObserver=class{observe(){}disconnect(){}};
 let hidden=false,allocations=0,draws=0,w=0,h=0;const canvas={hidden:false,dataset:{},style:{},closest:()=>hidden?{}:null,getContext:()=>new Proxy({},{get:(_,k)=>k==='clearRect'?()=>draws++:()=>{}}),getBoundingClientRect:()=>({left:0,width:800}),setAttribute(){},addEventListener(){},get width(){return w;},set width(v){w=v;allocations++;},get height(){return h;},set height(v){h=v;allocations++;}};
 const chart=bindFunctionTimeline(canvas,{onRange(){},onSelect(){},onError:e=>{throw e;}});chart.setData({range:{start:0,end:10},lanes:[],markers:[],binCount:1});const count=allocations;chart.setCursor(4);assert.equal(allocations,count);assert.ok(draws>1);
 hidden=true;const before=draws;chart.redraw();assert.equal(draws,before);chart.destroy();
});
