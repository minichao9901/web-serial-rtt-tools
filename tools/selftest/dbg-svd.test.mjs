/** SVD parser/decoder selftest (无需浏览器或探针). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSvdXml, decodeSvdRegister, svdSummary } from '../../app/dbg/svd.js';
import {gunzipSync} from 'node:zlib';
import {SvdValueState,svdAutoReadReason} from '../../app/dbg/svd-state.js';

const xml = readFileSync(new URL('../../app/dbg/svd/STM32F103xx.svd', import.meta.url), 'utf8');
const model = parseSvdXml(xml);
assert.equal(model.name, 'STM32F103xx');
assert.ok(model.peripherals.length >= 50);
const gpio = model.peripherals.find(p => p.name === 'GPIOA');
assert.ok(gpio && gpio.baseAddress === 0x40010800);
const crl = gpio.registers.find(r => r.name === 'CRL');
assert.ok(crl && crl.addressOffset === 0 && crl.fields.some(f => f.name === 'MODE0' && f.width === 2));
const decoded = decodeSvdRegister(crl, 0x0000000b);
assert.equal(decoded.valueHex, '0x0000000B');
assert.equal(decoded.fields.find(f => f.name === 'MODE0').value, 3);
assert.equal(decoded.fields.find(f => f.name === 'CNF0').value, 2);
assert.match(svdSummary(model), /53 个外设/);
assert.throws(() => parseSvdXml('<device><name>x</name></device>'), /没有可用/);
for(const [name,expectedRegisters]of [['STM32H743',2946],['STM32H750',3067]]){
  const source=readFileSync(new URL(`../../app/dbg/svd/${name}.svd`,import.meta.url));
  assert.equal(gunzipSync(readFileSync(new URL(`../../app/dbg/svd/${name}.svd.gz`,import.meta.url))).toString('utf8'),source.toString('utf8').replace(/\r\n/g,'\n'));
  const h7=parseSvdXml(source.toString('utf8'));
  assert.equal(h7.name,name);assert.equal(h7.peripherals.length,122);
  assert.equal(h7.peripherals.reduce((n,p)=>n+p.registers.length,0),expectedRegisters);
  assert.equal(h7.peripherals.filter(p=>!p.registers.length).length,0);
  const gpioA=h7.peripherals.find(p=>p.name==='GPIOA'),gpioB=h7.peripherals.find(p=>p.name==='GPIOB');
  assert.equal(gpioB.baseAddress,0x58020400);assert.equal(gpioB.registers.length,gpioA.registers.length);
  assert.ok(gpioB.registers.some(r=>/(^|_)IDR$/.test(r.name)&&r.addressOffset===0x10));
  assert.ok(h7.peripherals.find(p=>p.name==='USART2').registers.length>10);
  assert.equal(h7.peripherals.find(p=>p.name==='TIM2').baseAddress,0x40000000);
}
assert.throws(()=>parseSvdXml('<device><peripherals><peripheral derivedFrom="B"><name>A</name></peripheral><peripheral derivedFrom="A"><name>B</name></peripheral></peripherals></device>'),/继承循环/);
assert.throws(()=>parseSvdXml('<device><peripherals><peripheral derivedFrom="missing"><name>A</name></peripheral></peripherals></device>'),/找不到继承/);
const values=new SvdValueState(),firstStop={},secondStop={};
assert.equal(values.sample('reg',1n,{stopToken:firstStop}).mask,0n);
assert.equal(values.sample('reg',3n,{running:true,now:10}).mask,2n);
assert.equal(values.sample('reg',3n,{running:true,now:1000}).mask,2n);
assert.equal(values.highlight('reg',{running:true,now:2010}).mask,0n);
// Running reads must not replace the previous halted snapshot.
assert.equal(values.sample('reg',3n,{stopToken:secondStop}).mask,2n);
assert.equal(values.sample('reg',3n,{stopToken:secondStop}).mask,2n);
assert.equal(values.sample('reg',3n,{stopToken:{}}).mask,0n);
assert.equal(values.sample('other',3n,{stopToken:{}}).mask,0n);
values.clear();assert.equal(values.highlight('reg').mask,0n);
values.sample('bits',0n,{running:true,now:0});values.sample('bits',1n,{running:true,now:10});values.sample('bits',3n,{running:true,now:1000});
assert.equal(values.highlight('bits',{running:true,now:2010}).mask,2n);
assert.equal(values.highlight('bits',{running:true,now:3000}).mask,0n);
assert.match(svdAutoReadReason({access:'write-only'}),/只写/);
assert.match(svdAutoReadReason({fields:[{readAction:'clear'}]}),/副作用/);
assert.equal(svdAutoReadReason({access:'read-only',fields:[]}), '');
console.log('dbg-svd: F103/H743/H750 data, inheritance, field decode, live expiry and halted snapshots PASS');
