"""Build the Windows x64 ETM download from this repository's reviewed snapshot.

python tools/dev/build-etm-package.py
Requires build-only dependencies in bridge/etm/requirements-build.txt.
"""
import argparse,hashlib,importlib.metadata,json,os,shutil,subprocess,sys,uuid,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,default=ROOT/'bridge/etm/downloads');args=parser.parse_args()
    if os.name!='nt' or sys.maxsize<=2**32:raise ValueError('请在 Windows 64 位 Python 下构建')
    subprocess.run(['node','tools/dev/build-web.mjs','--check'],cwd=ROOT,check=True)
    snapshot=ROOT/'bridge/etm/backend'
    provenance=json.loads((ROOT/'bridge/etm/provenance.json').read_text(encoding='utf8'))
    for name,expected in provenance['packagedHashes'].items():
        if sha(snapshot/name)!=expected:raise ValueError('ETM 快照与来源清单不一致：'+name)
    work=ROOT/'tmp'/('etm-package-'+uuid.uuid4().hex[:8]);work.mkdir(parents=True)
    command=[sys.executable,'-m','PyInstaller','--noconfirm','--clean','--onedir','--name','etm-bridge','--contents-directory','runtime','--distpath',str(work/'dist'),'--workpath',str(work/'build'),'--specpath',str(work),'--add-data',str(snapshot)+';backend','--add-data',str(ROOT/'tools/dev/serve-etm.py')+';.','--paths',str(snapshot),'--paths',str(snapshot/'tools'),'--paths',str(snapshot/'tools/la'),'--collect-all','capstone','--collect-all','elftools']
    for name in ['server','werkzeug.middleware.dispatcher','decode_trace','trace_port','tpiu_demux','flow_analysis','record_store','source_export','breakpoint_resolver','kingst_la']:
        command+=['--hidden-import',name]
    for name in ['tkinter','matplotlib','numpy','scipy','IPython','pytest','PyQt6']:
        command+=['--exclude-module',name]
    command.append(str(ROOT/'bridge/etm/etm_bridge.py'))
    subprocess.run(command,cwd=ROOT,check=True)
    package=work/'dist/etm-bridge';toolbox=package/'toolbox';toolbox.mkdir()
    shutil.copyfile(ROOT/'index.html',toolbox/'index.html')
    public_files=subprocess.check_output(['git','ls-files','--','app'],cwd=ROOT,text=True).splitlines()
    # Include new app files introduced by this task before their first commit.
    public_files+=['app/gen/etm-kit.js','app/gen/etm-kit-src.js','docs/etm-integration.md']
    for name in sorted(set(public_files)):
        original=ROOT/name
        if original.is_file() and original.suffix!='.map':
            destination=toolbox/name;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(original,destination)
    # Force the validated bundle in portable mode; original module URLs still resolve for workers/assets.
    index=toolbox/'index.html';text=index.read_text(encoding='utf8').replace("window.__useWebBundle = mode === 'bundle' || (mode !== 'source' && !local);","window.__useWebBundle = mode !== 'source';")
    index.write_text(text,encoding='utf8')
    js="import {etmKitFiles} from './app/gen/etm-kit.js'; console.log(JSON.stringify(etmKitFiles().map(f=>({name:f.name.split('/').pop(),data:Buffer.from(f.data).toString('base64')}))));"
    import base64
    for file in json.loads(subprocess.check_output(['node','--input-type=module','-e',js],cwd=ROOT,text=True)):
        (package/file['name']).write_bytes(base64.b64decode(file['data']))
    licenses=package/'licenses';licenses.mkdir();shutil.copyfile(snapshot/'vendor/OpenCSD-1.8.3/LICENSE',licenses/'OpenCSD-BSD-3-Clause.txt')
    shutil.copyfile(snapshot/'vendor/OpenCSD-1.8.3/NOTICES.txt',licenses/'OpenCSD-NOTICES.txt')
    shutil.copytree(snapshot/'vendor/native-runtime-licenses',licenses/'Native-MinGW-runtime')
    python_license=Path(sys.base_prefix)/'LICENSE.txt'
    if python_license.exists():shutil.copyfile(python_license,licenses/'Python-LICENSE.txt')
    distributions={}
    for name in ['PyInstaller','Flask','Werkzeug','pyelftools','capstone','Jinja2','MarkupSafe','itsdangerous','click','blinker']:
        try:dist=importlib.metadata.distribution(name)
        except importlib.metadata.PackageNotFoundError:
            if name=='blinker':continue # Optional with the pinned Flask 2.2 release.
            raise
        distributions[name]=dist.version
        for member in dist.files or []:
            if any(key in member.name.lower() for key in ('license','copying','notice','copyright')):
                original=Path(dist.locate_file(member))
                if original.is_file():
                    destination=licenses/name/member.name;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(original,destination)
    shutil.copyfile(ROOT/'bridge/etm/provenance.json',package/'source-provenance.json')
    files=[dict(name=p.relative_to(package).as_posix(),bytes=p.stat().st_size,sha256=sha(p)) for p in sorted(package.rglob('*')) if p.is_file()]
    identity=hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest()
    manifest=dict(version='1.0.2',platform='windows-x64',packageId=identity,sourceRevision=provenance['sourceRevision'],python=sys.version,dependencies=distributions,files=files)
    (package/'package-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    args.output.mkdir(parents=True,exist_ok=True);archive=args.output/'etm-bridge-win64.zip'
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as zip:
        for file in sorted(package.rglob('*')):
            if file.is_file():zip.write(file,'etm-bridge-kit/'+file.relative_to(package).as_posix())
    download=dict(version='1.0.2',platform='windows-x64',file=archive.name,bytes=archive.stat().st_size,sha256=sha(archive),packageId=identity,sourceRevision=provenance['sourceRevision'])
    (args.output/'manifest.json').write_text(json.dumps(download,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(json.dumps(dict(package=str(package),archive=str(archive),**download),ensure_ascii=False))
if __name__=='__main__':main()
