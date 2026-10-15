<#
  给自动化测试启动一个带调试端口的浏览器（有头；无头模式下 WebUSB/Web Serial 的选择框不会真弹）。

    pwsh -File tools\selftest\launch-browser.ps1                 # 默认 Edge，端口 9333
    pwsh -File tools\selftest\launch-browser.ps1 -Port 9333 -Url http://127.0.0.1:8899/index.html

  ⚠️ 那几个 --disable-background-* 参数很要紧：窗口被遮挡时 Chrome 会把定时器限速到 1~4Hz，
     于是 RTT 轮询看起来"只有 4Hz"（其实探针本身往返只要 0.34ms）。
#>
param(
  [int]$Port = 9333,
  [string]$Url = 'about:blank',
  [string]$Profile = "$env:TEMP\edge-rtt-tools-test",
  [string]$Exe = '',
  [switch]$Visible
)

if (-not $Exe){
  <#
    🚨 候选路径要包含**非标准安装位置**：本机 Chrome 装在
       `%LOCALAPPDATA%\Google\Chrome\Bin\chrome.exe`（不是常见的 Application 目录），
       于是这里一直悄悄回退到 Edge —— 而"授权 profile 只在 Chrome 里"这种事就全靠运气了。
       注册表 App Paths 是权威来源，先查它，再退回固定路径。
  #>
  foreach ($k in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
                   'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
                   'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe')){
    try {
      $p = (Get-ItemProperty -Path $k -ErrorAction Stop).'(default)'
      if ($p -and (Test-Path $p)){ $Exe = $p; break }
    } catch { }
  }
}
if (-not $Exe){
  foreach ($c in @("$env:LOCALAPPDATA\Google\Chrome\Bin\chrome.exe",
                   "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
                   "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                   "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
                   "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")){
    if (Test-Path $c){ $Exe = $c; break }
  }
}
if (-not $Exe){ throw '找不到 Chrome/Edge' }

$args = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$Profile",
  '--no-first-run', '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--window-size=1400,950',
  $Url
)
Write-Output "启动: $Exe"
Write-Output ("参数: " + ($args -join ' '))
$browserWindowStyle = if ($Visible) { 'Normal' } else { 'Hidden' }
Start-Process -FilePath $Exe -ArgumentList $args -WindowStyle $browserWindowStyle | Out-Null

for ($i = 0; $i -lt 60; $i++){
  try {
    $v = Invoke-WebRequest "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 -UseBasicParsing
    Write-Output ("CDP 就绪: " + (($v.Content | ConvertFrom-Json).Browser))
    exit 0
  } catch { Start-Sleep -Milliseconds 400 }
}
throw "等 CDP($Port) 超时"
