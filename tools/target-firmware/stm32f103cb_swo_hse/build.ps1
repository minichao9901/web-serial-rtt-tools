$ErrorActionPreference='Stop'
$swoGcc=(Get-Command arm-none-eabi-gcc -ErrorAction SilentlyContinue).Source
if(-not $swoGcc){$swoGcc='E:/Share/env-windows/tools/gnu_gcc/arm_gcc/mingw/bin/arm-none-eabi-gcc.exe'}
$swoBin=Split-Path $swoGcc -Parent
$swoOut=Join-Path $PSScriptRoot 'build'
New-Item -ItemType Directory -Force $swoOut | Out-Null
& $swoGcc '-mcpu=cortex-m3' '-mthumb' '-mfloat-abi=soft' '-O1' '-g3' '-gdwarf-4' '-fno-omit-frame-pointer' '-fno-optimize-sibling-calls' '-funwind-tables' '-ffunction-sections' '-fdata-sections' '-Wall' '-Wextra' '-nostartfiles' '-specs=nano.specs' '-specs=nosys.specs' '-Wl,--gc-sections' "-T$PSScriptRoot/ld/stm32f103cb.ld" "$PSScriptRoot/src/clock.c" "$PSScriptRoot/src/main.c" "$PSScriptRoot/src/pipeline.c" "$PSScriptRoot/src/startup.c" '-o' "$swoOut/fw.elf"
if($LASTEXITCODE -ne 0){throw 'SWO fixture build failed'}
& "$swoBin/arm-none-eabi-objcopy.exe" '-O' 'binary' "$swoOut/fw.elf" "$swoOut/fw.bin"
if($LASTEXITCODE -ne 0){throw 'SWO fixture objcopy failed'}
& "$swoBin/arm-none-eabi-size.exe" "$swoOut/fw.elf"
Copy-Item "$swoOut/fw.elf" "$PSScriptRoot/fw.elf" -Force
