import hashlib,json,pathlib,tarfile,urllib.request
out=pathlib.Path(__file__).resolve().parent
sdk=out/'gdb-runtime';sdk.mkdir(exist_ok=True)
url='https://www.python.org/ftp/python/2.7.18/Python-2.7.18.tgz'
archive=sdk/'Python-2.7.18.tgz'
if not archive.exists():
    with urllib.request.urlopen(url,timeout=45) as response: archive.write_bytes(response.read())
assert hashlib.md5(archive.read_bytes()).hexdigest()=='38c84292658ed4456157195f1c9bcbe1'
with tarfile.open(archive) as tar:
    for member in tar:
        if not member.isfile() or not member.name.startswith('Python-2.7.18/Lib/'): continue
        relative=pathlib.PurePosixPath(member.name).relative_to('Python-2.7.18/Lib')
        assert '..' not in relative.parts
        target=sdk/'Lib'/relative;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(tar.extractfile(member).read())
base='https://ftp.gnu.org/gnu/gdb/gdb-10.2.tar.xz'
gdb_archive=sdk/'gdb-10.2.tar.xz'
if not gdb_archive.exists():
    with urllib.request.urlopen(base,timeout=60) as response:gdb_archive.write_bytes(response.read())
sources=[]
with tarfile.open(gdb_archive) as tar:
    for member in tar:
        if not member.isfile() or not member.name.startswith('gdb-10.2/gdb/python/lib/'): continue
        relative=pathlib.PurePosixPath(member.name).relative_to('gdb-10.2/gdb/python/lib')
        assert '..' not in relative.parts
        target=sdk/'gdb-python'/relative;target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(tar.extractfile(member).read())
        sources.append(dict(url=base,member=member.name,path=str(target),sha256=hashlib.sha256(target.read_bytes()).hexdigest()))
(sdk/'sources.json').write_text(json.dumps(dict(python=dict(url=url,sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),officialMd5Verified=True),gdb=sources),indent=2),encoding='utf8')
print('Scoped Python 2.7 standard library and GDB 10.2 modules prepared.')
