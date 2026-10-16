"""F103 USB reconnect via a temporary PA12 open-drain-low pulse, then SYSRESETREQ.
No Flash writes. USB register definitions use the bundled STM32F103xE CMSIS header.
"""
import datetime,hashlib,json,pathlib,subprocess,uuid,os
out=pathlib.Path(__file__).resolve().parent;root=out.parents[2]
lock=pathlib.Path('E:/web-etm-trace-coordination/hardware.lock');token=uuid.uuid4().hex
lock.mkdir();(lock/'owner.json').write_text(json.dumps(dict(owner='codex-usb-reenumeration',pid=os.getpid(),leaseToken=token,purpose=out.name,started=datetime.datetime.now().astimezone().isoformat())),encoding='utf8')
try:
    cmd='init; halt; echo "BEFORE_CRL [read_memory 0x40010804 32 1]"; set apb2 [lindex [read_memory 0x40021018 32 1] 0]; mww 0x40021018 [expr {$apb2 | 4}]; set apb1 [lindex [read_memory 0x4002101c 32 1] 0]; mww 0x4002101c [expr {$apb1 | 0x00800000}]; mwh 0x40005c40 3; mww 0x40010810 0x10000000; set crh [lindex [read_memory 0x40010804 32 1] 0]; mww 0x40010804 [expr {($crh & 0xfff0ffff) | 0x00060000}]; sleep 150; cortex_m reset_config sysresetreq; reset halt; set vectors [read_memory 0x08000000 32 2]; mww 0xe000ed08 0x08000000; reg sp [lindex $vectors 0]; reg pc [lindex $vectors 1]; reg primask 0; reg faultmask 0; resume; sleep 500; echo "AFTER_CRL [read_memory 0x40010804 32 1]"; echo "CLOCK [read_memory 0x200000a0 32 2]"; dump_image {'+str(out/'usb-reenumerated-flash.bin').replace('\\','/')+'} 0x08000000 524288; shutdown'
    args=['E:/Share/env-windows/xpack-openocd-0.12.0-6/bin/openocd.exe','-s','E:/Share/env-windows/xpack-openocd-0.12.0-6/openocd/scripts','-f','interface/cmsis-dap.cfg','-c','cmsis-dap backend usb_bulk','-f','target/stm32f1x.cfg','-c','adapter speed 1000','-c','gdb port disabled','-c','tcl port disabled','-c','telnet port disabled','-c',cmd]
    p=subprocess.run(args,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=120)
    (out/'usb-reenumerate.log').write_bytes(p.stdout);assert p.returncode==0,p.stdout.decode('utf8',errors='replace')[-2500:]
    actual=(out/'usb-reenumerated-flash.bin').read_bytes();original=(out/'original-flash.bin').read_bytes();assert actual==original
    result=dict(passed=True,method='USB PDWN/FRES; PA12 temporary open-drain low 150 ms; SYSRESETREQ restores GPIO and starts original firmware',flashWrites=False,flashBytesVerified=len(actual),flashSha256=hashlib.sha256(actual).hexdigest(),command=args,cwd=str(root),time=datetime.datetime.now().astimezone().isoformat())
    (out/'usb-reenumerate.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False))
finally:
    if json.loads((lock/'owner.json').read_text())['leaseToken']==token:lock.rename(lock.with_name('hardware.lock.released-usb-reenumeration-'+token[:8]))
