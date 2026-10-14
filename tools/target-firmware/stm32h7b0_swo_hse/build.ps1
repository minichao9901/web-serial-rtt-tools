<#
  Build the STM32H7B0 SWO fixture (HSE 25 MHz -> PLL1 -> 280 MHz).
  arm-none-eabi-gcc is required; the root fw.elf is the loadable, DWARF-enabled image.
#>
[CmdletBinding()]
param([switch]$Clean)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$build = Join-Path $root 'build'
$ld = Join-Path $root 'ld/stm32h7b0.ld'

$gcc = (Get-Command arm-none-eabi-gcc -ErrorAction SilentlyContinue).Source
if (-not $gcc) {
  $guess = 'E:/Share/env-windows/tools/gnu_gcc/arm_gcc/mingw/bin/arm-none-eabi-gcc.exe'
  if (Test-Path $guess) { $gcc = $guess } else { throw 'arm-none-eabi-gcc 不在 PATH 里' }
}
$bin = Split-Path -Parent $gcc
$objcopy = Join-Path $bin 'arm-none-eabi-objcopy.exe'
$size = Join-Path $bin 'arm-none-eabi-size.exe'
$nm = Join-Path $bin 'arm-none-eabi-nm.exe'

if ($Clean -and (Test-Path $build)) { Remove-Item $build -Recurse -Force }
New-Item -ItemType Directory -Force -Path $build | Out-Null

$sources = @(
  (Join-Path $root 'src/clock.c'),
  (Join-Path $root 'src/main.c'),
  (Join-Path $root 'src/pipeline.c'),
  (Join-Path $root 'src/startup.c')
)
$flags = @(
  '-mcpu=cortex-m7', '-mthumb', '-mfpu=fpv5-d16', '-mfloat-abi=hard',
  '-O1', '-g3', '-gdwarf-4', '-fno-omit-frame-pointer',
  '-fno-optimize-sibling-calls', '-funwind-tables',
  '-ffunction-sections', '-fdata-sections', '-fno-common',
  '-Wall', '-Wextra', '-Wno-unused-parameter',
  "-I$root/src", "-T$ld", '-nostartfiles', '-specs=nano.specs',
  '-specs=nosys.specs', '-Wl,--gc-sections', "-Wl,-Map=$build/fw.map"
)

$elf = Join-Path $build 'fw.elf'
& $gcc @flags @sources -o $elf
if ($LASTEXITCODE -ne 0) { throw "编译失败 (exit $LASTEXITCODE)" }
& $objcopy -O binary $elf (Join-Path $build 'fw.bin')
if ($LASTEXITCODE -ne 0) { throw 'objcopy binary 失败' }
& $size $elf

Write-Output ''
Write-Output 'SWO fixture：HSE 25 MHz -> PLL1 -> CPU/HCLK 280 MHz（失败时退回 HSI 64 MHz）'
Write-Output 'trace 输出由网页经 SWD 配置；固件只产生可分析的程序执行流与阶段标记。'
Write-Output '全局诊断符号：'
& $nm -S --size-sort $elf | Select-String -Pattern '\sg_(clock_hz|clock_error|clock_source|tick|phase|rounds|checksum|mark_seq|mark_dropped|irq_count|pendsv_count)$' |
  ForEach-Object { '  ' + $_.Line.Trim() }

Copy-Item $elf (Join-Path $root 'fw.elf') -Force
Write-Output ''
Write-Output "ELF：$root/fw.elf"
Write-Output "BIN：$(Join-Path $build 'fw.bin')"
