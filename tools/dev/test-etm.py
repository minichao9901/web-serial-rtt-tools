"""Run ETM controller/backend regressions with watchdogs and persistent evidence.

python tools/dev/test-etm.py [--portable] [--output PATH]
Requires npm ci and the developer Python requirements; never accesses SWD/LA.
"""
import argparse,datetime,json,os,subprocess,sys,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--portable',action='store_true');parser.add_argument('--output',type=Path);args=parser.parse_args()
    out=args.output or ROOT/'validation/etm'/('run-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6])
    out.mkdir(parents=True,exist_ok=True);env=dict(os.environ,PYTHONIOENCODING='utf-8');env.pop('VALIDATION_DIR',None)
    commands=[['node','--test',*[str(p.relative_to(ROOT)) for p in sorted((ROOT/'tools/selftest').glob('etm-*.test.mjs'))]],
              [sys.executable,'-m','unittest','discover','-s','tools/selftest','-p','test_etm_server.py','-v'],
              [sys.executable,'-m','unittest','discover','-s','tools/selftest','-p','test_etm_lifecycle.py','-v']]
    commands.append([sys.executable,'-m','unittest','discover','-s','tools/selftest','-p','test_etm_seed.py','-v'])
    if args.portable:commands.append([sys.executable,'-m','unittest','discover','-s','tools/selftest','-p','test_etm_portable.py','-v'])
    rows=[]
    for index,command in enumerate(commands):
        child_env=dict(env)
        if args.portable and index==len(commands)-1:child_env['VALIDATION_DIR']=str(out.resolve())
        log=out/f'{index+1}-tests.log'
        try:
            with log.open('wb') as stream:r=subprocess.run(command,cwd=ROOT,env=child_env,stdout=stream,stderr=subprocess.STDOUT,timeout=240)
            row=dict(command=command,exitCode=r.returncode,log=str(log.resolve()),timeout=False)
        except subprocess.TimeoutExpired:row=dict(command=command,exitCode=None,log=str(log.resolve()),timeout=True)
        except OSError as e:row=dict(command=command,error=str(e),exitCode=None,log=str(log.resolve()),timeout=False)
        rows.append(row);print(f'{index+1}/{len(commands)}: '+('PASS' if row.get('exitCode')==0 else 'FAIL')+' '+str(log.resolve()),flush=True)
    result=dict(revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
                dirty=bool(subprocess.check_output(['git','status','--porcelain'],cwd=ROOT)),hardwareTest='not-run (offline runner)',
                passed=all(r.get('exitCode')==0 for r in rows),commands=rows)
    (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    return 0 if result['passed'] else 1
if __name__=='__main__':sys.exit(main())
