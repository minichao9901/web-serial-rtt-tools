param([string]$Config=(Join-Path $PSScriptRoot 'etm.config.json'),[int]$Port=0,[switch]$CheckOnly,[switch]$NoBrowser)
$ErrorActionPreference='Stop'
try {
  $exe=Join-Path $PSScriptRoot 'etm-bridge.exe'
  if(-not (Test-Path -LiteralPath $exe)){throw '请先下载并解压完整 ETM 桥包，将这些启动文件放到完整包目录，再双击 BAT。'}
  $arguments=@('--config',$Config)
  if($Port){$arguments+=@('--port',[string]$Port)}
  if($CheckOnly){$arguments+='--check'}
  if($NoBrowser){$arguments+='--no-browser'}
  & $exe @arguments
  exit $LASTEXITCODE
} catch {Write-Host ('[错误] '+$_.Exception.Message) -ForegroundColor Red;exit 1}
