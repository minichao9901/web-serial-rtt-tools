"""把用户原固件写回 F103ZE 并逐字节校验（用本轮 session 的 original-flash.bin 备份）。

本脚本只做一件事：OpenOCD `flash write_image erase` + `verify_image` + 回读对比，
然后把核按 BOOT0=1 的既有配方送回原例程从复位向量开始跑。
"""
import datetime, hashlib, json, os, pathlib, re, subprocess, sys, uuid

OUT = pathlib.Path(__file__).resolve().parent
ROOT = OUT.parents[2]
NO_LOCK = '--no-lock' in sys.argv   # 作为 owner.py 的 job 运行时，锁由 owner 持有
LOCK = pathlib.Path('E:/web-etm-trace-coordination/hardware.lock')
TOKEN = uuid.uuid4().hex
OCD = 'E:/Share/env-windows/xpack-openocd-0.12.0-6/bin/openocd.exe'
SCRIPTS = 'E:/Share/env-windows/xpack-openocd-0.12.0-6/openocd/scripts'
COMMON = [OCD, '-s', SCRIPTS, '-f', 'interface/cmsis-dap.cfg', '-c', 'cmsis-dap backend usb_bulk',
          '-f', 'target/stm32f1x.cfg', '-c', 'adapter speed 1000',
          '-c', 'gdb port disabled', '-c', 'tcl port disabled', '-c', 'telnet port disabled']


def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf8')


def stamp():
    return datetime.datetime.now().astimezone().isoformat()


def tcl(path):
    p = str(pathlib.Path(path).resolve()).replace('\\', '/')
    assert not re.search(r'[{}\r\n]', p)
    return '{' + p + '}'


if LOCK.exists() and not NO_LOCK:
    raise SystemExit('hardware.lock 已存在：先确认没有别的硬件所有者，别强抢')

if not NO_LOCK:
    LOCK.mkdir()
    (LOCK / 'owner.json').write_text(json.dumps(dict(
        owner='dsh-restore-original-firmware', pid=os.getpid(), leaseToken=TOKEN,
        purpose=OUT.name, started=stamp()), ensure_ascii=False), encoding='utf8')
    save('lease-restore.json', dict(owner='dsh-restore-original-firmware', leaseToken=TOKEN, pid=os.getpid(), started=stamp()))

restored = False
try:
    cmd = ('init; reset halt; '
           'flash write_image erase ' + tcl(OUT / 'original-flash.bin') + ' 0x08000000; '
           'verify_image ' + tcl(OUT / 'original-flash.bin') + ' 0x08000000; '
           'dump_image ' + tcl(OUT / 'restored-flash.bin') + ' 0x08000000 524288; '
           'dump_image ' + tcl(OUT / 'restored-options.bin') + ' 0x1ffff800 16; '
           'reset halt; '
           'set vectors [read_memory 0x08000000 32 2]; mww 0xe000ed08 0x08000000; '
           'reg sp [lindex $vectors 0]; reg pc [lindex $vectors 1]; reg primask 0; reg faultmask 0; '
           'resume; shutdown')
    p = subprocess.run(COMMON + ['-c', cmd], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240)
    (OUT / 'restore-firmware.log').write_bytes(p.stdout)
    text = p.stdout.decode('utf8', errors='replace')
    if p.returncode:
        raise RuntimeError('openocd 退出码 %d：%s' % (p.returncode, text[-2500:]))
    actual = (OUT / 'restored-flash.bin').read_bytes()
    original = (OUT / 'original-flash.bin').read_bytes()
    assert actual == original, '回读与原备份不一致'
    options_ok = (OUT / 'restored-options.bin').read_bytes() == (OUT / 'original-options.bin').read_bytes()
    assert options_ok, '选项字节变了'
    restored = True
    result = dict(passed=True, bytes=len(actual), sha256=hashlib.sha256(actual).hexdigest(),
                  optionsUnchanged=True, time=stamp(),
                  method='openocd flash write_image erase + verify_image + dump_image (BOOT0=1 向量跳转后 resume)')
    save('restore-firmware.json', result)
    print('ORIGINAL FIRMWARE RESTORED AND VERIFIED', json.dumps(result, ensure_ascii=False), flush=True)
except Exception as error:
    save('restore-firmware.json', dict(passed=False, error=str(error), time=stamp()))
    print('RESTORE FAILED', error, flush=True)
    raise
finally:
    if NO_LOCK:
        pass
    else:
        try:
            owner = json.loads((LOCK / 'owner.json').read_text(encoding='utf-8-sig'))
            if owner.get('leaseToken') == TOKEN:
                LOCK.rename(LOCK.with_name('hardware.lock.released-restore-' + TOKEN[:8]))
        except Exception as error:
            print('lock release failed:', error, flush=True)
