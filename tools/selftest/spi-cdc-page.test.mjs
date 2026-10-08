/** Independent real page; no physical device or user's original tab touched. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {Cdp} from './cdp-lib.mjs';
const base=process.env.CDP||'http://127.0.0.1:9333',app=process.env.APP||'http://127.0.0.1:8899/index.html';
const c=new Cdp(base,60000),p=await(await fetch(base+'/json/new?'+encodeURIComponent(app+'?demo=serial&spi-cdc-test='+Date.now()+'#spicdc'),{method:'PUT'})).json();
try{
 c.ws=await c._open(p.webSocketDebuggerUrl,(_,m)=>c._dispatch(m));await c.send('Page.enable');await c.send('Runtime.enable');
 await c.send('Network.enable');await c.send('Network.setCacheDisabled',{cacheDisabled:true});await c.send('Page.bringToFront');
 for(let i=0;i<100;i++){if(await c.eval('return !!globalThis.__tools?.spiCdc?.stream?.rx').catch(()=>false))break;await new Promise(r=>setTimeout(r,50));}
 const controls=await c.eval(`
 const t=__tools,s=t.spiCdc.session;let running=false,pending=false,rc=0,generation=0,config=0;
 s.hidFactory=()=>({connected:false,label:'SPI fixture',async reconnect(){this.connected=true;},async request(){this.connected=true;},async close(){this.connected=false;},async xfer(cmd,data){
 const a=data[0];if(a===1){pending=true;rc=-100;generation++;config=data[1]|data[2]<<8;}if(a===2){running=false;pending=true;rc=-100;}
 if(a===0&&pending){pending=false;rc=0;running=generation>0&&running!==false?true:running;}
 // For START, pending status is produced once and becomes running next STATUS.
 if(a===1)running=true;
 const p=new Uint8Array(63);p.set([54,cmd,a]);const d=new DataView(p.buffer,3);
 [0x31435053,1|(+running<<1)|(+pending<<2),rc,config,16384,4096,4096,0,0,0,0,generation,0].forEach((v,i)=>d.setUint32(i*4,v,true));return p;
 }});
 const click=async id=>{document.getElementById(id).click();for(let i=0;i<100&&(s.busy||id==='si-reconnect'&&!s.connected);i++)await new Promise(r=>setTimeout(r,10));};
 await click('si-reconnect');document.getElementById('si-mode').value='3';document.getElementById('si-lsb').value='1';await click('si-start');
 const started={running:s.running,mode:s.last?.mode,lsb:s.last?.lsb,disabled:document.getElementById('si-start').disabled,state:document.getElementById('si-state').textContent};
 await click('si-stop');const stopped=!s.running&&!document.getElementById('si-start').disabled;
 await click('si-disconnect');
 return {started,stopped,disconnected:!s.connected,tabs:[...document.querySelectorAll('#tabs [data-tab]')].map(e=>[e.dataset.tab,e.textContent.trim()]),duplicates:[...document.querySelectorAll('[id]')].map(e=>e.id).filter((x,i,a)=>a.indexOf(x)!==i),errors:t.errors};`);
 assert.ok(controls.started.running&&controls.started.disabled);assert.equal(controls.started.mode,3);assert.equal(controls.started.lsb,true);assert.ok(controls.stopped&&controls.disconnected);assert.deepEqual(controls.duplicates,[]);assert.deepEqual(controls.errors,[]);
 assert.equal(controls.tabs.findIndex(x=>x[0]==='spicdc'),controls.tabs.findIndex(x=>x[0]==='rttcdc')+1);assert.equal(controls.tabs.find(x=>x[0]==='spicdc')[1],'SPI转发');assert.equal(controls.tabs.find(x=>x[0]==='spi')[1],'USB→SPI/QSPI');
 const pins=await c.eval(`
 document.getElementById('si-pinmap-btn').click();const m=__tools.spiCdc.pinMap;
 m.board.value='hpm5301evklite';m.board.dispatchEvent(new Event('change'));
 const result={visible:!m.box.hidden,count:m.box.querySelectorAll('.p-pin').length,signals:[...m.box.querySelectorAll('.is-signal .p-note')].map(e=>e.textContent),wiring:m.box.querySelector('[data-wiring]').textContent};
 m.box.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 return {...result,closed:m.box.hidden,focused:document.activeElement.id};`);
 assert.ok(pins.visible&&pins.closed);assert.equal(pins.count,40);assert.deepEqual(pins.signals,['SCK IN · PB11','CS IN · PB10','MOSI IN · PB13']);assert.match(pins.wiring,/J3\[26\].*PB10.*J3\[13\].*PB11.*J3\[28\].*PB13/);assert.equal(pins.focused,'si-pinmap-btn');
 const stream=await c.eval(`
 const t=__tools,s=t.spiCdc.stream;t.session.isOpen=true;
 s.rx.clear();s.rxc.reset();s.rx.setAutoscroll(true);s._setRxMode('ascii');s.rx.setTimestamps(false);t.stream.rx.clear();
 const packet=new TextEncoder().encode('hello world!\\r\\n');t.session.emit('data',packet,new Date());await new Promise(r=>setTimeout(r,100));
 const shown=s.rx.el.textContent.includes('hello world!');document.getElementById('si-rx-clear').click();const cleared=!s.rx.bytes&&t.stream.rx.bytes===packet.length;
 document.getElementById('si-rx-pause').click();t.session.emit('data',packet,new Date());const paused=s.rx.paused;document.getElementById('si-rx-pause').click();
 const big=new Uint8Array(4096);big.fill(65);let recorded=0,beats=0,last=performance.now(),maxGap=0;
 const rec=s.rec;rec.active=true;rec._w={write:async b=>{for(const v of b)if(v!==65)throw Error('record mismatch');recorded+=b.length;},close:async()=>{}};
 s.rxc.reset();const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;beats++;},20);
 for(let n=0;n<100;n++){for(let i=0;i<12;i++)t.session.emit('data',big,new Date());await new Promise(r=>setTimeout(r,20));}
 const high=s.suppressed;clearInterval(timer);rec._flush();await rec._wq;await rec.stop();await new Promise(r=>setTimeout(r,1400));s._stats();
 t.session.isOpen=false;return {shown,cleared,paused,resumed:!s.rx.paused,high,recovered:!s.suppressed,received:s.rxc.total,recorded,beats,maxGap,bytes:s.rx.bytes,chars:s.rx.el.textContent.length,errors:t.errors};`);
 assert.ok(stream.shown&&stream.cleared&&stream.paused&&stream.resumed&&stream.high&&stream.recovered);assert.equal(stream.received,4096*1200);assert.equal(stream.received,stream.recorded);assert.ok(stream.maxGap<500);assert.ok(stream.bytes<=2*1024*1024&&stream.chars<=262144);assert.deepEqual(stream.errors,[]);
 mkdirSync('tmp',{recursive:true});writeFileSync('tmp/spi-cdc-page-result.json',JSON.stringify({controls,pins,stream},null,2));console.log(JSON.stringify({controls,pins,stream},null,2));
}finally{c.close();await fetch(base+'/json/close/'+p.id).catch(()=>{});}
