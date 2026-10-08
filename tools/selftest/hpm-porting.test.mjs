/** No USB/hardware: parameter contracts, TAP/DMI/SBA simulation and failure paths. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HPM_BOARDS, HPM_CHIPS, createHpmTarget, resolveHpmTarget, hpmWorkLayout,
  assertHpmIdentity, GENERIC_RISCV_PORT } from '../../app/targets/hpm/porting.js';
import { hpmInitArgs, hpmCheckRange } from '../../app/flash/hpm/chips.js';
import { HpmFlasher } from '../../app/flash/hpm/flash.js';
import { RiscvTransport } from '../../app/flash/hpm/riscv-dm.js';
import { HPM_ALGO, hpmAlgoBytes } from '../../app/flash/hpm/algo.js';
import { xipCopyBytes } from '../../app/flash/hpm/xip-copy.js';
import { RiscvDebugSession } from '../../app/dbg/riscv.js';
import { SimTarget } from './hpm-sim.mjs';
import { CHIPS } from '../../app/core/chips.js';
import { store } from '../../app/core/store.js';
import { selectedHpmBoard, rememberHpmBoard, fillHpmSelect } from '../../app/targets/hpm/select.js';
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log('PASS ' + name); };
const bytes = hpmAlgoBytes();
const hash = () => createHash('sha256').update(hpmAlgoBytes()).digest('hex');
const initialHash = hash();
// Independent fixtures copied from SDK v1.11 boards/openocd/boards/*.cfg.
// Same IDCODE alone cannot distinguish these chips; their init arguments differ.
const expected = [
  ['hpm5300evk',0x2000000,0xf3000000,5,0x1000],
  ['hpm5301evklite',0x2000000,0xf3000000,5,0x1000],
  ['hpm5e00evk',0x2000000,0xf3000000,5,0x1000],
  ['hpm6200evk',0x1000000,0xf3040000,null,null],
  ['hpm6300evk',0x1000000,0xf3040000,null,null],
  ['hpm6750evk2',0x2000000,0xf3040000,7,null],
  ['hpm6750evkmini',0x1000000,0xf3040000,7,null],
  ['hpm6800evk',0x2000000,0xf3000000,7,null],
  ['hpm6e00evk',0x2000000,0xf3000000,7,null],
  ['hpm6p00evk',0x2000000,0xf3000000,5,0x1000],
];
assert.deepEqual(HPM_BOARDS.map(b => b.id), expected.map(b => b[0]));
for (const [id,size,xpi,opt0,opt1] of expected) {
  await test(id + ' SDK parameters and complete simulated flash', async () => {
    const port = resolveHpmTarget(id), words = opt1 != null ? 2 : opt0 != null ? 1 : 0;
    const init = [0x80000000, 0xfcf90000 + words, opt0 ?? 0, opt1 ?? 0, xpi];
    assert.equal(port.flashSize, size);
    assert.deepEqual(Object.values(hpmInitArgs(port)).slice(0,5), init);
    const sim = new SimTarget({ ramSize: 0x20000, flashSize: 0x10000, expectedInitArgs: init });
    const dm = new RiscvTransport(sim, { port }); await dm.init();
    const flash = new HpmFlasher(dm, { board: port, chunkBytes: 4096 });
    const data = Uint8Array.from({ length: 9003 }, (_, i) => (i * 19 + 11) & 255);
    await flash.flashImage(0x80001000, data);
    assert.deepEqual(sim.initCalls, [init]);
    assert.deepEqual(sim.flash.slice(0x1000,0x1000+data.length), data);
    assert.equal(sim.progChunks, 3); assert.equal(sim.xipCopies, 3); assert.equal(sim.romReads || 0, 0);
    assert.equal(sim.regs[2], flash.stackTop); assert.ok(sim.dcsrEbreakEnabled);
    assert.equal(port.flashSize, size, 'probing cannot mutate registry');
    assert.equal(flash.board.flashSize, 0x10000, 'runtime capacity limits every operation');
    await assert.rejects(flash.program(0x80010000,new Uint8Array(4)), /范围不合法/);
    await assert.rejects(flash.verify(0x8000ffff,new Uint8Array(1)), /范围不合法/);
    await flash.finish(); assert.equal(sim.halted, false);
    assert.equal(hash(), initialHash, 'all targets keep the same algorithm bytes');
  });
}
await test('registry is immutable and selectors derive every board', () => {
  assert.throws(() => { HPM_BOARDS[0].memory.workArea.size = 1; }, TypeError);
  assert.deepEqual(CHIPS.filter(b => b.v.startsWith('hpm')).map(b => b.v), HPM_BOARDS.map(b => b.id));
  assert.throws(() => resolveHpmTarget('unknown'), /不认识/);
  assert.equal(resolveHpmTarget('riscv-other'), GENERIC_RISCV_PORT);
  assertHpmIdentity(GENERIC_RISCV_PORT, {idcode:123});
});
await test('one shared selection migrates old preferences and preserves custom RAM settings', () => {
  store.d = {'flash.chip':'hpm6750evk2','rtt.range':'custom','rtt.addr':'0x1234'};
  assert.equal(selectedHpmBoard(),'hpm6750evk2');
  rememberHpmBoard('hpm5301evklite'); assert.equal(selectedHpmBoard(),'hpm5301evklite');
  assert.equal(store.get('rtt.rvChip'),'hpm5301evklite'); assert.equal(store.get('rtt.range'),'custom');
  assert.equal(store.get('rtt.addr'),'0x1234'); rememberHpmBoard('stm32f103');
  assert.equal(selectedHpmBoard(),'hpm5301evklite');
  globalThis.Option = class { constructor(text,value){this.text=text;this.value=value;} };
  const select = {replaceChildren(...options){this.options=options;}};
  fillHpmSelect(select,'hpm6e00evk'); assert.equal(select.value,'hpm6e00evk');
  assert.deepEqual(select.options.map(o => o.value), expected.map(e => e[0]));
  delete globalThis.Option;
});
await test('bad IDCODE is rejected before DM writes/reset', async () => {
  const sim = new SimTarget({idcode:0x12345678});
  await assert.rejects(new RiscvTransport(sim).init(), /IDCODE/);
  assert.deepEqual(sim.selectedHarts,[]);
});
const custom = createHpmTarget(HPM_CHIPS.hpm6750, {
  id:'custom-6750', name:'Custom 6750', flash: {flashBase:0x90000000,flashSize:0x10000,xpiBase:0xf3050000,option0:7,option1:null},
  debug:{hart:3}, memory:{workArea:{addr:0x4000,size:0x8000},healthPeekAddr:0x4000},
});
await test('relocated code/data/stack, smaller work area, XPI1 and nonzero hart end-to-end', async () => {
  const layout = hpmWorkLayout(custom, bytes.length, xipCopyBytes().length,65536);
  assert.ok(custom.memory.sbaReadForbidden.some(r=>r.start===0x90000000 && r.end===0x90010000),'board Flash window must automatically be excluded from SBA reads');
  assert.equal(layout.loadAddr,0x4000); assert.equal(layout.chunkBytes,20480);
  assert.ok(layout.copyAddr >= layout.loadAddr+bytes.length);
  assert.ok(layout.scratchInfo >= layout.copyAddr+xipCopyBytes().length);
  assert.ok(layout.dataBuf+layout.chunkBytes <= layout.stackBottom);
  const sim = new SimTarget({ramBase:0x4000,ramSize:0x8000,copyAddr:layout.copyAddr,
    flashBase:0x90000000,flashSize:0x10000,expectedInitArgs:[0x90000000,0xfcf90001,7,0,0xf3050000]});
  const dm = new RiscvTransport(sim,{port:custom}); await dm.init();
  const flash = new HpmFlasher(dm,{board:custom});
  const data = Uint8Array.from({length:30003}, (_, i) => i & 255);
  await flash.flashImage(0x90001000,data);
  assert.deepEqual(sim.flash.slice(0x1000,0x1000+data.length),data);
  assert.equal(sim.progChunks,2); assert.equal(sim.xipCopies,2);
  assert.ok(sim.selectedHarts.includes(3)); assert.ok(sim.selectedHarts.every(h => h===0 || h===3));
  const loaded = new DataView(sim.ram.buffer);
  for (const {offset,target} of HPM_ALGO.relocations) assert.equal(loaded.getUint32(offset,true),0x4000+target);
  assert.equal(sim.regs[2],0xc000); assert.equal(dm.hart,3);
  sim.ram.fill(0,layout.copyAddr-sim.ramBase,layout.copyAddr-sim.ramBase+28);
  await flash.recoverCore();
  assert.deepEqual(sim.ram.slice(layout.copyAddr-sim.ramBase,layout.copyAddr-sim.ramBase+28),xipCopyBytes()); assert.equal(sim.selectedHarts.at(-1),3);
  await flash.verify(0x90001000,data); await flash.finish();
});
await test('workspace/chunk/port mistakes fail before any target write', () => {
  for (const chunk of [0,-1,1.5,Infinity])
    assert.throws(() => new HpmFlasher({}, {board:HPM_BOARDS[0],chunkBytes:chunk}), /正整数/);
  const tiny = createHpmTarget(HPM_CHIPS.hpm5301,{...HPM_BOARDS[1],memory:{workArea:{size:0x1000}}});
  assert.throws(() => new HpmFlasher({}, {board:tiny}), /放不进/);
  for (const debug of [{hart:-1},{hart:1024},{irLength:4}])
    assert.throws(() => createHpmTarget(HPM_CHIPS.hpm5301,{...HPM_BOARDS[1],debug}), /porting/);
  for (const [addr,len] of [[-1,4],[0x80000000,1.5],[0x80000000,-1],[0xffffffff,2]])
    assert.equal(hpmCheckRange(HPM_BOARDS[0],addr,len).ok,false);
});
await test('prepare hook failure and resetFirst=false are honored', async () => {
  let writes=0,hookCalls=0;
  const failPort=createHpmTarget(HPM_CHIPS.hpm5301,{...HPM_BOARDS[1],hooks:{prepareFlash:async()=>{hookCalls++;throw Error('board prepare failed');}}});
  await assert.rejects(new HpmFlasher({idcode:0x1000563d,writeMem:async()=>{writes++;}},{board:failPort}).setup(),/prepare failed/);
  assert.equal(hookCalls,1); assert.equal(writes,0);
  const sim=new SimTarget({ramSize:0x20000});const dm=new RiscvTransport(sim);await dm.init();
  dm.resetHalt=async()=>{throw Error('reset must not run');};
  await new HpmFlasher(dm,{board:HPM_BOARDS[0],resetFirst:false}).setup();
});
await test('probe geometry fails before erase/write and capacity is authoritative', async () => {
  const sim=new SimTarget({ramSize:0x20000,flashSize:0x10000});
  sim.flashInfo.sectorBytes=0x3000;
  const dm=new RiscvTransport(sim);await dm.init();
  await assert.rejects(new HpmFlasher(dm,{board:HPM_BOARDS[0]}).setup(),/容量不合理/);
  assert.equal(sim.eraseOps,0);assert.equal(sim.progChunks,0);
});
await test('DDR readiness applies only to HPM6880; other models never read its SYSCTL', async () => {
  const sym={find:n=>['_init_ext_ram','init_ddr3l_1333'].includes(n)?{}:null};
  for (const id of ['hpm5301evklite','hpm6750evk2','hpm6e00evk','hpm6800evk']) {
    const session=Object.create(RiscvDebugSession.prototype), accesses=[];
    Object.assign(session,{port:resolveHpmTarget(id),sym,_log(){},dm:{readMem:async(a,n)=>{accesses.push(a);return new Uint8Array(n);}}});
    if(id==='hpm6800evk') {
      await assert.rejects(session.memRead(0x40001000,4),e=>e.code==='MEMORY_NOT_READY');
      assert.deepEqual(accesses,[0xf4000800,0xf400041c]);
    } else {
      await session.memRead(0x40001000,4);assert.deepEqual(accesses,[0x40001000]);
    }
  }
});
await test('custom chip memory readiness and reset hooks reach debug/RTT callers', async () => {
  const calls=[];
  const port=createHpmTarget(HPM_CHIPS.hpm6750,{...custom,debug:{hart:3},hooks:{checkMemoryReady:async(_ctx,a,n)=>{calls.push(['ready',a,n]);}},
    reset:{halt:async(_dm,h)=>{calls.push(['halt',h]);},haltForRun:async(_dm,h)=>{calls.push(['resetRun',h]);}}});
  const session=Object.create(RiscvDebugSession.prototype);
  Object.assign(session,{port,clearFrames(){},_log(){},dm:{readMem:async(_a,n)=>new Uint8Array(n)},
    _pollHalted:async()=>true,_rearmBpsAfterReset:async()=>calls.push(['bps']),refresh:async()=>{},refreshRegs:async()=>{},run:async()=>calls.push(['run'])});
  await session.memRead(0x4000,4);await session.resetHalt();await session.resetRun();
  assert.deepEqual(calls,[['ready',0x4000,4],['halt',3],['bps'],['resetRun',3],['bps'],['run']]);
  const {RiscvMem}=await import('../../app/rtt/riscv-mem.js');
  const mem=new RiscvMem({dm:session.dm,target:port});await mem.readMem(0x800,8);
  assert.deepEqual(calls.at(-1),['ready',0x800,8]);
});
await test('custom SBA fence catches crossing and aligned spans before the wire', async () => {
  const port=createHpmTarget(HPM_CHIPS.hpm5301,{...HPM_BOARDS[1],memory:{sbaReadForbidden:[{start:0x90000000,end:0xa0000000}]}});
  const dm=new RiscvTransport({}, {port});let commands=0;dm.sbaConfig=async()=>{commands++;};
  for (const [addr,len] of [[0x90000000,4],[0x8ffffffe,4],[0x9fffffff,1]]) await assert.rejects(dm.readMem(addr,len),/XIP/);
  assert.equal(commands,0);
  const session=Object.create(RiscvDebugSession.prototype);
  Object.assign(session,{port,sym:{codeBytes:(_a,n)=>new Uint8Array(n).fill(7)},_log(){}});
  assert.deepEqual(await session.memRead(0x90000000,4),new Uint8Array(4).fill(7));
});


await test('GOT relocations reject corrupt metadata and retain canonical bytes', async () => {
  const {relocateAlgoBytes}=await import('../../app/flash/hpm/entry.js');
  assert.deepEqual(HPM_ALGO.relocations,[{offset:0x554,target:0x440},{offset:0x558,target:0x438},{offset:0x55c,target:0x43c},{offset:0x560,target:0x434}]);
  assert.throws(()=>relocateAlgoBytes(bytes,{loadAddr:0},0x4000),/缺少 GOT/);
  assert.throws(()=>relocateAlgoBytes(bytes,{loadAddr:0,relocations:[{offset:0x554,target:0x444}]},0x4000),/不一致/);
  assert.throws(()=>hpmAlgoBytes(0xffffff00),/32 位/);
  assert.equal(hash(),initialHash);
});

await test('generic RISC-V health check never guesses an address or resets hardware', async () => {
  const dm=new RiscvTransport({}, {port:GENERIC_RISCV_PORT});let commands=0;
  dm.dmiRead=async()=>{commands++;return 0;};dm.dmiWrite=async()=>{commands++;};
  await assert.rejects(dm.sbaHealthCheck(),/未配置/);assert.equal(commands,0);
});
console.log(`HPM porting: ${passed} passed; shared algorithm SHA-256 ${initialHash}; no hardware accessed`);
