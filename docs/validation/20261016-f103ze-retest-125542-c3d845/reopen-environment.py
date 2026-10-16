import json,pathlib,subprocess
out=pathlib.Path(__file__).resolve().parent;root=out.parents[2]
profile=json.loads((out/'browser.json').read_text(encoding='utf8'))['profile']
safe=profile.replace("'","''")
script="Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*"+safe+"*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }"
subprocess.run(['pwsh','-NoProfile','-Command',script],check=True,timeout=25)
ocd=['E:/Share/env-windows/xpack-openocd-0.12.0-6/bin/openocd.exe','-s','E:/Share/env-windows/xpack-openocd-0.12.0-6/openocd/scripts','-f','interface/cmsis-dap.cfg','-c','cmsis-dap backend usb_bulk','-f','target/stm32f1x.cfg','-c','adapter speed 1000','-c','gdb port disabled','-c','tcl port disabled','-c','telnet port disabled','-c','init; echo "TARGET_ID [read_memory 0xe0042000 32 1]"; echo "CLOCK [read_memory 0x200000a0 32 2]"; echo "TICK1 [read_memory 0x20001d90 32 1]"; sleep 200; echo "TICK2 [read_memory 0x20001d90 32 1]"; shutdown']
with (out/'reopen-target-check.log').open('wb') as f:p=subprocess.run(ocd,cwd=root,stdout=f,stderr=subprocess.STDOUT,timeout=45)
assert p.returncode==0,(out/'reopen-target-check.log').read_text(encoding='utf8',errors='replace')[-1800:]
subprocess.run(['pwsh','-NoProfile','-File','tools/selftest/launch-browser.ps1','-Port','9333','-Url','http://127.0.0.1:8899/index.html','-Profile',profile],cwd=root,check=True,timeout=45)
