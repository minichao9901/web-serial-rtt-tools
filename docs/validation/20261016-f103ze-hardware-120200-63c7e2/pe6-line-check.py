"""Distinguish a missing PE6/CH4 signal path from ETM decode configuration."""
import json,pathlib,re,subprocess,sys
out=pathlib.Path(__file__).resolve().parent;root=out.parents[2]
sys.path.insert(0,str(root/'bridge/etm/backend/tools/la'))
from kingst_la import Vis,do_export
sys.path.insert(0,str(root/'bridge/etm/backend/tools'))
from trace_port import read_tracks
subprocess.run(['node',str(out/'release-web.mjs')],cwd=root,check=True,timeout=40)
v=Vis();original_rate=int(v.cmd('get-sample-rate'))
span=list(map(float,v.cmd('get-actual-sample-time').split()));original_time=span[-1]-span[0]
commands='init; halt; set apb [lindex [read_memory 0x40021018 32 1] 0]; mww 0x40021018 [expr {$apb | 64}]; set crl [lindex [read_memory 0x40011800 32 1] 0]; set odr [lindex [read_memory 0x4001180c 32 1] 0]; set dbg [lindex [read_memory 0xe0042004 32 1] 0]; mww 0xe0042004 [expr {$dbg & ~32}]; mww 0x40011800 [expr {($crl & 0xf0ffffff) | 0x08000000}]; echo GPIO_READY; sleep 500; for {set i 0} {$i < 20} {incr i} {mww 0x40011810 64; sleep 1; echo "PE6_HIGH [read_memory 0x40011808 32 1]"; sleep 10; mww 0x40011810 4194304; sleep 1; echo "PE6_LOW [read_memory 0x40011808 32 1]"; sleep 10}; mww 0x4001180c $odr; mww 0x40011800 $crl; mww 0xe0042004 $dbg; mww 0x40021018 $apb; resume; shutdown'
ocd=['E:/Share/env-windows/xpack-openocd-0.12.0-6/bin/openocd.exe','-s','E:/Share/env-windows/xpack-openocd-0.12.0-6/openocd/scripts','-f','interface/cmsis-dap.cfg','-c','cmsis-dap backend usb_bulk','-f','target/stm32f1x.cfg','-c','adapter speed 1000','-c','gdb port disabled','-c','tcl port disabled','-c','telnet port disabled','-c',commands]
proc=None
try:
    v.cmd('set-sample-rate 1000000');v.cmd('set-sample-time 1.2');v.cmd('set-trigger --reset')
    proc=subprocess.Popen(ocd,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    log=b''
    while True:
        line=proc.stdout.readline();log+=line
        if b'GPIO_READY' in line:break
        if not line:raise RuntimeError('GPIO setup failed: '+log.decode('utf8',errors='replace'))
    v.cmd('start',timeout=10)
    log+=proc.communicate(timeout=10)[0]
    (out/'pe6-line-openocd.log').write_bytes(log)
    assert proc.returncode==0
    csv=out/'pe6-line.csv';do_export(v,str(csv),channels=[0,1,2,3,4])
    initial,tracks,start,end=read_tracks(csv)
    text=log.decode('utf8',errors='replace')
    high=[int(x,0) for x in re.findall(r'PE6_HIGH\s+(0x[\da-f]+|\d+)',text,re.I)]
    low=[int(x,0) for x in re.findall(r'PE6_LOW\s+(0x[\da-f]+|\d+)',text,re.I)]
    pin_ok=len(high)==20 and len(low)==20 and all(x&64 for x in high) and all(not x&64 for x in low)
    result=dict(source='direct PE6 weak input pull-up/down, ETM gate temporarily disabled, GPIO/RCC/DBG restored',pinHighReads=len(high),pinLowReads=len(low),gpioReadbackPassed=pin_ok,initial=initial,transitions={k:len(t) for k,t in tracks.items()},laCH4PathPassed=len(tracks[4])>=30,rate=1000000,seconds=end-start,previousRate=original_rate,previousTime=original_time)
    (out/'pe6-line-result.json').write_text(json.dumps(result,indent=2),encoding='utf8');print(json.dumps(result),flush=True)
finally:
    if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=5)
    v.cmd('set-sample-rate '+str(original_rate));v.cmd('set-sample-time '+str(original_time));v.cmd('set-trigger --reset --neg-edge 1');v.close()
