# SRAM 网页测速优化跟进

**结论：**DS 已合入的 WriteABORT 修复和 SRAM 造帧优化有效；网页 F103ZE 实测约读写 3 MB/s，已接近同一探针的 OpenOCD 实测。继续删减 TAR 写入的方案在这块 F103ZE 上反而慢约 17%～38%，没有合入。跟进还纠正了 DS 微基准的地址边界判断：本板 TAR 在 **4 KiB** 边界回绕，不是 1 KiB。

## 对 DS 进度的复核

当前 `main` 最新提交为 `c656fb4419c25be9e0b40644572a6117f2e496d7`，此前的 `1f2794757041c3ed1bdae174de64f5d4529eef7b` 修正了 DAP WriteABORT 报文并重做了 SRAM 高速路径。工作区中这两部分源文件与提交一致，没有新的源代码改动。

我复核了 DS 的 20 KiB 产品基准、造帧开销拆分和 1024 字节报文矩阵。它把写造帧成本从约 0.265 ms 降到 0.071 ms；同会话写速从 2.688 提升到 2.924 MB/s。后续网页实板复测和发布包入口均完成读写校验。原生 OpenOCD 的同板结果约写 3.42 MB/s（命令墙钟 3.18 MB/s）、读 3.00 MB/s；网页当前速度已接近这个口径。

## 修正 TAR 边界结论

DS 的 `wrapTest` 在 TAR 起点写 254 字，再写 2 字；这只走到地址 `+0x3FF`，没有检查下一字落在哪。该测试的 `readme` 字段因此不能证明“1 KiB 回绕”。

新的实板测试先在 `0x20000000` 写 255 个字，再从地址 `+0x3FC` 写入两个不同标记。读回结果是：`+0x3FC` 保留第一个标记，`+0x400` 出现第二个标记，页首没有被覆盖。继续逐块读取 TAR 到 4 KiB 边界后，目标地址从预期的 `0x200013C4` 变成 `0x200003C4`。这证明本板的 MEM-AP TAR 跨过 1 KiB 后继续递增，在 4 KiB 边界回绕。完整 64 KiB SRAM、寄存器和 512 KiB Flash 均恢复或核验一致，CPU 回到原运行状态。

因此，DS 微基准中“单 TAR 链式 20 KiB 回读首字节错误”与 4 KiB 回绕相符，但不能据此说每 1 KiB 必须重写 TAR。

## 更少 TAR 写入的 A/B

我把每个测试方案都做成完整 20 KiB 写入、读回及逐字节比较，并在实板上交替测量 8 轮。实验方案每个 4 KiB 窗口只设一次 TAR，窗口内发 `DAP_TransferBlock`，最多四包并发；下一窗口在前一窗口完成后再开始。三种同窗口流水调度都比现行网页慢：

| 方案 | 写速 | 读速 | 相对现行网页 |
|---|---:|---:|---:|
| 现行网页路径 | 3.08～3.14 MB/s | 2.91～2.97 MB/s | 基准 |
| 4 KiB 窗口，OUT/IN 串行 | 1.85 MB/s | 1.98 MB/s | 慢 32%～38% |
| 4 KiB 窗口，四包分批 | 2.08 MB/s | 2.17 MB/s | 慢 27%～33% |
| 4 KiB 窗口，完成后立即补包 | 2.35 MB/s | 2.40 MB/s | 慢 17%～25% |

三轮测试中的完整读写校验均通过；每次结束都核实 SRAM 与寄存器恢复、Flash 未变。分组实现新增了每个 4 KiB 窗口的串行等待，减少 TAR 写入没有抵消这项等待成本，故不应换掉现行实现。

## 交付状态和边界

当前生产改动保留在 DS 提交中：正确的 DAP WriteABORT、切档资格验证、1024 字节帧、深度 4 流水和热路径造帧优化。新增 A/B 只用于审查，没有改动生产源文件。继续突破当前速度需要改变探针协议或固件的传输/缓冲限制；这不属于本次网页侧提交。

本轮直接 TAR 读回和 4 KiB 分组 A/B 在原 F103ZE 上完成，硬件锁已释放。DS 微基准旧 JSON 与旧报告保留原样；本报告提供更正后的实板证据。

运行记录说明：TAR 边界测试的板上断言、SRAM/寄存器恢复和 Flash 核验均通过；脚本最后释放租约目录时收到 Windows `EPERM`，随后确认对应 PID 已退出且没有 OpenOCD/USB 桥占用，再将残留目录归档。当前没有活动硬件租约。

Validation-Run-ID: `20261016-sram-web-opt-followup-173500` 及其引用的子实验目录

Tested-Revision: `c656fb4419c25be9e0b40644572a6117f2e496d7`

Tested-Dirty: `true`（仅有既存未跟踪证据和本跟进报告；生产源文件与该提交一致）

Validation-Result: `passed`（TAR 边界实测通过；4 KiB 分组各速率方案完成完整数据校验，但均慢于现行实现）

Validation-Commands: `node docs/validation/20261016-sram-tar-boundary-170200/tar-boundary.mjs`; `node docs/validation/20261016-sram-4k-tar-ab-172700/tar4k-ab.mjs`; `node docs/validation/20261016-sram-4k-tar-ab-172800/tar4k-ab.mjs`; `node docs/validation/20261016-sram-4k-tar-ab-172900/tar4k-ab.mjs`

重要证据 SHA256：

- `tar-boundary.json`：`DDD909872F23B186097F6A647E4729F94C357EA15F84C23A1230BF9723DEF99D`
- `tar-walk.json`：`8E0A20842998D26C83238C1030A57B5584EB5630D9D66C3B9EBB5FDD9AE46247`
- `tar4k-ab-summary.json` 串行：`CDAD8639682FCFAEE7F53697F97B6EA72C175A00100580D8A6F563D4EC728B77`
- `tar4k-ab-summary.json` 分批四包：`7CCFDC29F709D33B1EC25731EA16176E72C15AC05FD8666E29688FEABD40E736`
- `tar4k-ab-summary.json` 窗口内补包：`1891D48FD3C481CAFD96EDD65F87846E3F1D86F534F5042BB8E95A09AECB1B6F`

完整 4 MiB JSON 原始输出保留在本机子实验目录；Git 记录包含压缩后的逐轮指标、测试脚本和本报告。
