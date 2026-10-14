import {ETM_SCRIPTS} from './etm-kit-src.js';
export const ETM_KIT_DIR='etm-bridge-kit';
export function etmKitConfig(options={}){
  const port=Number(options.port || 8878);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('ETM 端口必须在 1024～65535 之间');
  return {serialRoot:String(options.serialRoot||'').trim(),etmRoot:String(options.etmRoot||'').trim(),port};
}
export function etmKitFiles(options={}){
  const config=etmKitConfig(options);
  const bat=check=>`@echo off\nsetlocal EnableExtensions\nchcp 65001 >nul\ncd /d "%~dp0"\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0etm-launcher.ps1"${check?' -CheckOnly':''} %*\nset "RESULT=%ERRORLEVEL%"\necho.\necho ETM bridge exited. Press any key to close.\npause >nul\nexit /b %RESULT%\n`;
  const docs=`ETM 本地桥（Windows）

1. 解压整个 ZIP。两个更新后的仓库需要保留在本机；此包是启动工具，未包含工程、Python或解码器。
2. 在 etm.config.json 填写 web-serial-rtt-tools / web-etm-trace 的目录。留空时只在启动包所在目录及上两级寻找相邻工程。
3. 双击 check-tools.bat 预检；双击 start-etm-bridge.bat 启动，会自动打开工具箱的 ETM 页面。
4. 启动后也可在工程页面点击“打开 ETM 工作台”。此按钮打开已运行的网页；网页不能直接执行 BAT。

环境：Python 3.9+，python -m pip install -r "ETM目录/requirements.txt"。
需要 ETM目录/build-native/etm_decode.exe；缺少时按照 ETM README 构建（CMake/Ninja/MinGW）。
启动器不自动安装依赖，不更改系统设置；只监听 127.0.0.1。Ctrl+C 退出。
启动包可放在含空格、中文的目录；相对工程路径以包内目录为基准。端口默认8878，可修改JSON。
同目录同端口的工作台已运行时直接打开；其他服务占用端口则报错，不会停止它。

KingstVIS：先启动并打开Socket（23367），使能五路通道，CH0～4=TRACECLK/TRACED0～3，与板子共地。
页面顺序：ELF → 探针 → 起点断点 → 时钟 → 联动采集 → 分析。首次连接需浏览器选择USB探针。
F103ZE验收档：CPU48MHz/TRACECLK24MHz、500MSa/s、10ms、2.0V、相位0.25，分支广播关闭。

维护脚本SHA256：
${Object.entries(ETM_SCRIPTS).map(([n,v])=>n+' '+v.sha256).join('\n')}
`;
  const list=[['start-etm-bridge.bat',bat(false)],['check-tools.bat',bat(true)],['etm.config.json',JSON.stringify(config,null,2)+'\n'],...Object.entries(ETM_SCRIPTS).map(([name,v])=>[name,v.src]),['README-etm.txt',docs]];
  return list.map(([name,text])=>{
    text=text.replace(/\r\n/g,'\n');
    if(/\.(bat|ps1)$/.test(name))text=text.replace(/\n/g,'\r\n');
    return {name:ETM_KIT_DIR+'/'+name,text,data:new TextEncoder().encode((name.endsWith('.ps1')?'\ufeff':'')+text)};
  });
}
