/** Layout regression and screenshots at 1600 / 1280; uses the existing mock CDP test browser. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const APP = process.env.APP || 'http://localhost:8899/index.html';
const out = 'tmp/ui-review/after';
// Separate tab: never navigate a user's active hardware session.
const page = await (await fetch(CDP + '/json/new?' + encodeURIComponent('about:blank'), {method:'PUT'})).json();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve,reject) => { ws.onopen=resolve;ws.onerror=reject; });
let seq=0,pass=0,fail=0;
const pending=new Map(),report=[];
ws.onmessage=e => {
  const message=JSON.parse(e.data),request=pending.get(message.id);
  if(!request)return;
  clearTimeout(request.timer);pending.delete(message.id);
  message.error?request.reject(Error(message.error.message)):request.resolve(message.result);
};
const send=(method,params={}) => new Promise((resolve,reject) => {
  const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' 超时'));},20000);
  pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
});
async function ev(code){
  const result=await send('Runtime.evaluate',{expression:`(async()=>{${code}})()`,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
  return result.result.value;
}
function ok(condition,name){ condition?pass++:fail++;console.log(`${condition?'PASS':'FAIL'} ${name}`); }

try {
  await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
  await send('Network.setCacheDisabled',{cacheDisabled:true});
  await send('Page.navigate',{url:APP+'?demo=serial&hid=mock&ui=layout&t='+Date.now()});
  await ev(`for(let i=0;i<100 && !document.getElementById('build-stamp');i++)await new Promise(r=>setTimeout(r,50));return !!window.__tools;`);
  const tabs=await ev(`return [...document.querySelectorAll('#tabs [data-tab]')].map(e=>e.dataset.tab);`);
  ok(tabs.length===13,'13 个工具入口保留（包含 SPI→USB）');
  await ev(`await window.__tools.flash._onFile(new File([Uint8Array.of(0,1,2,3)],'layout.bin'));return true;`);
  // Let the transient file-load toast expire before taking the page snapshots.
  await ev(`for(let i=0;i<100 && document.querySelector('#toasts .toast');i++)await new Promise(r=>setTimeout(r,50));return true;`);
  await ev(`for(const selector of ['#sp-dock-tabs [data-dock="cmd"]','#pn-dock-tabs [data-dock="img"]','#i2-dock-tabs [data-dock="scan"]','#g-dock-tabs [data-dock="files"]'])document.querySelector(selector)?.click();return true;`);

  for(const width of [1600,1280]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    await mkdir(join(out,String(width)),{recursive:true});
    for(const tab of tabs){
      await ev(`document.querySelector('#tabs [data-tab="${tab}"]').click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;`);
      const state=await ev(`
        const panel=document.querySelector('.panel.active'),side=panel.querySelector('.side');
        const rootOverflow=document.documentElement.scrollWidth-innerWidth;
        const sideOverflow=side?side.scrollWidth-side.clientWidth:0;
        const stop=panel.querySelector('.dockhead button.danger');
        const head=stop?.closest('.dockhead')?.getBoundingClientRect(),button=stop?.getBoundingClientRect();
        const labels=side?[...side.querySelectorAll('.row>span:first-child')].filter(e=>e.clientWidth&&e.scrollWidth>e.clientWidth+2).map(e=>e.textContent):[];
        return {tab:panel.id,width:innerWidth,rootOverflow,sideOverflow,labels,stopInside:!stop||(button.top>=head.top&&button.bottom<=head.bottom),bodyFont:getComputedStyle(document.body).fontSize};`);
      report.push(state);
      ok(state.rootOverflow<=1&&state.sideOverflow<=1,`${width} ${tab}：页面及侧栏不横向溢出`);
      ok(!state.labels.length&&state.stopInside,`${width} ${tab}：标签可读，停止动作留在卡片内`);
      const png=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      await writeFile(join(out,String(width),tab+'.png'),Buffer.from(png.data,'base64'));
    }
    await ev(`document.querySelector('#tabs [data-tab="flash"]').click();return true;`);
    const address=await ev(`
      const e=document.getElementById('f-base'),c=document.createElement('canvas').getContext('2d'),style=getComputedStyle(e);
      c.font=style.font;return {value:e.value,fit:c.measureText(e.value).width+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)+4<=e.clientWidth};`);
    ok(address.value==='0x08000000'&&address.fit,`${width}：完整显示 Flash 基地址`);
    await ev(`document.querySelector('#tabs [data-tab="analog"]').click();return true;`);
    const adc=await ev(`await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const c=document.getElementById('an-adc-canvas');return {h:c.clientHeight,w:c.clientWidth,pixels:[c.width,c.height],dpr:devicePixelRatio,work:c.closest('.work').clientHeight};`);
    ok(adc.h>adc.work*.65&&Math.abs(adc.pixels[0]-adc.w*adc.dpr)<=1,`${width}：ADC 填满工作区，画布像素随尺寸更新`);
  }
  const errors=await ev(`return window.__tools.errors;`);ok(errors.length===0,'所有页面切换没有未捕获错误');
  await writeFile(join(out,'layout.json'),JSON.stringify({time:new Date().toISOString(),pass,fail,pages:report},null,2));
  console.log(`UI layout: ${pass} 通过 / ${fail} 失败；截图 ${out}`);
} finally {
  ws.close();await fetch(CDP + '/json/close/' + page.id);
}
process.exitCode=fail?1:0;
