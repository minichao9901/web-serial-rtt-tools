import assert from 'node:assert/strict';
import {measureAdc,cursorDelta,formatMeasure} from '../../app/analog/measure.js';
const close=(a,b,e=1e-4)=>assert.ok(Math.abs(a-b)<=e,`${a} != ${b}`);
const signal=(fn,n=4000,rate=100000,bits=16)=>Uint16Array.from({length:n},(_,i)=>Math.round(fn(i/rate)*(2**bits-1)/3.3));
for(const bits of [8,10,12,16]){
  const codes=signal(t=>1.65+Math.sin(2*Math.PI*1000*t),4000,100000,bits);
  const m=measureAdc(codes,{rate:100000,bits,reference:3.3});
  close(m.frequency,1000,.05);close(m.period,.001,1e-7);
  close(m.min,.65,3.3/(2**bits-1));close(m.max,2.65,3.3/(2**bits-1));
  close(m.average,1.65,3.3/(2**bits-1));close(m.peakToPeak,2,6.6/(2**bits-1));
}
for(const duty of [.1,.3,.5,.9]){
  const codes=signal(t=>t*1000%1<duty?.5:2.8);
  close(measureAdc(codes,{rate:100000}).frequency,1000,1);
}
const fractional=measureAdc(signal(t=>1.65+Math.sin(2*Math.PI*1234*t)),{rate:100000});
close(fractional.frequency,1234,.1);
assert.equal(measureAdc(new Uint16Array(1000).fill(20000),{rate:100000}).frequency,null);
assert.equal(measureAdc(Uint16Array.of(100,101,100,99),{rate:100000}).frequency,null);
assert.equal(measureAdc(signal(t=>1.65+Math.sin(2*Math.PI*1000*t),150),{rate:100000}).frequency,null);
let seed=1;const noise=Uint16Array.from({length:4000},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>16;});
assert.equal(measureAdc(noise,{rate:100000}).frequency,null);
const chirp=signal(t=>1.65+Math.sin(2*Math.PI*(500*t+40000*t*t)));
assert.equal(measureAdc(chirp,{rate:100000}).frequency,null);
const spike=new Uint16Array(65536).fill(100);spike[12345]=65535;
assert.equal(measureAdc(spike,{rate:1e6}).max,3.3,'narrow spikes survive automatic measurements');
assert.equal(measureAdc([],{}).min,null);
assert.deepEqual(cursorDelta({x:[.001,.002],y:[.5,2.5]}),{dt:.001,frequency:1000,dv:2});
assert.deepEqual(cursorDelta({x:[.002,.001],y:[2.5,.5]}),{dt:-.001,frequency:1000,dv:-2});
assert.equal(cursorDelta({x:[0,0],y:null}).frequency,null);
assert.equal(formatMeasure(.001,'s'),'1 ms');assert.equal(formatMeasure(1e-7,'s'),'100 ns');
assert.equal(formatMeasure(1000,'Hz'),'1 kHz');assert.equal(formatMeasure(null,'V'),'—');
console.log('ADC measurements: raw statistics, 8/10/12/16 bit, sine/pulse/fractional rate, DC/noise/short/unstable rejection, spikes, signed cursors PASS');
