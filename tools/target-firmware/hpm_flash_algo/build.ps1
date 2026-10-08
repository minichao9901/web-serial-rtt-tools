# 构建 HPM flashloader（RV32）并生成网页用的 blob
#
#   pwsh -File tools/target-firmware/hpm_flash_algo/build.ps1
#
# 为什么要自己构建：HPM SDK 只给源码 + 现成的 OpenOCD 二进制，烧录算法是**编进 OpenOCD 里**的，
# 拿不出来。这里的做法与 SDK 的 CMake 流程等价，但只编这一个文件（起 include 路径见下），
# 产物直接变成网页里的 base64 blob。
#
# 🚨 必须用 -nostdlib + memset.c：算法只用到 memset，而链 newlib 会把 malloc 表/impure_data/GOT
#    一起带进来，blob 从 1.4 KB 涨到 16.8 KB（要逐字写进目标 SRAM，差一个数量级）。
#
# 参数（环境变量可覆盖）：
#   $env:HPM_SDK_BASE  HPM SDK 根目录
#   $env:RV_TOOLCHAIN  RISC-V 工具链 bin 目录
#   $env:HPM_SOC_DIR   SoC 头文件目录（默认 HPM6800/HPM6880；板卡参数经公共 hpm_xpi ABI 在运行时传入）
#   $env:HPM_BOARD_DIR 板级头文件目录（只有 board.h 需要）

param(
    [string]$Sdk      = $env:HPM_SDK_BASE,
    [string]$Toolchain = $env:RV_TOOLCHAIN,
    [string]$SocDir   = $env:HPM_SOC_DIR,
    [string]$BoardDir = $env:HPM_BOARD_DIR,
    [switch]$KeepElf
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here '..\..\..')

if (-not $Sdk){ $Sdk = 'E:\sdk_env_v1.11.0\hpm_sdk' }
if (-not $Toolchain){ $Toolchain = 'E:\sdk_env_v1.11.0\toolchains\rv32imac_zicsr_zifencei_multilib_b_ext-win\bin' }
if (-not $SocDir){ $SocDir = Join-Path $Sdk 'soc\HPM6800\HPM6880' }
if (-not $BoardDir){ $BoardDir = Join-Path $Sdk 'boards\hpm6800evk' }

$gcc   = Join-Path $Toolchain 'riscv32-unknown-elf-gcc.exe'
$size  = Join-Path $Toolchain 'riscv32-unknown-elf-size.exe'
$objcopy = Join-Path $Toolchain 'riscv32-unknown-elf-objcopy.exe'
$nm    = Join-Path $Toolchain 'riscv32-unknown-elf-nm.exe'
$objdump = Join-Path $Toolchain 'riscv32-unknown-elf-objdump.exe'
foreach ($exe in @($gcc, $size, $objcopy, $nm, $objdump)){
    if (-not (Test-Path $exe)){ throw "找不到 $exe（用 -Toolchain 或 `$env:RV_TOOLCHAIN 指定）" }
}
if (-not (Test-Path $Sdk)){ throw "找不到 HPM SDK：$Sdk（用 -Sdk 或 `$env:HPM_SDK_BASE 指定）" }

$out = Join-Path $here 'build'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$elf = Join-Path $out 'hpm_flash_algo.elf'
$bin = Join-Path $out 'hpm_flash_algo.bin'
$rsp = Join-Path $out 'gcc.rsp'

# include 列表：与 SDK 的 CMake 等价的最小集（编不过就照报错补一个目录即可）
$incs = @(
    $SocDir,
    (Join-Path $Sdk 'soc\HPM6800\ip'),
    (Join-Path $Sdk 'arch'),
    (Join-Path $Sdk 'arch\riscv'),
    (Join-Path $Sdk 'arch\riscv\l1c'),
    (Join-Path $Sdk 'arch\riscv\intc'),
    (Join-Path $Sdk 'drivers'),
    (Join-Path $Sdk 'drivers\inc'),
    $BoardDir,
    (Join-Path $Sdk 'components\debug_console'),
    (Join-Path $Sdk 'components\spi'),
    (Join-Path $Sdk 'utils')
) | Where-Object { Test-Path $_ } | ForEach-Object { $_ -replace '\\', '/' }

