import datetime
import json
import os
import pathlib
import subprocess

out = pathlib.Path(__file__).resolve().parent
env = os.environ.copy()
env.pop('PYTHONHOME', None)
env['PYTHONPATH'] = str(out / 'gdb-python')
exe = 'E:/Share/env-windows/tools/gnu_gcc/arm_gcc/mingw/bin/arm-none-eabi-gdb-py.exe'
command = [exe, '-q', '-nx', '-batch', '-ex', 'python import _gdb; print("GDB_EMBEDDED_PYTHON_AVAILABLE"); print(_gdb.VERSION)']
proc = subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20)
(out / 'gdb-python-scoped.log').write_bytes(proc.stdout)
(out / 'gdb-python-scoped.json').write_text(json.dumps(dict(command=command, cwd=str(pathlib.Path.cwd()), time=datetime.datetime.now().astimezone().isoformat(), exitCode=proc.returncode, scopedEnvironment=dict(PYTHONPATH=env['PYTHONPATH'], PYTHONHOME=None), targetAccess=False), indent=2), encoding='utf8')
print(proc.stdout.decode('utf8', errors='replace'))
print('exitCode:', proc.returncode)
