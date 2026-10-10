param(
    [ValidateSet('flash_xip', 'ram')][string]$BuildType = 'flash_xip',
    [ValidateSet('Og', 'Os')][string]$Optimization,
    [ValidateSet(4, 5)][int]$Dwarf = 4,
    [switch]$Matrix,
    [switch]$NoCopy
)

# HPM5301EVKLite debugger fixture. The matrix builds are isolated by optimization/DWARF
# and carry a SHA-bound manifest beside the ELF for the GDB/Web acceptance scripts.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sdkEnv = if ($env:HPM_SDK_ENV_DIR) { $env:HPM_SDK_ENV_DIR } else { 'E:\sdk_env_v1.11.0' }
$isMatrix = $Matrix -or $PSBoundParameters.ContainsKey('Optimization') -or $PSBoundParameters.ContainsKey('Dwarf')
if ($isMatrix -and -not $Optimization) { $Optimization = 'Os' }

$env:PATH = "$sdkEnv\tools\python3;$sdkEnv\tools\cmake\bin;$sdkEnv\tools\ninja;$env:PATH"
$env:HPM_SDK_BASE = "$sdkEnv\hpm_sdk"
$env:GNURISCV_TOOLCHAIN_PATH = "$sdkEnv\toolchains\rv32imac_zicsr_zifencei_multilib_b_ext-win"
$env:HPM_SDK_TOOLCHAIN_VARIANT = 'gcc'

if ($isMatrix) {
    $bdir = Join-Path $here "build\matrix-$Optimization-dw$Dwarf"
} else {
    $bdir = Join-Path $here "build\$BuildType"
}
Write-Output "building $BuildType -> $bdir"
$cmakeArgs = @('-G', 'Ninja', '-DBOARD=hpm5301evklite', "-DHPM_BUILD_TYPE=$BuildType", '-DCMAKE_BUILD_TYPE=debug', '-B', $bdir, '-S', $here)
if ($isMatrix) {
    $optFlag = "-$Optimization"
    $cmakeArgs += "-DHPM_FRAME_OPT=$optFlag"
    $cmakeArgs += "-DHPM_FRAME_DWARF=$Dwarf"
}
& cmake @cmakeArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& cmake --build $bdir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$elf = Join-Path $bdir 'output\demo.elf'
if (-not (Test-Path $elf)) { throw "构建没有生成 ELF：$elf" }
$sdkCompilerBin = "$sdkEnv\toolchains\rv32imac_zicsr_zifencei_multilib_b_ext-win\bin"
$nm = Join-Path $sdkCompilerBin 'riscv32-unknown-elf-nm.exe'
Write-Output ""
Write-Output '关键符号（调试器页/压测脚本按这些名字下断点）：'
& $nm -S $elf | Select-String 'g_model|g_ticks|g_loops|g_stage|g_checksum|g_seq_slot|engine_|deep_l|is_even|is_odd|fn_|model_|dbg_frame_|g_frame_result'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($isMatrix) {
    $hash = (Get-FileHash -LiteralPath $elf -Algorithm SHA256).Hash.ToLowerInvariant()
    $sharedSource = Join-Path (Split-Path -Parent $here) 'common\dbg_frames.c'
    $sourceHashes = @{
        'dbg_frames.c' = (Get-FileHash -LiteralPath $sharedSource -Algorithm SHA256).Hash.ToLowerInvariant()
        'main.c' = (Get-FileHash -LiteralPath (Join-Path $here 'src\main.c') -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $flags = @("-$Optimization", '-g3', "-gdwarf-$Dwarf", '-fasynchronous-unwind-tables')
    $manifest = @{
        schema = 1; board = '5301evklite'; optimization = $Optimization; dwarf = $Dwarf
        flags = $flags; compiler = (Join-Path $sdkCompilerBin 'riscv32-unknown-elf-gcc.exe')
        sources = $sourceHashes; elfSha256 = $hash
    }
    $manifestPath = Join-Path (Split-Path -Parent $elf) 'build-info.json'
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    Write-Output "Build manifest: $manifestPath"
    Write-Output "ELF SHA-256: $hash"
}

if (-not $NoCopy) {
    $out = Join-Path $here 'fw.elf'
    Copy-Item $elf $out -Force
    Write-Output "已复制给用户下载/烧录： $out"
}
