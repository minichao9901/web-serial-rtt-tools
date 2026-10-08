# HPM 系列（RISC-V）零安装烧录 —— 设计、离线验证与 bring-up 清单

> 目标：在**烧录器**页用 WebUSB 直接烧 HPM 系列的外部 flash，不需要 OpenOCD/本地桥。
> 数据来源：`E:\sdk_env_v1.11.0\hpm_sdk`（HPM SDK v1.11.0）。本轮**未使用探针**（被别的开发占用），
> 所以下面严格区分「离线已验证」与「待真机 bring-up」。

## 1. 为什么这条路的每一环都是"有据可依"的

| 环节 | 依据（不是猜的） |
|---|---|
| 烧录算法的机器码 | HPM SDK 自带 `samples/openocd_algo/`（RV32 源码 + 链接脚本 + 入口表），本仓库用 SDK 的工具链自己编 |
| 算法怎么调 | 入口表 + 各函数签名（`flash_init/erase/program/read/get_info/erase_chip/deinit`）来自那份源码 |
| 板级参数（flash 基址/XPI 基址/option0/option1） | SDK 的 `boards/openocd/boards/*.cfg` 里 `flash bank xpi0 hpm_xpi …` 一行 |
| TAP IDCODE / IR 长度 / work-area | SDK 的 `boards/openocd/soc/*.cfg` |
| ROM API 表地址 | 各 `soc/<系列>/<型号>/hpm_romapi.h`：SDK 所列系列共用 `0x2001FF00`；官方 `hpm_xpi` 驱动实际加载统一算法数组，以运行时参数适配板卡 |
| JTAG 位序、DMI 流水线、SBA 语义 | akaLinkPro 探针固件 `src/riscv/riscv_jtag.c`（那份在 HPM6800EVK 上跑通过），逐条对齐 |
| DAP 封包格式 | 探针固件 `src/dap/DAP.c` 的 `DAP_JTAG_Sequence` 实现（照它的字节布局，不照记忆） |
| output_mode 切换报文 | akaLinkPro 的 `script_test/hpm6800_probe.py set-mode`（照抄 7 个字节） |

## 2. 数据通路

```
烧录器页
 ├─ HID 0xFF00 ──── CMD_SET_CONFIG(0x02) → 探针 output_mode = SWD+JTAG（RAM-only，掉电即失）
 └─ WebUSB（interface 0，CMSIS-DAP v2，bulk OUT 0x02 / IN 0x81）
      ├─ DAP_Connect(2)         → 拿 JTAG 口
      ├─ DAP_JTAG_Configure(5)  → 一个 TAP、IR 长度 5
      └─ DAP_JTAG_Sequence(0x14) × N
            └─ TAP: IR=0x01 读 IDCODE / IR=0x10 读 DTMCS / IR=0x11 读写 DMI(41 位)
                  └─ Debug Module：dmcontrol/dmstatus/abstractcs/command/data0（停核、传参、取返回码）
                        └─ SBA（sbcs/sbaddress0/sbdata0）：往 SRAM 写 flashloader、读写数据中转区
```

模块（`app/flash/hpm/`）：

| 文件 | 职责 |
|---|---|
| `algo.js` | **自动生成**：flashloader blob（base64）+ 构建时的符号地址 + header 常量 |
| `entry.js` | 入口表解析：走一遍 `jal` 发现偏移（**步长不是 8 B**，见下） |
| `chips.js` | 兼容导出 + 初始化参数/范围检查；权威参数与钩子在 `app/targets/hpm/porting.js` |
| `jtag.js` | TAP 动作 / DMI 41 位编码 / 抽象命令 / sbcs 位（TM 位置与固件逐条对齐） |
| `riscv-dm.js` | `RiscvTransport`：init / halt / waitHalted / 抽象寄存器 / SBA 块读写 / 单字流水读 |
| `dap-transport.js` | 真机：WebUSB + CMSIS-DAP 的 JTAG 序列封包/解包 |
| `flash.js` | `HpmFlasher`：加载算法 → init → get_info → 擦 → 写 → 校验 → 复位运行 |

## 3. 三个"踩过就知道"的点

1. **入口表步长不是 8 B**：`func_table.S` 里每项是 `jal` + `ebreak`，而汇编器把 `ebreak` 压成
   2 字节的 `c.ebreak` ⇒ **每项 6 B**。构建脚本一开始按 8 B 校验，第 2 项就炸了。
   现在偏移由 `entry.js` **真解码**（识别 RVC 的 16 位指令）得到，并用构建时抓的符号地址对账。
2. **blob 必须 `-nostdlib` + 自带 `memset`**：算法只用到一个 `memset`，而链 newlib 会把
   malloc 表 / `impure_data` / GOT 一起带进来 —— 实测 **1388 B → 16868 B**。要逐字写进 SRAM，差一个数量级。
