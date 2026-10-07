/** 显示通路有界排队；接收计数、原始缓冲与文件记录在外部独立进行。 */
export class BurstGuard {
  constructor(){ this.start = 0; this.bytes = 0; }
  add(n, now = performance.now()){
    if (now - this.start >= 100){ this.start = now; this.bytes = 0; }
    this.bytes += n;
    return this.bytes > 10 * 1024;
  }
}

export class AnsiDisplay {
  constructor(term, { visible = () => true, format = b => b, onSkip = () => {}, limit = 64 * 1024 } = {}){
    this.term = term; this.visible = visible; this.format = format; this.limit = limit;
    this.onSkip = onSkip;
    this.pending = []; this.bytes = 0; this.skipped = 0; this.busy = false;
    this.timer = setInterval(() => this.flush(), 60);
  }
  push(b, t){
    if (!b?.length) return;
    if (b.length > this.limit){ this.skipped += b.length - this.limit; b = b.subarray(b.length - this.limit); }
    this.pending.push({ b, t }); this.bytes += b.length;
    while (this.bytes > this.limit || this.pending.length > 1024){ const old = this.pending.shift(); this.bytes -= old.b.length; this.skipped += old.b.length; }
  }
  clear(){ this.pending = []; this.bytes = 0; this.skipped = 0; if (this.busy) this._clearOnDrain = true; }
  flush(){
    if (this.busy || !this.visible() || !this.pending.length) return;
    const chunks = []; let size = 0;
    if (this.skipped){
      this.onSkip();
      chunks.push(new TextEncoder().encode(`\r\n（显示省略了 ${this.skipped} 字节；完整数据请记录到文件）\r\n`));
      this.skipped = 0;
    }
    let records = 0;
    while (this.pending.length && size < 16 * 1024 && records++ < 128){
      const r = this.pending[0], take = Math.min(r.b.length, 16 * 1024 - size);
      const part = r.b.subarray(0, take);
      chunks.push(this.format(part, r.t)); size += take; this.bytes -= take;
      if (take === r.b.length) this.pending.shift(); else r.b = r.b.subarray(take);
    }
    const out = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
    let offset = 0; for (const b of chunks){ out.set(b, offset); offset += b.length; }
    this.busy = true;
    try { this.term.write(out, () => {
      if (this._clearOnDrain){ this.term.clear?.(); this._clearOnDrain = false; }
      this.busy = false;
    }); }
    catch (e){ this.busy = false; throw e; }
  }
}

export function terminalBytes(bytes, state){
  const out = new Uint8Array(bytes.length * 2); let n = 0;
  for (const b of bytes){
    if (b === 10 && !state.lastWasCR) out[n++] = 13;
    out[n++] = b; state.lastWasCR = b === 13;
  }
  return out.subarray(0, n);
}
