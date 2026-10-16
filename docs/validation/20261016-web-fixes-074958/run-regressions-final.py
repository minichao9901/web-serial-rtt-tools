from pathlib import Path
import json,subprocess,os,time
out=Path('docs/validation/20261016-web-fixes-074958/regression-final');out.mkdir()
commands=json.loads(Path('docs/validation/20261016-web-review-062721/commands.json').read_text('utf-8'))
commands+=['node tools/selftest/web-review-maintenance.test.mjs','node tools/selftest/web-review-fixes.test.mjs','node tools/selftest/dap-ap-discovery.test.mjs']
env=dict(os.environ,PROBE_FIRMWARE_REPO='E:/Share/github/akaLinkPro',PYTHON='python',PYTHONIOENCODING='utf-8')
rows=[]
for command in commands:
 name=command.split('/')[-1];start=time.time()
 try:
  with (out/(name+'.log')).open('wb') as f:r=subprocess.run(command.split(),stdout=f,stderr=subprocess.STDOUT,env=env,timeout=100)
  row={'command':command,'exitCode':r.returncode,'seconds':round(time.time()-start,2)}
 except subprocess.TimeoutExpired:row={'command':command,'exitCode':None,'timeout':True}
 rows.append(row);(out/'results.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')
 if row['exitCode']!=0:print('FAIL',command,flush=True)
print(json.dumps({'total':len(rows),'passed':sum(r['exitCode']==0 for r in rows),'failed':[r['command'] for r in rows if r['exitCode']!=0]}),flush=True)
