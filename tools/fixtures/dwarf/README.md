# DWARF / ELF 解析的对账基线

`tools/selftest/dwarf.test.mjs` 用的**真 ELF 快照**（二进制，见 `.gitattributes` 里的 `binary`）。
为什么要入库：`tools/target-firmware/**/build/` 是构建产物（被 .gitignore 忽略），
在干净克隆里不存在 —— 解析器不能"本机有固件才测得动"。

| 文件 | 来源 | 用来测什么 |
|---|---|---|
| `stm32f103_scope.elf` | `tools/target-firmware/stm32f103_scope/`（`build.ps1` 产物，`-g3 -gdwarf-4`） | **结构体展开**（`g_pack` 24 B → 9 个成员）、类型映射（f32/f64/u16/i16/u8/i8/u32/i32）、数组剔除、8 种标量全覆盖 |
| `stm32f103_rtt_speed.elf` | `tools/target-firmware/stm32f103_rtt_speed/` | **真工程风格**：多 CU、typedef 结构体（`_SEGGER_RTT`）、以及 `DW_AT_specification`（定义 DIE 无名，名字/类型在声明那侧 —— 不追就会把 RTT 控制块整个漏掉） |
| `riscv_dwarf5.elf` | `dwarf5_fixture.c`（同目录源码，用 HPM SDK 的 riscv32 gcc 13.2 编，`-gdwarf-5`） | **DWARF 5**：CU 头的 unit_type、`strx*`/`addrx*` 间接表（`.debug_str_offsets` / `.debug_addr`）、`line_strp`，以及"数据段不在 0x2xxxxxxx"时按可写节推 RAM 窗口 |

前两份是 **DWARF 4**（GCC 10.3 的默认版本）；第三份是 **DWARF 5**（GCC 11+ 默认，HPM SDK 也是 ——
真机上用户的固件就是这种，解析器必须认得；2026-10 就因为只支持 4，变量列表退化成了一堆 newlib 符号）。

## 重新生成

`riscv_array_scope.elf` 来自 `array_scope_fixture.c`，用于数组元素采样：u16 数组、二维 float、三维字节、结构体数组及 8 MB 大数组。大数组保留为目录项，按指定下标解析，不整批展开。

生成命令与上面的 RISC-V 工具链相同，参数为：`-march=rv32imac_zicsr_zifencei -mabi=ilp32 -O0 -gdwarf-5 -nostdlib -nostartfiles -Wl,-Ttext=0x80003000 -Wl,-Tdata=0x40000000 tools/fixtures/dwarf/array_scope_fixture.c -o tools/fixtures/dwarf/riscv_array_scope.elf`。

```powershell
cd tools\target-firmware\stm32f103_scope;   pwsh -File build.ps1
cd tools\target-firmware\stm32f103_rtt_speed; pwsh -File build.ps1
Copy-Item ..\stm32f103_scope\build\fw.elf        ..\..\fixtures\dwarf\stm32f103_scope.elf -Force
Copy-Item ..\stm32f103_rtt_speed\build\fw.elf   ..\..\fixtures\dwarf\stm32f103_rtt_speed.elf -Force

# DWARF 5 夹具（需要 HPM SDK 里的 RISC-V 工具链，路径见 tools/target-firmware/hpm_flash_algo/build.ps1 头部）
$tc = 'E:\sdk_env_v1.11.0\toolchains\rv32imac_zicsr_zifencei_multilib_b_ext-win\bin'
& "$tc\riscv32-unknown-elf-gcc.exe" -march=rv32imac_zicsr_zifencei -mabi=ilp32 -Os -gdwarf-5 `
  -nostdlib -nostartfiles '-Wl,-Ttext=0x80000000' `
  tools\fixtures\dwarf\dwarf5_fixture.c -o tools\fixtures\dwarf\riscv_dwarf5.elf

node tools\selftest\dwarf.test.mjs     # 期望的地址/类型都写在测试里，变了就得同步
```

> 快照里的地址是**链接结果**，改代码/换编译器都会变。测试里那张地址表就是"变量契约"，
> 变更是**有意义的信号**（比如结构体加了字段），别顺手改测试了事。
