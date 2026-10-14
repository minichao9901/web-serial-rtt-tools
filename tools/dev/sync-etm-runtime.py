"""Refresh the reviewed ETM runtime snapshot; not needed by end users or ordinary builds."""
import argparse,gzip,hashlib,json,shutil,subprocess,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
FILES=['server.py','requirements.txt','tools/decode_trace.py','tools/trace_port.py','tools/tpiu_demux.py','tools/flow_analysis.py','tools/record_store.py','tools/source_export.py','tools/breakpoint_resolver.py','tools/la/kingst_la.py']
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--etm-root',required=True,type=Path);args=parser.parse_args()
    source=args.etm_root.resolve();dest=ROOT/'bridge/etm/backend';origins={}
    paths=FILES+[p.relative_to(source).as_posix() for p in (source/'web').rglob('*') if p.is_file()]
    paths+=['native/decoder.cpp','build-native/etm_decode.exe','vendor/OpenCSD-1.8.3/LICENSE']
    for name in paths:
        target=dest/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source/name,target)
        origins[name]=hashlib.sha256(target.read_bytes()).hexdigest()
    notices=set()
    for file in (source/'vendor/OpenCSD-1.8.3/decoder').rglob('*'):
        if file.is_file() and file.suffix in ('.cpp','.c','.h'):
            for line in file.read_text(encoding='utf8',errors='replace').splitlines():
                if 'copyright' in line.lower() and ('20' in line or '19' in line):notices.add(line.strip().lstrip('/* ').rstrip('*/ '))
    (dest/'vendor/OpenCSD-1.8.3/NOTICES.txt').write_text('\n'.join(sorted(notices))+'\n',encoding='utf8')
    for name in ['gcc-libs','headers','libwinpthread','winpthreads']:
        directory=Path('C:/msys64/mingw64/share/licenses')/name
        for file in directory.iterdir():
            if file.is_file():
                target=dest/'vendor/native-runtime-licenses'/name/file.name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(file,target)
    # Keep mutable records beside the portable executable, outside packaged read-only resources.
    server=dest/'server.py';text=server.read_text(encoding='utf8')
    text=text.replace('import base64\n','import base64\nimport os\n',1).replace("RECORDS = ROOT / 'records'","RECORDS = Path(os.environ.get('WEB_ETM_RECORDS', str(ROOT / 'records')))")
    server.write_text(text,encoding='utf8')
    # Windows command-line/file APIs use UTF-16; the memory manifest uses UTF-8.
    native=dest/'native/decoder.cpp';text=native.read_text(encoding='utf8')
    text=text.replace('#include <fstream>','#include <fstream>\n#ifdef _WIN32\n#include <windows.h>\n#endif',1)
    helper='''#ifdef _WIN32
static std::wstring file_path(const std::string &path) {
    const int length=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,path.data(),(int)path.size(),0,0);
    if(!length) throw std::runtime_error("Invalid UTF-8 path");
    std::wstring wide(length,0); MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,path.data(),(int)path.size(),&wide[0],length); return wide;
}
#else
static const std::string &file_path(const std::string &path) { return path; }
#endif
'''
    text=text.replace('static std::vector<uint8_t> read(',helper+'static std::vector<uint8_t> read(',1)
    text=text.replace('std::ifstream f(path.c_str(),std::ios::binary);','std::ifstream f(file_path(path).c_str(),std::ios::binary);')
    text=text.replace('int main(int argc,char **argv)', 'static int decode_main(int argc,char **argv)',1)
    text=text.replace('std::ifstream config(argv[2]);','std::ifstream config(file_path(argv[2]).c_str());',1)
    text+='''
#ifdef _WIN32
int wmain(int argc,wchar_t **wide) {
    std::vector<std::string> utf8; std::vector<char *> argv;
    for(int i=0;i<argc;i++) {
        int size=WideCharToMultiByte(CP_UTF8,0,wide[i],-1,0,0,0,0); std::string value(size,0);
        WideCharToMultiByte(CP_UTF8,0,wide[i],-1,&value[0],size,0,0); value.resize(size-1); utf8.push_back(value);
    }
    for(auto &value:utf8) argv.push_back(&value[0]);
    return decode_main(argc,argv.data());
}
#else
int main(int argc,char **argv) { return decode_main(argc,argv); }
#endif
'''
    native.write_text(text,encoding='utf8')
    for name in ['firmware/stm32h7b0_spi_trace/stable-70-35-v1/fw.elf','firmware/stm32f103_cdc_trace/fw-ze.elf']:
        target=dest/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source/name,target)
        origins[name]=hashlib.sha256(target.read_bytes()).hexdigest()
    # Carry one known demo only. No user recordings, SDKs or toolchain are copied.
    manifest=json.loads((source/'baselines/spi-70-35-v1/manifest.json').read_text(encoding='utf8'))
    folder=source/'records'/manifest['previewRecord'];demo=dest/'demo';demo.mkdir(exist_ok=True)
    with zipfile.ZipFile(demo/'sample.etmrecord','w',zipfile.ZIP_DEFLATED) as archive:
        for name in ['session.json','capture.csv','capture.kvdat','firmware.elf','sources.json','spi-validation.json']:
            if (folder/name).is_file():archive.write(folder/name,name)
    (demo/'decoded.json.gz').write_bytes(gzip.compress((folder/'decoded.json').read_bytes(),mtime=0))
    baseline=dest/'baselines/spi-70-35-v1';baseline.mkdir(parents=True,exist_ok=True)
    (baseline/'manifest.json').write_text(json.dumps(dict(version=1,id='spi-70-35-v1',profile='spi-70',record='demo-spi-70-35-v1',previewRecord='demo-spi-70-35-v1',sourcePreview=manifest['previewRecord'])),encoding='utf8')
    # Rebuild the portable wrapper against the source project's static OpenCSD libraries.
    subprocess.run(['C:/msys64/mingw64/bin/g++.exe','-std=c++11','-O2','-municode','-static','-static-libgcc','-static-libstdc++','-I'+str(source/'vendor/OpenCSD-1.8.3/decoder/include'),str(native),str(source/'build-native/vendor/OpenCSD-1.8.3/libopencsd_c_api.a'),str(source/'build-native/vendor/OpenCSD-1.8.3/libopencsd.a'),'-o',str(dest/'build-native/etm_decode.exe')],check=True)
    provenance=dict(sourceRepository='web-etm-trace',sourceRevision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip(),sourceHashes=origins,localChanges=['server.py: WEB_ETM_RECORDS redirects mutable records to portable data directory','native/decoder.cpp: UTF-16 Windows argv/file APIs for UTF-8 manifests and Unicode paths; recompiled static OpenCSD wrapper'],packagedHashes={p.relative_to(dest).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in dest.rglob('*') if p.is_file()})
    (ROOT/'bridge/etm/provenance.json').write_text(json.dumps(provenance,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(f'Runtime snapshot: {len(provenance["packagedHashes"])} files; source {provenance["sourceRevision"]}')
if __name__=='__main__':main()