$args = @(
    '-march=rv32imac_zicsr_zifencei', '-mabi=ilp32', '-mcmodel=medlow',
    '-Os', '-fpic', '-ffunction-sections', '-fdata-sections',
    # 🚨 这两个开关是**给 memset.c 保命的**（2026-10 真机 bring-up 挖出来的）：
    #    GCC 的 loop idiom recognition（-ftree-loop-distribute-patterns）会把
    #    `while (n--) *p++ = v;` 认成 memset 调用，而这个函数**就是** memset →
    #    编出来的是「prologue → c.jal 自己 → epilogue」，一条 sb 都没有（无限递归）。
    #    flash_init 第一步 memset(nor_config,0,256) 就转死，核再也不停、连 haltreq 都抓不住
    #    （页面现象："烧录卡死/永远不结束"）。-fno-builtin 顺手挡掉同一类内建替换。
    '-fno-tree-loop-distribute-patterns', '-fno-builtin',
    '-nostartfiles', '-nostdlib', '-Wl,--gc-sections',
    '-T', ((Join-Path $here 'linker.ld') -replace '\\', '/')
)
$args += ($incs | ForEach-Object { "-I$_" })
$args += @(
    ((Join-Path $here 'func_table.S') -replace '\\', '/'),
    ((Join-Path $here 'openocd_flash_algo.c') -replace '\\', '/'),
    ((Join-Path $Sdk 'arch\riscv\l1c\hpm_l1c_drv.c') -replace '\\', '/'),
    ((Join-Path $here 'memset.c') -replace '\\', '/'),
    '-o', ($elf -replace '\\', '/')
)
# 🚨 响应文件里必须用正斜杠：gcc 把响应文件中的反斜杠当转义符，-IE:\sdk\... 会被吃掉
Set-Content -Path $rsp -Value ($args -join "`n") -Encoding ascii

Write-Host '== 编译 =='
& $gcc "@$rsp"
if ($LASTEXITCODE -ne 0){ throw "编译失败（exit $LASTEXITCODE）" }
& $size $elf

Write-Host '== 校验入口表 =='
$syms = @{}
& $nm $elf | ForEach-Object {
    if ($_ -match '^([0-9a-f]{8})\s+\S\s+(\S+)$'){ $syms[$matches[2]] = [Convert]::ToUInt32($matches[1], 16) }
}
$table = @('flash_init', 'flash_erase', 'flash_program', 'flash_read', 'flash_get_info', 'flash_erase_chip', 'flash_deinit')
$initAddr = $syms['_init']
if ($initAddr -ne 0){ throw "_init 不在偏移 0（实际 0x$($initAddr.ToString('x'))）—— func_table 必须排在 .text 最前" }

& $objcopy -O binary $elf $bin
$blob = [System.IO.File]::ReadAllBytes($bin)
Write-Host ("blob = {0} B (0x{0:x})" -f $blob.Length)

# 🚨 机器码级结构自检：入口表 7 项 + 没有"无出口自循环/自递归"。
#    这一步是 2026-10 真机 bring-up 之后加的 —— 当时 memset.c 被 GCC 优化成了递归调用，
#    blob 大小、入口表、离线自测**全都正常**，只有真机上才表现为"烧录卡死"。
Write-Host '== 结构自检（机器码级）=='
$checker = Join-Path $here 'check-algo.mjs'
if (Test-Path $checker){
    & node $checker $bin
    if ($LASTEXITCODE -ne 0){ throw "结构自检没过（见上面的原因）—— 别把这份 blob 烧到板子上" }
} else {
    Write-Warning "没找到 $checker，跳过结构自检"
}

# 🚨 表项步长**不是**固定 8 B：`ebreak` 被汇编成 2 字节的 c.ebreak（实测每项 = 4 B jal + 2 B = 6 B）。
#    所以这里不猜步长：把符号地址写进生成的 algo.js，由网页侧的表解析器
#    （app/flash/hpm/entry.js）在**运行时**从 blob 里走一遍 jаl 发现偏移，并用这些符号对账
#    （自测 tools/selftest/hpm-flash.test.mjs 会逐项核对）。
foreach ($name in $table){
    if (-not $syms.ContainsKey($name)){ throw "符号 $name 不在 ELF 里（被 gc-sections 丢掉了？）" }
    if ($syms[$name] -ge $blob.Length){ throw "符号 $name 的地址 0x$($syms[$name].ToString('x')) 超出 blob（$($blob.Length) B）" }
}
$symJs = (($table | ForEach-Object { "    ${_}: 0x$($syms[$_].ToString('x'))," }) -join "`n")
Write-Host ("  入口符号：" + (($table | ForEach-Object { "$_@0x$($syms[$_].ToString('x'))" }) -join ' '))

