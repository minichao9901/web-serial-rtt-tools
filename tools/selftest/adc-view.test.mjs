import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AnalogView} from '../../app/analog/view.js';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../../app/app.css',import.meta.url),'utf8');
assert.match(html,/<nav class="seg docktabs an-tabs" id="an-dock-tabs" role="tablist"/,'ADC and DAC use the shared dock-tab style');
assert.match(html,/id="an-panel-adc"[^>]*role="tabpanel"[^>]*tabindex="0"/,'ADC tab panel is keyboard-focusable');
assert.match(html,/id="an-panel-dac"[^>]*role="tabpanel"[^>]*tabindex="0"/,'DAC tab panel is keyboard-focusable');
assert.doesNotMatch(css,/#tab-analog \.an-tabs button\s*\{/,'ADC/DAC tabs inherit the same font and spacing as other dock tabs');
const ids=[...html.matchAll(/\bid="(an-[^"]+)"/g)].map(m=>m[1]);
assert.equal(new Set(ids).size,ids.length,'ADC/DAC controls must have distinct IDs');
const elements=new Map(ids.map(id=>[id,{value:'',style:{},options:[],handlers:{},addEventListener(event,fn){this.handlers[event]=fn;},width:1000,height:260}]));
for(const [,attrs,id] of html.matchAll(/<input\b([^>]*\bid="(an-[^"]+)"[^>]*)>/g))elements.get(id).value=attrs.match(/\bvalue="([^"]*)"/)?.[1]??'';
for(const [,id,body] of html.matchAll(/<select\b[^>]*\bid="(an-[^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){
  const options=[...body.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map(([,a,t])=>({value:a.match(/\bvalue="([^"]*)"/)?.[1]??t,selected:a.includes('selected')}));
  elements.get(id).options=options;elements.get(id).value=(options.find(o=>o.selected)??options[0])?.value??'';
}
elements.get('an-wave').value='sine';
/**
 * 时基档位：1-2-5 系列（2026-10-07 反馈"按 10 倍变化跨度太大，加 2/5 档"）。
 * 两端各有硬边界，所以档位不是随便加的：
 *   · 短档下限 500 ns —— 硬件封顶 2 MSa/s，500 ns/div 的一屏(5 µs)本来就只有 10 个点；
 *   · 长档上限 100 ms —— 有界记录 65536 点，10 ms/div 的一屏(100 ms)已要求 ≤ 6.5 kSa/s。
 * 断言"相邻档位只能是 ×2 或 ×2.5"，避免以后有人手滑插进一个 3 µs 把整条序列搅乱。
 */
{
  const timeDivs=elements.get('an-time').options.map(o=>Number(o.value));
  assert.deepEqual(timeDivs,[...timeDivs].sort((a,b)=>a-b),'时基档位必须递增');
  for(const want of [2e-6,5e-6,2e-5,5e-5,2e-3,5e-3,1e-6,1e-4,1e-3,1e-2,1e-1])
    assert.ok(timeDivs.includes(want),`时基档位缺 ${want} s/div`);
  assert.ok(timeDivs[0]>=5e-7,'最短档不得低于 500 ns（2 MSa/s 上限下一屏已只剩 10 点）');
  timeDivs.forEach((v,i)=>{ if(i) assert.ok([2,2.5].includes(+(v/timeDivs[i-1]).toFixed(4)),`时基档位 ${timeDivs[i-1]}→${v} 不是 1-2-5 步进`); });
}
let trace=false,coordinates=[];
/**
 * 假 canvas 的 2D 上下文要跟得上 view.js 真正用到的 API：`canvasMetrics()` 会
 * 读 `window.devicePixelRatio` 并调 `setTransform()`（a715b45 起），少一个就报
 * "window is not defined / setTransform is not a function"，整条离线回归就断在这一条上。
 */
const context={fillRect(){},clearRect(){},beginPath(){},stroke(){},setLineDash(){},fillText(){},setTransform(){},moveTo(x,y){if(trace)coordinates.push([x,y]);},lineTo(x,y){if(trace)coordinates.push([x,y]);},set strokeStyle(v){trace=v==='#ffd15c';}};
for(const id of ['an-adc-canvas','an-dac-canvas'])elements.get(id).getContext=()=>context;
const makeClassList=()=>({values:new Set(),toggle(name,on){on?this.values.add(name):this.values.delete(name);}});
const tabs=['adc','dac'].map(name=>({dataset:{anTab:name},classList:makeClassList(),attrs:{},setAttribute(k,v){this.attrs[k]=v;},addEventListener(event,fn){this.handlers??={};this.handlers[event]=fn;},focus(){}}));
const panels=['adc','dac'].map(name=>({dataset:{anPage:name},classList:makeClassList(),hidden:false}));
globalThis.document={getElementById(id){assert.ok(elements.has(id),`missing ${id}`);return elements.get(id);},querySelectorAll(selector){return selector==='#an-dock-tabs [data-an-tab]'?tabs:selector==='#tab-analog [data-an-page]'?panels:[];}};
/**
 * 浏览器 API 的桩（Node 里没有，浏览器里当然有）。a715b45 给 AnalogView 加了
 * `getComputedStyle` 取等宽字体、`ResizeObserver` 跟着容器量画布、`canvasMetrics()` 读
 * `devicePixelRatio` —— 这些没跟着补，`make test-offline` 就断在这一条上。
 */
globalThis.window={devicePixelRatio:1};
globalThis.getComputedStyle=()=>({getPropertyValue:()=>'Menlo, monospace'});
globalThis.ResizeObserver=class{constructor(fn){this.fn=fn;}observe(){}unobserve(){}disconnect(){}};
globalThis.requestAnimationFrame=()=>1;   // 用例自己调 renderAdc()，这里不必真触发回调
const view=new AnalogView();view.init();assert.equal(view.wave.length,100,'preview is the same complete-cycle LUT as output');
assert.equal(view.page,'adc');assert.equal(tabs[0].attrs['aria-selected'],'true');assert.equal(panels[1].hidden,true);
tabs[0].handlers.keydown({key:'ArrowRight',preventDefault(){}});assert.equal(view.page,'dac');assert.equal(tabs[1].attrs['aria-selected'],'true');assert.equal(panels[0].hidden,true);
tabs[1].handlers.keydown({key:'Home',preventDefault(){}});assert.equal(view.page,'adc');assert.equal(panels[0].hidden,false);
assert.ok(elements.get('an-dac-start').disabled);
elements.get('an-max').value='3';elements.get('an-min').value='1';elements.get('an-max').handlers.change();
assert.equal(elements.get('an-amplitude').value,'1');assert.equal(elements.get('an-dac-offset').value,'2');
assert.equal(elements.get('an-vpp').value,'2');assert.ok(view.wave.length);
elements.get('an-vpp').value='1';elements.get('an-vpp').handlers.change();
assert.equal(elements.get('an-min').value,'1.5');assert.equal(elements.get('an-max').value,'2.5');
elements.get('an-wave').value='dc';elements.get('an-wave').handlers.change();
assert.ok(elements.get('an-amplitude').disabled);assert.ok(view.wave.every(r=>r.volts===2));
assert.equal(elements.get('an-min').value,'2');assert.equal(elements.get('an-max').value,'2');
elements.get('an-wave').value='sine';elements.get('an-wave').handlers.change();assert.equal(elements.get('an-vpp').value,'1');
elements.get('an-max').value='5';elements.get('an-max').handlers.change();
assert.equal(view.wave.length,0);assert.match(elements.get('an-wave-state').textContent,/不自动削顶/);
elements.get('an-max').value='2.5';elements.get('an-max').handlers.change();assert.equal(view.wave.length,100);
view.store.append({codes:Uint16Array.from({length:10},()=>30000),rate:1000,bits:16});view.total=10;
elements.get('an-time').value='.01';view.renderAdc();
assert.ok(coordinates.length);assert.equal(Math.max(...coordinates.map(p=>p[0])),90,'10 samples at 1kSa/s span 9ms, not an entire 100ms screen');
assert.match(elements.get('an-stats').textContent,/当前时窗超过记录长度/);
elements.get('an-freeze').checked=true;
const held=view.lastFrame;
view.store.append({codes:new Uint16Array(100).fill(60000),rate:1000,bits:16});view.renderAdc();
assert.equal(view.lastFrame,held,'freeze retains the captured frame while newer samples arrive');
assert.match(elements.get('an-measure-note').textContent,/冻结/);
elements.get('an-cursor-x').checked=true;elements.get('an-cursor-x').handlers.change();
assert.ok(Math.abs(view.adcCursors.x[0]-.025)<1e-12&&Math.abs(view.adcCursors.x[1]-.075)<1e-12);
const timeCursors=[...view.adcCursors.x];
elements.get('an-cursor-y').checked=true;elements.get('an-cursor-y').handlers.change();
assert.deepEqual(view.adcCursors.x,timeCursors,'enabling Y does not reset X');
elements.get('an-cursor-t1').value='10000';elements.get('an-cursor-t1').handlers.change();
assert.equal(view.adcCursors.x[0],.01);assert.match(elements.get('an-cursor-dt').textContent,/65 ms/);
elements.get('an-cursor-clear').handlers.click();assert.equal(view.adcCursors.x,null);assert.equal(view.adcCursors.y,null);
assert.equal(elements.get('an-cursor-dt').textContent,'—');
elements.get('an-freeze').checked=false;view.store.reset();view.lastFrame=null;
view.store.append({codes:Uint16Array.of(10000,60000),rate:1000,bits:16});
elements.get('an-time').value='0.0000005';view.renderAdc();
assert.equal(view.adcDisplay.frame.codes.length,1,'off-screen second sample cannot affect statistics');
assert.equal(elements.get('an-measure-vpp').textContent,'0 V');
console.log('Analog page: HTML binding, ADC/DAC tab keyboard/accessibility, linked generator levels, coherent LUT, DC controls, clipping rejection, 1-2-5 time/div series, ADC partial-record time axis/freeze PASS');
