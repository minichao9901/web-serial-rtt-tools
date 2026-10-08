/** Real page selectors/lifecycle; never requests or opens hardware. */
import assert from 'node:assert/strict';
import {Cdp,sleep} from './cdp-lib.mjs';
const c = new Cdp(process.env.CDP || 'http://127.0.0.1:9333',20000);
const app = process.env.APP || 'http://127.0.0.1:8899/index.html';
const ids = ['hpm5300evk','hpm5301evklite','hpm5e00evk','hpm6200evk','hpm6300evk','hpm6750evk2','hpm6750evkmini','hpm6800evk','hpm6e00evk','hpm6p00evk'];
let pass=0;
try {
  await c.connect(); await c.send('Page.navigate',{url:app+'?demo=serial&t='+Date.now()});
  const deadline=Date.now()+15000;
  while(!await c.eval('return !!window.__tools?.dbg;')) {if(Date.now()>deadline)throw Error('page init timeout');await sleep(100);}
  const result=await c.json(`(async()=>{
    const {store}=await import('/app/core/store.js');
    const {rememberHpmBoard}=await import('/app/targets/hpm/select.js');
    const {resolveHpmTarget}=await import('/app/targets/hpm/porting.js');
    const $=id=>document.getElementById(id), {dbg,rtt,flash}=window.__tools;
    // Connection is deliberately forbidden throughout this suite.
    for(const api of [navigator.usb,navigator.hid]) if(api){
      api.getDevices=async()=>{throw Error('test must not enumerate hardware');};
      api.requestDevice=async()=>{throw Error('test must not request hardware');};
    }
    const result={};
    for(const id of ['d-hpm-target','r-chip','f-chip'])
      result[id]=[...$(id).options].filter(o=>o.value.startsWith('hpm')).map(o=>o.value);
    $('d-backend').value='riscv'; await dbg._syncBackend();
    result.rvVisible=!$('d-hpm-target-row').hidden && getComputedStyle($('d-hpm-target-row')).display!=='none';
    $('d-hpm-target').value='hpm5301evklite';$('d-hpm-target').dispatchEvent(new Event('change'));
    result.selected=store.get('target.hpmBoard');
    store.set('rtt.target','riscv');
    $('r-target').value='riscv';$('r-chip').value='hpm6800evk';
    $('r-range').value='0x01240000-0x01250000';rtt.onShow();
    result.rttBoard=$('r-chip').value;result.defaultRange=$('r-range').value;
    $('r-range').value='0x12340000-0x12341000';$('r-addr').value='0x12340040';
    rememberHpmBoard('hpm6750evk2');rtt.onShow();
    result.customRange=$('r-range').value;result.elfAddr=$('r-addr').value;
    $('f-chip').value='hpm6800evk';flash.onShow();result.flashBoard=$('f-chip').value;
    dbg.onShow();result.debugBoard=$('d-hpm-target').value;
    dbg.session.port=resolveHpmTarget('hpm5301evklite');
    dbg.session.probe={};dbg._syncButtons(true,false);
    rememberHpmBoard('hpm6e00evk');
    result.activePort=dbg.session.port.id;result.activeDisabled=$('d-hpm-target').disabled;
    dbg.session.probe=null;dbg._syncButtons(false,false);dbg.onShow();
    result.afterDisconnect=$('d-hpm-target').value;
    $('d-backend').value='mock';await dbg._syncBackend();
    result.genericOption=[...$('d-hpm-target').options].some(o=>o.value==='riscv-other');
    $('d-hpm-target').value='riscv-other';$('d-hpm-target').dispatchEvent(new Event('change'));
    dbg.onShow();result.genericRemembered=$('d-hpm-target').value;
    result.armHidden=$('d-hpm-target-row').hidden && getComputedStyle($('d-hpm-target-row')).display==='none';
    return result;
  })()`);
  for(const selector of ['d-hpm-target','r-chip','f-chip']){assert.deepEqual(result[selector],ids);pass++;}
  assert.equal(result.rvVisible,true);assert.equal(result.armHidden,true);pass++;
  assert.equal(result.selected,'hpm5301evklite');assert.equal(result.rttBoard,'hpm5301evklite');
  assert.equal(result.defaultRange,'0x00080000-0x00090000');pass++;
  assert.equal(result.customRange,'0x12340000-0x12341000');assert.equal(result.elfAddr,'0x12340040');pass++;
  assert.equal(result.flashBoard,'hpm6750evk2');assert.equal(result.debugBoard,'hpm6750evk2');pass++;
  assert.equal(result.activePort,'hpm5301evklite');assert.equal(result.activeDisabled,true);pass++;
  assert.equal(result.afterDisconnect,'hpm6e00evk');pass++;
  assert.equal(result.genericOption,true);assert.equal(result.genericRemembered,'riscv-other');pass++;
  console.log(`HPM porting page: ${pass} passed; generated selectors, shared selection, custom ranges and active-session isolation; no hardware accessed`);
} finally {c.close();}
