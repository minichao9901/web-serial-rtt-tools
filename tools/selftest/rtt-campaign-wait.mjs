/** Observe the first completed RTT poll without changing an active debug session. */
export async function waitForFirstRttData({ readState, pause, now = Date.now, timeoutMs = 25000 }){
  const deadline = now() + timeoutMs;
  for (;;){
    const st = await readState();
    if (st.polls >= 1 && st.bytes > 0) return st;
    if (st.slow)
      throw new Error(`链路偏慢（health=${JSON.stringify(st.health)}）—— 需要重开 USB 会话`);
    if (st.running === false && st.error)
      throw new Error(`RTT Viewer（RISC-V）轮询已停止：${st.err}`);
    if (now() >= deadline)
      throw new Error(`RTT Viewer（RISC-V）首轮没跑起来：polls=${st.polls} bytes=${st.bytes} 状态栏=${st.err || '—'}`);
    await pause(400);
  }
}

/** Capture after a whole poll to avoid partial-buffer bias in short rate windows. */
export async function waitForNextRttPoll({ readState, pause, now = Date.now, timeoutMs = 5000 }){
  const first = await readState(), deadline = now() + timeoutMs;
  for (;;){
    const st = await readState();
    if (st.running === false) throw new Error(`RTT 轮询已停止：${st.err || '—'}`);
    if (st.polls < first.polls || st.bytes < first.bytes) throw new Error('RTT 测速窗口内统计已重置');
    if (st.polls > first.polls) return st;
    if (now() >= deadline) throw new Error('等待 RTT 完整轮询超时');
    await pause(10);
  }
}
