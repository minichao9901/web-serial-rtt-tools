/** 真实页面连接状态与按钮颜色；模拟 HID 能力应答，不使用实物探针。 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Cdp, sleep } from './cdp-lib.mjs';
const c = new Cdp(process.env.CDP || 'http://127.0.0.1:9333', 30000);
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
async function waitFor(expression){
  for (let i=0;i<100;i++){
    if (await c.eval('return ' + expression + ';')) return;
    await sleep(50);
  }
  throw Error('等待页面状态超时：' + expression);
}
try {
  await c.connect();
  await c.send('Page.navigate', { url: (process.env.APP || 'http://127.0.0.1:8899/index.html') + '?analog-connect=' + Date.now() + '#analog' });
  await sleep(500);
  await c.eval(`
    const { AkaLinkHid } = await import('./app/hid/probe.js');
    window.__anFixture = { hold: true, fail: false };
    AkaLinkHid.prototype.request = async function(){
      if (__anFixture.hold) await new Promise(r => __anFixture.release = r);
      if (__anFixture.fail) throw Error('模拟连接失败');
      this.device = { opened: true, productName: '模拟 ADC' };
    };
    AkaLinkHid.prototype.close = async function(){ if(this.device)this.device.opened=false;this.device=null; };
    AkaLinkHid.prototype.xfer = async function(cmd, data){
      const action=data[0], b=new Uint8Array(action===9?20:16), v=new DataView(b.buffer);
      if (action===9){ b.set([65,68,66,50,0x8b,2,15,6]);v.setUint32(8,2000000,true);v.setUint16(12,4096,true);v.setUint16(14,4096,true);b[17]=1;v.setUint16(18,3300,true); }
      else b.set([68,65,67,49,1,0,0,0]);
      return Uint8Array.of(8+b.length,cmd,action,0,0,0,0,...b);
    };
    window.__anButtons=()=>{const a=document.getElementById('an-connect'),d=document.getElementById('an-disconnect');return {connect:a.disabled,close:d.disabled,color:getComputedStyle(a).backgroundColor,connected:__tools.analog.session.connected};};
  `);
  const idle = await c.eval('return __anButtons();');
  check(!idle.connect && idle.close, '初始只有连接可用');
  await c.eval(`document.getElementById('an-connect').click();`);
  await waitFor("typeof __anFixture.release === 'function'");
  check(await c.eval(`const b=__anButtons();return b.connect&&b.close;`), '授权处理中禁止重复连接和关闭');
  await c.eval(`__anFixture.hold=false;__anFixture.release();`);
  await waitFor('!__tools.analog.session._connectPromise');
  const connected = await c.eval('return __anButtons();');
  check(connected.connected && connected.connect && !connected.close && connected.color !== idle.color, 'ADC 连接成功后连接变灰、关闭可用');
  if (process.env.SHOTS){
    await c.send('Emulation.setDeviceMetricsOverride', { width:1600, height:950, deviceScaleFactor:1, mobile:false });
    mkdirSync('docs/shots', { recursive:true });
    writeFileSync('docs/shots/analog-connected-controls.png', Buffer.from((await c.send('Page.captureScreenshot', { format:'png' })).data, 'base64'));
    await c.send('Emulation.clearDeviceMetricsOverride');
  }
  await c.eval(`await __tools.analog.session.disconnect();`);
  check(await c.eval(`const b=__anButtons();return !b.connected&&!b.connect&&b.close;`), '会话从外部关闭后，按钮仍同步');
  await c.eval(`__anFixture.fail=true;document.getElementById('an-connect').click();`);
  await waitFor("document.getElementById('an-state').textContent.includes('模拟连接失败')");
  check(await c.eval(`const b=__anButtons();return !b.connected&&!b.connect&&b.close&&document.getElementById('an-state').textContent.includes('模拟连接失败');`), '连接失败恢复连接按钮并显示错误');
  await c.eval(`__anFixture.fail=false;document.getElementById('an-connect').click();`);
  await waitFor('__tools.analog.session.connected');
  await c.eval(`const h=__tools.analog.session.hid;h.device.opened=false;h.onDisconnect();`);
  check(await c.eval(`const b=__anButtons();return !b.connected&&!b.connect&&!b.close;`), '掉线后可以重新连接，也可关闭遗留会话');
  await c.eval(`document.getElementById('an-disconnect').click();`);
  await waitFor('!__tools.analog.session.hid');
  check(await c.eval(`const b=__anButtons();return !b.connected&&!b.connect&&b.close&&__tools.errors.length===0;`), '关闭后恢复初始状态，无页面异常');
  console.log('PASS: ' + checks + ' 项 ADC/DAC 连接按钮检查');
} finally { c.close(); }
