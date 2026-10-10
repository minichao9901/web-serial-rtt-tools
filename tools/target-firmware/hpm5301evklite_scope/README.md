# HPM5301EVKLite J-Scope 靶子

复用 HPM6800EVK 的已知数据契约：`g_v` 提供 8 个 10 kHz 更新变量，`g_v_hi` 提供 200 kHz 计数和 500 Hz 平滑正弦。所有采样值都能按 `src/main.c` 的公式核验。HPM5301 没有 D-cache，变量集中放在 `.noncacheable.bss`，即 HPM5301 DLM/SBA 窗口；异常现场同样位于此处。

构建：

```powershell
pwsh -File tools\target-firmware\hpm5301evklite_scope\build.ps1
```

烧录后在 J-Scope 页加载 `fw.elf`，选择 `g_v.u_hi`、`g_v.tick` 或 `g_v_hi.f_sin`。符号地址每次构建可能变化，以 ELF 为准。首次 HPM5301 测量使用 `node tools/selftest/hw-campaign-hpm.mjs --board=5301evklite --chip=hpm5301evklite --record --cycles=1 --alt=1`，记录设备自身的 RTT/J-Scope 能力。
