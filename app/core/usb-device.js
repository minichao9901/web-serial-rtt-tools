/** Shared device/interface lifecycle. transferIn/Out deliberately bypass this queue. */
const byDevice = new WeakMap();
const bySerial = new Map();
let resetGuard = null;
export function setUsbResetGuard(fn){ resetGuard = fn; }
function entryFor(device){
  let e = byDevice.get(device);
  if (e && !e.disconnected) return e;
  // No serial number means no safe way to merge two distinct device objects.
  const key = device.serialNumber ? `${device.vendorId}:${device.productId}:${device.serialNumber}` : null;
  e = (key && bySerial.get(key)) || { key, device, clients: new Set(), interfaces: new Map(), chain: Promise.resolve() };
  byDevice.set(device, e);
  if (key) bySerial.set(key, e);
  return e;
}
export function usbDeviceInUse(device){ return !!entryFor(device).clients.size; }

export class UsbLease {
  constructor(device, owner, { timeoutMs = 5000 } = {}){
    this.entry = entryFor(device);
    this.device = this.entry.device;
    this.owner = owner;
    this.timeoutMs = timeoutMs;
    this.claims = new Map();
    this.externalIfaces = new Set();
  }
  _run(fn){
    const e = this.entry;
    const p = e.chain.then(() => {
      if (e.unsettled && !e.disconnected) throw new Error('上一次 USB 生命周期操作仍未退出，请等待或拔插探针');
      return fn();
    });
    e.chain = p.catch(() => {});
    return p;
  }
  async _io(fn){
    let timer, timedOut = false;
    const native = Promise.resolve().then(fn);
    native.then(() => { if (timedOut) this.entry.unsettled = false; }, () => { if (timedOut) this.entry.unsettled = false; });
    try {
      return await Promise.race([native, new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true; this.entry.unsettled = true; this.entry.fault = true;
          reject(new Error('USB 生命周期操作超时，请断开其它功能后重试恢复'));
        }, this.timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  async _open(){
    const d = this.device;
    if (this.entry.disconnected) throw new Error('USB 设备已拔出，请重新选择探针');
    if (!this.entry.off && globalThis.navigator?.usb?.addEventListener){
      const e = this.entry;
      e.off = event => {
        if (event.device !== e.device && byDevice.get(event.device) !== e) return;
        e.disconnected = true;
        if (e.key && bySerial.get(e.key) === e) bySerial.delete(e.key);
        try { globalThis.navigator.usb.removeEventListener('disconnect', e.off); } catch {}
        try { e.device.close()?.catch?.(() => {}); } catch {}
      };
      globalThis.navigator.usb.addEventListener('disconnect', e.off);
    }
    const others = [...this.entry.clients].filter(c => c !== this);
    // Failed setup may have no caller left to retry cleanup. Recover only after all
    // live peers have released; abandoned native requests still require a reset.
    if (others.length && others.every(c => c.abandoned)){
      if (!d.opened) await this._io(() => d.open());
      await this._reset();
    }
    if (this.entry.fault) throw new Error('USB 生命周期状态未确认，需要独占复位恢复');
    // Reserve before open, so cleanup cannot close a handle during setup.
    this.entry.clients.add(this);
    this.abandoned = false;
    if (!d.opened) await this._io(() => d.open());
    if (d.configuration === null) await this._io(() => d.selectConfiguration(1));
  }
  open(){ return this._run(() => this._open()); }
  claim(iface, endpoints){
    return this._run(async () => {
      await this._open();
      const e = this.entry;
      if ([...e.interfaces.get(iface) || []].some(c => c.externalIfaces?.has(iface)))
        throw new Error(`USB 接口 ${iface} 正由外部工作线程使用`);
      for (const c of e.clients){
        if (c === this) continue;
        for (const eps of c.claims.values()) if (endpoints.some(ep => eps.has(ep)))
          throw new Error(`USB 端点正在被 ${c.owner} 使用`);
      }
      let owners = e.interfaces.get(iface);
      if (!owners){
        await this._io(() => this.device.claimInterface(iface));
        owners = new Set(); e.interfaces.set(iface, owners);
      }
      owners.add(this);
      this.claims.set(iface, new Set(endpoints));
    });
  }
  /** Reserve an interface in this page while a dedicated worker owns the native USB handle. */
  claimExternal(iface, endpoints){
    return this._run(async () => {
      const e = this.entry;
      if (e.disconnected) throw new Error('USB 设备已拔出，请重新选择探针');
      const owners = e.interfaces.get(iface);
      if (owners?.size) throw new Error(`USB 接口 ${iface} 已被占用`);
      for (const c of e.clients){
        if (c === this) continue;
        for (const eps of c.claims.values()) if (endpoints.some(ep => eps.has(ep)))
          throw new Error(`USB 端点正在被 ${c.owner} 使用`);
      }
      e.clients.add(this); this.abandoned = false;
      e.interfaces.set(iface, new Set([this]));
      this.claims.set(iface, new Set(endpoints));
      this.externalIfaces.add(iface);
    });
  }
  async _release(iface){
    const owners = this.entry.interfaces.get(iface);
    if (!owners?.has(this)) return;
    if (owners.size === 1 && this.device.opened && !this.externalIfaces.has(iface))
      await this._io(() => this.device.releaseInterface(iface));
    owners.delete(this);
    if (!owners.size) this.entry.interfaces.delete(iface);
    this.claims.delete(iface);
    this.externalIfaces.delete(iface);
  }
  release(iface){ return this._run(() => this._release(iface)); }
  canRetireHandle(){
    return this.entry.clients.has(this) && this.entry.clients.size === 1 && !this.externalIfaces.size;
  }
  async _reset(){
    const others = [...this.entry.clients].filter(c => c !== this && !c.abandoned);
    if (others.length) throw new Error(`USB 整设备复位需要先断开 ${others.map(c => c.owner).join('、')}`);
    await resetGuard?.(this.owner, this.device);
    await this._io(() => this.device.reset());
    this.entry.fault = false;
    this.entry.interfaces.clear();
    this.claims.clear();
    for (const c of this.entry.clients) if (c.abandoned){ c.claims.clear(); this.entry.clients.delete(c); }
  }
  abandon(){ this.abandoned = true; }
  reset(){ return this._run(() => this._reset()); }
  close({ dirty = false } = {}){
    return this._run(async () => {
      if (this.entry.disconnected){
        this.claims.clear(); this.entry.clients.delete(this); this.entry.interfaces.clear();
        return;
      }
      if (!this.entry.clients.has(this)) return;
      if (dirty || this.entry.fault) await this._reset(); // Failure retains the lease and native requests.
      for (const iface of [...this.claims.keys()]) await this._release(iface);
      if (this.entry.clients.size <= 1 && this.device.opened && !this.externalIfaces.size)
        await this._io(() => this.device.close());
      this.entry.clients.delete(this);
    });
  }
}