3. **等算法跑完只能轮询，不能再写 haltreq**：算法靠最后一条 `ebreak` 自然停住来交差；
   轮询时若再发 `haltreq` 会把还在擦写的算法当场打断，返回码变垃圾（`waitHalted()` 与 `halt()` 因此分开）。

## 4. 离线已验证（`make test-hpm`，69 项；`make test-image`，10 项；都不需要探针/板子）

`tools/selftest/hpm-sim.mjs` 是**模拟目标**：真的按位解释 `jtag.js` 生成的 JTAG 序列
（TAP 状态机 → IR → 41 位 DMI 流水线），实现 DM 寄存器、SBA 语义、SRAM、XPI flash，
并按**入口表**执行七个算法函数（包括 NOR 的"按位与"编程语义）。
模拟器刻意按**真机定标**的语义来（下面第 5 节那些坑都能在离线自测里炸出来，而不是等到板子上）：

- **地址参数是偏移**：传绝对地址一律 `out of range`（真机 rc=2 的行为）；
- **`dcsr.ebreak*` 没置时 `ebreak` 变异常**：算法"跑飞不 halt"（初始 dcsr 按"全新板子"造，不靠上次调试器留下的状态）；
- **`sbaddress0` 写入即触发预读**（带 `sbreadonaddr` 时）：写路径配错就会整体错位一个字。

已验证：
- blob 尺寸/入口表/符号对账；垃圾输入不会进表；**机器码级结构自检**（无"无出口自循环/自递归"）；
- TAP 复位与装 IR 的位序、41 位 DMI 布局、抽象命令编码（`dpc = 0x7b1`）、`c.jal` 立即数符号扩展、sbcs 位；
- IDCODE/DTMCS/DMSTATUS 读回、halt、抽象命令读写寄存器与 dpc、`prepareRun()`（dcsr + progbuf fence）；
- SBA 块写→块读逐字节一致、非对齐读补齐、越界写报错、单字流水读的"延迟一拍"语义；
- **端到端**：加载 flashloader（1388 B 经 SBA 写入 SRAM）→ `flash_init` → `flash_get_info`
  （拿回真容量/扇区）→ 擦 → 按 4 KB 分块写（尾块补 0xFF）→ `flash_read` 校验；
- 负例：往"已是 0"的位写 1 → 校验必须抓出（NOR 语义）；主机侧范围检查拦住越界地址；
- DAP 封包/解包与固件 `DAP.c` 的布局一致（含"TMS=1 的序列也要带 TDI"这条）；
- ELF/HEX/BIN 解析：**按节取 + VMA→LMA 换算**、`NOBITS` 不烧、无节表时退回按段。

## 5. 真机 bring-up 结果（HPM6800EVK + akaLinkPro，2026-10）

**结论：通了。** 网页里点烧录 → `demo.elf`（45.1 KB）擦/写/校验全绿 → `ndmreset` 复位后
固件从 flash 跑起来（自描述契约块 `g_v @ 0x01240000` 的 magic 是 `'SCOP'`、tick 以 ~10 kHz 推进、
`f_sin / i_sq1k / ramp / u_hi` 都在契约范围内）。**独立复核**：绕开烧录器自己的校验，
把 flash 读回来与本地 ELF **逐节**对账，逐字节一致。

这一轮真机挖出来 7 个离线测不出来的坑（全部已修 + 已加回归测试）：

| # | 坑 | 现象 | 修法 |
|---|---|---|---|
| 1 | **dpc 的寄存器号写错**（`0x7c1`，规范是 `0x7b1`） | 写"pc"其实落到自定义 CSR 上 → 核始终从复位向量跑，`dmstatus` 永远 running、算法永不结束、读 pc 永远 `0x80001` | `REGNO.PC = 0x7b1`（与 OpenOCD 的 `riscv.h` 一致） |
| 2 | **用 ndmreset 停核** | 顺手复位整个 SoC、把核停在 boot ROM；`dmstatus` 位被误读成 unavail | 改成只写 `haltreq`（OpenOCD 全程不碰 ndmreset），reset-halt 只留作兜底 |
| 3 | **dmstatus 位排法** | 这台 DM 是 0.11 排法：停=`[9:8]`、跑=`[11:10]`、resumeack=`[17:16]`；之前把 `[11:10]` 当 unavail | `DMSTATUS_LAYOUT` 两套都认 + `detectLayout()` 实测 |
| 4 | **算法收尾的 `ebreak` 变成异常** | 没置 `dcsr.ebreak*` 时 `ebreak` 只是断点异常 → 核跳异常向量乱跑 | 跑算法前 `dcsr \|= ebreak*`（OpenOCD 的 `set_dcsr_ebreak()`） |
| 5 | **刚写进 SRAM 的代码没刷指令预取** | 同上，表现为"跑飞/卡住" | 跑算法前用 **progbuf**（抽象命令 postexec）执行 `fence.i; fence rw,rw`（不能在 SRAM 里跑，鸡生蛋） |
| 6 | **`memset` 被 GCC 优化成"调自己"** | `memset.c` 的字节循环触发 loop idiom recognition（`-ftree-loop-distribute-patterns`）→ `c.jal memset` 无限递归，**一条 `sb` 都没有**；`flash_init` 第一步 `memset(nor_config,0,256)` 就转死、连 haltreq 都抓不住（"烧录卡死"） | 该文件加 `-fno-tree-loop-distribute-patterns -fno-builtin`；新增 `check-algo.mjs` **机器码级结构自检**（构建时 + `make test` 都跑）并接进 `build.ps1` |
| 7 | **算法要的是"偏移"不是绝对地址** | 传 `0x80000000` → `rc=2`（out of range）；擦/写/读全废 | `HpmFlasher` 对外仍用绝对地址，调用点换算成 XPI 窗口偏移（`offsetOf()`）；模拟目标同步改成"越界即报错"，忘换算会在离线自测里炸 |

