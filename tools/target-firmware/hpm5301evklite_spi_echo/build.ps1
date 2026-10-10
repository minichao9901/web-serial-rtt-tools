# Build the HPM5301EVKLite SPI2 slave echo target.
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sdkEnv = if ($env:HPM_SDK_ENV_DIR) { $env:HPM_SDK_ENV_DIR } else { 'E:\sdk_env_v1.11.0' }
$buildType = 'flash_xip'
for ($i = 0; $i -lt $args.Count; $i++) {
    if ($args[$i] -eq '-BuildType' -and $i + 1 -lt $args.Count) { $buildType = $args[$i + 1] }
}

$env:PATH = "$sdkEnv\tools\python3;$sdkEnv\tools\cmake\bin;$sdkEnv\tools\ninja;$env:PATH"
$env:HPM_SDK_BASE = "$sdkEnv\hpm_sdk"
$env:GNURISCV_TOOLCHAIN_PATH = "$sdkEnv\toolchains\rv32imac_zicsr_zifencei_multilib_b_ext-win"
$env:HPM_SDK_TOOLCHAIN_VARIANT = 'gcc'

$bdir = Join-Path $here "build\$buildType"
Write-Output "building $buildType -> $bdir"
& cmake -G Ninja "-DBOARD=hpm5301evklite" "-DHPM_BUILD_TYPE=$buildType" "-DCMAKE_BUILD_TYPE=debug" -B $bdir -S $here
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& cmake --build $bdir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$elf = Join-Path $bdir 'output\demo.elf'
if (-not (Test-Path $elf)) { throw "Build produced no ELF: $elf" }
$out = Join-Path $here 'fw.elf'
Copy-Item -Force $elf $out
$nm = "$sdkEnv\toolchains\rv32imac_zicsr_zifencei_multilib_b_ext-win\bin\riscv32-unknown-elf-nm.exe"
Write-Output 'SPI echo symbols:'
& $nm -S $elf | Select-String 'g_spi_(magic|frames|errors|last_bytes|clock_hz)'
Write-Output "Published: $out"
