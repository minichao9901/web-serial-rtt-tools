param(
  [string]$Config = (Join-Path $PSScriptRoot 'etm.config.json'),
  [string]$SerialRoot = '', [string]$EtmRoot = '', [int]$Port = 0,
  [switch]$CheckOnly, [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
try {
  $settings = if (Test-Path -LiteralPath $Config) { Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
  if (-not $SerialRoot -and $settings) { $SerialRoot = $settings.serialRoot }
  if (-not $EtmRoot -and $settings) { $EtmRoot = $settings.etmRoot }
  if (-not $Port) { $Port = if ($settings -and $settings.port) { [int]$settings.port } else { 8878 } }
  if ($Port -lt 1024 -or $Port -gt 65535) { throw '端口必须在 1024～65535 之间。' }
  $parents = @($PSScriptRoot, (Split-Path $PSScriptRoot -Parent), (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
  function Find-Project([string]$chosen, [string]$name, [string]$marker) {
    if ($chosen) {
      if (-not [IO.Path]::IsPathRooted($chosen)) { $chosen = Join-Path $PSScriptRoot $chosen }
      $candidates = @($chosen)
    } else { $candidates = @($parents | ForEach-Object { $_; Join-Path $_ $name }) }
    foreach ($candidate in $candidates) {
      if (Test-Path -LiteralPath (Join-Path $candidate $marker)) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    throw "找不到 $name；请在 etm.config.json 中填写工程目录（或在页面填写后重新下载）。"
  }
  $SerialRoot = Find-Project $SerialRoot 'web-serial-rtt-tools' 'app\etm\view.js'
  $EtmRoot = Find-Project $EtmRoot 'web-etm-trace' 'web\app\embedding.js'
  foreach ($required in @('server.py', 'requirements.txt', 'build-native\etm_decode.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $EtmRoot $required))) {
      throw "ETM 缺少 $required。请先按照 ETM 工程 README 安装依赖、构建解码器，再启动本地桥。"
    }
  }
  $server = Join-Path $PSScriptRoot 'serve-etm.py'
  if (-not (Test-Path -LiteralPath $server)) { throw '启动包不完整：缺少 serve-etm.py，请重新下载完整 ZIP。' }
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  $pythonArgs = @()
  if (-not $python) { $python = Get-Command py.exe -ErrorAction SilentlyContinue; $pythonArgs = @('-3') }
  if (-not $python) { throw '没有找到 Python 3，请安装 Python 并启用 PATH，再双击启动器。' }
  & $python.Source @pythonArgs -X utf8 -c 'import sys; assert sys.version_info >= (3,9); import flask, werkzeug, elftools, capstone'
  if ($LASTEXITCODE -ne 0) { throw "Python 版本或依赖不满足；需要 Python 3.9+，请执行：python -m pip install -r `"$EtmRoot\requirements.txt`"" }
  $url = "http://127.0.0.1:$Port/"
  $existing = $null
  try { $existing = Invoke-RestMethod -Uri ($url + 'etm-launcher.json') -TimeoutSec 2 } catch {}
  if ($existing -and $existing.protocol -eq 1 -and $existing.serialRoot -eq $SerialRoot -and $existing.etmRoot -eq $EtmRoot) {
    Write-Host "本地工作台已运行：$url#etm"
    if (-not $CheckOnly -and -not $NoBrowser) { Start-Process ($url + '#etm') }
    exit 0
  }
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
  try { $listener.Start() } catch { throw "端口 $Port 已被其他服务占用；请更换端口，不会停止已有服务。" } finally { $listener.Stop() }
  Write-Host "工具箱：$SerialRoot"
  Write-Host "ETM：$EtmRoot"
  Write-Host "预检通过。KingstVIS 需开启 Socket，并使能 CH0～4。"
  if ($CheckOnly) { exit 0 }
  if (-not $NoBrowser) {
    # 等待同源服务准备完毕后才打开网页；退出会连同这个等待任务一起释放。
    $browserJob = Start-Job -ArgumentList $url -ScriptBlock {
      param($base)
      for ($i=0; $i -lt 60; $i++) {
        try { $ready = Invoke-RestMethod ($base + 'etm-launcher.json') -TimeoutSec 1; if ($ready.protocol -eq 1) { Start-Process ($base + '#etm'); return } } catch {}
        Start-Sleep -Milliseconds 500
      }
    }
  }
  Write-Host "启动 ETM 桥：$url#etm（退出请按 Ctrl+C）"
  & $python.Source @pythonArgs -X utf8 $server --serial-root $SerialRoot --etm-root $EtmRoot --port $Port
  if ($LASTEXITCODE -ne 0) { throw '本地桥启动失败，请查看上面的错误。' }
} catch { Write-Host ("[错误] " + $_.Exception.Message) -ForegroundColor Red; exit 1 }
finally { if ($browserJob) { Stop-Job $browserJob; Remove-Job $browserJob } }
