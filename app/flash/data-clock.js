/** Bulk flash data may use a user-selected SWD rate; execution control stays
 * at 1MHz. Never execute a flashloader after an unverified fast RAM copy. */
export class FlashDataClock {
  constructor(probe, clockKhz = 1000){
    if (!Number.isInteger(clockKhz) || clockKhz < 100 || clockKhz > 60000) throw new Error('烧录时钟应在 100～60000 kHz 之间');
    this.probe = probe;
    this.clockKhz = clockKhz;
  }
  async _transfer(fn){
    if (this.clockKhz === 1000) return await fn();
    const p = this.probe;
    await p._healIfFaulted?.();
    let result, failure;
    try { await p.setClock(this.clockKhz * 1000); result = await fn(); }
    catch (e){ failure = e; }
    try { await p.setClock(1000000); }
    catch (e){
      if (failure) throw new AggregateError([failure, e], '烧录数据传输与恢复控制时钟均失败');
      throw e;
    }
    if (failure) throw new Error(`烧录数据传输在 ${this.clockKhz / 1000} MHz 失败，请降低时钟：${failure.message}`, { cause: failure });
    return result;
  }
  async readMem(addr, length){ return await this._transfer(() => this.probe.readMem(addr, length)); }
  async writeMem(addr, data){
    if (this.clockKhz === 1000) return await this.probe.writeMem(addr, data);
    return await this._transfer(async () => {
      const p = this.probe, original = p.verifyWrites;
      p.verifyWrites = false;
      try {
        await p.writeMem(addr, data);
        await p.flushWrites?.();
        const back = await p.readMem(addr, data.length);
        if (back.length !== data.length || back.some((v, i) => v !== data[i]))
          throw new Error(`RAM 数据回读不一致（0x${addr.toString(16)}），未启动烧录算法`);
      } finally { p.verifyWrites = original; }
    });
  }
}
