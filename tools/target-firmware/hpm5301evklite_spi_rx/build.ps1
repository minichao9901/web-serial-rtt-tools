$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sdkEnv = if ($env:HPM_SDK_ENV_DIR) { $env:HPM_SDK_ENV_DIR } else { 'E:\sdk_env_v1.11.0' }
$env:PATH = "$sdkEnv\tools\python3;$sdkEnv\tools\cmake\bin;$sdkEnv\tools\ninja;$env:PATH"
$env:HPM_SDK_BASE = "$sdkEnv\hpm_sdk"
$env:GNURISCV_TOOLCHAIN_PATH = "$sdkEnv\toolchains\rv32imac_zicsr_zifencei_multilib_b_ext-win"
$env:HPM_SDK_TOOLCHAIN_VARIANT = 'gcc'
$bdir = Join-Path $here 'build\flash_xip'
Write-Output "building HPM5301 SPI2 RX-only cyclic DMA -> $bdir"
& cmake -G Ninja '-DBOARD=hpm5301evklite' '-DHPM_BUILD_TYPE=flash_xip' '-DCMAKE_BUILD_TYPE=release' -B $bdir -S $here
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& cmake --build $bdir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$elf = Join-Path $bdir 'output\demo.elf'
if (-not (Test-Path $elf)) { throw "Build produced no ELF: $elf" }
Copy-Item -Force $elf (Join-Path $here 'fw.elf')
Write-Output "Published: $(Join-Path $here 'fw.elf')"
