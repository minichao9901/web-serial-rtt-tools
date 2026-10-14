/**
 * 「让一步」的几种姿势 —— 以及为什么**不能一律用 setTimeout**（2026-10 真机定因）。
 *
 * 🚨 事故现场（用户报「烧录非常慢，每一步都要好几秒钟」，STM32F103ZE + akaLinkPro）：
 *    同一份代码、同一块板子、同一根线，**只把浏览器窗口最小化 / 被别的窗口盖住**，
 *    烧录就从 **1.4 s 变成 12~47 s**。原因不在探针、不在 USB、不在目标芯片：
 *    页面不可见时，Chrome/Edge 会把 `setTimeout` 的短延时**钳到 ≥1 s**（后台定时器节流）。
 *    而烧录流程里有几十处 2~60 ms 的"轮询间隔"：
 *      · flashloader 跑完了没有（`isHalted` 轮询，sleep(5)）
 *      · 调试寄存器写进去了没有（S_REGRDY 轮询，sleep(2)）—— 一次烧录有 30+ 次 regWrite
 *      · 稳定读的两次之间、复位后让目标起身（sleep(20~60)）……
 *    每处各多花约 1 s，几十处就是几十秒。**节流不是"慢一点"，是把 1.4 s 变成 47 s。**
 *    实测（tools/selftest 之外的临时体检脚本，见 commit 说明）：
 *      · 页面可见（未节流）：3.3 KB 固件 1.4 s，其中 USB 往返总共 0.25 s；
 *      · 页面不可见（真节流）：同样的固件 12.6~13.0 s；
 *      · 把每个 <1 s 的等待都按 1 s 执行（节流的实际效果）：13.9 s，
 *        其中 _targetInit/sysReset/run 三个"轮询型"步骤各占 1~3 s，而 USB 层仍然只花 0.3 s。
 *    → 结论：**慢的是等待方式，不是链路**。
 *
 * 于是把等待分成三类，各自用对的原语：
 *   · `yieldTask()` —— 只是"让出一次事件循环"，不要求真实时长。
 *     用 MessageChannel 投递（普通任务，**不受定时器节流影响**），一次往返约 0.1 ms。
 *     轮询循环一律用它：节奏交给"每次迭代里那笔真实的 USB 往返"去把握。
 *     ⚠️ 长循环要配"两级节奏"（见 runner.js 的 spin 计数）——真跑几十秒的算法别空转 CPU。
 *   · `waitMs(ms)` —— "**至少**等 ms 毫秒"，≤128 ms 用让路自旋实现（不受节流，时长也真实）。
 *     用在"短但必须真实"的等待上（复位后给目标起身、S_REGRDY 轮询间隔、跨页签握手 settle）。
 *     实测一次让路往返 ≈ 22 µs，所以 128 ms 的自旋约 6000 次往返 —— 一次性等待毫无压力。
 *   · `sleep(ms)` —— 真交给定时器。用于本来就"等久一点没关系"的地方
 *     （端口复位后 150 ms、nRESET 脉冲后 120 ms、跨页签握手的 settle）。
 *     这些被钳到 1 s 也无所谓，而且一处烧录里只有几处。
 *
 * ⚠️ 别把 `sleep` 全换成 `yieldTask`：像「写完 AIRCR 等目标复位」这种必须留真实时间，
 *    换成"让一步"就变成瞬间返回了。判断标准：这一步是在**等硬件**，还是在**轮询硬件**。
 */

/** 让出一次事件循环（不受后台定时器节流影响）。一次约 0.1 ms。 */
export function yieldTask(){
  if (typeof MessageChannel !== 'function') return new Promise(r => setTimeout(r, 0));  // 老环境兜底
  return new Promise(resolve => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { try { ch.port1.close(); } catch { /* 关不关都行 */ } resolve(); };
    ch.port2.postMessage(0);
  });
}

/** 真等待（毫秒）：交给定时器。语义是"至少等这么久"，被节流钳到 1 s 也不影响正确性 */
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * **至少**等 ms 毫秒，且短等待不受定时器节流影响。
 * ≤ 128 ms 走让路自旋（时长真实、不被钳，实测 ≈22 µs/次往返）；更长的交给定时器
 * （>128 ms 本来就属于"等久点没关系"，被钳到 1 s 也不影响正确性）。
 * ⚠️ 循环里用它要自己控制次数：自旋是占 CPU 的（这正是它精确的原因）。
 */
export async function waitMs(ms){
  if (!(ms > 0)) return;
  if (ms > 128) return await sleep(ms);
  const t0 = performance.now();
  if (typeof MessageChannel !== 'function') return await sleep(ms);
  const ch = new MessageChannel();
  const hop = () => new Promise(r => { ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
  try {
    while (performance.now() - t0 < ms) await hop();
  } finally { try { ch.port1.close(); } catch { /* 同上 */ } }
}
