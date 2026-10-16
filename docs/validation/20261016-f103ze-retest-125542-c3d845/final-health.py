import datetime,json,os,pathlib,re,subprocess,uuid
out=pathlib.Path(__file__).resolve().parent;root=out.parents[2]
lock=pathlib.Path('E:/web-etm-trace-coordination/hardware.lock');token=uuid.uuid4().hex
lock.mkdir()
(lock/'owner.json').write_text(json.dumps(dict(owner='codex-final-health',pid=os.getpid(),leaseToken=token,purpose='verify restored firmware running',started=datetime.datetime.now().astimezone().isoformat())),encoding='utf8')
base=['E:/Share/env-windows/xpack-openocd-0.12.0-6/bin/openocd.exe','-s','E:/Share/env-windows/xpack-openocd-0.12.0-6/openocd/scripts','-f','interface/cmsis-dap.cfg','-c','cmsis-dap backend usb_bulk','-f','target/stm32f1x.cfg','-c','adapter speed 1000','-c','gdb port disabled','-c','tcl port disabled','-c','telnet port disabled']
try:
    cmd='init; echo "DHCSR [read_memory 0xe000edf0 32 1]"; echo "FPB [read_memory 0xe0002000 32 8]"; echo "CLOCK [read_memory 0x200000a0 32 2]"; echo "TICK1 [read_memory 0x20001d90 32 1]"; sleep 300; echo "TICK2 [read_memory 0x20001d90 32 1]"; shutdown'
    p=subprocess.run(base+['-c',cmd],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=40)
    (out/'final-health.log').write_bytes(p.stdout);assert p.returncode==0
    text=p.stdout.decode('utf8',errors='replace');print(text[-2500:])
    dhcsr=int(re.search(r'DHCSR\s+(0x[\da-f]+|\d+)',text,re.I)[1],0)
    if dhcsr&(1<<17):
        cmd='init; halt; '+''.join('mww '+hex(0xe0002008+4*i)+' 0; ' for i in range(6))+'mww 0xe000edfc 16777216; resume; sleep 400; echo "DHCSR_RESUMED [read_memory 0xe000edf0 32 1]"; echo "TICK_RESUMED [read_memory 0x20001d90 32 1]"; shutdown'
        p=subprocess.run(base+['-c',cmd],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=40)
        (out/'final-health-resume.log').write_bytes(p.stdout);assert p.returncode==0
        print(p.stdout.decode('utf8',errors='replace')[-1500:])
finally:
    if json.loads((lock/'owner.json').read_text())['leaseToken']==token:lock.rename(lock.with_name('hardware.lock.released-final-health-'+token[:8]))
