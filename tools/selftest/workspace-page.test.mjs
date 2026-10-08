/** Layout-only regression. A separate mock tab never acquires the live probe. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Cdp, sleep } from './cdp-lib.mjs';

const c = new Cdp(process.env.CDP || 'http://127.0.0.1:9333', 20000);
const url = process.env.APP || 'http://localhost:8899/index.html';
const out = 'tmp/ui-workspace';
const page = await (await fetch(c.base+'/json/new?'+encodeURIComponent('about:blank'), {method:'PUT'})).json();
const metrics=[];
let pass=0;
function check(ok,label){assert.ok(ok,label);pass++;console.log('PASS '+label);}
async function ready(){
  for(let n=0;n<100;n++){
    if(await c.eval('return !!window.__tools && !!document.getElementById("build-stamp");'))return;
    await sleep(50);
  }
  throw Error('页面初始化超时');
}
async function settle(){await c.eval('await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));');await sleep(80);}
async function click(id){await c.eval(`document.getElementById(${JSON.stringify(id)}).click();`);await settle();}
async function tab(name){await c.eval(`document.querySelector('#tabs [data-tab="${name}"]').click();`);await settle();}
async function geometry(){return c.eval(`
  const r=id=>{const e=document.getElementById(id),b=e.getBoundingClientRect();return {w:b.width,h:b.height,x:b.x,y:b.y,visible:!!e.getClientRects().length};};
  const canvas=document.getElementById('sc-canvas');
  return {width:innerWidth,height:innerHeight,header:document.querySelector('.topbar').getBoundingClientRect().height,
    overflow:document.documentElement.scrollWidth-innerWidth,font:getComputedStyle(document.body).fontSize,
    main:{w:document.querySelector('.panel.active .main').clientWidth},src:r('d-box-src'),term:r('d-box-term'),dock:r('d-box-dock'),scope:r('sc-canvas'),
    canvas:[canvas.width,canvas.height],dpr:devicePixelRatio,
    active:document.querySelector('.panel.active').id,focus:document.querySelector('.panel.active').dataset.focus||null};`);}
async function shot(name){const p=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(`${out}/${name}.png`,Buffer.from(p.data,'base64'));}
async function seed(){await c.eval(`
  const dbg=window.__tools.dbg;
  const text=await (await fetch('/tools/target-firmware/stm32h743_fault/src/main.c')).text();
  dbg._srcPaint(document.getElementById('d-src'),{file:'main.c',line:60},text.split(/\\r?\\n/),null);
  document.getElementById('d-src-file').textContent='main.c · 布局预览';
  dbg._out('布局预览：未连接目标，源码来自 H743 测试例程。','dim');
  const {SampleStore}=await import('./app/scope/store.js');
  const s=window.__tools.scope,vars=[{name:'模拟正弦',scalar:'f32',size:4,addr:0},{name:'模拟方波',scalar:'i16',size:2,addr:4}];
  s.all=vars;s.selected=vars;s.renderVars();
  s.store=new SampleStore(vars,4096);
  for(let i=0;i<4096;i++)s.store.pushFrame([Math.sin(i/4096*Math.PI*12),Math.sin(i/4096*Math.PI*24)>=0?1000:-1000],i*10);
  s.renderer.setStore(s.store);document.querySelector('[data-group=sclayout] [data-v="lanes"]').click();s._needDraw=true;
  s.setStatusText('模拟波形 · 布局预览（未连接目标）','dim');
`);await settle();}
try{
  await mkdir(out,{recursive:true});
  c.ws=await c._open(page.webSocketDebuggerUrl,(_,m)=>c._dispatch(m));
  await c.send('Page.enable');await c.send('Runtime.enable');
  await c.send('Page.navigate',{url:url+'?demo=serial&hid=mock&workspace-test='+Date.now()+'#dbg'});await ready();
  // This origin is isolated from the user's 127.0.0.1 hardware page.
  await c.eval(`const {store}=await import('./app/core/store.js');for(const k of ['dbg.termH','workspace.dbg.sidebarCollapsed','workspace.scope.sidebarCollapsed'])store.set(k,0);`);
  await c.send('Page.reload',{ignoreCache:true});await ready();
  check(await c.eval(`return document.querySelectorAll('#tabs [data-tab]').length===13;`),'13 个工具入口保留');
  await seed();
  for(const width of [1920,1280,960]){
    await c.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await settle();
    await tab('dbg');const normal=await geometry();metrics.push({mode:'default',...normal});
    check(normal.overflow<=1&&normal.font==='13px',`${width}：不横向溢出，保留字号`);
    check(normal.header<=70,`${width}：紧凑顶栏`);
    if(width>=1280)check(normal.src.h>normal.term.h*2,`${width}：源码占左列大部分高度`);
    await shot(`dbg-${width}`);
    await click('d-layout-sidebar');const wide=await geometry();
    check(wide.main.w>normal.main.w,`${width}：折叠设置扩大工作区`);
    check(await c.eval(`return document.getElementById('d-layout-sidebar').getAttribute('aria-expanded')==='false';`),'侧栏折叠状态可访问');
    await click('d-layout-sidebar');
    for(const target of ['src','term','dock']){
      await click('d-max-'+target);const focused=await geometry();
      check(focused.header===0&&focused[target].w>normal[target].w&&focused[target].h>normal[target].h,`${width}：最大化 ${target}`);
      check(await c.eval(`return document.getElementById('d-max-${target}').getClientRects().length>0;`),'还原按钮可见');
      await click('d-max-'+target);const restored=await geometry();
      check(Math.abs(restored.src.h-normal.src.h)<1&&Math.abs(restored.src.w-normal.src.w)<1,'还原原始布局');
    }
    await tab('scope');const scope=await geometry();metrics.push({mode:'default',...scope});
    check(Math.abs(scope.canvas[0]-scope.scope.w*scope.dpr)<=1&&Math.abs(scope.canvas[1]-scope.scope.h*scope.dpr)<=1,'停止采集的画布像素匹配尺寸');
    await shot(`scope-${width}`);
    await click('sc-layout-focus');const full=await geometry();metrics.push({mode:'maximized',...full});
    check(full.scope.w>scope.scope.w&&full.scope.h>scope.scope.h&&full.header===0,`${width}：波形最大化`);
    check(Math.abs(full.canvas[0]-full.scope.w*full.dpr)<=1&&Math.abs(full.canvas[1]-full.scope.h*full.dpr)<=1,'最大化后自动重绘画布');
    await shot(`scope-full-${width}`);
    await c.eval(`window.__tools.scope.renderer.cursors.a=123;window.__tools.scope.renderer.cursors.b=321;`);
    await c.eval(`document.getElementById('sc-layout-focus').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);await settle();
    check((await geometry()).focus===null,'Esc 还原波形');
    check(await c.eval(`const m=window.__tools.scope.renderer.cursors;return m.a===123&&m.b===321;`),'还原操作保留测量游标');
    await c.eval(`window.__tools.scope.renderer.clearMarks();`);
  }
  await tab('dbg');await click('d-layout-focus');await click('d-layout-sidebar');
  check(await c.eval(`return !document.querySelector('#tab-dbg').dataset.focus&&!document.querySelector('#tab-dbg').classList.contains('sidebar-collapsed');`),'专注模式可以展开设置');
  await click('d-layout-sidebar');await tab('scope');
  check(await c.eval(`return !document.querySelector('#tab-scope').classList.contains('sidebar-collapsed');`),'两页侧栏状态独立');
  await c.send('Page.reload',{ignoreCache:true});await ready();await tab('dbg');
  check(await c.eval(`return document.querySelector('#tab-dbg').classList.contains('sidebar-collapsed')&&!document.querySelector('#tab-dbg').dataset.focus;`),'刷新保留侧栏选择，最大化不持久化');
  await click('d-layout-sidebar');
  await c.eval(`const {store}=await import('./app/core/store.js');store.set('dbg.termH',180);store.set('dbg.dockW',340);`);
  await c.send('Page.reload',{ignoreCache:true});await ready();await tab('dbg');await settle();
  const saved=await geometry();
  await click('d-max-term');await click('d-max-term');const back=await geometry();
  check(Math.abs(saved.term.h-back.term.h)<1&&Math.abs(saved.dock.w-back.dock.w)<1,'最大化不覆盖已保存的分隔条尺寸');
  await click('d-layout-focus');await tab('scope');
  check((await geometry()).header>0,'切页恢复顶栏');
  await tab('dbg');check((await geometry()).header===0,'返回专注页保留临时布局');
  await click('d-layout-focus');
  await tab('scope');await click('sc-layout-focus');await click('sc-quality');
  await c.eval(`document.getElementById('sc-layout-focus').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);await settle();
  check(await c.eval(`return !!document.querySelector('#tab-scope').dataset.focus && document.querySelector('.diag-drawer').hidden;`),'Esc 优先关闭质量面板');
  await click('sc-layout-focus');
  check(await c.eval(`return !document.getElementById('btn-help').getClientRects().length;`),'更多菜单默认折叠');
  await c.eval(`document.querySelector('#app-more>summary').click();`);
  check(await c.eval(`return ['btn-help','lnk-github','build-stamp'].every(id=>document.getElementById(id).getClientRects().length);`),'帮助、仓库与版本可展开查看');
  await c.eval(`document.getElementById('d-layout-sidebar').click();`);
  check(await c.eval(`return !document.getElementById('app-more').open;`),'菜单点击外部关闭');
  for(const width of [760,600]){
    await c.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await settle();
    for(const name of ['dbg','scope']){await tab(name);check((await geometry()).overflow<=1,`${width} ${name}：窄窗口不溢出`);}
    await c.eval(`document.querySelector('#app-more>summary').click();`);
    check(await c.eval(`return document.getElementById('build-stamp').getClientRects().length>0;`),'窄窗口菜单保留版本信息');
    await c.eval(`document.getElementById('app-more').open=false;`);
  }
  check(await c.eval(`return window.__tools.errors.length===0;`),'无未捕获页面错误');
  await writeFile(out+'/metrics.json',JSON.stringify({pass,metrics},null,2));
  console.log('Workspace layout: '+pass+' passed; screenshots '+out);
}finally{c.close();await fetch(c.base+'/json/close/'+page.id);}
