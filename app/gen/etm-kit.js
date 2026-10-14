import {ETM_SCRIPTS} from './etm-kit-src.js';
export const ETM_KIT_DIR='etm-bridge-kit';
export const ETM_PACKAGE_URL=new URL('../../bridge/etm/downloads/etm-bridge-win64.zip',import.meta.url);
export const ETM_PACKAGE_MANIFEST_URL=new URL('../../bridge/etm/downloads/manifest.json',import.meta.url);
export function etmKitConfig(options={}){
  const port=Number(options.port || 8878);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('ETM 端口必须在 1024～65535 之间');
  return {port};
}
export function etmKitFiles(options={}){
  const config=etmKitConfig(options);
  const bat=check=>`@echo off\nsetlocal EnableExtensions\nchcp 65001 >nul\ncd /d "%~dp0"\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0etm-launcher.ps1"${check?' -CheckOnly':''} %*\nset "RESULT=%ERRORLEVEL%"\necho.\necho ETM bridge exited. Press any key to close.\npause >nul\nexit /b %RESULT%\n`;
  const docs=`ETM 本地桥 · Windows 64 位

首次使用：下载完整 ETM 桥包，解压整个文件夹，双击 start-etm-bridge.bat。
本机只需 KingstVIS；桥包已经包含 Python、依赖、网页和 OpenCSD 解码器，不需要两个工程目录。
仅下载的启动文件应放到已解压完整包目录，覆盖同名文件；它不包含 etm-bridge.exe 和 runtime。

双击 check-tools.bat 检查包是否完整；双击 start-etm-bridge.bat 启动并自动打开网页。
默认端口 8878；本次启动文件端口 ${config.port}，可在 etm.config.json 修改。
完整包使用默认端口；需要其他端口时，可用本次启动文件覆盖完整包内配置。
采集记录保存在包内 data/records，保留它们即可再次分析；更新完整包前请保留 data 目录。
退出按 Ctrl+C；同版本桥已运行时会复用，其他服务占用端口时会报错，不会停止已有服务。

KingstVIS：开启 Socket（默认23367），使能 CH0～4；五路对应 TRACECLK、TRACED0～3，并与板子共地。
页面顺序：ELF → 探针 → 起点断点 → 时钟 → 联动采集 → 分析。首次连接需浏览器选择 USB 探针。
F103ZE：CPU48MHz/TRACECLK24MHz，500MSa/s、10ms、2.0V、相位0.25，分支广播关闭。
支持 ETMv3/ETMv4；火焰图宽度表示执行序号或路径数，不表示耗时。
使用与许可证说明见完整包 README 和 licenses 目录。
`;
  const list=[['start-etm-bridge.bat',bat(false)],['check-tools.bat',bat(true)],['etm.config.json',JSON.stringify(config,null,2)+'\n'],['etm-launcher.ps1',ETM_SCRIPTS['etm-launcher.ps1'].src],['README-etm.txt',docs]];
  return list.map(([name,text])=>{
    text=text.replace(/\r\n/g,'\n');
    if(/\.(bat|ps1)$/.test(name))text=text.replace(/\n/g,'\r\n');
    return {name:ETM_KIT_DIR+'/'+name,text,data:new TextEncoder().encode((name.endsWith('.ps1')?'\ufeff':'')+text)};
  });
}
