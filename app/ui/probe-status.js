import { PROBE_FEATURES } from '../core/probe-users.js';
import { setFlag } from './dom.js';

/** Only inspect local connection/lease state; never query hardware from the header. */
export function probeStatus(tools){
  const manager = tools.probeManager;
  const { pending = [], failures = [] } = manager?.summary() || {};
  const name = id => PROBE_FEATURES.find(f => f.id === id)?.label || id;
  if (failures.length) return { text:'探针：需恢复', kind:'err', title:failures.map(f => `${name(f.owner)}：${f.error}`).join('\n') };
  if (pending.length) return { text:'探针：切换中', kind:'warn', title:pending.map(p => name(p.owner)).join('、') };
  const active = PROBE_FEATURES.filter(f => f.active(tools)).map(f => f.label);
  return active.length
    ? { text:`探针：${active.length === 1 ? active[0] : `${active.length} 项连接`}`, kind:'on', title:`当前连接：${active.join('、')}` }
    : { text:'探针：未使用', kind:'off', title:'当前页面没有功能连接实体探针；串口连接状态单独显示。' };
}

export function initProbeStatus(tools){
  const summaryViews = [
    ['spi', () => `控制${tools.spiSession.connected?'已连接':'未连接'} · 数据${tools.spiSession.dataReady?'已连接':'未连接'}`],
    ['panel', () => `共享 SPI：控制${tools.spiSession.connected?'已连接':'未连接'} · 数据${tools.spiSession.dataReady?'已连接':'未连接'}`],
    ['scope', () => `探针${tools.scope.hid?.connected||tools.scope.usingMock?'已连接':'未连接'} · 数据${tools.scope.transport||tools.scope.usingMock?'已连接':'未连接'}`],
    ['rttcdc', () => `转发${tools.hid.last?.running?'运行中':tools.probeManager?.failures.has('hid')?'状态未确认':'未启动'} · 接收口${tools.session.isOpen?'已打开':'未打开'}`],
    ['spicdc', () => `转发${tools.spiCdc.session.running?'运行中':'未启动'} · 接收口${tools.session.isOpen?'已打开':'未打开'}`],
  ].map(([name, read]) => {
    const side=document.querySelector(`#tab-${name} .side`);
    if(!side)return null;
    const el=document.createElement('div');el.className='connection-summary';el.setAttribute('role','status');
    side.prepend(el);return {el,read};
  }).filter(Boolean);
  const serial = document.getElementById('conn-flag');
  setFlag(serial, tools.session.isOpen ? '串口：已连接' : '串口：未连接', tools.session.isOpen ? 'on' : 'off');
  tools.session.on('open', ({ info, opts }) => {
    setFlag(serial, '串口：已连接', 'on'); serial.title = `${info} @${opts.baudRate}`;
  });
  tools.session.on('close', () => { setFlag(serial, '串口：未连接'); serial.title = ''; });
  const el = document.getElementById('probe-flag');
  let previous = '';
  const update = () => {
    for(const {el,read} of summaryViews){const text=read();if(el.textContent!==text)el.textContent=text;}
    const state = probeStatus(tools), key = JSON.stringify(state);
    if (key === previous) return;
    previous = key;
    el.textContent = state.text; el.title = state.title; el.className = `flag flag-${state.kind}`;
  };
  update();
  // No DOM writes while unchanged, including during high-rate capture.
  setInterval(update, 1000);
}
