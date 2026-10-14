/**
 * 源码文件仓 —— 「停下来显示当前源码行」的另一半（行号表那一半在 `app/elf/lines.js`）。
 *
 * 浏览器**读不到**你磁盘上的 `.c`（安全模型），所以必须由用户明确给一次权限。两条路：
 *   ① `showDirectoryPicker()`（File System Access，Chromium 系；http://127.0.0.1 与 https 下可用）
 *      —— 选一次工程目录，之后按需读文件，**不用重复授权**（句柄可以留着）；
 *   ② `<input type="file" webkitdirectory>`（老浏览器兜底）—— 拿到的是 File 快照，
 *      文件后来改了要重新选一次目录。
 *
 * 命中率的关键在 `resolve()`：ELF 里记的是**编译机上的绝对路径**
 * （`E:/proj/src/main.c`，甚至跟同事机器上的路径不一样），而用户选的目录可能是
 * `E:/proj`、`E:/proj/MDK-ARM` 或它的父目录。所以按"从最长后缀开始逐级尝试"匹配，
 * 再退到"同名文件唯一就认它"。匹配不上就老实说"没找到源文件"，不猜别的文件。
 */

/**
 * 索引文件数上限。
 *
 * 🚨 2026-10 真机现场：HPM6800EVK + lwip_tcpecho 的 ELF，DWARF 里记的是编译机绝对路径
 *    `E:/sdk_env_v1.11.0/hpm_sdk/...`，而 `hpm_sdk` 有 **33255** 个文件、`sdk_env_v1.11.0`
 *    有 **43719** —— 老上限 20000 一进去就被截断（只给一句 ⚠），选"最外层那块"反而可能
 *    索引不到你要的那个 .c。现在放到 60000：`sdk_env_v1.11.0` 整棵也装得下（含工具链头文件）。
 *    条目本身只存路径字符串（句柄模式不读文件内容），几万条对桌面浏览器不是负担；
 *    真正的代价是"选目录那一下"要遍历几万个目录项，几秒钟，慢但一次性。
 */
const MAX_FILES = 60000;
const MAX_DEPTH = 14;
const SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '__pycache__']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;         // 单个源文件读取上限（防手滑选到整个磁盘）
const MAX_CACHE = 120;

