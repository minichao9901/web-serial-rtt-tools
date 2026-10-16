"""Non-destructive preparation only. Never opens a probe or writes target memory."""
import datetime
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = pathlib.Path(__file__).resolve().parent
rows = []

def run(name, args, timeout=120):
    started = datetime.datetime.now().astimezone().isoformat()
    try:
        proc = subprocess.run(args, cwd=ROOT, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, timeout=timeout)
        data, code = proc.stdout, proc.returncode
    except subprocess.TimeoutExpired as exc:
        data, code = (exc.stdout or b'') + b'\nPREFLIGHT TIMEOUT\n', 124
    (OUT / (name + '.log')).write_bytes(data)
    row = dict(name=name, command=args, cwd=str(ROOT), startedAt=started,
               endedAt=datetime.datetime.now().astimezone().isoformat(), exitCode=code)
    rows.append(row)
    (OUT / 'preflight-results.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps(row, ensure_ascii=False), flush=True)

run('make-full-dry-run', ['make', '-n', 'full_flow_f103ze'])
run('kingst-read-only-info', ['python', 'tools/la/kingst_la.py', 'info'], 35)
run('usb-enumeration', ['python', '-c', 'import json,usb.core,serial.tools.list_ports as p; print(json.dumps(dict(usb=[dict(vid=hex(d.idVendor),pid=hex(d.idProduct)) for d in usb.core.find(find_all=True)],serial=[dict(port=x.device,description=x.description,hwid=x.hwid) for x in p.comports()]),indent=2))'])
run('openocd-version', ['openocd', '--version'])
run('gdb-python', ['arm-none-eabi-gdb', '-q', '-nx', '-batch', '-ex', 'python print("GDB_PYTHON_AVAILABLE")'])
run('build-f103ze-examples', ['make', 'build-f103ze-examples'], 180)
run('build-f103ze-debug-og', ['pwsh', '-NoProfile', '-File', 'tools/target-firmware/stm32f103_dbgstress/build.ps1', '-Board', 'ze', '-Optimization', 'Og'])
run('build-f103ze-fault', ['pwsh', '-NoProfile', '-File', 'tools/target-firmware/stm32f103ze_fault/build.ps1'])

# Build SWO source using the actual ZE linker script. Existing CB acceptance
# scripts are not executed because their backup/restore sizes are CB-specific.
swo = ROOT / 'tools/target-firmware/stm32f103cb_swo_hse'
swo_out = OUT / 'swo-ze'
swo_out.mkdir(exist_ok=True)
sources = [swo / 'src' / n for n in ('clock-24mhz.c', 'main.c', 'pipeline.c', 'startup.c')]
run('build-swo-ze-24mhz', ['arm-none-eabi-gcc', '-mcpu=cortex-m3', '-mthumb', '-mfloat-abi=soft', '-O1', '-g3', '-gdwarf-4', '-fno-omit-frame-pointer', '-fno-optimize-sibling-calls', '-funwind-tables', '-ffunction-sections', '-fdata-sections', '-Wall', '-Wextra', '-nostartfiles', '-specs=nano.specs', '-specs=nosys.specs', '-Wl,--gc-sections', '-T' + str(ROOT / 'tools/target-firmware/stm32f103_dbgstress/ld/stm32f103ze.ld'), *map(str,sources), '-o', str(swo_out / 'fw.elf')])
artifacts = []
for p in [ROOT / 'tools/target-firmware' / q for q in ('stm32f103_rtt_speed/build-ze/fw.elf', 'stm32f103_rtt_seq/build-ze/fw.elf', 'stm32f103_scope/build/fw.elf', 'stm32f103_dbgstress/build/fw.elf', 'stm32f103_dbgstress/build-og/fw.elf', 'stm32f103ze_fault/build/fw.elf')] + [swo_out / 'fw.elf']:
    if p.exists():
        artifacts.append(dict(path=str(p), bytes=p.stat().st_size, sha256=hashlib.sha256(p.read_bytes()).hexdigest()))
(OUT / 'artifacts.json').write_text(json.dumps(artifacts, ensure_ascii=False, indent=2), encoding='utf8')
print('Preparation finished; real hardware tests have NOT run.', flush=True)
