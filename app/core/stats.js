/** 收发计数器：总量 + 滑动 1 秒速率（按 1 ms 聚合，窗口边界误差 <1 ms）。 */
export class Counter {
  constructor(){ this.reset(); }
  _prune(now){
    let head = this._head;
    while (head < this._win.length && now - this._win[head][0] > 1000) head++;
    this._head = head;
    if (head > 1024){ this._win = this._win.slice(head); this._head = 0; }
  }
  add(n, t = performance.now()){
    this.total += n; this.frames++;
    this._prune(t);
    const last = this._win[this._win.length - 1];
    // 限制时间桶数量，而不是截断最近一秒的小包，避免高事件率下低报速率。
    if (last && this._head < this._win.length && Math.floor(last[0]) === Math.floor(t)) last[1] += n;
    else this._win.push([t, n]);
  }
  rate(now = performance.now()){
    this._prune(now);
    let s = 0;
    for (let i = this._head; i < this._win.length; i++) s += this._win[i][1];
    return s;
  }
  reset(){ this.total = 0; this.frames = 0; this._win = []; this._head = 0; }
}
