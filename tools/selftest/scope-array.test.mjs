import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Elf} from '../../app/elf/elf.js';
import {listSampleable} from '../../app/elf/dwarf.js';
import {arrayElementChannels} from '../../app/scope/array-vars.js';
import {ScopeView} from '../../app/scope/view.js';

const elf=new Elf(readFileSync(new URL('../fixtures/dwarf/riscv_array_scope.elf',import.meta.url)));
const r=listSampleable(elf),sym=n=>elf.symbols().find(s=>s.name===n);
const channels=path=>arrayElementChannels(r.dwarf,path,{ram:r.ram});
assert.equal(r.source,'dwarf');
assert.equal(r.arrays.length,5);
assert.equal(r.sampleable.length,0,'large arrays are catalogued without eagerly expanding millions of elements');
assert.equal(channels('scope_u16[3]')[0].addr,sym('scope_u16').addr+6);
assert.equal(channels('scope_u16[3]')[0].scalar,'u16');
assert.equal(channels('scope_matrix[1][2]')[0].addr,sym('scope_matrix').addr+20);
assert.equal(channels('scope_matrix[1][2]')[0].scalar,'f32');
assert.equal(channels('scope_cube[1][2][3]')[0].addr,sym('scope_cube').addr+23);
const row=channels('scope_channels[1]');
assert.deepEqual(row.map(v=>v.name),['scope_channels[1].value','scope_channels[1].flags','scope_channels[1].gain']);
assert.equal(row[0].addr,sym('scope_channels').addr+sym('scope_channels').size/2);
assert.equal(channels('scope_channels[1].samples[2]')[0].addr,row[0].addr+16);
assert.equal(channels('scope_big[8388607]')[0].addr,sym('scope_big').addr+8388607);
for(const path of ['scope_u16[4]','scope_u16[-1]','scope_matrix[2][0]','scope_matrix[0][3]','scope_big[8388608]','scope_u16[9007199254740993]']){
  assert.throws(()=>channels(path),/越界/,path);
}
for(const path of ['scope_u16','scope_matrix[0]','scope_channels[0].pointer','scope_u16[0]+1','scope_u16[0];alert(1)','scope_channels[0].absent']){
  assert.throws(()=>channels(path),undefined,path);
}
assert.throws(()=>arrayElementChannels(r.dwarf,'scope_u16[3]',{ram:[sym('scope_u16').addr,sym('scope_u16').addr+7]}),/RAM/,'entire sample must fit the RAM window');

// Real DWARF 4 RTT structure array: member type and stride come from the ELF.
const rttElf=new Elf(readFileSync(new URL('../fixtures/dwarf/stm32f103_rtt_speed.elf',import.meta.url)));
const rtt=listSampleable(rttElf),root=rtt.dwarf.varType('_SEGGER_RTT');
const aUp=root.type.members.find(m=>m.name==='aUp');
const off=aUp.type.elem.members.find(m=>m.name==='WrOff');
const wr=arrayElementChannels(rtt.dwarf,'_SEGGER_RTT.aUp[0].WrOff',{ram:rtt.ram})[0];
assert.equal(wr.addr,root.addr+aUp.offset+off.offset);assert.equal(wr.scalar,'u32');
assert.equal(arrayElementChannels(rtt.dwarf,'_SEGGER_RTT.aUp[0]',{ram:rtt.ram}).length,4);

// View logic: scalar selection, structure choices, de-duplication, 8-channel
// limit and invalid input all go through the real add handler.
const elements=new Map(['sc-arraypath','sc-arrayinfo','sc-search'].map(k=>[k,{value:'',textContent:''}]));
globalThis.document={getElementById:k=>elements.get(k)};
const v=Object.create(ScopeView.prototype);
Object.assign(v,{dwarf:r.dwarf,ram:r.ram,all:[],selected:[],running:false,usingMock:false,renderVars(){},updatePlan(){},setStatusText(text,kind){this.status={text,kind};}});
const add=path=>{elements.get('sc-arraypath').value=path;v.addArrayElement();};
add('scope_u16[1]');add('scope_u16[1]');
assert.equal(v.all.length,1);assert.equal(v.selected.length,1);
add('scope_channels[0]');assert.equal(v.all.length,4);assert.equal(v.selected.length,1);
for(const path of ['scope_u16[0]','scope_u16[2]','scope_u16[3]','scope_cube[0][0][0]','scope_cube[0][0][1]','scope_cube[0][0][2]','scope_cube[0][0][3]'])add(path);
assert.equal(v.selected.length,8);
add('scope_matrix[1][2]');assert.equal(v.selected.length,8);assert.match(elements.get('sc-arrayinfo').textContent,/最多同时采样/);
const count=v.all.length;add('scope_u16[4]');assert.equal(v.all.length,count);assert.equal(v.status.kind,'err');
v.running=true;add('scope_u16[0]');assert.match(v.status.text,/停止采样/);
console.log('scope-array: real DWARF 4/5, multidimensional strides, structure members, bounds, 8 MB lazy catalog, selection limits PASS');
