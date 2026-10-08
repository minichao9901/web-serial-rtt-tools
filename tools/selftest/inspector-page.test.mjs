/** Display-only acceptance, independent tab and synthetic values; no target operations. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Cdp, sleep } from './cdp-lib.mjs';
const c=new Cdp(process.env.CDP||'http://127.0.0.1:9333',20000);
const app=process.env.APP||'http://localhost:8899/index.html',out='tmp/ui-inspector';
const page=await(await fetch(c.base+'/json/new?'+encodeURIComponent('about:blank'),{method:'PUT'})).json();
let pass=0;const report=[];
function ok(v,label){assert.ok(v,label);pass++;console.log('PASS '+label);}
async function ready(){for(let n=0;n<100;n++){if(await c.eval(`return !!document.getElementById('build-stamp');`))return;await sleep(50);}throw Error('初始化超时');}
async function settle(){await c.eval(`await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));`);await sleep(60);}
async function shot(name){const r=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(`${out}/${name}.png`,Buffer.from(r.data,'base64'));}
async function seed(){await c.eval(`
  const d=window.__tools.dbg;
  d.loadElfBuffer(await(await fetch('/tools/target-firmware/stm32h743_fault/fw.elf')).arrayBuffer(),'stm32h743_fault.elf');
  const text=await(await fetch('/tools/target-firmware/stm32h743_fault/src/main.c')).text();
  d._srcPaint(document.getElementById('d-src'),{file:'main.c',line:60},text.split(/\\r?\\n/),null);
  document.getElementById('d-src-file').textContent='main.c · 模拟显示数据 / UI 验收';
  window.__inspectorReads=0;d.session.memRead=async()=>{window.__inspectorReads++;throw Error('布局测试禁止读目标');};
  d.session.regs=[{name:'R0',value:1500,changed:false},{name:'R1',value:0x24000000,changed:false},{name:'SP',value:0x24040000,changed:false},{name:'LR',value:0x080000fd,changed:false},{name:'PC',value:0x080000f0,changed:false},{name:'XPSR',value:0x21000000,changed:false}];d.renderRegs();
  const type={kind:'struct',name:'status_t',size:8,members:[{name:'counter',offset:0,type:{kind:'scalar',scalar:'u32',size:4}},{name:'flags',offset:4,type:{kind:'scalar',scalar:'u16',size:2}}]};
  d.watch.items=[{expr:'g_status',label:'g_status',kind:'struct',addr:0x24000000,size:8,typeName:'status_t',type,expanded:true,bytes:Uint8Array.of(220,5,0,0,3,0,0,0),value:{text:'{counter=1500, flags=3}',type:'status_t'}},
    {expr:'g_ticks',label:'g_ticks',kind:'var',addr:0x24000008,size:4,typeName:'uint32_t',value:{text:'123456',hex:'0x1e240',type:'uint32_t'}},
    {expr:'g_long_variable_name_for_layout',label:'g_long_variable_name_for_layout',kind:'var',addr:0x2400000c,size:4,typeName:'float',value:{text:'0.707107',hex:'0x3f3504f3',type:'float'}},
    {expr:'unknown_symbol',error:'找不到符号 unknown_symbol'}];
  d.renderWatch();d._dockSelect('var',{save:false});
  d._out('UI 验收：寄存器和监视值为模拟显示数据，未连接目标。','dim');
`);await settle();}
try{
  await mkdir(out,{recursive:true});c.ws=await c._open(page.webSocketDebuggerUrl,(_,m)=>c._dispatch(m));
  await c.send('Page.enable');await c.send('Runtime.enable');
  await c.send('Page.navigate',{url:app+'?demo=serial&hid=mock&inspector-test=1#dbg'});await ready();
  await c.eval(`const {store}=await import('./app/core/store.js');for(const k of ['dbg.termH','dbg.dockW','workspace.dbg.sidebarCollapsed'])store.set(k,0);for(const id of ['d-regs','d-sym-list','d-watch-list'])store.set('inspector.'+id+'.widths',[]);`);
  await c.send('Page.reload',{ignoreCache:true});await ready();await seed();
  for(const width of [1920,1280,960,600]){
    await c.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await settle();
    const r=await c.eval(`const p=document.querySelector('.topbar');return {width:innerWidth,height:p.getBoundingClientRect().height,overflow:document.documentElement.scrollWidth-innerWidth,tabs:document.querySelectorAll('#tabs [data-tab]').length,font:getComputedStyle(document.body).fontSize};`);report.push(r);
    ok(r.height<=42&&r.overflow<=1&&r.tabs===14&&r.font==='13px',`${width}：单行顶栏，保留入口与字号`);
    await shot(`debugger-${width}`);
    const aligned=await c.eval(`const rows=[...document.querySelectorAll('#d-watch-list .table-row')].filter(e=>e.children.length===5);return rows.every(e=>[...e.children].every((cell,i)=>Math.abs(cell.getBoundingClientRect().x-rows[0].children[i].getBoundingClientRect().x)<1));`);
    ok(aligned,`${width}：父项与结构体成员共用列宽`);
  }
  await c.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await settle();
  ok(await c.eval(`return [...document.querySelectorAll('#tabs>.primary-tabs .tab')].map(e=>e.dataset.tab).join(',')==='serial,terminal,rtt,rttcdc,scope,flash,dbg'&&!document.getElementById('tool-switch').open;`),'7 个常用工具平铺，更多功能菜单默认关闭');
  await c.eval(`document.querySelector('#tool-switch>summary').click();`);await settle();
  ok(await c.eval(`return document.querySelectorAll('#tool-switch .tool-menu>.tab').length===7&&[...document.querySelectorAll('#tool-switch .tool-menu>.tab')].map(e=>e.textContent.trim()).join(',')==='USB→SPI/QSPI,SPI/QSPI屏,SPI转发,SWO 执行轨迹,USB→I2C,USB→ADC/DAC,工程生成'&&!document.querySelector('#tool-switch .tool-group');`),'更多功能按指定顺序列出 7 项且不分类');await shot('tools-menu');
  await c.eval(`document.querySelector('#tool-switch [data-tab="spicdc"]').click();`);await settle();
  ok(await c.eval(`return !document.getElementById('tool-switch').open&&document.getElementById('tool-switch').classList.contains('has-current')&&location.hash==='#spicdc'&&document.activeElement===document.querySelector('#tool-switch>summary');`),'从更多功能切换后关闭菜单、更新地址并归还焦点');
  await c.eval(`location.hash='#dbg';`);await settle();
  ok(await c.eval(`return document.querySelector('#tabs [data-tab="dbg"]').classList.contains('active')&&!document.getElementById('tool-switch').classList.contains('has-current');`),'地址跳转同步平铺工具选中状态');
  await c.eval(`const s=document.querySelector('#tool-switch>summary');s.focus();s.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));`);
  ok(await c.eval(`return document.getElementById('tool-switch').open&&document.activeElement.dataset.tab==='spi';`),'方向键打开菜单并定位首个更多功能');
  await c.eval(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);
  ok(await c.eval(`return !document.getElementById('tool-switch').open && document.activeElement===document.querySelector('#tool-switch>summary');`),'Esc 关闭菜单并还原焦点');
  const drag=await c.eval(`const h=document.querySelector('#d-watch-list .column-grip'),b=h.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2,width:h.parentElement.getBoundingClientRect().width};`);
  await c.send('Page.bringToFront');
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:drag.x,y:drag.y,button:'left',buttons:1,clickCount:1});
  await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:drag.x+70,y:drag.y,buttons:1});
  await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:drag.x+70,y:drag.y,button:'left',buttons:0,clickCount:1});await settle();
  const resized=await c.eval(`return document.querySelector('#d-watch-list .table-col').getBoundingClientRect().width;`);
  ok(Math.abs(resized-drag.width-70)<2,'真实指针拖动改变列宽');
  await c.eval(`const h=document.querySelector('#d-watch-list .column-grip');h.focus();h.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));`);await settle();
  ok(await c.eval(`return Math.abs(document.querySelector('#d-watch-list .table-col').getBoundingClientRect().width-${resized}-8)<2;`),'键盘微调列宽');
  ok(await c.eval(`const d=window.__tools.dbg,t=d._inspector('watch'),before=t.widths[0],h=t.head.querySelector('.column-grip');h.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:42,clientX:100,bubbles:true}));window.dispatchEvent(new PointerEvent('pointermove',{pointerId:42,clientX:120}));const moved=t.widths[0]!==before;window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:42}));window.dispatchEvent(new PointerEvent('pointermove',{pointerId:42,clientX:140}));return moved&&t.widths[0]===before;`),'取消拖动恢复原列宽并清理跟踪事件');
  ok(await c.eval(`const d=window.__tools.dbg;d.renderWatch();return document.querySelector('#d-watch-list .table-col').getBoundingClientRect().width>${drag.width}+70;`),'刷新值保留列宽');
  ok(await c.eval(`const row=document.querySelectorAll('#d-watch-list .wrow')[1];return row.querySelector('.ad').textContent==='0x24000008'&&/0x1e240/.test(row.querySelector('.vl').title);`),'地址独立显示，完整十六进制值可查看');
  await c.eval(`const d=window.__tools.dbg;d.watch.items[1].value={text:'123457',hex:'0x1e241',type:'uint32_t'};d.watch.items[0].bytes[0]++;d.renderWatch();`);
  ok(await c.eval(`return document.querySelectorAll('#d-watch-list .wrow')[1].querySelector('.vl').getAnimations().length>0&&document.querySelector('#d-watch-list .wkid .vl').getAnimations().length>0;`),'标量与结构体成员变化短暂高亮');
  await sleep(1550);
  ok(await c.eval(`return document.querySelectorAll('#d-watch-list .wrow')[1].querySelector('.vl').getAnimations().length===0;`),'高亮自动结束');
  await c.eval(`window.__tools.dbg.renderWatch();`);
  ok(await c.eval(`return document.querySelectorAll('#d-watch-list .wrow')[1].querySelector('.vl').getAnimations().length===0;`),'相同值重绘不反复高亮');
  await c.eval(`const d=window.__tools.dbg;d._dockSelect('regs',{save:false});const input=document.querySelector('#d-regs input');window.__regInput=input;input.focus();input.value='123';d.session.regs[0].value=42;d.session.regs[0].changed=true;d.renderRegs();`);
  ok(await c.eval(`return document.querySelector('#d-regs input')===window.__regInput && window.__regInput.value==='123';`),'刷新寄存器保留正在编辑的输入');await shot('registers-1280');
  ok(await c.eval(`return window.__regInput.getAnimations().length>0;`),'寄存器变化短暂高亮');
  await c.eval(`window.__regInput.blur();window.__tools.dbg.renderRegs();window.__tools.dbg._dockSelect('var',{save:false});document.querySelectorAll('#d-watch-list button[data-del]')[1].click();`);
  ok(await c.eval(`return window.__tools.dbg.watch.items.map(it=>it.expr).join(',')==='g_status,g_long_variable_name_for_layout,unknown_symbol';`),'删除指定监视项不会错位');
  const savedWidth=await c.eval(`return window.__tools.dbg._inspector('watch').widths[0];`);
  ok(await c.eval(`return window.__inspectorReads===0;`),'显示与布局操作不读取目标');
  await c.send('Page.reload',{ignoreCache:true});await ready();
  ok(await c.eval(`return window.__tools.dbg._inspector('watch').widths[0]===${savedWidth};`),'重载保留列宽');
  await c.eval(`document.querySelector('#d-watch-list .column-grip').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));`);
  ok(await c.eval(`return window.__tools.dbg._inspector('watch').widths.every(v=>v===null);`),'双击分隔线恢复本表默认列宽');
  ok(await c.eval(`return window.__tools.errors.length===0;`),'无未捕获错误');
  await writeFile(out+'/report.json',JSON.stringify({pass,report},null,2));console.log('Inspector UI: '+pass+' passed; screenshots '+out);
}finally{c.close();await fetch(c.base+'/json/close/'+page.id);}