export const normSlashes = p => String(p ?? '').replace(/\\/g, '/');
export const baseNameOf = p => normSlashes(p).split('/').pop() || '';
const isAbs = p => /^([A-Za-z]:\/|\/)/.test(p);
const styleOf = p => (/^[A-Za-z]:\//.test(p) ? 'win' : 'posix');

/**
 * 「ELF 里的绝对路径」→「相对所选目录的路径」。
 *
 * 依据：用户在目录选择器里选中的那个目录，它的**名字**必定出现在 DWARF 路径里（选 hpm_sdk，
 * 路径里就有 `…/hpm_sdk/…`；选它的父目录 `sdk_env_v1.11.0`，路径里也有）—— 取名字之后的那一截
 * 就是这个文件在所选目录下的相对路径，直接拿去做 `getFileHandle` 即可，**不用遍历目录**。
 * 名字对不上（工具链路径、编译机路径）就返回 null：那些文件本来也不在这个目录里。
 */
export function relUnderRoot(absPath, rootName){
  const parts = normSlashes(absPath).split('/').filter(Boolean);
  const want = String(rootName || '').trim().toLowerCase();
  if (!want || parts.length < 2) return null;
  for (let i = 0; i < parts.length - 1; i++){
    if (parts[i].toLowerCase() === want) return parts.slice(i + 1).join('/');
  }
  return null;
}

/**
 * 从 ELF 的 DWARF 路径里推荐「该选哪个源码目录」。
 *
 * 为什么能做：`.debug_line` 里存的就是**编译时的路径**，这份 HPM6800EVK 的 ELF 实测 188 条
 * **全是绝对路径**，而且分三簇：
 *   · `E:/sdk_env_v1.11.0/hpm_sdk` 146 条（例程 / SoC / 驱动 / lwIP 内核）
 *   · `E:/sdk_env_v1.11.0/toolchains` 18 条（工具链头文件）
 *   · `/home/builder/...` 24 条（**编译机上的路径**，本机不存在，谁也覆盖不到）
 * 用户要手选一个目录，选小了 `main` 以外的看不到，选大了几万个文件还得遍历。
 *
 * 算法（好解释、也稳）：先按"前两段"分簇（`E:/sdk_env_v1.11.0`、`/home/builder`…），取文件最多的
 * 那一簇；然后在簇内**沿最大分支往下钻**：只要最大的孩子几乎装下这一层（≥ 85%，默认）就继续往
 * 具体里走，一旦再往下会丢掉超过 15% 的文件就停 —— 得到"覆盖够多、又尽量具体"的那个目录。
 * （阈值是这么定的：实测 `E:/sdk_env_v1.11.0` 164 → `…/hpm_sdk` 146 是 89%，往下钻几乎不亏，
 *   于是推荐 `hpm_sdk`；再往下最大分支只占两成多，钻进去就要丢一半文件，所以停住。）
 * 另外把别的簇也钻一遍列出来（跨机器/跨盘的标 foreign —— 那份 HPM 的 ELF 里就有 24 条
 * `/home/builder/...`，本机永远覆盖不到，先说清楚省得用户白挑）。
 */
export function sourceRootSuggestions(rawPaths, { maxOthers = 2, drill = 0.85, minShare = 0.02 } = {}){
  const seen = new Map();                       // 小写 → 原样（Windows 路径不区分大小写）
  for (const raw of (rawPaths || [])){
    const p = normSlashes(raw);
    if (!p || !isAbs(p)) continue;
    const k = p.toLowerCase();
    if (!seen.has(k)) seen.set(k, p);
  }
  const paths = [...seen.values()];
  const total = paths.length;
  if (!total) return { total: 0, best: null, root: null, others: [], covered: 0 };

  /**
   * 分簇用的"机器根"：取前两个**非空**路径段。
   *   `E:/sdk_env_v1.11.0/hpm_sdk/…` → `E:/sdk_env_v1.11.0`
   *   `/home/builder/work/…`         → `/home/builder`（posix 前面那个空段要跳过，否则会缩成 /home）
   */
  const clusterKey = p => {
    const seg = p.split('/').filter(Boolean).slice(0, 2);
    return seg[0]?.endsWith(':') ? seg.join('/') : '/' + seg.join('/');
  };
  const clusters = new Map();
  for (const p of paths){
    const k = clusterKey(p).toLowerCase();
    if (!clusters.has(k)) clusters.set(k, { dir: clusterKey(p), files: [] });
    clusters.get(k).files.push(p);
  }
  const ranked = [...clusters.values()].sort((a, b) => b.files.length - a.files.length);
  const main = ranked[0];

  /** 在一个簇内"沿最大分支往下钻"，直到没有哪个孩子占该目录的绝对多数 */
  const drillDown = (cluster) => {
    let cur = cluster.dir, curCount = cluster.files.length;
    for (;;){
      const prefix = cur + '/';
      const kids = new Map();
      for (const p of cluster.files){
        if (!p.toLowerCase().startsWith(prefix.toLowerCase())) continue;
        const rest = p.slice(prefix.length);
        if (!rest.includes('/')) continue;                   // 直接躺在这一层的文件，不是"孩子"
        const seg = rest.split('/')[0];
        const k = (prefix + seg).toLowerCase();
        kids.set(k, { dir: prefix + seg, n: (kids.get(k)?.n || 0) + 1 });
      }
      const top = [...kids.values()].sort((a, b) => b.n - a.n)[0];
      if (!top || top.n < curCount * drill) break;
      cur = top.dir; curCount = top.n;
    }
    return { dir: cur, files: curCount, share: curCount / total };
  };

  const best = drillDown(main);
  const others = ranked.slice(1)
    .filter(c => c.files.length / total >= minShare)
    .slice(0, maxOthers)
    .map(c => ({ ...drillDown(c), foreign: styleOf(c.dir) !== styleOf(main.dir) }));

  return {
    total,
    best,
    root: { dir: main.dir, files: main.files.length, share: main.files.length / total },
    others,
    covered: best.files,
  };
}

export class SourceStore {
  constructor(){
    this.rootName = '';
    this.byRel = new Map();          // 相对路径（小写）→ 条目
    this.byBase = new Map();         // 文件名（小写）→ 条目数组
    this.entries = [];
    this.text = new Map();           // 路径（小写）→ 文本
    this.note = '';
    this.root = null;                // showDirectoryPicker 给的目录句柄（认得它就不用整棵遍历）
    this._generation = 0;
    this._files = null;
    this.expected = null;            // ELF 里的完整路径列表 —— "按需索引"的唯一依据
  }

  static supported(){
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  }

  get ready(){ return this.entries.length > 0; }
  get count(){ return this.entries.length; }

  summary(){
    if (!this.ready) return this.note || '还没选源码目录';
    return `源码目录「${this.rootName}」：${this.entries.length} 个文件`
      + (this.note ? `　⚠ ${this.note}` : '');
  }

  clear(){
    this._resetEntries();
    this._files = null;
    this.rootName = ''; this.note = '';
    this.root = null;                                   // ELF 路径列表跟着 ELF 走，不在这里清
  }

  /** 只清"索引"，保留目录句柄与 ELF 路径列表（重新索引时用） */
  _resetEntries(){
    this._generation++;
    this.byRel.clear(); this.byBase.clear(); this.entries = []; this.text.clear();
    this.note = '';
  }

  _put(entry){
    this.entries.push(entry);
    const rel = entry.rel.toLowerCase();
    if (!this.byRel.has(rel)) this.byRel.set(rel, entry);
    const b = entry.base.toLowerCase();
    if (!this.byBase.has(b)) this.byBase.set(b, []);
    this.byBase.get(b).push(entry);
  }

  /**
   * 路径①：选目录（Chromium；必须由用户点击触发）。
   *
   * 🚨 **不再整棵遍历**（2026-10 用户现场：选 `E:\sdk_env_v1.11.0\hpm_sdk` 要等很久 ——
   *    那棵树 33000+ 个文件，遍历几万个目录项当然慢）。现在只**记住句柄**：
   *    ELF 的路径列表一到（`setExpectedPaths`），就只按那份列表去"要哪几个文件开哪几个"，
   *    188 个文件就是 188 次 `getFileHandle`，毫秒级；`MAX_FILES` 只对下面 FileList 那条兜底路有效。
   */
  async pick(){
    if (!SourceStore.supported()) throw new Error('这个浏览器不支持选目录（用「选择源码文件夹…」那个按钮，或换 Chrome/Edge）');
    const dir = await window.showDirectoryPicker({ id: 'dbg-src', mode: 'read' });
    this.clear();
    this.root = dir;
    this.rootName = dir.name || '';
    if (this.expected?.length){ await this.indexFromExpected(); return this.summary(); }
    this.note = '已记住这个目录：载入 .elf 后按 ELF 里的路径直接索引（不再整棵遍历）';
    return this.summary();
  }

  /** ELF 载入后把它的路径列表交进来：能立刻按需索引（有目录句柄的话），并报覆盖数 */
  async setExpectedPaths(paths){
    this.expected = [...new Set((paths || []).map(normSlashes).filter(Boolean))];
    if (this.root){
      await this.indexFromExpected();
      return this.summary();
    }
    if (this._files) return this.indexFileList(this._files);
    return this.note || '还没选源码目录';
  }

  /**
   * 按 ELF 的路径列表**按需索引**：只对"这条路径在所选目录下的那一截"做 getFileHandle，
   * 不做目录遍历、不看没被引用的文件。命中几个算几个，并如实报出覆盖数。
   */
  async indexFromExpected(){
    this._resetEntries();
    const generation = this._generation, root = this.root, rootName = this.rootName;
    const list = [...(this.expected || [])];
    if (!list.length){ this.note = '当前 ELF 没有源码路径，未扫描目录'; return this.summary(); }
    let hit = 0, miss = 0;
    for (const p of list){
      if (generation !== this._generation) return this.summary();
      const rel = relUnderRoot(p, rootName);
      if (!rel) continue;
      const fh = await this._openRel(rel, root).catch(() => null);
      if (generation !== this._generation) return this.summary();
      if (!fh){ miss++; continue; }
      this._put({ rel, base: baseNameOf(rel), kind: 'handle', h: fh });
      hit++;
    }
    if (generation !== this._generation) return this.summary();
    this.note = `按 ELF 的路径按需索引：${hit}/${list.length} 个文件在这个目录里`
      + (miss ? `（另外 ${miss} 条不在 —— 工具链/编译机路径居多）` : '');
    /**
     * 一条都没命中 ⇒ 多半是**选错了目录**（比如选了别处的同名文件夹），
     * 这时退回"整棵遍历 + 后缀/同名兜底"那条老路 —— 慢，但至少可能找得到。
     */
    if (!hit && this.root){
      this.note = '按 ELF 的路径一条都没命中（可能选错了目录）→ 退回整棵遍历再试一次';
      await this._walk(root, '', 0, generation);
    }
    return this.summary();
  }

  /** 打开"相对所选目录"的文件句柄（逐级 getDirectoryHandle，最后 getFileHandle） */
  async _openRel(rel, root = this.root){
    const parts = normSlashes(rel).split('/').filter(Boolean);
    if (!root || !parts.length) return null;
    let dir = root;
    for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
    return await dir.getFileHandle(parts[parts.length - 1]);
  }

  async _walk(dir, prefix, depth, generation = this._generation){
    if (depth > MAX_DEPTH || generation !== this._generation) return;
    for await (const [name, h] of dir.entries()){
      if (generation !== this._generation) return;
      if (this.entries.length >= MAX_FILES){ this.note = `文件数超过 ${MAX_FILES}，只索引了前面这些`; return; }
      if (h.kind === 'directory'){
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
        await this._walk(h, prefix ? `${prefix}/${name}` : name, depth + 1, generation);
      } else {
        this._put({ rel: prefix ? `${prefix}/${name}` : name, base: name, kind: 'handle', h });
      }
    }
  }

  /** 路径②：`<input webkitdirectory>` / 拖进来的 FileList（老浏览器兜底） */
  indexFileList(list){
    this._resetEntries();
    const arr = Array.from(list || []);
    this.root = null;
    this._files = arr;
    this.rootName = (arr[0]?.webkitRelativePath || '').split('/')[0] || '（已选文件夹）';
    /**
     * 浏览器已经把整棵树列给我们的（这一步没法省），但**索引可以只留 ELF 用得上的那些**：
     * 3 万个文件里通常只有一两百个是 DWARF 引用过的，只留它们，后面 resolve/read 也清爽。
     */
    const wanted = this.expected?.length
      ? new Set(this.expected.map(p => relUnderRoot(p, this.rootName)).filter(Boolean).map(s => s.toLowerCase()))
      : null;
    // 兜底：喂进来的可能是"光文件名"的 File（自测脚本就这么造），按同名也放行
    const wantedBase = this.expected?.length
      ? new Set(this.expected.map(p => baseNameOf(p).toLowerCase()))
      : null;
    for (const f of arr){
      if (this.entries.length >= MAX_FILES) break;
      const rel = normSlashes(f.webkitRelativePath || f.name).replace(/^[^/]+\//, '');
      if (wanted && wanted.size && !wanted.has(rel.toLowerCase())
          && !wantedBase.has(baseNameOf(rel).toLowerCase())) continue;
      this._put({ rel, base: baseNameOf(rel), kind: 'file', h: f });
    }
    if (wanted && wanted.size){
      this.note = `按 ELF 的路径筛过：索引 ${this.entries.length} 个文件（ELF 引用 ${this.expected.length} 条）`;
    }
    return this.summary();
  }

  /** ELF 里的路径 → 索引里的条目（匹配不上返回 null） */
  resolve(p){
    const full = normSlashes(p);
    if (!full || !this.ready) return null;
    const parts = full.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++){                 // 从最长后缀开始试
      const hit = this.byRel.get(parts.slice(i).join('/').toLowerCase());
      if (hit) return hit;
    }
    const same = this.byBase.get(baseNameOf(full).toLowerCase());
    if (same?.length === 1) return same[0];                 // 同名只有一个 → 认它
    return null;
  }

  /** 读源码（带缓存）；找不到/读不了**抛人话错误**，界面照实显示 */
  async read(p){
    const generation = this._generation;
    const key = normSlashes(p).toLowerCase();
    if (this.text.has(key)) return this.text.get(key);
    const entry = this.resolve(p);
    if (!entry) throw new Error(`源码目录里找不到 ${baseNameOf(p)}（点「选择源码目录…」选到它的上级目录；ELF 里记的是 ${p}）`);
    let file;
    try {
      file = entry.kind === 'handle' ? await entry.h.getFile() : entry.h;
    } catch (e){
      throw new Error(`打不开 ${entry.rel}：${e?.message || e}（浏览器的目录授权可能被回收了，重新选一次目录）`);
    }
    if (file.size > MAX_FILE_BYTES) throw new Error(`${entry.rel} 有 ${(file.size / 1048576).toFixed(1)} MB，太大不读`);
    const txt = await file.text();
    if (generation !== this._generation) throw new Error('源码目录或 ELF 已切换，请重新读取');
    if (this.text.size >= MAX_CACHE) this.text.delete(this.text.keys().next().value);
    this.text.set(key, txt);
    return txt;
  }
}
