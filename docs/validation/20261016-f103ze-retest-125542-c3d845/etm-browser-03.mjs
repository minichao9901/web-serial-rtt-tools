import assert from 'node:assert/strict';import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {createHash} from 'node:crypto';import {Cdp,sleep} from '../../../tools/selftest/cdp-lib.mjs';
const out=new URL('./browser-etm-03/',import.meta.url);mkdirSync(out,{recursive:true});const c=new Cdp(undefined,120000),report={method:'actual same-origin iframe, real browser WebUSB and ProbeManager, UI file/controls/live capture; directory compatibility File API with actual referenced source bytes',views:[],errors:[]};
const prefix=`const w=document.getElementById('etm-frame').contentWindow,e=w.__etm,$=id=>w.document.getElementById(id);`;
async function evaluate(code){return await c.eval(prefix+code);}
async function wait(condition,label,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate('return !!('+condition+');').catch(()=>false))return;await sleep(100);}throw Error('Timeout: '+label);}
try{
 await c.connect();c.onEvent=m=>{if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails?.text||'uncaught exception');};
 await c.send('Page.navigate',{url:'http://127.0.0.1:8898/index.html?etm-hw='+Date.now()+'#etm'});
 await wait('e&&e.state&&!e.state.operation','integrated ETM');
 const elf=readFileSync('bridge/etm/backend/firmware/stm32f103_cdc_trace/fw-ze.elf');
 await evaluate(`const bytes=Uint8Array.from(atob(${JSON.stringify(elf.toString('base64'))}),x=>x.charCodeAt(0));const dt=new w.DataTransfer();dt.items.add(new w.File([bytes],'f103ze-cdc.elf'));$('elf-file').files=dt.files;$('elf-file').dispatchEvent(new w.Event('change'));return true;`);
 await wait('e.state.elfId&&!e.state.operation','ELF loaded');
 const references=await evaluate('return e.state.elfInfo.sourceFiles;');
 const sourceFiles=references.filter(p=>/^E:[/\\]web-etm-trace(?:-worktrees)?[/\\]/i.test(p)&&existsSync(p)).map(p=>({path:p,text:readFileSync(p,'utf8')}));
 report.sources=sourceFiles.map(f=>({path:f.path,sha256:createHash('sha256').update(f.text).digest('hex')}));assert.ok(sourceFiles.length>10);
 await evaluate(`const dt=new w.DataTransfer();for(const f of ${JSON.stringify(sourceFiles)}){const file=new w.File([f.text],f.path.replaceAll('\\\\','/').split('/').pop());Object.defineProperty(file,'webkitRelativePath',{value:f.path});dt.items.add(file);}$('sources-files').files=dt.files;$('sources-files').dispatchEvent(new w.Event('change'));return true;`);
 await wait('e.state.sourceSnapshot&&!e.state.operation','matching source snapshot');
 await evaluate(`$('connect').click();return true;`);await wait('e.target.probe&&!e.state.operation','WebUSB connection');
 await evaluate(`$('hse').value='8';$('hse').dispatchEvent(new w.Event('change'));return true;`);await wait('!e.state.operation','clock input');
 await evaluate(`$('break-command').value='b cdc_acm_init';$('break-command-form').dispatchEvent(new w.Event('submit',{cancelable:true}));return true;`);
 await wait('e.state.entryAddress!==null&&!e.state.operation','actual entry breakpoint');
 await evaluate(`$('rate').value='500000000';$('duration').value='1';$('threshold').value='1.65';$('fraction').value='.25';$('channels').value='0,1,2,3,4';$('branch-broadcast').checked=false;$('sync').checked=true;$('auto-decode').checked=true;$('reset-before').checked=true;$('entry-before').checked=true;$('auto-clock').checked=true;$('read-clock').click();return true;`);
 await wait('!e.state.operation','clock readback');
 report.before=await evaluate(`return {elfSha:e.state.elfInfo.sha256,clocks:e.target.info.clocks,entry:e.state.entryAddress,usbAuthorized:(await navigator.usb.getDevices()).length,disabled:$('start').disabled};`);assert.equal(report.before.clocks.coreHz,48e6);assert.equal(report.before.clocks.physicalTraceHz,24e6);assert.equal(report.before.disabled,false);
 await evaluate(`$('start').click();return true;`);await wait('!e.state.operation&&!e.state.job&&e.history.result','real linked capture',180000);
 report.capture=await evaluate(`return {record:e.state.current,summary:e.history.result.summary,quality:e.history.result.quality,jobState:$('job-state').textContent,source:$('source-code').textContent,selected:e.history.selected,info:e.target.info,leases:[...parent.__tools.probeManager.leases.keys()]};`);
 assert.ok(report.capture.summary.instructions>1000);assert.equal(report.capture.summary.sourceMapped,report.capture.summary.instructions);for(const k of ['packetIssues','overflowPackets','unprocessedBytes','unknownSourceBytes'])assert.equal(report.capture.quality[k],0,k);assert.ok(report.capture.source.length>40);assert.ok(report.capture.leases.includes('etm'));
 for(const view of ['instructions','functions','hotspots','packets','quality','flame']){
  await evaluate(`w.document.querySelector('[data-view="${view}"]').click();return true;`);await sleep(450);
  const data=await evaluate(`return {view:e.history.view,body:$('table-container').textContent.slice(0,200),source:$('source-location').textContent};`);assert.equal(data.view,view);report.views.push(data);
  writeFileSync(new URL(view+'.png',out),Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 }
 for(const kind of ['record','csv','source']){const response=await fetch('http://127.0.0.1:8898/etm/api/download/'+report.capture.record+'/'+kind);assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length>100);writeFileSync(new URL('export.'+({record:'etmrecord',csv:'csv',source:'c'}[kind]),out),bytes);report['export_'+kind]=bytes.length;}
 // Switch the actual main page to Debug and let the real manager release ETM.
 report.handoff=await c.eval(`document.querySelector('.tab[data-tab="dbg"]').click();document.getElementById('d-backend').value='webusb';document.getElementById('d-clock').value='1000';document.getElementById('d-rtt-on').checked=false;await __tools.dbg._syncBackend();const connected=await __tools.dbg.connect();const state={connected,etmProbeClosed:!__tools.etm.probe,etmLeaseReleased:!__tools.probeManager.leases.has('etm')};if(__tools.dbg.session.connected){await __tools.dbg.runLine('c');await __tools.dbg.disconnect();}return state;`);
 assert.equal(report.handoff.connected,true);assert.equal(report.handoff.etmProbeClosed,true);assert.equal(report.handoff.etmLeaseReleased,true);assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;console.error(error.stack);try{report.failureState=await evaluate(`return {debugFault:e.target.debugFault,transportFault:e.target.transportFault,faulted:e.target.probe?._faulted,recovering:e.target.probe?._recovering,job:$('job-state').textContent,log:$('log')?.textContent?.slice(-3000),parentText:document.body.innerText.slice(-2500)};`);}catch{} }
finally{try{await c.eval(`if(window.__tools?.probeManager)await __tools.probeManager.releaseOthers(null,'ETM 实板复测收尾');return true;`);}catch(e){report.cleanupError=e.message;}writeFileSync(new URL('result.json',out),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,capture:report.capture?.record,views:report.views.length,error:report.error,cleanupError:report.cleanupError}));c.close();}

