import hashlib,json,pathlib,subprocess
out=pathlib.Path(__file__).resolve().parent;root=out.parents[2]
base=root/'tools/target-firmware/stm32f103_rtt_seq';dest=out/'rtt-seq72';dest.mkdir(exist_ok=True)
source=(base/'src/main.c').read_text(encoding='utf8')
assert source.count('#define TARGET_HCLK_MHZ 96')==1
derived=source.replace('#define TARGET_HCLK_MHZ 96','#define TARGET_HCLK_MHZ 72')
(dest/'main-72.c').write_text(derived,encoding='utf8')
args=['arm-none-eabi-gcc','-mcpu=cortex-m3','-mthumb','-Os','-g3','-ffunction-sections','-fdata-sections','-fno-common','-Wall','-Wextra','-Wno-unused-parameter','-I'+str(base/'src'),'-I'+str(base/'segger_rtt'),'-T'+str(base/'ld/stm32f103ze.ld'),'-DBUFFER_SIZE_UP=32768','-nostartfiles','-specs=nano.specs','-specs=nosys.specs','-Wl,--gc-sections',str(dest/'main-72.c'),str(base/'src/startup.c'),str(base/'segger_rtt/SEGGER_RTT.c'),'-o',str(dest/'fw.elf')]
with (dest/'build.log').open('wb') as f:p=subprocess.run(args,cwd=root,stdout=f,stderr=subprocess.STDOUT)
assert p.returncode==0,(dest/'build.log').read_text(encoding='utf8',errors='replace')
(dest/'build.json').write_text(json.dumps(dict(command=args,cwd=str(root),coreMHz=72,source=str(base/'src/main.c'),sourceSha256=hashlib.sha256(source.encode()).hexdigest(),derivedSha256=hashlib.sha256((dest/'main-72.c').read_bytes()).hexdigest(),change='TARGET_HCLK_MHZ 96 -> 72 only',elfSha256=hashlib.sha256((dest/'fw.elf').read_bytes()).hexdigest()),indent=2),encoding='utf8')
print('72 MHz F103ZE sequence RTT fixture built')
