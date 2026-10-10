# Build the HPM5301EVKLite J-Scope fixture firmware (RISC-V) with the HPM SDK env.
#
#   pwsh -File tools\target-firmware\hpm5301evklite_scope\build.ps1 [-BuildType flash_xip]
#
# Output: build\<build_type>\output\demo.elf / .bin / .hex；并复制为目录根的 fw.elf
# 末尾会把**变量块的地址**打出来 —— 主机（探针）就按这个地址去采：
#   g_v          = 契约变量块（8 × u32 = 32 B，偏移见 src/main.c）
#   g_mchtmr_hz  = 靶子实测的 MCHTMR 频率（用来核对 10 kHz 时基）
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
# ⚠️ 参数必须**加引号**：PowerShell 7 把以 `-` 开头的裸 token 当参数名，里面的
#    $buildType 不做变量展开（原样传给 cmake，SDK 会报 invalid HPM_BUILD_TYPE: $buildtype）。
#    Windows PowerShell 5.1 会展开，所以这个坑只在 pwsh 下出现。
& cmake -G Ninja "-DBOARD=hpm5301evklite" "-DHPM_BUILD_TYPE=$buildType" "-DCMAKE_BUILD_TYPE=debug" -B $bdir -S $here
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& cmake --build $bdir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$elf = Join-Path $bdir 'output\demo.elf'      # SDK 统一把可执行文件叫 demo.elf
if (Test-Path $elf) {
    # 与 flood/dbgstress 例程保持相同约定：campaign/flash 脚本从目录根取默认 fw.elf。
    # build/ 被 .gitignore 忽略，根上的副本也是用户下载和 full_flow 的稳定入口。
    $out = Join-Path $here 'fw.elf'
    Copy-Item -Force $elf $out
    $nm = "$sdkEnv\toolchains\rv32imac_zicsr_zifencei_multilib_b_ext-win\bin\riscv32-unknown-elf-nm.exe"
    Write-Output ""
    Write-Output "J-Scope 变量块（g_v = 契约块 / g_v_hi = 高速平滑块，把它填进 --base）："
    & $nm -S $elf | Select-String 'g_v|g_mchtmr_hz|g_updates'
    Write-Output ("已复制给用户下载/流程使用： {0}" -f $out)
}
