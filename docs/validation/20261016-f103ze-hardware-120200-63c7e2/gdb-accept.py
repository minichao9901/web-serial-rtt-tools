import json, os, pathlib, socket, subprocess, time
runout=pathlib.Path(__file__).resolve().parent
out=pathlib.Path(os.environ.get('GDB_OUT',str(runout)))
out.mkdir(exist_ok=True)
root=runout.parents[2]
ocd='E:/Share/env-windows/xpack-openocd-0.12.0-6/bin/openocd.exe'
scripts='E:/Share/env-windows/xpack-openocd-0.12.0-6/openocd/scripts'
gdb='E:/Share/env-windows/tools/gnu_gcc/arm_gcc/mingw/bin/arm-none-eabi-gdb-py.exe'
elf='tools/target-firmware/stm32f103_dbgstress/build/fw.elf'
env=os.environ.copy()
env['PYTHONHOME']=str(runout/'gdb-runtime')
env['PYTHONPATH']=str(runout/'gdb-runtime/Lib')+os.pathsep+str(runout/'gdb-runtime/gdb-python')
commands=[ocd,'-s',scripts,'-f','interface/cmsis-dap.cfg','-c','cmsis-dap backend usb_bulk','-f','target/stm32f1x.cfg','-c','adapter speed 1000','-c','gdb port 3333','-c','tcl port disabled','-c','telnet port disabled','-c','init']
subprocess.run(['node',str(runout/'release-web.mjs')],cwd=root,check=True,timeout=40)
with (out/'gdb-flash.log').open('wb') as f:
    p=subprocess.run([ocd,'-s',scripts,'-f','interface/cmsis-dap.cfg','-c','cmsis-dap backend usb_bulk','-f','target/stm32f1x.cfg','-c','adapter speed 1000','-c','gdb port disabled','-c','tcl port disabled','-c','telnet port disabled','-c','init; program {'+str(root/pathlib.Path(elf)).replace('\\','/')+'} verify; reset halt; shutdown'],cwd=root,stdout=f,stderr=subprocess.STDOUT,timeout=90)
assert p.returncode==0
server_log=(out/'gdb-server.log').open('wb')
server=subprocess.Popen(commands,cwd=root,stdout=server_log,stderr=subprocess.STDOUT)
try:
    for n in range(80):
        if server.poll() is not None: raise RuntimeError('OpenOCD exited')
        try:
            with socket.create_connection(('127.0.0.1',3333),timeout=.3): break
        except OSError: time.sleep(.1)
    else: raise RuntimeError('GDB server not ready')
    args=['node','tools/selftest/dbg-frame-gdb-oracle.mjs','--board=f103ze','--elf='+elf,'--remote=127.0.0.1:3333','--gdb='+gdb,'--out='+str(out/'frame-oracle.json')]
    with (out/'gdb-oracle.log').open('wb') as f:
        p=subprocess.run(args,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=240)
    assert p.returncode==0, (out/'gdb-oracle.log').read_text(encoding='utf8',errors='replace')[-2500:]
    lines=['set pagination off','set confirm off','target extended-remote 127.0.0.1:3333','monitor reset halt','set $sp = *(unsigned int*)0x08000000','set $pc = (*(unsigned int*)0x08000004) & ~1','set $primask = 0','set $faultmask = 0','monitor mww 0xe000ed08 0x08000000','hbreak engine_linear','continue','info registers','x/16bx 0x08000000','backtrace','stepi','stepi','next','finish','delete breakpoints','detach','quit']
    script=out/'gdb-smoke.gdb';script.write_text('\n'.join(lines)+'\n',encoding='utf8')
    with (out/'gdb-smoke.log').open('wb') as f:
        p=subprocess.run([gdb,'-q','-nx','-batch',elf,'-x',str(script)],cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=120)
    assert p.returncode==0,(out/'gdb-smoke.log').read_text(encoding='utf8',errors='replace')[-2500:]
    (out/'gdb-result.json').write_text(json.dumps(dict(passed=True,frameOracle='frame-oracle.json',cases=7,smoke=['hardware breakpoint','registers','memory','backtrace','stepi','next','finish','detach']),indent=2),encoding='utf8')
finally:
    server.terminate()
    try: server.wait(timeout=8)
    except subprocess.TimeoutExpired: server.kill();server.wait()
    server_log.close()
