# F103CB SWO 复杂靶子

128 KiB Flash / 20 KiB SRAM，HSI 8 MHz。该例程专门验证 SWO PC 采样，不属于 RTT/JScope 活动固件矩阵。它不初始化 UART 或自行配置 SWO，由网页通过 SWD 配置 trace 输出。

执行阶段每次持续 35 ms：扫描/CRC → 排序 → A 或 B 分支 → 编码 → 递归 → WFI → 校验，持续循环。`g_scenario=0` 为 A，`=1` 为 B。1 kHz SysTick 有计算工作，每 100 ms 挂起一次 PendSV。

源码分为启动、主循环和计算管线三个文件。刻意保留 `never_path()`，但 `g_enable_decoy=0` 时不执行。全局阶段号、256 项环形阶段日志及 ITM port 1 的 `0xA5sssspp` 单次非阻塞输出提供验证依据；标记仅在 ITM port 1 被主机启用时输出。`g_mark_dropped` 统计未能写入的软件标记。ITM 标记用于核对阶段，PC-only 模式不需要它。

构建：

```powershell
pwsh -NoProfile -File tools/target-firmware/stm32f103cb_swo/build.ps1
```

Arm GNU GCC，`-O1 -g3 -gdwarf-4`，禁用省略帧指针与尾调用。发布文件为根目录 `fw.elf`，生成目录为 `build/`。已构建 ELF 随仓库提供，可直接载入示例；重建后 ELF 指纹可能改变，需重新采集与该 ELF 匹配的示例，不能将旧记录强行映射到新 ELF。

Flash text 5,940 B、data 408 B、BSS 3,308 B。正常测试先备份用户原固件，最后完整恢复；手工烧录该例程会替换目标程序。

[页面与实测报告](../../../docs/SWO-PC-SAMPLING.md)。
