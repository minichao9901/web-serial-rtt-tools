import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
const root=new URL('../../../',import.meta.url),load=p=>import(new URL(p,root));
const {document}=parseHTML(await readFile(new URL('index.html',root),'utf8'));globalThis.document=document;
const {WebUsbDapProbe}=await load('app/rtt/dap-webusb.js');
const {RiscvTransport}=await load('app/flash/hpm/riscv-dm.js');
const {DM,DMI_OP}=await load('app/flash/hpm/jtag.js');
const {SymTab}=await load('app/dbg/symbols.js');const {LineTable}=await load('app/elf/lines.js');
const {Rtt}=await load('app/rtt/protocol.js');const {RttCdcView}=await load('app/hid/view.js');
const {I2cView}=await load('app/i2c/view.js');const {parseScript}=await load('app/i2c/dsl.js');
const {RiscvDebugSession}=await load('app/dbg/riscv.js');
const {SpiCdcSession}=await load('app/spi-cdc/session.js');
const {BusPeriodicClient,BUS}=await load('app/core/bus-periodic.js');
const {MockSpiTransport}=await load('app/spi/transport.js');
const {createProbeManager}=await load('app/core/probe-users.js');
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(r=>setImmediate(r));const rows=[];
async function check(id,fn){try{rows.push({id,...await fn(),verification:'verified'});}catch(e){rows.push({id,verification:'failed',error:e.stack});}}
await check('N01-heal-bypasses-memory-lock',async()=>{
 const p=new WebUsbDapProbe(),held=gate(),healing=gate(),events=[];
 p._readMemLocked=async addr=>{events.push('read-enter-'+addr);if(addr===1)await held.promise;events.push('read-exit-'+addr);return Uint8Array.of(addr);};
 p._targetInit=async()=>{events.push('heal-enter');await healing.promise;events.push('heal-exit');};
 const a=p.readMem(1,1);await tick();p._faulted=true;const b=p.readMem(2,1);await tick();assert.equal(p._locked,true);assert.ok(events.includes('heal-enter'));
 held.resolve();const c=p.readMem(3,1);await Promise.all([a,c]);assert.ok(events.indexOf('read-enter-3')>events.indexOf('heal-enter'));assert.equal(events.includes('heal-exit'),false);healing.resolve();await b;return {events};
});
await check('N01b-failed-heal-clears-fault',async()=>{const p=new WebUsbDapProbe();p._faulted=true;p._targetInit=async()=>{throw Error('init failed');};p._note=()=>{};const result=await p._healIfFaulted();assert.equal(result,false);assert.equal(p._faulted,false);return {result,faultAfterFailure:p._faulted};});
await check('N02-usb-recovery-does-not-mark-target-stale',async()=>{const p=new WebUsbDapProbe();p.device={};p._usb={reset:async()=>{}};p._note=()=>{};let disconnected=false;p._claim=async()=>{disconnected=true;};await p._onXferTimeout('injected IN');assert.equal(disconnected,true);assert.equal(p._faulted,false);return {claimPerformed:true,targetFaultFlag:p._faulted};});
await check('N03-zero-count-read-returns-zero-filled-success',async()=>{const p=new WebUsbDapProbe();p.maxWords=120;p._setTAR=async()=>{};p._transferBlock=async()=>({count:0,words:[]});const data=await p._readMemOnce(0x20000000,8);assert.deepEqual([...data],Array(8).fill(0));return {length:data.length,data:[...data]};});
await check('REJECT-dmi-sba-response-swap',async()=>{
 const dm=new RiscvTransport({}, {burst:false}),trace=[];let pending={op:0,addr:0,data:0};
 dm.dmiPost=async(op,addr,data)=>{trace.push({op,addr});const previous=pending;if(op===DMI_OP.READ)pending={op:0,addr,data:addr===DM.SBDATA0?0xaabbccdd:0x11223344};else if(op===DMI_OP.WRITE)pending={op:0,addr,data:0};await tick();return previous;};
 dm.sbaConfig=async()=>{};dm._checkSbcsAt=async()=>0;
 const [reg,mem]=await Promise.all([dm.dmiRead(DM.DMSTATUS),dm.readMem(0x01240000,4)]);
 assert.equal(reg,0x11223344);assert.equal(new DataView(mem.buffer).getUint32(0,true),0xaabbccdd);for(let i=0;i<trace.length;i+=2){assert.notEqual(trace[i].op,DMI_OP.NOP);assert.equal(trace[i+1].op,DMI_OP.NOP);}return {register:reg,memory:[...mem],trace};
});
await check('N04-i2c-script-results-pollute-command-table',async()=>{
 const v=new I2cView();v.session={connected:true,log(){}};v.results.set(1,{text:'old table result'});v._flushSoon=()=>{};v._runPill=()=>{};
 const parsed=parseScript('rd 0x50 0x00 1');assert.equal(parsed.errors.length,0);v._parseDsl=()=>parsed;
 v._run=async items=>{for(const item of items)v._onRunEvent({type:'item',phase:'done',item,err:0,hex:'AA',ms:1});};await v._runScript(false);
 assert.ok(v.results.get(0).text.includes('AA'));assert.equal(v.results.get(1).text,'old table result');return {results:[...v.results]};
});
await check('REJECT-promise-race-loser-unhandled',async()=>{
 const pending=gate(),r=new Rtt({readMem:()=>pending.promise});r.up=[{sName:0x20000000}];const unhandled=[];const handler=e=>unhandled.push(e.message);process.on('unhandledRejection',handler);
 try{assert.equal(await r.name('up',0),'');pending.reject(Error('late read rejection'));await tick();await tick();assert.deepEqual(unhandled,[]);return {unhandled};}finally{process.off('unhandledRejection',handler);}
});
await check('REJECT-signed-PC-loses-function-and-line',async()=>{
 const pc=0x8000578c,masked=pc&0xfffffffe;
 const lines=new LineTable({starts:Uint32Array.of(pc),ends:Uint32Array.of(pc+4),lines:Int32Array.of(19),files:Int32Array.of(0),flags:Uint8Array.of(1),seqs:Int32Array.of(0),paths:['src/main.c']});
 const sym=new SymTab({funcs:[{name:'high_pc_fn',addr:pc,size:4}],lines});assert.equal(sym.funcAt(masked).name,'high_pc_fn');assert.equal(sym.locText(masked),'main.c:19');return {masked,function:sym.funcAt(masked).name,line:sym.locText(masked)};
});
await check('N10-unconfirmed-resume-still-reports-step',async()=>{
 const s=Object.create(RiscvDebugSession.prototype);s.halted=true;s._ensureHalted=async()=>{};s._withBpCleared=async(pc,fn)=>fn();s._waitResumed=async()=>false;s.refresh=async()=>{};s.refreshRegs=async()=>{};
 s.dm={readReg:async()=>0x80000000,writeReg:async()=>{},dmiWrite:async()=>{},_ctl:()=>0,waitHalted:async()=>true};const result=await s.step();assert.equal(result,'step');return {resumeConfirmed:false,result,note:'PC equality alone cannot prove failure: stepping a self-loop can legitimately retain PC'};
});
await check('N07a-spi-cdc-cleanup-erases-original-error',async()=>{const hid={connected:true,request:async()=>{},xfer:async()=>{throw Error('original status failure');},close:async()=>{throw Error('cleanup failure');}};const s=new SpiCdcSession({hidFactory:()=>hid});let error;try{await s.connect(true);}catch(e){error=e;}assert.equal(error.message,'cleanup failure');assert.equal(error.cause,undefined);return {message:error.message,handleRetained:s.hid===hid};});
await check('N07b-periodic-finally-erases-body-error',async()=>{
 const c=new BusPeriodicClient();c.command=async action=>{if(action===0)return Uint8Array.of(66,80,84,49,8,0,2,16,54,32);if(action===3)return new Uint8Array(4);if(action===8)throw Error('original buffer full');return new Uint8Array();};c.stop=async()=>{throw Error('cleanup STOP failed');};let error;try{await c.run(BUS.I2C,[{period:10,count:1,records:[{kind:BUS.DELAY,data:new Uint8Array(4)}]}]);}catch(e){error=e;}assert.equal(error.message,'cleanup STOP failed');return {message:error.message,cause:error.cause??null};
});
await check('REJECT-spi-callback-step-not-validated',async()=>{
 const c=new BusPeriodicClient();c.command=async action=>action===0?Uint8Array.of(66,80,84,49,8,0,2,16,54,32):action===3?new Uint8Array(4):new Uint8Array();c.stop=async()=>{};c.read=async()=>({slot:0,epoch:0,step:99});let callbacks=0,error;try{await c.run(BUS.SPI,[{period:10,count:1,records:[{kind:BUS.DELAY,data:new Uint8Array(4)}]}],{onResult:()=>callbacks++});}catch(e){error=e;}assert.match(error.message,/任务身份不匹配/);assert.equal(callbacks,0);return {callbacks,error:error.message};
});
await check('N15-mock-response-arrives-after-stop',async()=>{
 let taken=false,callbackAfterStop=false;const t=new MockSpiTransport({probe:{takeRsp:()=>taken?null:(taken=true,Uint8Array.of(1))},latencyMs:35});t.running=true;t.onRsp=()=>{callbackAfterStop=!t.running;};const p=t._drain();await tick();await t.stop();await p;assert.equal(callbackAfterStop,true);return {callbackAfterStop};
});
await check('CORRECT-uncertain-RTT-start-needs-proven-stop',async()=>{
 const v=Object.create(RttCdcView.prototype);Object.assign(v,{_engineGen:1,_ensure:async()=>true,params:()=>({clockHz:0}),render(){},last:null,dev:{setTargetType:async()=>{},start:async()=>{throw Error('START reply lost');}}});const manager=createProbeManager({hid:v,session:{}},{locks:null});v.probeManager=manager;await v._startBridgeNow(false,1);assert.equal(v._bridgeRequested,true);assert.equal(manager.cdcMode.state().mode,'unknown');v._bridgeRequested=false;assert.equal(manager.cdcMode.state().mode,'unknown');return {before:'unknown',afterClearingRequested:'unknown',reason:'failure ledger still blocks UART; firmware acceptance is uncertain'};
});
await writeFile(new URL('verification-v2.json',import.meta.url),JSON.stringify(rows,null,2));console.log(JSON.stringify(rows,null,2));if(rows.some(r=>r.verification!=='verified'))process.exitCode=1;
