import pathlib,subprocess,hashlib,json
out=pathlib.Path(__file__).resolve().parent;results=[]
common=['E:/sdk_env_v1.11.0/tools/openocd/openocd.exe','-s','E:/sdk_env_v1.11.0/tools/openocd/tcl','-f','E:/Share/github/akaLinkPro/script_test/openocd_stm32f1_swd.cfg','-c','gdb port disabled','-c','telnet port disabled','-c','tcl port disabled']
src=out/'native-original-script/sram_test.bin'
for method in ['halt-before','halt-after','reset-after']:
 for n in range(3):
  name=f'native-direct-{method}-{n}';dst=out/(name+'.bin')
  cmd='init; halt; echo RCC_BEFORE; mdw 0x40021004; '+('' if method=='halt-before' else 'resume; ')+'adapter speed 60000; '+('' if method=='halt-before' else ('halt; ' if method=='halt-after' else 'reset halt; '))+'echo RCC_TEST; mdw 0x40021004; load_image {'+src.as_posix()+'} 0x20000000 bin; dump_image {'+dst.as_posix()+'} 0x20000000 20480; shutdown'
  p=subprocess.run(common+(['-d4'] if n==0 else [])+['-c',cmd],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=80)
  (out/(name+'.log')).write_bytes(p.stdout)
  r=dict(method=method,repeat=n,exitCode=p.returncode,verified=dst.exists() and dst.read_bytes()==src.read_bytes(),command=common+['-c',cmd]);results.append(r);print(json.dumps({k:v for k,v in r.items() if k!='command'}),flush=True)
(out/'native-direct.json').write_text(json.dumps(results,indent=2),encoding='utf8')