# PIC code uses PC-relative GOT access, but GOT entries still contain linked addresses.
# Extract internal pointer relocations from ELF .got; do not guess fixed offsets.
$gotHeader = (& $objdump -h $elf) | Where-Object { $_ -match '^\s*\d+\s+\.got\s+' } | Select-Object -First 1
$relocJs = @()
if ($gotHeader -match '^\s*\d+\s+\.got\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)'){
    $gotSize = [Convert]::ToUInt32($matches[1], 16)
    $gotAddr = [Convert]::ToUInt32($matches[2], 16)
    if ($gotAddr + $gotSize -gt $blob.Length -or $gotSize % 4){ throw 'GOT outside algorithm blob' }
    # Slot zero is the reserved dynamic-table pointer, not an internal data pointer.
    for ($relocOffset = $gotAddr + 4; $relocOffset -lt $gotAddr + $gotSize; $relocOffset += 4){
        $pointer = [BitConverter]::ToUInt32($blob, $relocOffset)
        if ($pointer -lt $blob.Length){
            $relocJs += "    { offset: 0x$($relocOffset.ToString('x')), target: 0x$($pointer.ToString('x')) },"
        }
    }
}
Write-Host '== 生成 app/flash/hpm/algo.js =='
$b64 = [Convert]::ToBase64String($blob)
$jsPath = Join-Path $repo 'app\flash\hpm\algo.js'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $jsPath) | Out-Null
# 每 96 字符折一行，便于 diff 与人工抽查
$lines = for ($i = 0; $i -lt $b64.Length; $i += 96){ $b64.Substring($i, [Math]::Min(96, $b64.Length - $i)) }
$js = @"
/**
 * HPM 系列 flashloader（RV32）—— **自动生成，别手改**。
 * 生成：pwsh -File tools/target-firmware/hpm_flash_algo/build.ps1
 * 出处/许可/入口表语义见 tools/target-firmware/hpm_flash_algo/README.md。
 *
 * 尺寸 $($blob.Length) B（0x$('{0:x}' -f $blob.Length)），加载地址 0x00000000。
 * 🚨 入口表**没有固定步长**（ebreak 汇编成 2 字节的 c.ebreak，实测每项 6 B）——
 *    偏移由 app/flash/hpm/entry.js 在运行时从 blob 里走一遍 jal 发现，
 *    symbols 是构建时从 ELF 取的真值，自测拿它逐项对账。
 */
import { relocateAlgoBytes } from './entry.js';
export const HPM_ALGO = {
  loadAddr: 0x00000000,
  size: $($blob.Length),
  /** Internal GOT pointers, generated from ELF .got for runtime relocation. */
  relocations: [
$($relocJs -join "`n")
  ],
  /** 构建时的符号地址（仅供自测对账，运行时不依赖它）*/
  symbols: {
$symJs
  },
  /** xpi_nor_config_option_t 头字：words(4bit) | tag(0xfcf90) << 12 */
  headerWords1: 0xFCF90001,
  headerWords2: 0xFCF90002,
  headerWords0: 0xFCF90000,
  b64: [
$(($lines | ForEach-Object { "    '$_'," }) -join "`n")
  ].join(''),
};

/** 解出 blob 字节（每次调用都新建一份，避免被就地改动）*/
export function hpmAlgoBytes(loadAddr = HPM_ALGO.loadAddr){
  const bin = atob(HPM_ALGO.b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return relocateAlgoBytes(out, HPM_ALGO, loadAddr);
}
"@
[IO.File]::WriteAllText($jsPath, ($js -replace "`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))
Write-Host "已写入 $jsPath（base64 $($b64.Length) 字符）"

# Validate runtime GOT relocation against a second independent compiler link.
$oracleElf = Join-Path $out 'linked-4000.elf'
$oracleBin = Join-Path $out 'linked-4000.bin'
& $gcc "@$rsp" '-Wl,-Ttext=0x4000' '-o' $oracleElf
if ($LASTEXITCODE -ne 0){ throw 'Relocation oracle link failed' }
& $objcopy -O binary $oracleElf $oracleBin
if ($LASTEXITCODE -ne 0){ throw 'Relocation oracle objcopy failed' }
& node (Join-Path $here 'check-relocation.mjs') $oracleBin '0x4000'
if ($LASTEXITCODE -ne 0){ throw 'Runtime relocation differs from independently linked binary' }
if (-not $KeepElf){ Remove-Item $rsp -ErrorAction SilentlyContinue }
Write-Host '完成 ✅'
