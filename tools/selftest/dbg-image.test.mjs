import assert from 'node:assert/strict';
import { runCmd, parseCmd, Cancelled } from '../../app/dbg/cmd.js';
import { completeLine } from '../../app/dbg/complete.js';
import { parseImage, imageLoadPlan, imageCommand, imageWords } from '../../app/dbg/image.js';
import { ImageFiles, imagePath } from '../../app/dbg/image-files.js';
import { DebugSession } from '../../app/dbg/session.js';

const text = value => new TextEncoder().encode(value);
function ihexRecord(address, kind, bytes = []){
  const data = [bytes.length, address >>> 8, address & 255, kind, ...bytes];
  data.push((-data.reduce((sum, n) => sum + n, 0)) & 255);
  return ':' + data.map(n => n.toString(16).padStart(2, '0')).join('');
}
function sRecord(kind, address, bytes = []){
  const width = {0:2,1:2,2:3,3:4,7:4,8:3,9:2}[kind];
  const data = [width + bytes.length + 1];
  for (let shift = (width - 1) * 8; shift >= 0; shift -= 8) data.push(Math.floor(address / 2 ** shift) & 255);
  data.push(...bytes); data.push((~data.reduce((sum, n) => sum + n, 0)) & 255);
  return 'S' + kind + data.map(n => n.toString(16).padStart(2, '0')).join('');
}
function elfImage({ wide = false, little = true, physical = [0x20001000, 0x20001010], virtual = [0x3000, 0x4000] } = {}){
  const bytes = new Uint8Array(512), view = new DataView(bytes.buffer), header = wide ? 64 : 52, stride = wide ? 56 : 32;
  bytes.set([0x7f,69,76,70,wide ? 2 : 1,little ? 1 : 2,1]);
  const u16 = (offset, value) => view.setUint16(offset, value, little);
  const u32 = (offset, value) => view.setUint32(offset, value, little);
  const word = (offset, value) => wide ? view.setBigUint64(offset, BigInt(value), little) : u32(offset, value);
  word(wide ? 32 : 28, header); u16(wide ? 54 : 42, stride); u16(wide ? 56 : 44, 3);
  for (let i = 0; i < 3; i++){
    const at = header + stride * i;
    u32(at, 1); word(at + (wide ? 8 : 4), 256 + i * 16);
    word(at + (wide ? 16 : 8), virtual[i] ?? 0x5000);
    word(at + (wide ? 24 : 12), physical[i] ?? 0);
    word(at + (wide ? 32 : 16), i < 2 ? 4 : 0); // Third segment is BSS only.
    word(at + (wide ? 40 : 20), 8);
    if (i < 2) bytes.set([i * 4 + 1,i * 4 + 2,i * 4 + 3,i * 4 + 4],256+i*16);
  }
  return bytes;
}

assert.deepEqual(imageWords('{sub dir/a.bin} 0x2000 bin'), ['sub dir/a.bin','0x2000','bin']);
assert.deepEqual(imageWords('"sub dir/a.bin" 0x2000'), ['sub dir/a.bin','0x2000']);
assert.deepEqual(imageWords('sub\\ dir/a.bin 0x2000'), ['sub dir/a.bin','0x2000']);
assert.deepEqual(imageWords('{sub\\dir\\a.bin}'), ['sub\\dir\\a.bin']);
for (const bad of ['{unclosed','"unclosed','{file}tail','"file"tail']) assert.throws(() => imageWords(bad));
assert.equal(parseCmd('LOAD_IMAGE {sub dir/a.bin} 0x20 bin').args[0], 'sub dir/a.bin');
assert.equal(completeLine('load_im').value, 'load_image ');
assert.equal(completeLine('dump_im').value, 'dump_image ');
assert.equal(completeLine('load_image x 0x2000 ih').value, 'load_image x 0x2000 ihex');
assert.equal(completeLine('load_image {sub dir/a.bin} 0x2000 ih').value, 'load_image {sub dir/a.bin} 0x2000 ihex');
assert.equal(completeLine('load_image "sub dir/a.bin" 0x2000 el').value, 'load_image "sub dir/a.bin" 0x2000 elf');
assert.equal(completeLine('load_image "sub dir/ih').total, 0);
assert.equal(imageCommand('load_image',['x','010','bin']).offset,8);
assert.equal(imageCommand('load_image',['x','-0x20','bin']).offset,-32);
for (const args of [[],['x','08'],['x','0x100000000'],['x','0','hex'],['x','0','bin','0xffffffff','2'],['x','0','bin','0','0','extra']])
  assert.throws(() => imageCommand('load_image',args));
