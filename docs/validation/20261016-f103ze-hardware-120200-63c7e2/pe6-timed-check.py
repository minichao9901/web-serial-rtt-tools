import json,pathlib,socket,subprocess,sys,threading,time
run=pathlib.Path(__file__).resolve().parent;root=run.parents[2];out=run/'pe6-timed';out.mkdir(exist_ok=True)
sys.path.insert(0,str(root/'bridge/etm/backend/tools/la'))
from kingst_la import Vis,do_export
sys.path.insert(0,str(root/'bridge/etm/backend/tools'))
from trace_port import read_tracks
exe='E:/Share/env-windows/xpack-openocd-0.12.0-6/bin/openocd.exe';scripts='E:/Share/env-windows/xpack-openocd-0.12.0-6/openocd/scripts'
log=(out/'openocd.log').open('wb')
p=subprocess.Popen([exe,'-s',scripts,'-f','interface/cmsis-dap.cfg','-c','cmsis-dap backend usb_bulk','-f','target/stm32f1x.cfg','-c','adapter speed 1000','-c','gdb port disabled','-c','tcl port 3335','-c','telnet port disabled','-c','init'],cwd=root,stdout=log,stderr=subprocess.STDOUT)
s=None;v=None;saved={};rows=[];worker=None
def command(text):
    s.sendall(text.encode()+b'\x1a');data=b''
    while b'\x1a' not in data:data+=s.recv(4096)
    return data.split(b'\x1a')[0].decode().strip()
def read(a):return int(command('read_memory '+hex(a)+' 32 1').strip('{}'),0)
def write(a,value):command('mww '+hex(a)+' '+str(value))
try:
    for _ in range(60):
        try:s=socket.create_connection(('127.0.0.1',3335),timeout=.2);s.settimeout(3);break
        except OSError:time.sleep(.1)
    assert s
    command('halt');saved['apb']=read(0x40021018);write(0x40021018,saved['apb']|64)
    saved.update(crl=read(0x40011800),odr=read(0x4001180c),dbg=read(0xe0042004))
    write(0xe0042004,saved['dbg']&~32);write(0x40011800,(saved['crl']&0xf0ffffff)|0x08000000)
    v=Vis();rate=int(v.cmd('get-sample-rate'));span=list(map(float,v.cmd('get-actual-sample-time').split()));duration=span[-1]-span[0]
    v.cmd('set-sample-rate 1000000');v.cmd('set-sample-time 1.2');v.cmd('set-trigger --reset')
    started=time.monotonic();errors=[]
    def sample():
        try:v.cmd('start',timeout=10)
        except Exception as error:errors.append(str(error))
    worker=threading.Thread(target=sample);worker.start();time.sleep(.15)
    for i in range(20):
        for high in [True,False]:
            write(0x40011810,64 if high else 4194304);time.sleep(.006)
            rows.append(dict(high=high,pinHigh=bool(read(0x40011808)&64),seconds=time.monotonic()-started))
    worker.join(timeout=10);assert not worker.is_alive() and not errors,errors
    actualDepth=v.cmd('get-actual-sample-depth');actualTime=v.cmd('get-actual-sample-time')
    do_export(v,str(out/'capture.csv'),channels=list(range(16)))
    initial,tracks,_,_=read_tracks(out/'capture.csv')
    result=dict(method='persistent OpenOCD TCL writes while free-running Kingst capture is active; weak pull-up/down input',actualDepth=actualDepth,actualTime=actualTime,rows=rows,gpioReadbackPassed=all(r['high']==r['pinHigh'] for r in rows),transitions={k:len(t) for k,t in tracks.items()},observedChannels=[k for k,t in tracks.items() if len(t)>=30],channel4PathPassed=len(tracks[4])>=30,overlapWindow=[rows[0]['seconds'],rows[-1]['seconds']])
    (out/'result.json').write_text(json.dumps(result,indent=2),encoding='utf8');print(json.dumps(result),flush=True)
finally:
    if s:
        try:
            if 'crl' in saved:
                write(0x4001180c,saved['odr']);write(0x40011800,saved['crl']);write(0xe0042004,saved['dbg'])
            if 'apb' in saved:write(0x40021018,saved['apb'])
            command('resume');command('shutdown')
        except Exception as error:print('TCL cleanup:',error)
        s.close()
    if worker and worker.is_alive():worker.join(timeout=12)
    if v:
        v.cmd('set-sample-rate '+str(rate));v.cmd('set-sample-time '+str(duration));v.cmd('set-trigger --reset --neg-edge 1');v.close()
    if p.poll() is None:p.terminate();p.wait(timeout=5)
    log.close()
