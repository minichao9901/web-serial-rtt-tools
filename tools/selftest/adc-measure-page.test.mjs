// Real DOM/canvas/pointer acceptance using known raw samples; no USB or probe.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {Cdp,sleep} from './cdp-lib.mjs';
const c=new Cdp(process.env.CDP||'http://127.0.0.1:9333');await c.connect();
const near=(a,b,e=1e-6)=>assert.ok(Math.abs(a-b)<e,`${a} != ${b}`);
try{
  await c.send('Page.navigate',{url:(process.env.APP||'http://127.0.0.1:8899/index.html')+'?adcmeasure='+Date.now()+'#analog'});
  for(let i=0;i<50;i++){if(await c.eval('return !!window.__tools?.analog;').catch(()=>false))break;await sleep(100);}
  await c.eval(`
    const v=window.__tools.analog;
    window.__adcFixture=()=>{
      document.getElementById('an-freeze').checked=false;
      document.getElementById('an-time').value='0.001';
      document.getElementById('an-rate').value='100000';
      document.getElementById('an-level').value='1.65';
      document.getElementById('an-trigger').value='auto';
      v.store.reset();v.lastFrame=null;
      v.store.append({rate:100000,bits:16,codes:Uint16Array.from({length:4000},(_,i)=>Math.round((1.65+Math.sin(2*Math.PI*i/100))*65535/3.3))});
      v.total=4000;v.renderAdc();
    };
    window.__adcFixture();return true;
  `);
  const auto=await c.eval(`return Object.fromEntries(['period','frequency','min','max','average','vpp'].map(k=>[k,document.getElementById('an-measure-'+k).textContent]));`);
  assert.equal(auto.period,'1 ms');assert.equal(auto.frequency,'1 kHz');
  near(parseFloat(auto.average),1.65,1e-4);near(parseFloat(auto.vpp),2,1e-4);
  assert.ok(Object.values(auto).every(v=>v!=='—'));
  const values=await c.eval(`
    const v=window.__tools.analog;
    document.getElementById('an-cursor-x').click();document.getElementById('an-cursor-y').click();
    window.__adcSet=(id,value)=>{const el=document.getElementById(id);el.value=el.tagName==='SELECT'&&typeof value==='number'?[...el.options].find(o=>Number(o.value)===value)?.value||String(value):String(value);el.dispatchEvent(new Event('change',{bubbles:true}));};
    window.__adcSet('an-cursor-t1',1000);window.__adcSet('an-cursor-t2',2000);
    window.__adcSet('an-cursor-v1',.65);window.__adcSet('an-cursor-v2',2.65);
    const canvas=document.getElementById('an-adc-canvas'),ctx=canvas.getContext('2d'),pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    const colors=[[99,189,255],[197,145,255],[81,219,177],[255,155,115]],counts=colors.map(color=>{
      let count=0;for(let i=0;i<pixels.length;i+=4)if(color.every((v,j)=>Math.abs(pixels[i+j]-v)<10))count++;return count;
    });
    return {counts,dt:document.getElementById('an-cursor-dt').textContent,f:document.getElementById('an-cursor-frequency').textContent,dv:document.getElementById('an-cursor-dv').textContent};
  `);
  assert.equal(values.dt,'1 ms');assert.equal(values.f,'1 kHz');assert.equal(values.dv,'2 V');
  assert.ok(values.counts.every(n=>n>40),'all four cursor colors are painted: '+values.counts);
  const box=await c.eval(`const r=document.getElementById('an-adc-canvas').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};`);
  async function drag(ax,ay,bx,by){
    await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:box.x+ax*box.w,y:box.y+ay*box.h});
    await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,x:box.x+ax*box.w,y:box.y+ay*box.h});
    await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:box.x+bx*box.w,y:box.y+by*box.h});
    await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:box.x+bx*box.w,y:box.y+by*box.h});
  }
  await drag(.1,.4,.15,.4);
  near(await c.eval('return window.__tools.analog.adcCursors.x[0];'),.0015,2e-5);
  await drag(.7,.25,.7,.375);
  near(await c.eval('return window.__tools.analog.adcCursors.y[1];'),2.15,.02);
  await c.eval(`window.__adcSet('an-cursor-t1',3000);return true;`);
  assert.equal(await c.eval(`return document.getElementById('an-cursor-dt').textContent;`),'-1 ms');
  await c.eval(`window.__adcSet('an-cursor-t1',2000);return true;`);
  assert.equal(await c.eval(`return document.getElementById('an-cursor-frequency').textContent;`),'—');
  const frozen=await c.eval(`
    const v=window.__tools.analog;document.getElementById('an-freeze').click();const held=v.lastFrame;
    v.store.append({rate:100000,bits:16,codes:new Uint16Array(4000).fill(20000)});v.total=v.store.total;v.renderAdc();
    window.__adcSet('an-cursor-t1',1000);
    return {same:v.lastFrame===held,frequency:document.getElementById('an-measure-frequency').textContent,dt:document.getElementById('an-cursor-dt').textContent};
  `);
  assert.equal(frozen.same,true);assert.equal(frozen.frequency,'1 kHz');assert.equal(frozen.dt,'1 ms');
  await c.eval(`document.getElementById('an-adc-canvas').focus();document.getElementById('an-cursor-target').value='x0';return true;`);
  await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight'});
  await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight'});
  near(await c.eval('return window.__tools.analog.adcCursors.x[0];'),.00101);
  const held=await c.eval(`
    const v=window.__tools.analog;
    window.__adcSet('an-time',.0005);const count=v.adcDisplay.frame.codes.length;
    window.__adcSet('an-level',4);
    document.getElementById('an-freeze').checked=false;
    window.__adcSet('an-trigger','normal');
    return {count,frequency:document.getElementById('an-measure-frequency').textContent,status:document.getElementById('an-stats').textContent};
  `);
  assert.equal(held.count,500);assert.equal(held.frequency,'1 kHz');assert.match(held.status,/保持上一帧/);
  const dc=await c.eval(`
    const v=window.__tools.analog;v.store.reset();v.lastFrame=null;window.__adcSet('an-trigger','auto');
    v.store.append({rate:100000,bits:16,codes:new Uint16Array(4000).fill(20000)});v.renderAdc();
    return {f:document.getElementById('an-measure-frequency').textContent,note:document.getElementById('an-measure-note').textContent,title:document.getElementById('an-measure-frequency').title};
  `);
  assert.equal(dc.f,'—');assert.match(dc.note,/直流/);
  assert.match(dc.title,/直流/,'unknown-frequency reason remains available on hover');
  const partial=await c.eval(`window.__adcSet('an-time',.0000005);const v=window.__tools.analog;return {n:v.adcDisplay.frame.codes.length,vpp:document.getElementById('an-measure-vpp').textContent};`);
  assert.equal(partial.n,1);assert.equal(partial.vpp,'0 V');
  const empty=await c.eval(`
    const v=window.__tools.analog;v.store.reset();v.lastFrame=null;v.renderAdc();document.getElementById('an-cursor-clear').click();
    return {min:document.getElementById('an-measure-min').textContent,cursors:v.adcCursors,disabled:document.getElementById('an-cursor-t1').disabled};
  `);
  assert.equal(empty.min,'—');assert.deepEqual(empty.cursors,{x:null,y:null});assert.equal(empty.disabled,true);
  await c.eval(`document.getElementById('an-cursor-y').click();return true;`);
  assert.equal(await c.eval(`return document.getElementById('an-cursor-target').value;`),'y0','Y-only mode selects an enabled voltage cursor');
  await c.eval(`document.getElementById('an-cursor-clear').click();return true;`);
  await c.send('Emulation.setDeviceMetricsOverride',{width:1909,height:861,deviceScaleFactor:1,mobile:false});await sleep(150);
  const idleLayout=await c.eval(`return {cursorRow:getComputedStyle(document.getElementById('an-cursor-values')).display,plot:document.getElementById('an-adc-canvas').getBoundingClientRect().height};`);
  assert.equal(idleLayout.cursorRow,'none','disabled cursors do not reserve a blank input row');
  // Leave a clearly labelled known-sample preview; hardware remains untouched.
  await c.eval(`window.__adcFixture();document.getElementById('an-cursor-x').click();document.getElementById('an-cursor-y').click();
    window.__adcSet('an-cursor-t1',1000);window.__adcSet('an-cursor-t2',2000);window.__adcSet('an-cursor-v1',.65);window.__adcSet('an-cursor-v2',2.65);
    window.__tools.analog.status('测试预览：已知 1 kHz / 2 Vpp 原始样本，未连接硬件');return true;`);
  await sleep(200);
  const compactLayout=await c.eval(`
    const work=document.querySelector('#an-panel-adc .an-work'),strip=work.querySelector('.an-measurements');
    return {plot:document.getElementById('an-adc-canvas').getBoundingClientRect().height,
      strip:strip.getBoundingClientRect().height,tops:[...strip.children].map(el=>el.getBoundingClientRect().top),
      overflow:work.scrollHeight-work.clientHeight,helpOpen:document.getElementById('an-measure-help').open};
  `);
  assert.ok(compactLayout.plot>=450,'waveform retains at least 450px even with both cursor pairs: '+JSON.stringify(compactLayout));
  assert.ok(compactLayout.strip<=36,'six measurements use a compact strip');
  assert.ok(Math.max(...compactLayout.tops)-Math.min(...compactLayout.tops)<2,'six wide-screen measurements share one line');
  assert.ok(compactLayout.overflow<=2,'controls stay visible without scrolling the waveform workspace');
  assert.equal(compactLayout.helpOpen,false);
  assert.ok(idleLayout.plot>compactLayout.plot,'unused cursor row gives its height back to the waveform');
  console.log('ADC layout at 1909x861: '+JSON.stringify({idlePlot:idleLayout.plot,cursorsPlot:compactLayout.plot,measureStrip:compactLayout.strip}));
  for(const [width,height] of [[1100,760],[800,800]]){
    await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await sleep(150);
    const layout=await c.eval(`const w=document.querySelector('#an-panel-adc .an-work');return {overflow:w.scrollWidth-w.clientWidth,body:document.body.scrollWidth-innerWidth,frequency:document.getElementById('an-measure-frequency').textContent};`);
    assert.ok(layout.overflow<=2&&layout.body<=2,'measurement controls fit narrow views: '+JSON.stringify(layout));
    assert.equal(layout.frequency,'1 kHz');
  }
  await c.send('Emulation.setDeviceMetricsOverride',{width:1909,height:861,deviceScaleFactor:1,mobile:false});await sleep(150);
  const screenshot=process.argv.find(x=>x.startsWith('--screenshot='))?.slice(13);
  if(screenshot){const shot=await c.send('Page.captureScreenshot',{format:'png'});mkdirSync(dirname(screenshot),{recursive:true});writeFileSync(screenshot,Buffer.from(shot.data,'base64'));}
  const errors=await c.eval('return window.__tools.errors;');assert.deepEqual(errors,[]);
  console.log('ADC real page: six automatic measures, 4 painted cursors, pointer drag on both axes, precise/reversed/coincident values, keyboard, freeze/zoom/normal hold, DC/empty, clear and JS errors PASS');
}finally{await c.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});c.close();}
