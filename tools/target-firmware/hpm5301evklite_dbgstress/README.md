# HPM5301EVKLite RISC-V 调试压力靶子

与 HPM6800EVK 调试靶子使用相同的控制流、深层调用、递归、分支、结构体、位域、数组和局部变量场景。观测变量放在 `.noncacheable.bss`，链接到 HPM5301 DLM/SBA 可读区域；HPM5301 无 D-cache。

构建：

```powershell
pwsh -File tools\target-firmware\hpm5301evklite_dbgstress\build.ps1
```

在烧录页写入 `fw.elf` 后运行：

```powershell
node tools/selftest/dbg-hw-riscv.mjs --board=5301evklite
```

压力程序以 10 kHz MCHTMR 节拍持续运行。`g_stage` 表示流水线阶段，`g_ticks`、`g_checksum` 和 `g_trap_*` 可用于观察运行与异常现场。真机异常验收可在调试器写 `g_fault_trigger=1`，程序会执行非法指令并在 `g_exception_stall` 停住；预期 `mcause=2`、`mepc` 指向非法指令，且 `g_trap_*` 与 CSR 一致。
