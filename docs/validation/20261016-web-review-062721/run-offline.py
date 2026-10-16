import subprocess,json,re,os,time
from pathlib import Path
root=Path.cwd();out=root/'docs/validation/20261016-web-review-062721'
raw=subprocess.check_output(['make','-n','test','test-swo'],text=True,encoding='utf-8',errors='replace')
commands=[]
for line in raw.splitlines():
    if re.fullmatch(r'node tools/selftest/[\w.-]+\.mjs',line) and line not in commands:commands.append(line)
extra=['node tools/selftest/bus-periodic.test.mjs','node tools/selftest/flash-data-clock.test.mjs','node tools/selftest/flash-sram-flow.test.mjs','node tools/selftest/reset-io-protocol.test.mjs','node tools/selftest/reset-io-ui.test.mjs','node tools/selftest/sram-transfer.test.mjs','node tools/selftest/sram-bench.test.mjs']
for cmd in extra:
    if cmd not in commands:commands.append(cmd)
(out/'commands.json').write_text(json.dumps(commands,indent=2),encoding='utf-8')
rows=[]
for i,cmd in enumerate(commands):
    name=cmd.split('/')[-1];log=out/('test-'+name+'.log');start=time.time()
    try:
        with log.open('wb') as f:r=subprocess.run(cmd.split(),cwd=root,stdout=f,stderr=subprocess.STDOUT,timeout=90)
        row=dict(command=cmd,exitCode=r.returncode,seconds=round(time.time()-start,2),log=str(log))
    except subprocess.TimeoutExpired:row=dict(command=cmd,exitCode=None,timeout=True,log=str(log))
    rows.append(row);(out/'tests.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
    if row.get('exitCode')!=0:print('FAIL',cmd,flush=True)
print(json.dumps(dict(total=len(rows),passed=sum(r.get('exitCode')==0 for r in rows),failed=[r['command'] for r in rows if r.get('exitCode')!=0])),flush=True)
