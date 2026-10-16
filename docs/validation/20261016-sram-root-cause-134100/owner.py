"""Single hardware owner. Runs queued jobs serially and restores full Flash on exit."""
import datetime, hashlib, json, os, pathlib, re, subprocess, time, uuid
OUT=pathlib.Path(__file__).resolve().parent
ROOT=OUT.parents[2]
LOCK=pathlib.Path('E:/web-etm-trace-coordination/hardware.lock')
TOKEN=uuid.uuid4().hex
OCD='E:/Share/env-windows/xpack-openocd-0.12.0-6/bin/openocd.exe'
SCRIPTS='E:/Share/env-windows/xpack-openocd-0.12.0-6/openocd/scripts'
COMMON=[OCD,'-s',SCRIPTS,'-f','interface/cmsis-dap.cfg','-c','cmsis-dap backend usb_bulk','-f','target/stm32f1x.cfg','-c','adapter speed 1000','-c','gdb port disabled','-c','tcl port disabled','-c','telnet port disabled']
def save(name,value): (OUT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf8')
def stamp(): return datetime.datetime.now().astimezone().isoformat()
def tcl(path):
    p=str(pathlib.Path(path).resolve()).replace('\\','/')
    assert not re.search(r'[{}\r\n]',p)
    return '{'+p+'}'
def ocd(name,command):
    p=subprocess.run(COMMON+['-c',command],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=120)
    (OUT/(name+'.log')).write_bytes(p.stdout)
    text=p.stdout.decode('utf8',errors='replace')
    if p.returncode: raise RuntimeError(name+' failed: '+text[-3000:])
    return text
def alive(pid):
    return subprocess.run(['pwsh','-NoProfile','-Command',f'if(Get-Process -Id {int(pid)} -ErrorAction SilentlyContinue){{exit 0}}else{{exit 1}}'],stdout=subprocess.DEVNULL).returncode==0

acquired=False
backup=False
original_demcr=0
try:
    if LOCK.exists():
        owner=json.loads((LOCK/'owner.json').read_text(encoding='utf-8-sig'))
        if alive(owner['pid']): raise RuntimeError('Existing hardware owner is still alive')
        # Actual process inventory was checked immediately before this launch:
        # no OpenOCD, GDB, USB bridge or active collection worker was present.
        save('previous-lock.json',owner)
        LOCK.rename(LOCK.with_name('hardware.lock.expired-'+OUT.name+'-'+TOKEN[:6]))
    LOCK.mkdir()
    acquired=True
    save('lease.json',dict(owner='codex-f103ze-acceptance',leaseToken=TOKEN,pid=os.getpid(),started=stamp(),purpose=OUT.name))
    (LOCK/'owner.json').write_bytes((OUT/'lease.json').read_bytes())
    save('state.json',dict(stage='backing-up',pid=os.getpid(),token=TOKEN))
    cmd='init; flash probe 0; echo "ORIGINAL_DHCSR [read_memory 0xe000edf0 32 1]"; echo "ORIGINAL_DEMCR [read_memory 0xe000edfc 32 1]"; halt; reg pc; reg sp; mdw 0xe0042000 1; mdh 0x1ffff7e0 1; dump_image '+tcl(OUT/'original-flash.bin')+' 0x08000000 524288; dump_image '+tcl(OUT/'original-confirm.bin')+' 0x08000000 524288; dump_image '+tcl(OUT/'original-options.bin')+' 0x1ffff800 16; resume; shutdown'
    log=ocd('backup',cmd)
    assert re.search(r'device id = 0x[0-9a-f]*414\b',log,re.I),log
    assert 'flash size = 512 KiB' in log,log
    first=(OUT/'original-flash.bin').read_bytes()
    assert len(first)==524288 and first==(OUT/'original-confirm.bin').read_bytes()
    original_demcr=int(re.search(r'ORIGINAL_DEMCR\s+(0x[0-9a-f]+|\d+)',log,re.I)[1],0)
    backup=True
    save('backup.json',dict(passed=True,bytes=len(first),sha256=hashlib.sha256(first).hexdigest(),demcr=original_demcr,optionsSha256=hashlib.sha256((OUT/'original-options.bin').read_bytes()).hexdigest(),time=stamp()))
    save('state.json',dict(stage='ready',pid=os.getpid(),token=TOKEN,backupPassed=True))
    print('BACKUP PASSED; waiting for serial hardware jobs',flush=True)
    idle=time.monotonic()
    while time.monotonic()-idle<7200:
        jobs=sorted(OUT.glob('job-*.json'))
        pending=[p for p in jobs if not p.with_suffix('.result.json').exists() and not p.name.endswith('.result.json')]
        if not pending:
            time.sleep(.5)
            continue
        item=pending[0]; job=json.loads(item.read_text(encoding='utf8'))
        if job.get('stop'): break
        if job.get('mutates'): (OUT/'target-modified.flag').touch()
        name=item.stem
        save('state.json',dict(stage=name,command=job['command'],started=stamp(),pid=os.getpid()))
        env=os.environ.copy();env.update(job.get('env',{}))
        started=stamp()
        try:
            with (OUT/(name+'.log')).open('wb') as output:
                p=subprocess.run(job['command'],cwd=job.get('cwd',str(ROOT)),env=env,stdout=output,stderr=subprocess.STDOUT,timeout=job.get('timeout',1200))
            result=dict(exitCode=p.returncode,startedAt=started,endedAt=stamp(),command=job['command'],cwd=job.get('cwd',str(ROOT)))
        except Exception as error: result=dict(exitCode=-1,startedAt=started,endedAt=stamp(),error=str(error))
        save(item.with_suffix('.result.json').name,result)
        save('state.json',dict(stage='ready',lastJob=name,lastResult=result,pid=os.getpid()))
        print(name,json.dumps(result),flush=True)
        idle=time.monotonic()
except Exception as error:
    save('owner-error.json',dict(error=str(error),time=stamp()))
    print('OWNER ERROR',error,flush=True)
finally:
    restored=True
    if backup:
        try:
            # Tests change only RAM/RCC while halted. Never program main Flash.
            cmd='init; halt; set apb2 [lindex [read_memory 0x40021018 32 1] 0]; mww 0x40021018 [expr {$apb2 | 4}]; set apb1 [lindex [read_memory 0x4002101c 32 1] 0]; mww 0x4002101c [expr {$apb1 | 0x00800000}]; mwh 0x40005c40 3; mww 0x40010810 0x10000000; set crh [lindex [read_memory 0x40010804 32 1] 0]; mww 0x40010804 [expr {($crh & 0xfff0ffff) | 0x00060000}]; sleep 150; cortex_m reset_config sysresetreq; reset halt; mww 0xe000edfc '+str(original_demcr)+'; set vectors [read_memory 0x08000000 32 2]; mww 0xe000ed08 0x08000000; reg sp [lindex $vectors 0]; reg pc [lindex $vectors 1]; reg primask 0; reg faultmask 0; resume; sleep 500; dump_image '+tcl(OUT/'restored-flash.bin')+' 0x08000000 524288; dump_image '+tcl(OUT/'restored-options.bin')+' 0x1ffff800 16; shutdown'
            ocd('restore',cmd)
            actual=(OUT/'restored-flash.bin').read_bytes()
            assert actual==(OUT/'original-flash.bin').read_bytes()
            assert (OUT/'restored-options.bin').read_bytes()==(OUT/'original-options.bin').read_bytes()
            save('restore.json',dict(passed=True,bytes=len(actual),sha256=hashlib.sha256(actual).hexdigest(),optionsUnchanged=True,time=stamp()))
            print('ORIGINAL FLASH RESTORED AND VERIFIED',flush=True)
        except Exception as error:
            restored=False;save('restore.json',dict(passed=False,error=str(error),time=stamp()))
            print('RESTORE FAILED',error,flush=True)
    if acquired and restored and json.loads((LOCK/'owner.json').read_text())['leaseToken']==TOKEN:
        LOCK.rename(LOCK.with_name('hardware.lock.released-'+OUT.name+'-'+TOKEN[:6]))
    save('state-final.json',dict(restored=restored,backupPassed=backup,lockReleased=acquired and restored,time=stamp()))
