import {parseHTML} from 'linkedom';import {readFile} from 'node:fs/promises';
import {ProbeManager} from '../../app/core/probe-manager.js';
let instance=0;
export function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
export async function ui(){
  const {window:dom}=parseHTML(await readFile(new URL('../../bridge/etm/backend/web/index.html',import.meta.url),'utf8'));
  const window={document:dom.document,HTMLElement:dom.HTMLElement,addEventListener(){},devicePixelRatio:1};
  const {document}=window;document.body.dataset.embedded='1';
  const $=id=>document.getElementById(id),events=[],intervals=[],requests=[],jobs=[];
  const model={halted:false,pc:0x08000590,fault:false,block:null,jobStates:['armed','done'],jobError:null};
  const saved=new Map(),globals={window,document,innerWidth:1500,ResizeObserver:class{observe(){}disconnect(){}},
    Option:function(text,value){const e=document.createElement('option');e.textContent=text;e.value=String(value);return e;},
    requestAnimationFrame:fn=>fn(),setInterval:fn=>{intervals.push(fn);return intervals.length;}};
  for(const input of document.querySelectorAll('input[type=checkbox]'))input.checked=input.hasAttribute('checked');
  for(const select of document.querySelectorAll('select')){
    let value=select.querySelector('[selected]')?.getAttribute('value')||select.querySelector('option')?.getAttribute('value')||'';
    Object.defineProperty(select,'value',{get:()=>value,set:v=>{value=String(v);}});
  }
  window.HTMLElement.prototype.getBoundingClientRect=()=>({left:0,top:0,width:1000,height:400});
  for(const canvas of document.querySelectorAll('canvas'))canvas.getContext=()=>new Proxy({measureText:text=>({width:String(text).length*7})},{get:(obj,key)=>obj[key]||(()=>{})});
  const info={profile:'stm32f103ze',name:'F103ZE',device:0x414,core:'Cortex-M3',etmVersion:'ETMv3',traceSupported:true,flashLimit:0x08080000,
    traceOptions:{branchBroadcast:true,returnStack:false,cycleCount:false},config:{protocol:'ETMv3',idr:0x4114f241,ctrl:0x810,ccer:0x18800,traceid:2},clocks:{coreHz:48e6,hclkHz:48e6,physicalTraceHz:24e6,path:'HSE 8 MHz'},rcc:{}};
  const elf={name:'fw-ze.elf',sha256:'a'.repeat(64),elfId:'elf-'+'a'.repeat(32),sourceFiles:[],segments:[],functions:[{name:'cdc_acm_init',address:0x080004d0},{name:'cdc_poll',address:0x08000590}]};
  const manager=new ProbeManager({locks:null});let bridge;
  const host={probeType:class{},attach:b=>{bridge=b;},run:fn=>manager.run('etm',fn)};
  manager.register('etm',{resources:['target-engine','dap-bulk'],active:()=>!!bridge?.probe(),protected:()=>!!bridge?.busy(),release:()=>bridge.release()});
  manager.register('dbg',{resources:['target-engine','dap-bulk'],active:()=>false,release:async()=>{}});
  globals.fetch=async(url,options={})=>{
    const path=String(url).replace(/^.*\/api\//,'');requests.push(path);
    if(model.block?.path===path)await model.block.promise;
    let data={};
    if(path==='records')data=[];
    else if(path==='elf')data=elf;
    else if(path==='import')data={record:'raw-record'};
    else if(path==='decode/raw-record')data={job:'decode-a'};
    else if(path==='capture'){jobs.push(options.body);data={job:'capture-a',record:'record-a'};}
    else if(path.startsWith('jobs/')){const phase=model.jobStates.length>1?model.jobStates.shift():model.jobStates[0];data={state:phase,record:'record-a',error:model.jobError||'capture failed'};}
    else if(path.startsWith('stop/')){events.push('stop-la');model.jobStates=['cancelled'];}
    else if(path==='status')data={rates:[500e6]};
    else throw Error('Unexpected test API '+path);
    return {ok:true,status:200,json:async()=>data};
  };
  for(const [key,value]of Object.entries(globals)){saved.set(key,globalThis[key]);globalThis[key]=value;}
  window.parent={__tools:{etm:host}};window.addEventListener=()=>{};window.devicePixelRatio=1;
  await import(new URL('../../bridge/etm/backend/web/app/view.js?test='+instance++,import.meta.url));
  for(let n=0;n<10&&window.__etm.state.operation;n++)await new Promise(r=>setImmediate(r));
  const {target,state,history}=window.__etm,mem=new Map([[0xe0002000,0x260]]);
  const probe={_faulted:false,run:async()=>{model.halted=false;events.push('run');},halt:async()=>{model.halted=true;},disconnect:async()=>{}};
  target.read=async a=>mem.get(a)||0;target.write=async(a,v)=>{mem.set(a,a===0xe0002000?0x260|(v&1):v);};
  target.inspect=async()=>{target.info={...info,halted:model.halted};target.config={...info.config};return target.info;};
  target.connect=async()=>{target.probe=probe;return target.inspect();};target.disconnect=async()=>{await target.breakpoints.suspend();target.probe=null;target.config=null;};
  target.halt=async()=>{events.push('halt');model.halted=true;};target.isHalted=async()=>model.halted;target.pc=async()=>model.pc;
  target.verifyElf=async()=>{events.push('verify');model.halted=true;if(model.verifyError)throw Error(model.verifyError);};
  target.reset=target.runTo=async({address}={})=>{if(typeof address!=='number')address=state.entryAddress;events.push('entry');model.pc=address;model.halted=true;if(model.entryError)throw Error(model.entryError);return target.inspect();};
  target.configure=async()=>{events.push('configure');return target.inspect();};
  target.run=async()=>{events.push('run');model.halted=false;};target.restore=async()=>{events.push('restore');};target.clearEntryBreak=async()=>{};
  target.recoverDebugPort=async()=>{events.push('recover');probe._faulted=false;target.debugFault=false;model.halted=true;return target.inspect();};
  history.load=async sid=>{history.sid=sid;};
  return {$,window,target,state,history,events,requests,jobs,model,manager,intervals,elf,
    click:async id=>{const el=$(id);if(el.disabled)throw Error('Button disabled: '+id);return el.onclick();},
    upload:async()=>{Object.defineProperty($('elf-file'),'files',{configurable:true,value:[new File(['elf'],'fw.elf')]});await $('elf-file').onchange();},
    select:async()=>{await $('capture-symbol').querySelector('button').onclick();},
    close:()=>{for(const [key,value]of saved)globalThis[key]=value;}};
}