另外两条"接线/工具链"层面的经验：

8. **HPM 必须烧 ELF，不能烧 `.bin`**：`elf2img` 出来的 `.bin` 里启动头那段是空的。
   我们的 ELF 解析**按节(section)** 取（`SHF_ALLOC` 的 `PROGBITS`），LMA 由所属 `PT_LOAD` 换算
   （`.vectors`/`.data` 这类 VMA 在 SRAM、LMA 在 flash 的节全靠这个）；
   与 OpenOCD 的 `flash write_image` 行为一致（它也是按节写的）。新增 `tools/selftest/flash-image.test.mjs` 钉住。
   > 同一个镜像的 `.bin` 在 0x0 有启动头、`.elf` 里对应节在 `0x80000400` —— 以 **ELF 的节地址**为准，
   > ROM 认的就是那里的头（`01 00 f9 fc 07`）。
9. **CPU 的写会被 D-cache 挡住**：用 SBA 读 RAM 时，如果 CPU 侧 D-cache 开着且没回写，
   读到的可能是旧值（诊断时踩过：往 0x3000 写的金丝雀"看不见"）。
   flashloader 之所以没事，是因为 `flash_init` 里调了 `l1c_dc_disable()`。
   同理 **片内外设（SYSCTL/XPI）不能用 SBA 读** —— 总线事务可能永不完成，
   现在 `readMem` 对每个字都有上限并给出"地址没映射 / 外设没时钟"的明确提示。

**参考对照**：HPM SDK 自带的 OpenOCD（`E:\sdk_env_v1.11.0\tools\openocd`）在同一块板、同一个探针上
`flash probe 0` 成功（16 MB / 4 KB 扇区），它的算法入口偏移与我们完全一致（0x0=init、0x18=info）；
用我们的调用链去跑**它那份算法**也能一次成功（63 ms 返回 0）—— 所以"传输层 + 调用姿势"是对的，
坑都在上面这 9 条里。它那份算法是编进 `openocd.exe` 的，只能从 RAM 里 dump 出来对照（`tmp/hpm-oc-algo.mjs`）。

### 还没验的（下一步）

- **其它 HPM 板子/芯片**：`HPM_BOARDS` 里 10 块板的参数取自 SDK cfg，但只在 HPM6800EVK 上真机跑过。
  换板子第一件事是看 `flash_get_info` 回报的容量/扇区对不对。
- **`erase_chip`**：目前流程只用按段擦除，`flash_erase_chip` 没在真机上走过。
- **吞吐**：现在每个 DMI 访问一次扫描 + 每字一次 `sbcs` 查询（安全优先）；46 KB 烧+校验约 25 s。
  真机上若嫌慢，可以把"读 sbcs"从每字改成每块一次（固件里的块读就是这么做的）。
- **SWD/F103 回归**：`dap-webusb.js` 的封包自检/超时自救改动同步影响 SWD 那条路，
  需要换回 Cortex-M 目标再跑一次（`make test-hw`）。

## 6. 怎么自己重建算法

```powershell
# 需要 HPM SDK + RISC-V 工具链（默认路径见脚本头部，可用环境变量覆盖）
pwsh -File tools/target-firmware/hpm_flash_algo/build.ps1   # 或 make hpm-algo
```

脚本会编译、**跑机器码级结构自检**（入口表 7 项 + 无"无出口自循环/自递归"）、
写出 `app/flash/hpm/algo.js`（base64）。改了 SDK 版本或算法源码后重建；换板卡只更新 porting 参数，不需要按型号重建算法。

移植接口、工作区与 GOT 重定位说明见 [HPM 移植接口](hpm-porting.md)。
