import assert from 'node:assert/strict';
import {checkHpmFrame as check} from '../dev/hpm-scope-contract.mjs';
const v={'g_v.tick':25,'g_v.u_hi':0x10000019,'g_v.f_sin':1,'g_v.f_tri':-.5,
 'g_v.i_sq1k':-1000,'g_v.i_sq5k':1000,'g_v.u_ramp':25};
assert.deepEqual(check(v),{bad:false,torn:false});
assert.deepEqual(check({...v,'g_v.i_sq5k':-1000}),{bad:false,torn:true});
for(const value of [0,NaN,Infinity,12345])assert.equal(check({...v,'g_v.i_sq1k':value}).bad,true);
assert.equal(check({...v,'g_v.u_hi':0}).bad,true);
assert.equal(check({...v,'g_v.f_tri':100}).bad,true);
assert.equal(check({...v,'g_v.u_ramp':28}).bad,true);
assert.deepEqual(check({'g_v_hi.tick':100,'g_v_hi.f_sin':1}),{bad:false,torn:false,phaseSkew:0});
assert.equal(check({'g_v_hi.tick':99,'g_v_hi.f_sin':1}).torn,true);
assert.equal(check({'g_v_hi.tick':100,'g_v_hi.f_sin':0}).bad,true);
assert.equal(check({'g_v_hi.tick':98,'g_v_hi.f_sin':1}).phaseSkew,2);
assert.equal(check({'g_v_hi.tick':97,'g_v_hi.f_sin':1}).bad,true);
assert.equal(check({'g_v_hi.tick':96,'g_v_hi.f_sin':1},5).phaseOutlier,true);
assert.equal(check({'g_v_hi.tick':94,'g_v_hi.f_sin':1},5).bad,true);
console.log('HPM scope waveform contract: correct fields, torn update and corrupt values PASS');