assert.throws(() => imageCommand('dump_image',['x','0xffffffff','2']));
assert.equal(imageCommand('dump_image',['x','0','0']).size,0);

const hexText = [ihexRecord(0,4,[0x20,0]),ihexRecord(0x1000,0,[1,2,3,4]),ihexRecord(0x1010,0,[5,6,7,8]),ihexRecord(0,5,[0,0,0,1]),ihexRecord(0,1)].join('\n');
const hex = parseImage(text(hexText));
assert.equal(hex.type,'ihex');assert.deepEqual(hex.sections.map(s=>s.addr),[0x20001000,0x20001010]);
assert.equal(imageLoadPlan(hex).length,2,'sparse holes are not filled');
const clipped = imageLoadPlan(hex,{offset:0x10,min:0x20001012,max:0x20001022});
assert.deepEqual(clipped.map(s=>[s.addr,[...s.data]]),[[0x20001012,[3,4]],[0x20001020,[5,6]]]);
const segmentHex=parseImage(text([ihexRecord(0,2,[0x10,0]),ihexRecord(2,0,[9]),ihexRecord(0,1)].join('\n')),'ihex');
assert.equal(segmentHex.sections[0].addr,0x10002);
assert.throws(()=>parseImage(text(hexText.replace('01020304','01020305'))),/校验和/);
assert.throws(()=>parseImage(text(ihexRecord(0,0,[1])),'ihex'),/结束/);
for(const kind of [1,2,3]){
  const address={1:0x1234,2:0x123456,3:0x20001234}[kind];
  const image=parseImage(text(sRecord(kind,address,[0x55,0xaa])+'\n'+sRecord(10-kind,address)),'s19');
  assert.deepEqual(image.sections.map(s=>[s.addr,[...s.data]]),[[address,[0x55,0xaa]]]);
}
assert.equal(parseImage(text(sRecord(1,0x1234,[1,2,3]))).type,'s19');
assert.throws(()=>parseImage(text(sRecord(1,0x1234,[1,2,3]).slice(0,-2)+'00'),'s19'),/校验和/);
for(const wide of [false,true])for(const little of [false,true]){
  const image=parseImage(elfImage({wide,little}));
  assert.equal(image.type,'elf');assert.deepEqual(image.sections.map(s=>s.addr),[0x20001000,0x20001010]);
  assert.deepEqual(image.sections.map(s=>s.data.length),[4,4],'load file bytes only; do not zero BSS');
}
assert.deepEqual(parseImage(elfImage({physical:[0,0]}),'elf').sections.map(s=>s.addr),[0x3000,0x4000]);
const single=elfImage({physical:[0,0]});new DataView(single.buffer).setUint16(44,1,true);
assert.equal(parseImage(single,'elf').sections[0].addr,0,'one PT_LOAD with p_paddr=0 stays at zero');
assert.throws(()=>parseImage(elfImage().subarray(0,260),'elf'),/截断/);
assert.throws(()=>imageLoadPlan({sections:[{addr:0xffffffff,data:Uint8Array.of(1,2)}]}),/32 位/);
assert.equal(parseImage(Uint8Array.of(0x7f,69,76,70)).type,'bin','OpenOCD detects files shorter than nine bytes as bin');

