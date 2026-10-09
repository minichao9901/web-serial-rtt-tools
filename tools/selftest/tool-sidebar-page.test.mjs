/** 四页侧栏：模拟采集不中断、桥会话共享、控件保留、键盘与窄窗口显示。 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Cdp, sleep } from './cdp-lib.mjs';

const c = new Cdp(process.env.CDP || 'http://127.0.0.1:9333', 40000);
const app = process.env.APP || 'http://127.0.0.1:8899/index.html';
const configs = [['scope','sc','capture'],['spi','sp','bus'],['panel','pn','display'],['i2c','i2','bus']];
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
try {
  await c.connect(); await c.send('Page.navigate', { url: app + '?tool-sidebar=' + Date.now() + '#scope' }); await sleep(600);
  await c.eval(`for(const side of document.querySelectorAll('[data-sidebar-tabs]')) side.querySelector('[data-side-tab]').click();const sc=__tools.scope;await sc.setMock(true);document.getElementById('sc-period').value=1000;document.getElementById('sc-seconds').value=10;await sc.start();`);
  await sleep(180);
  const running = await c.eval(`const sc=__tools.scope,p=sc.hid,period=document.getElementById('sc-period').value,side=document.querySelector('#tab-scope .tool-side');for(const b of side.querySelectorAll('[data-side-tab]'))b.click();return {running:sc.running,same:sc.hid===p,period:document.getElementById('sc-period').value===period,stop:!document.getElementById('sc-stop').disabled&&!!document.getElementById('sc-stop').getClientRects().length};`);
  check(running.running && running.same && running.period && running.stop, '切换采集侧栏不中断采集，停止仍可用');
  await c.eval(`document.getElementById('sc-stop').click();`); await sleep(250);
  check(await c.eval(`return !__tools.scope.running;`), '帮助 tab 中的常驻停止按钮可停止采集');
  await c.eval(`await __tools.scope.setMock(false);await __tools.spiSession.setMock(true);`);
  const shared = await c.eval(`const S=__tools.spiSession,p=S.mockProbe,cfg=JSON.stringify(S.cfg);for(const name of ['spi','panel'])for(const b of document.querySelectorAll('#tab-'+name+' [data-side-tab]'))b.click();return __tools.spi.session===__tools.panel.session&&S.mockProbe===p&&S.connected&&JSON.stringify(S.cfg)===cfg;`);
  check(shared, '两页共享 SPI 会话，切 tab 不重连、不改配置');
  await c.eval(`await __tools.spiSession.setMock(false);await __tools.i2c._connect(false,true);`);
  check(await c.eval(`const S=__tools.i2c.session,h=S.hid,cfg=JSON.stringify(S.cfg);for(const b of document.querySelectorAll('#tab-i2c [data-side-tab]'))b.click();return S.connected&&S.enabled&&S.hid===h&&JSON.stringify(S.cfg)===cfg;`), 'I2C 切 tab 保持已使能的会话和配置');
  mkdirSync('docs/shots', { recursive: true });
  for (const [name,prefix,representative] of configs){
    await c.eval(`location.hash=${JSON.stringify(name)};`); await sleep(60);
    const state = await c.eval(`const side=document.querySelector('#tab-'+${JSON.stringify(name)}+' .tool-side'),tabs=[...side.querySelectorAll('[data-side-tab]')],ids=[...side.querySelectorAll('[id]')].map(e=>e.id),help=side.querySelector('[data-side-panel=help]');const full=help.textContent;for(const t of tabs)t.click();const last=tabs.at(-1);last.focus();last.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));return {idsUnique:new Set(ids).size===ids.length,keyboard:document.activeElement===tabs[0]&&tabs[0].getAttribute('aria-selected')==='true',one:[...side.querySelectorAll('[data-side-panel]')].filter(p=>!p.hidden).length===1,help:full.length>60,collapsed:[...help.querySelectorAll('details')].every(d=>!d.open),status:!side.querySelector('.tool-side-actions').closest('[role=tabpanel]')};`);
    check(state.idsUnique && state.keyboard && state.one && state.help && state.collapsed && state.status, name+' 分组、说明与键盘操作');
    for (const width of [1600,900,600]){
      await c.send('Emulation.setDeviceMetricsOverride', { width,height:950,deviceScaleFactor:1,mobile:false }); await sleep(60);
      const layout = await c.eval(`const side=document.querySelector('#tab-'+${JSON.stringify(name)}+' .tool-side'),tabs=[...side.querySelectorAll('[data-side-tab]')],result=[];for(const t of tabs){t.click();const panel=side.querySelector('[data-side-panel="'+t.dataset.sideTab+'"]'),nav=side.querySelector('nav').getBoundingClientRect(),actions=side.querySelector('.tool-side-actions').getBoundingClientRect();result.push({key:t.dataset.sideTab,overflow:side.scrollWidth-side.clientWidth,nav:nav.height>0,actions:actions.height>0&&actions.top>=nav.bottom,content:panel.getBoundingClientRect().height>20});}return result;`);
      check(layout.every(r=>r.overflow<=1&&r.nav&&r.actions&&r.content), name+' '+width+' px，所有 tab 的内容和运行控制可见：'+JSON.stringify(layout));
      await c.eval(`document.getElementById(${JSON.stringify(prefix+'-side-'+representative+'-tab')}).click();document.activeElement.blur();if(${JSON.stringify(name)}==='panel')document.querySelector('#pn-dock-tabs [data-dock=img]').click();`);
      if (width===1600) writeFileSync(`docs/shots/${name}-sidebar-tabs.png`, Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
  }
  check(await c.eval(`const v=__tools.i2c;document.getElementById('i2-side-help-tab').click();v._setState('验收错误：总线超时','err');const el=document.getElementById('i2-state');return el.textContent.includes('总线超时')&&el.classList.contains('err')&&el.getBoundingClientRect().height>0;`), '帮助 tab 也能看见错误状态');
  await c.eval(`await __tools.i2c.session.disconnect();document.getElementById('i2-side-diagnostics-tab').click();`);
  await c.send('Page.reload'); await sleep(450);
  check(await c.eval(`return document.getElementById('i2-side-diagnostics-tab').getAttribute('aria-selected')==='true';`), '刷新后保留侧栏选择');
  check(await c.eval(`return __tools.errors.length===0;`), '无未捕获页面异常');
  console.log(`PASS: ${checks} 项侧栏检查（模拟探针，未使用实物探针）`);
} finally {
  try { await c.eval(`await __tools.scope.stop();await __tools.scope.setMock(false);await __tools.spiSession.setMock(false);await __tools.i2c.session.disconnect();for(const s of document.querySelectorAll('[data-sidebar-tabs]'))s.querySelector('[data-side-tab]').click();`); await c.send('Emulation.clearDeviceMetricsOverride'); } catch {}
  c.close();
}
