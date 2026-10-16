"""Import unchanged upstream test; redirect only output directory and tool paths.
Outer owner holds the hardware lease and restarts unchanged original Flash.
"""
import importlib.util, pathlib, json, hashlib, os
out=pathlib.Path(__file__).resolve().parent
source=pathlib.Path('E:/Share/github/akaLinkPro/script_test/sram_speed_test.py')
spec=importlib.util.spec_from_file_location('native_sram',source)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.WORKDIR=str(out/'native-original-script');pathlib.Path(m.WORKDIR).mkdir()
m.OPENOCD='E:/sdk_env_v1.11.0/tools/openocd/openocd.exe'
m.SCRIPTS='E:/sdk_env_v1.11.0/tools/openocd/tcl'
(out/'native-original-script'/'invocation.json').write_text(json.dumps(dict(source=str(source),sha256=hashlib.sha256(source.read_bytes()).hexdigest(),overrides=dict(WORKDIR=m.WORKDIR,OPENOCD=m.OPENOCD,SCRIPTS=m.SCRIPTS),boost=m.BOOST,speeds=m.SPEEDS_KHZ),indent=2),encoding='utf8')
m.main()
