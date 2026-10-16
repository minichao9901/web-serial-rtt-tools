import datetime,json,os,pathlib,subprocess,uuid
out=pathlib.Path(__file__).resolve().parent;root=out.parents[2]
lock=pathlib.Path('E:/web-etm-trace-coordination/hardware.lock');token=uuid.uuid4().hex
lock.mkdir();(lock/'owner.json').write_text(json.dumps(dict(owner='codex-flash-page-sram',pid=os.getpid(),leaseToken=token,purpose=out.name,started=datetime.datetime.now().astimezone().isoformat())),encoding='utf8')
restored=False
try:
    with (out/'browser-prep.log').open('wb') as f:subprocess.run(['python',str(out/'browser-prep.py')],cwd=root,stdout=f,stderr=subprocess.STDOUT,check=True,timeout=45)
    with (out/'sram-web.log').open('wb') as f:
        p=subprocess.run(['node',str(out/'sram-web.mjs')],cwd=root,stdout=f,stderr=subprocess.STDOUT,timeout=900)
    (out/'execution.json').write_text(json.dumps(dict(command=['node',str(out/'sram-web.mjs')],cwd=str(root),exitCode=p.returncode),indent=2),encoding='utf8')
finally:
    if (out/'restore.json').exists():restored=json.loads((out/'restore.json').read_text())['passed']
    if not restored and (out/'original-state.json').exists():
        profile=json.loads((out/'browser.json').read_text(encoding='utf8'))['profile'].replace("'","''")
        subprocess.run(['pwsh','-NoProfile','-Command',"Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*"+profile+"*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }"],timeout=25)
        state=json.loads((out/'original-state.json').read_text());ram=str(out/'original-ram.bin').replace('\\','/')
        cmd='init; halt; load_image {'+ram+'} 0x20000000 bin; verify_image {'+ram+'} 0x20000000; '+''.join('reg '+('r'+str(i) if i<13 else ['sp','lr','pc','xPSR'][i-13])+' '+str(v)+'; ' for i,v in enumerate(state['regs']))+('' if state['wasHalted'] else 'resume; ')+'shutdown'
        with (out/'native-restore.log').open('wb') as f:
            p=subprocess.run(['E:/Share/env-windows/xpack-openocd-0.12.0-6/bin/openocd.exe','-s','E:/Share/env-windows/xpack-openocd-0.12.0-6/openocd/scripts','-f','interface/cmsis-dap.cfg','-c','cmsis-dap backend usb_bulk','-f','target/stm32f1x.cfg','-c','adapter speed 1000','-c','gdb port disabled','-c','tcl port disabled','-c','telnet port disabled','-c',cmd],cwd=root,stdout=f,stderr=subprocess.STDOUT,timeout=90)
        restored=p.returncode==0
        (out/'native-restore.json').write_text(json.dumps(dict(passed=restored,command=cmd)),encoding='utf8')
    if (restored or not (out/'original-state.json').exists()) and json.loads((lock/'owner.json').read_text())['leaseToken']==token:lock.rename(lock.with_name('hardware.lock.released-'+out.name+'-'+token[:6]))
    (out/'state-final.json').write_text(json.dumps(dict(restored=restored,lockReleased=not lock.exists(),time=datetime.datetime.now().astimezone().isoformat())),encoding='utf8')
