@echo off
rem ===========================================================================
rem  UTF-8 bootstrap.  EVERYTHING ABOVE THE GUARD MUST BE ASCII-ONLY.
rem  See start-web.bat for the full explanation: a Chinese console defaults to
rem  936(GBK), so we switch to 65001 and RE-ENTER this script once.
rem ===========================================================================
if not "%RTT_TOOLS_UTF8%"=="1" (
  chcp 65001 >nul
  set "RTT_TOOLS_UTF8=1"
  cmd /c ""%~f0" %*"
  exit /b %errorlevel%
)
rem ============================================================================
rem  双击即用：起 **ETM 桥**（serve-etm.py：同一个回环源同时托管工具箱和
rem  兄弟仓 web-etm-trace 的 ETM 页面），然后直接打开 ETM 标签页。
rem
rem  用法：
rem    双击                 -> 端口 8878，打开 http://127.0.0.1:8878/#tab-etm
rem    start-etm.bat 8880   -> 换端口
rem
rem  为什么用它而不是直接开 web-etm-trace 的 8766：
rem    8878 把工具箱页面和 ETM 子页放在**同一个 origin** 下（子页挂在 /etm/，
rem    接口走 /etm/api/），#tab-etm 的内嵌页才不会因为跨源被挡；
rem    WebUSB / Web Serial 也必须有 http 源，file:// 打不开任何探针。
rem
rem  探针授权：第一次进页面点「连接探针」会弹 WebUSB 设备框，选
rem    akaLinkPro (0D28:0204) 即可；授权按 profile 记住，之后不再弹。
rem ============================================================================
setlocal
cd /d "%~dp0"

rem ---- 0) 本 bat 需要兄弟仓库 web-etm-trace（它才是 ETM 后端）----
rem     只有工具箱仓库的用户请改用包自带的 start-etm-bridge.bat（便携桥）
if not exist "..\web-etm-trace\server.py" (
  echo.
  echo   [x] 找不到 ..\web-etm-trace 目录 —— 本 bat 需要和 ETM 仓库并排放。
  echo       如果你只 clone 了工具箱，请改用便携桥：
  echo         bridge\etm\downloads\etm-bridge-win64.zip ^-^> 解压 ^-^> 双击 start-etm-bridge.bat
  echo.
  pause
  exit /b 1
)

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8878"
set "URL=http://127.0.0.1:%PORT%/#tab-etm"

echo.
echo   ETM 桥 + 工具箱 —— 本地网页
echo   ---------------------------------------------------------------
echo   仓库：%CD%
echo   ETM 源：%CD%\..\web-etm-trace
echo   地址：%URL%
echo.

rem ---- 1) 端口已在监听？在跑就直接开页面 -------------------------------
netstat -ano | findstr ":%PORT% " | findstr /i "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo   [1/3] 服务已在运行（端口 %PORT%）—— 跳过启动
  goto :open
)

rem ---- 2) 起 ETM 桥（后台最小化窗口）-----------------------------------
where python >nul 2>nul
if errorlevel 1 (
  echo   [x] 没找到 python —— 装 Python 3.10+ 再来
  echo       或者先用线上版： https://minichao9901.github.io/web-serial-rtt-tools/
  echo.
  pause
  exit /b 1
)
echo   [1/3] 启动：python tools/dev/serve-etm.py --etm-root ..\web-etm-trace --port %PORT%
start "etm-bridge" /min cmd /c python -X utf8 "tools\dev\serve-etm.py" --etm-root "..\web-etm-trace" --port %PORT%

rem ---- 3) 等端口就绪（最多 ~20 秒），然后开浏览器 ------------------------
echo   [2/3] 等服务就绪…
for /l %%i in (1,1,20) do (
  ping -n 2 127.0.0.1 >nul
  netstat -ano | findstr ":%PORT% " | findstr /i "LISTENING" >nul 2>nul
  if not errorlevel 1 goto :open
)
echo   [!] 等了 20 秒端口还没起来 —— 仍然先打开浏览器，页面里刷新一下看

:open
echo   [3/3] 打开浏览器：%URL%
rem 默认用 Chrome + 调试端口（这样 AI/脚本能通过 CDP 全程驱动页面）；找不到 Chrome 才退回默认浏览器
set "CHROME=%LOCALAPPDATA%\Google\Chrome\Bin\chrome.exe"
set "CDP_PROFILE=%TEMP%\etm-web-cdp"
set "DEBUG_PORT=9340"
if not "%~2"=="" set "DEBUG_PORT=%~2"
if exist "%CHROME%" (
  echo         Chrome + remote-debugging-port=%DEBUG_PORT%，profile=%CDP_PROFILE%
  start "" "%CHROME%" --remote-debugging-port=%DEBUG_PORT% --user-data-dir="%CDP_PROFILE%" --no-first-run --no-default-browser-check --disable-features=WebUsbDeviceDetection "%URL%"
) else (
  echo         [!] 没找到 Chrome —— 用默认浏览器（不带调试端口，AI 驱动不了）
  start "" "%URL%"
)
echo.
echo   ---------------------------------------------------------------
echo   完成。这个窗口可以关 —— 桥在另一个最小化的窗口（标题 etm-bridge）里跑。
echo   · 停止桥：关掉那个最小化窗口
echo   · 换端口：start-etm.bat 8880
echo   · 探针没授权：页面里点「连接探针」，选 akaLinkPro (0D28:0204)
echo.
ping -n 6 127.0.0.1 >nul
exit /b 0
