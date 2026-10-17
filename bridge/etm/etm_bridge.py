"""Portable ETM workbench. Runtime and assets are bundled; user data stays beside the EXE."""
import argparse,gzip,hashlib,importlib.util,json,os,socket,sys,tempfile,threading,time,uuid,webbrowser,zipfile
from pathlib import Path
from urllib.request import urlopen
from flask import send_file
from werkzeug.serving import make_server

VERSION='1.0.5'
HERE=Path(__file__).resolve().parent
for stream in (sys.stdout,sys.stderr):
    if hasattr(stream,'reconfigure'):stream.reconfigure(encoding='utf8',errors='replace')

def load_module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec)
    sys.modules[name]=module;spec.loader.exec_module(module);return module

_seed_guard=threading.Lock()
def valid_demo(folder):
    try:
        if not all((folder/name).is_file() for name in ('session.json','capture.csv','firmware.elf','sources.json','decoded.json')):return False
        for name in ('session.json','sources.json','decoded.json'):
            if not isinstance(json.loads((folder/name).read_text(encoding='utf8')),dict):return False
        return True
    except (OSError,ValueError):return False

def seed_demo(backend,records):
    # Publish a complete directory only; retain any interrupted old seed outside
    # the record list instead of deleting potentially useful user evidence.
    folder=records/'demo-spi-70-35-v1'
    with _seed_guard:
        if valid_demo(folder):return
        with tempfile.TemporaryDirectory(prefix='.etm-demo-',dir=records.parent) as temporary:
            staging=Path(temporary)/folder.name;staging.mkdir()
            with zipfile.ZipFile(backend/'demo/sample.etmrecord') as archive:
                for name in ['session.json','capture.csv','capture.kvdat','firmware.elf','sources.json','spi-validation.json']:
                    if name in archive.namelist():(staging/name).write_bytes(archive.read(name))
            (staging/'decoded.json').write_bytes(gzip.decompress((backend/'demo/decoded.json.gz').read_bytes()))
            metadata=json.loads((staging/'session.json').read_text(encoding='utf8'));metadata['name']='Demo · CPU 70 / Trace 35 MHz · 1 ms'
            (staging/'session.json').write_text(json.dumps(metadata,ensure_ascii=False),encoding='utf8')
            if not valid_demo(staging):raise ValueError('随包 Demo 不完整；原有记录未修改，请重新下载完整桥包')
            if valid_demo(folder):return  # Another workbench may share this data directory.
            if folder.exists():folder.rename(records.parent/('demo-recovery-'+uuid.uuid4().hex))
            try:staging.rename(folder)
            except FileExistsError:
                if not valid_demo(folder):raise

def package_archive(home,data):
    # Re-download the runtime without copying user captures or records.
    manifest=json.loads((home/'package-manifest.json').read_text(encoding='utf8'))
    destination=data/'exports/etm-bridge-win64.zip';destination.parent.mkdir(parents=True,exist_ok=True)
    signature=manifest['packageId']+hashlib.sha256((home/'etm.config.json').read_bytes()).hexdigest()
    stamp=destination.with_suffix('.stamp')
    if destination.exists() and stamp.exists() and stamp.read_text()==signature:return destination
    staging=destination.with_suffix('.building')
    with zipfile.ZipFile(staging,'w',zipfile.ZIP_DEFLATED) as archive:
        for item in manifest['files']:
            source=(home/item['name']).resolve()
            if not source.is_relative_to(home.resolve()) or item['name'].startswith('data/'):raise ValueError('Invalid package manifest')
            archive.write(source,'etm-bridge-kit/'+item['name'])
            if item['name']=='etm.config.json':item.update(bytes=source.stat().st_size,sha256=hashlib.sha256(source.read_bytes()).hexdigest())
        archive.writestr('etm-bridge-kit/package-manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2))
    staging.replace(destination);stamp.write_text(signature);return destination

def main():
    home=Path(sys.executable).resolve().parent if getattr(sys,'frozen',False) else HERE
    runtime=Path(sys._MEIPASS) if getattr(sys,'frozen',False) else HERE
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int);parser.add_argument('--config',type=Path,default=home/'etm.config.json')
    parser.add_argument('--data-dir',type=Path,default=home/'data');parser.add_argument('--check',action='store_true');parser.add_argument('--no-browser',action='store_true')
    args=parser.parse_args();config=json.loads(args.config.read_text(encoding='utf-8-sig')) if args.config.exists() else {}
    port=args.port if args.port is not None else int(config.get('port',8878))
    if not 1024<=port<=65535:raise ValueError('端口必须在 1024～65535 之间')
    data=args.data_dir.resolve();backend=runtime/'backend';toolbox=home/'toolbox'
    for path in [backend/'server.py',backend/'build-native/etm_decode.exe',toolbox/'index.html']:
        if not path.is_file():raise ValueError('完整包缺少文件：'+str(path)+'；请重新解压完整 ZIP')
    data.mkdir(parents=True,exist_ok=True);records=data/'records';records.mkdir(exist_ok=True)
    os.environ['WEB_ETM_RECORDS']=str(records)
    server=load_module('portable_same_origin',runtime/'serve-etm.py')
    application=server.create_application(backend,toolbox)
    # Hidden Python modules have __file__ under the bundled runtime, so select the snapshot root explicitly.
    sys.modules['decode_trace'].ROOT=backend
    package_id=json.loads((home/'package-manifest.json').read_text(encoding='utf8'))['packageId']
    app=application.app
    app.view_functions['launcher_info']=lambda:dict(protocol=1,portable=True,version=VERSION,packageId=package_id,port=port,dataDirectory=str(data))
    archive_guard=threading.Lock()
    def download_package():
        with archive_guard:return send_file(package_archive(home,data),as_attachment=True,download_name='etm-bridge-win64.zip')
    app.add_url_rule('/bridge/etm/downloads/etm-bridge-win64.zip','download_portable',download_package)
    def download_manifest():
        with archive_guard:
            archive=package_archive(home,data)
            return dict(version=VERSION,platform='windows-x64',file=archive.name,bytes=archive.stat().st_size,sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),packageId=package_id)
    app.add_url_rule('/bridge/etm/downloads/manifest.json','portable_download_manifest',download_manifest)
    print(f'ETM 桥 {VERSION}；数据目录：{data}',flush=True)
    if args.check:
        seed_demo(backend,records);print('环境预检通过；运行环境、网页与解码器完整。',flush=True);return
    url=f'http://127.0.0.1:{port}/'
    try:
        with urlopen(url+'etm-launcher.json',timeout=1) as response:existing=json.load(response)
    except Exception:existing={}
    if existing.get('portable') and existing.get('packageId')==package_id and existing.get('dataDirectory')==str(data):
        print('同版本工作台已运行：'+url+'#etm',flush=True)
        if not args.no_browser:webbrowser.open(url+'#etm')
        return
    try:http=make_server('127.0.0.1',port,application,threaded=True)
    except (OSError,SystemExit):raise ValueError(f'端口 {port} 已被占用，请修改 etm.config.json 的 port；不会停止已有服务')
    seed_demo(backend,records)
    print('KingstVIS 需开启 Socket 并使能五路通道。',flush=True)
    print('工作台：'+url+'#etm（退出按 Ctrl+C）',flush=True)
    if not args.no_browser:webbrowser.open(url+'#etm')
    try:http.serve_forever()
    except KeyboardInterrupt:pass
    finally:http.server_close()

if __name__=='__main__':
    try:main()
    except Exception as error:print('[错误] '+str(error),file=sys.stderr,flush=True);sys.exit(1)
