import subprocess,json,time
from pathlib import Path
p=Path('docs/validation/20261016-cross-review-065747');names=['rtt.test.mjs','riscv-sba-async.test.mjs','cdc-mode.test.mjs','rtt-cdc-lifecycle.test.mjs','dbg-riscv-resume.test.mjs','probe-manager.test.mjs','probe-cross-tab.test.mjs','usb-device.test.mjs','spi-runner-lifecycle.test.mjs','i2c-lifecycle.test.mjs','adc-transport.test.mjs','swo-capture.test.mjs','etm-panel-retry.test.mjs']
rows=[]
for name in names:
 command=['node','tools/selftest/'+name];start=time.time()
 with (p/(name+'.log')).open('wb') as f:r=subprocess.run(command,stdout=f,stderr=subprocess.STDOUT,timeout=60)
 rows.append({'command':command,'exitCode':r.returncode,'seconds':round(time.time()-start,3),'log':str((p/(name+'.log')).resolve())})
(p/'regressions.json').write_text(json.dumps(rows,indent=2),encoding='utf-8');print(json.dumps({'entries':len(rows),'passed':sum(r['exitCode']==0 for r in rows),'failed':[r for r in rows if r['exitCode']]}))
