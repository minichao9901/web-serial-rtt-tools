import hashlib, json, os, pathlib, shutil, subprocess, time, urllib.request
out=pathlib.Path(__file__).resolve().parent;root=out.parents[2]
records=out/'etm-records';records.mkdir(exist_ok=True)
env=os.environ.copy();env['WEB_ETM_RECORDS']=str(records);env['APP']='http://127.0.0.1:8898';env['VALIDATION_DIR']=str(out);env['VALIDATION_RUN_ID']=out.name
source=pathlib.Path('E:/web-etm-trace/tools/usb_acceptance_bridge.py')
shutil.copy2(source,out/'usb_acceptance_bridge.py')
(out/'usb-bridge-source.json').write_text(json.dumps(dict(source=str(source),sha256=hashlib.sha256(source.read_bytes()).hexdigest()),indent=2),encoding='utf8')
backend_log=(out/'etm-backend.log').open('wb')
backend=subprocess.Popen(['python','-u','tools/dev/serve-etm.py','--etm-root','bridge/etm/backend','--port','8898'],cwd=root,env=env,stdout=backend_log,stderr=subprocess.STDOUT)
try:
    for _ in range(100):
        if backend.poll() is not None: raise RuntimeError('ETM backend exited')
        try:
            with urllib.request.urlopen('http://127.0.0.1:8898/etm/integration.json',timeout=1): break
        except OSError: time.sleep(.2)
    else: raise RuntimeError('ETM backend startup timeout')
    for label,script in [('audit','tools/selftest/etm-audit-hw.mjs'),('host-reset','tools/selftest/etm-host-reset-hw.mjs')]:
        log=(out/('etm-usb-'+label+'.log')).open('wb')
        bridge=subprocess.Popen(['python','-u',str(out/'usb_acceptance_bridge.py')],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
        try:
            time.sleep(1)
            assert bridge.poll() is None,'USB bridge failed'
            with (out/('etm-'+label+'.log')).open('wb') as f:
                p=subprocess.run(['node',script],cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=900)
            (out/('etm-'+label+'-exit.json')).write_text(json.dumps(dict(exitCode=p.returncode,command=['node',script],records=str(records))),encoding='utf8')
            print('ETM',label,'exit',p.returncode,flush=True)
        finally:
            if bridge.poll() is None:
                try: bridge.wait(timeout=4)
                except subprocess.TimeoutExpired: bridge.terminate();bridge.wait(timeout=5)
            log.close()
finally:
    backend.terminate()
    try: backend.wait(timeout=8)
    except subprocess.TimeoutExpired: backend.kill();backend.wait()
    backend_log.close()
