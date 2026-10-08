$ErrorActionPreference='Stop'
$taskGcc=(Get-Command arm-none-eabi-gcc -ErrorAction SilentlyContinue).Source
if(-not $taskGcc){$taskGcc='E:/Share/env-windows/tools/gnu_gcc/arm_gcc/mingw/bin/arm-none-eabi-gcc.exe'}
if(-not (Test-Path -LiteralPath $taskGcc)){throw 'arm-none-eabi-gcc is not available'}
$taskBin=Split-Path -Parent $taskGcc
$taskOut=Join-Path $PSScriptRoot 'build'
New-Item -ItemType Directory -Force $taskOut | Out-Null
& $taskGcc '-mcpu=cortex-m7' '-mthumb' '-mfpu=fpv5-d16' '-mfloat-abi=hard' '-Og' '-g3' '-gdwarf-4' '-fno-omit-frame-pointer' '-funwind-tables' '-ffunction-sections' '-fdata-sections' '-Wall' '-Wextra' '-Wno-unused-parameter' '-nostartfiles' '-specs=nano.specs' '-specs=nosys.specs' '-Wl,--gc-sections' "-T$PSScriptRoot/ld/stm32h743.ld" "$PSScriptRoot/src/main.c" '-o' "$taskOut/fw.elf"
if($LASTEXITCODE -ne 0){throw 'Fault fixture build failed'}
& "$taskBin/arm-none-eabi-objcopy.exe" '-O' 'binary' "$taskOut/fw.elf" "$taskOut/fw.bin"
& "$taskBin/arm-none-eabi-size.exe" "$taskOut/fw.elf"
Copy-Item -LiteralPath "$taskOut/fw.elf" -Destination "$PSScriptRoot/fw.elf" -Force
