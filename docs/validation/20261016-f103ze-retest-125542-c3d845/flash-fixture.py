import pathlib, subprocess, sys
out=pathlib.Path(__file__).resolve().parent;root=out.parents[2]
fixture=pathlib.Path(sys.argv[1]).resolve();label=sys.argv[2]
assert fixture.is_file()
assert (out/'backup.json').is_file()
subprocess.run(['node',str(out/'release-web.mjs')],cwd=root,check=True,timeout=40)
ocd='E:/Share/env-windows/xpack-openocd-0.12.0-6/bin/openocd.exe'
scripts='E:/Share/env-windows/xpack-openocd-0.12.0-6/openocd/scripts'
cmd='init; program {'+str(fixture).replace('\\','/')+'} verify; reset halt; set vectors [read_memory 0x08000000 32 2]; mww 0xe000ed08 0x08000000; reg sp [lindex $vectors 0]; reg pc [lindex $vectors 1]; reg primask 0; reg faultmask 0; resume; shutdown'
with (out/(label+'.log')).open('wb') as f:
    p=subprocess.run([ocd,'-s',scripts,'-f','interface/cmsis-dap.cfg','-c','cmsis-dap backend usb_bulk','-f','target/stm32f1x.cfg','-c','adapter speed 1000','-c','gdb port disabled','-c','tcl port disabled','-c','telnet port disabled','-c',cmd],cwd=root,stdout=f,stderr=subprocess.STDOUT,timeout=90)
assert p.returncode==0,(out/(label+'.log')).read_text(encoding='utf8',errors='replace')[-2000:]
print('Fixture programmed and verified:',fixture)
