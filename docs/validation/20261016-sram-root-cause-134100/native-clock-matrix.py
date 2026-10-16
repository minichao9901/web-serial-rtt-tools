"""Run upstream 64KiB/10-round TCL with controlled halted-target HCLK.
Only setup, evidence paths and post-test halt differ. No target Flash writes.
"""
import pathlib,subprocess,hashlib,json,re
out=pathlib.Path(__file__).resolve().parent;source=pathlib.Path('E:/Share/github/akaLinkPro/script_test/swd/benchmark_readback.tcl')
common=['E:/sdk_env_v1.11.0/tools/openocd/openocd.exe','-s','E:/sdk_env_v1.11.0/tools/openocd/tcl']
allresults=[]
for mhz in [48,64,96]:
 dest=out/f'native-64k-v2-{mhz}mhz';dest.mkdir()
 for index in [1,2]:
  x=0x12345678^index;data=bytearray()
  for i in range(65536):
   x^=(x<<13)&0xffffffff;x^=x>>17;x^=(x<<5)&0xffffffff;data.append(x&255)
  (dest/f'test{index}.bin').write_bytes(data)
 # SYSRESETREQ establishes HSI; VECTRESET later preserves the selected RCC.
 cfgr={48:0x110400,64:0x380400,96:0x290400}[mhz]
 setup='adapter speed 1000\ninit\ncortex_m reset_config sysresetreq\nreset halt\nmww 0x40022000 0x12\nmww 0x40021000 0x00010001\nsleep 20\nmww 0x40021004 '+hex(cfgr)+'\nmww 0x40021000 0x01010001\nsleep 20\nmww 0x40021004 '+hex(cfgr|2)+'\nsleep 20\necho CONTROLLED_RCC\nmdw 0x40021000 2\ncortex_m reset_config vectreset\nadapter speed 60000\nreset halt\necho TEST_RCC\nmdw 0x40021000 2\n'
 text=source.read_text(encoding='utf8').replace('source [find interface/cmsis-dap.cfg]\ntransport select swd\nsource [find target/stm32f1x.cfg]','source {E:/Share/github/akaLinkPro/script_test/openocd_stm32f1_swd.cfg}').replace('adapter speed 60000\n\ninit',setup).replace('\nresume\n','\nhalt\n').replace('        resume\n','        halt\n')
 script=dest/'benchmark_readback.tcl';script.write_text(text,encoding='utf8')
 args=common+['-f',str(script),'-c','gdb port disabled','-c','tcl port disabled','-c','telnet port disabled']
 p=subprocess.run(args,cwd=dest,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
 (dest/'openocd.log').write_bytes(p.stdout);log=p.stdout.decode('utf8',errors='replace')
 passed=p.returncode==0 and re.search(r'Passed Rounds\s*:\s*10 / 10',log) is not None and 'FAILED' not in log
 r=dict(targetHclkMHz=mhz,exitCode=p.returncode,passed=passed,command=args,cwd=str(dest),source=str(source),sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),adaptations='Controlled RCC setup; SRAM paths only; final resume replaced by halt; original 10-round alternating-file comparison unchanged')
 for label,key in [('Write','writeKiBps'),('Read','readKiBps')]:
  match=re.search(label+r' Avg Speed\s*:\s*([\d.]+)',log)
  if match:r[key]=float(match[1])
 allresults.append(r);print(json.dumps(r),flush=True)
 (out/'native-clock-matrix-v2.json').write_text(json.dumps(allresults,indent=2),encoding='utf8')
 if not passed:raise RuntimeError('native matrix failed: '+log[-2500:])
