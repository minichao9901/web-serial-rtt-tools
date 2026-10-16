import pathlib
out=pathlib.Path(__file__).resolve().parent
root=out.parents[2]
text=(root/'tools/selftest/swo-current-hw.mjs').read_text(encoding='utf8')
text=text.replace("from './cdp-lib.mjs'", "from '../../../tools/selftest/cdp-lib.mjs'")
text=text.replace("from '../../app/", "from '../../../app/")
text=text.replace("from './swo-stage-oracle.mjs'", "from '../../../tools/selftest/swo-stage-oracle.mjs'")
text=text.replace("fixture=base+'fw-24mhz.elf'", "fixture='docs/validation/20261016-f103ze-acceptance-112445-5b3aac/swo-ze/fw.elf'")
text=text.replace("out='tmp/swo-breakpoint-current-hw'", "out='docs/validation/"+out.name+"/swo-01'")
text=text.replace("http://127.0.0.1:9345", "http://127.0.0.1:9333")
text=text.replace("http://127.0.0.1:8911/", "http://127.0.0.1:8899/")
text=text.replace("F103CB acceptance", "F103ZE acceptance")
text=text.replace("writeFileSync(out+'/capture-'+report.rows.length+'.swopc',packRecording(raw,data.metadata));", "writeFileSync(out+'/capture-'+report.rows.length+'.swopc',packRecording(raw,data.metadata));writeFileSync(out+'/capture-'+report.rows.length+'.bin',raw);writeFileSync(out+'/capture-'+report.rows.length+'.png',Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));")
(out/'swo-ze.mjs').write_text(text,encoding='utf8')
print(out/'swo-ze.mjs')