const memory=new Uint8Array(20000).fill(0xaa), writes=[], reads=[], saved=new Map();
const source=Uint8Array.from({length:9001},(_,i)=>(i*73)&255);
let closes=0,aborts=0;
const session={connected:true,clearFrames(){},async memWrite(address,bytes){writes.push([address,bytes.length]);memory.set(bytes,address);},async memRead(address,size){reads.push([address,size]);return memory.slice(address,address+size);}};
const files={async read(name){assert.equal(name,'dir/a b.bin');return source;},async openWrite(name){const chunks=[];return {async write(bytes){chunks.push(bytes.slice());},async close(){closes++;saved.set(name,Uint8Array.from(chunks.flatMap(b=>[...b])));},async abort(){aborts++;}};}};
await runCmd('load_image {dir/a b.bin} 16 bin',session,{imageFiles:files});
assert.deepEqual(writes,[[16,4096],[4112,4096],[8208,809]]);
assert.deepEqual(memory.subarray(16,16+source.length),source);assert.equal(memory[15],0xaa);assert.equal(memory[9017],0xaa);
const dumped=await runCmd('dump_image {output with spaces.bin} 16 9001',session,{imageFiles:files});
assert.match(dumped.lines.at(-1).t,/dumped 9001 bytes/);assert.deepEqual(saved.get('output with spaces.bin'),source);assert.equal(closes,1);assert.equal(aborts,0);
await runCmd('dump_image empty.bin 0 0',session,{imageFiles:files});assert.equal(saved.get('empty.bin').length,0);
await assert.rejects(runCmd('dump_image x 0 10',{...session,async memRead(){return new Uint8Array(9);}},{imageFiles:files}),/短读/);
assert.equal(aborts,1);assert.equal(saved.has('x'),false);
let cancelled=false,loadWrites=0;
await assert.rejects(runCmd('load_image {dir/a b.bin} 0 bin',{...session,async memWrite(){loadWrites++;cancelled=true;}},{imageFiles:files,signal:()=>cancelled}),Cancelled);
assert.equal(loadWrites,1);
cancelled=false;
await assert.rejects(runCmd('dump_image cancelled.bin 0 9001',{...session,async memRead(a,n){cancelled=true;return new Uint8Array(n);}},{imageFiles:files,signal:()=>cancelled}),Cancelled);
assert.equal(aborts,2);assert.equal(saved.has('cancelled.bin'),false);
let failedCloseAborted=false;
await assert.rejects(runCmd('dump_image failed.bin 0 1',session,{imageFiles:{openWrite:async()=>({write:async()=>{},close:async()=>{throw Error('disk full');},abort:async()=>{failedCloseAborted=true;}})}}),/disk full/);
assert.equal(failedCloseAborted,true,'a failed close must not report export success');
let touched=0;
await assert.rejects(runCmd('load_image bad.hex 0 ihex',{...session,async memWrite(){touched++;}},{imageFiles:{read:async()=>text(hexText.replace('01020304','01020305'))}}),/校验和/);
assert.equal(touched,0,'validate the entire image before touching target memory');
await assert.rejects(runCmd('load_image x 0 bin',{connected:false},{imageFiles:files}),/连接目标/);
await assert.rejects(runCmd('load_image x',session),/镜像目录/);

assert.deepEqual(imagePath('sub/../folder/a.bin'),['folder','a.bin']);
assert.deepEqual(imagePath('folder\\a.bin'),['folder','a.bin']);
for(const path of ['../a','a/../../b','E:/a.bin','/a','\\\\host\\a','folder/',''])assert.throws(()=>imagePath(path));
const store=new ImageFiles();await assert.rejects(store.read('a.bin'),/镜像目录/);
const calls=[];store.root={async getDirectoryHandle(name){calls.push(['directory',name]);return this;},async getFileHandle(name,options){calls.push(['file',name,options.create]);return {async getFile(){return {arrayBuffer:async()=>Uint8Array.of(1,2).buffer};},async createWritable(){return {write(){},close(){},abort(){}};}};}};
assert.deepEqual(await store.read('folder/a.bin'),Uint8Array.of(1,2));await store.openWrite('folder/dump.bin');
assert.deepEqual(calls,[['directory','folder'],['file','a.bin',false],['directory','folder'],['file','dump.bin',true]]);

const target=new DebugSession();await target.connect({mock:true});
try {
  const pc=target.pc,halted=target.halted;
  await runCmd('load_image {dir/a b.bin} 0x20001000 bin',target,{imageFiles:files});
  assert.deepEqual(await target.memRead(0x20001000,source.length),source);
  await runCmd('dump_image mock.bin 0x20001000 9001',target,{imageFiles:files});
  assert.deepEqual(saved.get('mock.bin'),source);
  assert.equal(target.pc,pc);assert.equal(target.halted,halted,'image operations do not change target execution state');
} finally {await target.disconnect();}
console.log('dbg-image: OpenOCD arguments, Tcl file words, BIN/IHEX/S19/ELF32/64 endianness, relocation/window clipping, sparse/BSS preservation, chunked roundtrip, cancellation, short-read abort and directory grants PASS');
