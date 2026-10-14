param([int]$Port=8878,[string]$EtmRoot=(Join-Path $PSScriptRoot '..\..\..\web-etm-trace'))
$ErrorActionPreference='Stop'
$EtmRoot=(Resolve-Path -LiteralPath $EtmRoot).Path
$decoder=Join-Path $EtmRoot 'build-native\etm_decode.exe'
if(-not (Test-Path -LiteralPath $decoder)){
  & pwsh -NoProfile -File (Join-Path $EtmRoot 'build-decoder.ps1')
  if($LASTEXITCODE -ne 0){throw 'ETM 解码器构建失败'}
}
& python -X utf8 (Join-Path $PSScriptRoot 'serve-etm.py') --port $Port --etm-root $EtmRoot
if($LASTEXITCODE -ne 0){throw '本地工作台启动失败；请检查Python依赖及ETM目录'}
