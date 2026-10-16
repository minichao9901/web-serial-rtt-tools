import pathlib,subprocess,json,re
out=pathlib.Path(__file__).resolve().parent;root=out.parents[2];results=[]
common=['E:/sdk_env_v1.11.0/tools/openocd/openocd.exe','-s','E:/sdk_env_v1.11.0/tools/openocd/tcl','-f','E:/Share/github/akaLinkPro/script_test/openocd_stm32f1_swd.cfg','-c','gdb port disabled','-c','tcl port disabled','-c','telnet port disabled']
for mhz in [48,64,96]:
 cfgr={48:0x110400,64:0x380400,96:0x290400}[mhz]
 cmd=f'init; cortex_m reset_config sysresetreq; reset halt; mww 0x40022000 0x12; mww 0x40021000 0x00010001; sleep 20; mww 0x40021004 {cfgr}; mww 0x40021000 0x01010001; sleep 20; mww 0x40021004 {cfgr|2}; sleep 20; mdw 0x40021004; shutdown'
 p=subprocess.run(common+['-c',cmd],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=60);(out/f'web-clock-setup-{mhz}.log').write_bytes(p.stdout);assert p.returncode==0
 with (out/f'web-compare-{mhz}mhz.log').open('wb') as f:p=subprocess.run(['node',str(out/'clock-compare-web.mjs'),str(mhz)],cwd=root,stdout=f,stderr=subprocess.STDOUT,timeout=240)
 r=json.loads((out/f'web-compare-{mhz}mhz.json').read_text());assert p.returncode==0 and r['passed'],r
 expected=(cfgr&~0xf)|10;assert r['direct']['rcc']==expected,(hex(r['direct']['rcc']),hex(expected))
 results.append(r);print(json.dumps(r),flush=True)
(out/'web-clock-matrix.json').write_text(json.dumps(results,indent=2),encoding='utf8')
