/** CDC is one receiver with a selectable producer; changing producer never reopens the port. */
export function isProbeCdcPort(port){
  let info = {};
  try { info = port?.getInfo?.() || {}; } catch {}
  return info.usbVendorId === 0x0d28 && info.usbProductId === 0x0204;
}
export class CdcMode {
  constructor(tools, manager){ this.tools = tools; this.manager = manager; }
  state(){
    const { hid, scope, session, spiCdc } = this.tools;
    let mode = 'uart';
    if (scope?._cdcPausedRequested && !scope.usingMock) mode = 'paused';
    else if (spiCdc?.session?.running) mode = 'spi';
    else if (!hid?.mock && (hid?._bridgeRequested || hid?.last?.running)) mode = 'rtt';
    if (this.manager.failures.has('hid') || this.manager.failures.has('spicdc') || (mode === 'paused' && this.manager.failures.has('scope'))) mode = 'unknown';
    return { mode, portOpen: !!session?.isOpen && isProbeCdcPort(session.port) };
  }
  assertUart(){
    const { mode } = this.state();
    if (mode !== 'uart') throw new Error(`CDC 当前为 ${mode === 'rtt' ? 'RTT 转发' : mode === 'spi' ? 'SPI 转发' : mode === 'paused' ? '暂停' : '未确认'}模式，请先停止对应功能再发送 UART 数据`);
  }
  async drainWrites(){
    if (isProbeCdcPort(this.tools.session?.port)) await this.tools.session._wq;
  }
}
