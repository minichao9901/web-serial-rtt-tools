<#
  STM32F103 scope 测试固件编译脚本（不需要 make，也不需要 Keil）
    pwsh -File build.ps1                 # 默认 ZE（512KB flash / 64KB RAM）
    pwsh -File build.ps1 -Board cb       # F103CB（默认 96 MHz）
    pwsh -File build.ps1 -Board cb -CpuMhz 72 # 额定主频；build-cb-72mhz
    pwsh -File build.ps1 -Board c8       # 中等密度 64KB flash / 20KB RAM
    pwsh -File build.ps1 -Clean
  依赖：arm-none-eabi-gcc 在 PATH 里（本机在 E:\Share\env-windows\tools\gnu_gcc\arm_gcc\mingw\bin）

  默认板的产物固定落在 build\ —— check.py / flash.ps1 / 文档都按这个路径找。
#>
param([switch]$Clean, [ValidateSet('c8', 'cb', 'ze')][string]$Board = 'ze', [ValidateSet(72,96)][int]$CpuMhz = 96)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
$root = $PSScriptRoot

$BOARDS = @{
  ze = @{ Ld = 'stm32f103ze.ld'; Out = 'build';    Note = '512KB flash / 64KB RAM' }
  cb = @{ Ld = 'stm32f103cb.ld'; Out = 'build-cb'; Note = '128KB flash / 20KB RAM' }
  c8 = @{ Ld = 'stm32f103c8.ld'; Out = 'build-c8'; Note = '64KB flash  / 20KB RAM' }
}
$b = $BOARDS[$Board]
$build = Join-Path $root $b.Out
if ($CpuMhz -ne 96) { $build = "$build-$($CpuMhz)mhz" }
$ldpath = Join-Path $root ('ld\' + $b.Ld)
if (-not (Test-Path $ldpath)) { throw "找不到链接脚本 $ldpath" }

$gcc = (Get-Command arm-none-eabi-gcc -ErrorAction SilentlyContinue).Source
if (-not $gcc){
  $guess = 'E:\Share\env-windows\tools\gnu_gcc\arm_gcc\mingw\bin\arm-none-eabi-gcc.exe'
  if (Test-Path $guess){ $gcc = $guess } else { throw 'arm-none-eabi-gcc 不在 PATH 里' }
}
$bin = Split-Path -Parent $gcc
$objcopy = Join-Path $bin 'arm-none-eabi-objcopy.exe'
$size    = Join-Path $bin 'arm-none-eabi-size.exe'
$nm      = Join-Path $bin 'arm-none-eabi-nm.exe'

if ($Clean -and (Test-Path $build)) { Remove-Item $build -Recurse -Force }
New-Item -ItemType Directory -Force -Path $build | Out-Null

$sources = @(
  (Join-Path $root 'src\main.c'),
  (Join-Path $root 'src\startup.c')
)
$elf = Join-Path $build 'fw.elf'

# 参数一律加引号并用数组 splat：
# PowerShell 会把 -specs=nano.specs 按点号拆成两段（"-specs=nano" + ".specs"），
# 直接导致 "cannot read spec file 'nano'"。这是兄弟例程第一版踩的坑。
#
# -gdwarf-4 是**故意写死的**：scope 页面第一版的 DWARF 解析器只吃 DWARF 4
# （本机 GCC 10.3 默认也是 4，但 GCC 11+ 会默认切到 5 —— 显式写死免得工具链一升级就解析不出来）。
$cflags = @(
  "-DCPU_HZ=$($CpuMhz * 1000000)u",
  '-mcpu=cortex-m3', '-mthumb', '-Os', '-g3', '-gdwarf-4',
  '-ffunction-sections', '-fdata-sections', '-fno-common',
  '-Wall', '-Wextra', '-Wno-unused-parameter',
  "-I$root\src",
  "-T$ldpath",
  '-nostartfiles', '-specs=nano.specs', '-specs=nosys.specs',
  '-Wl,--gc-sections', "-Wl,-Map=$build\fw.map"
)

& $gcc @cflags @sources -o $elf
if ($LASTEXITCODE -ne 0) { throw "编译失败 (exit $LASTEXITCODE)" }
Write-Output ("core    : {0} MHz" -f $CpuMhz)
Write-Output ("board   : {0}  ({1})" -f $Board, $b.Note)

& $objcopy -O binary $elf (Join-Path $build 'fw.bin')
& $objcopy -O ihex   $elf (Join-Path $build 'fw.hex')
& $size $elf

# 根目录只发布 ZE 默认档；CB/C8 必须使用各自 build-* 目录，避免容量档互相覆盖。
if ($Board -eq 'ze' -and $CpuMhz -eq 96) {
  Copy-Item -Force $elf (Join-Path $root 'fw.elf')
  Write-Output ("已复制给用户下载： {0}" -f (Join-Path $root 'fw.elf'))
}

# 顺手把被采样变量的地址打印出来 —— 手填地址/排障时不用再开 nm。
# ⚠️ -g 会把 -Os 优化掉的静态变量……这里全是 volatile 全局，不会被优化掉。
Write-Output ""
Write-Output "被采样变量（nm 实测地址/大小）："
& $nm -S --size-sort $elf | Select-String -Pattern '\sg_' |
  ForEach-Object { "  " + $_.Line.Trim() }

Write-Output ""
Write-Output ("产物： {0}" -f $elf)
Write-Output ("       {0} ({1} B)" -f (Join-Path $build 'fw.bin'), (Get-Item (Join-Path $build 'fw.bin')).Length)
