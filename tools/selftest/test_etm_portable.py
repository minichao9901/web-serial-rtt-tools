"""Verify an extracted portable bridge with Python/Node/toolchain absent from its PATH.

VALIDATION_DIR selects a persistent run; this test does not touch SWD or flash.
"""
import hashlib,json,os,socket,subprocess,time,unittest,uuid,zipfile
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
ROOT=Path(__file__).resolve().parents[2]

@unittest.skipUnless(os.name=='nt' and os.environ.get('VALIDATION_DIR'),'Windows portable validation requires VALIDATION_DIR')
class PortableTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root=Path(os.environ['VALIDATION_DIR']);cls.results=[]
        cls.extracted=cls.root/('独立 桥包-'+uuid.uuid4().hex[:6]);cls.extracted.mkdir()
        archive=Path(os.environ.get('ETM_ARCHIVE',ROOT/'bridge/etm/downloads/etm-bridge-win64.zip'))
        with zipfile.ZipFile(archive) as zip:zip.extractall(cls.extracted)
        cls.home=cls.extracted/'etm-bridge-kit';cls.exe=cls.home/'etm-bridge.exe'
        cls.env=dict(os.environ,PATH=str(Path(os.environ['SystemRoot'])/'System32')+';'+os.environ['SystemRoot'])
        for name in ['PYTHONPATH','PYTHONHOME','WEB_ETM_RECORDS']:cls.env.pop(name,None)
        cls.env['PYTHONNOUSERSITE']='1'
        with socket.socket() as socket_:socket_.bind(('127.0.0.1',0));cls.port=socket_.getsockname()[1]
        (cls.home/'etm.config.json').write_text(json.dumps(dict(port=cls.port)),encoding='utf8')
        cls.base=f'http://127.0.0.1:{cls.port}/'
        cls.output=open(cls.root/('portable-server-'+str(cls.port)+'.log'),'w',encoding='utf8')
        cls.process=subprocess.Popen([str(cls.exe),'--no-browser'],cwd=cls.root,env=cls.env,stdout=cls.output,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW)
        for attempt in range(100):
            if cls.process.poll() is not None:
                cls.output.close();raise RuntimeError('Portable bridge exited; see log')
            try:
                cls.metadata=cls.api('etm-launcher.json');break
            except Exception:time.sleep(.15)
        else:raise RuntimeError('Portable bridge startup timeout')
    @classmethod
    def tearDownClass(cls):
        cls.process.terminate();cls.process.wait(timeout=10);cls.output.close()
        (cls.root/'portable-cases.json').write_text(json.dumps(dict(home=str(cls.home),port=cls.port,environmentPATH=cls.env['PATH'],metadata=cls.metadata,results=cls.results),ensure_ascii=False,indent=2),encoding='utf8')
    @classmethod
    def api(cls,path,body=None):
        request=Request(cls.base+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})
        with urlopen(request,timeout=90) as response:return json.load(response)
    def run_exe(self,*args):
        command=[str(self.exe),*args];result=subprocess.run(command,cwd=self.root,env=self.env,capture_output=True,encoding='utf8',errors='replace',timeout=20)
        self.results.append(dict(command=command,exitCode=result.returncode,stdout=result.stdout,stderr=result.stderr));return result
    def test_independent_startup_and_assets(self):
        self.assertTrue(self.metadata['portable']);self.assertEqual(self.api('etm/integration.json')['protocol'],1)
        manifest=json.loads((self.home/'package-manifest.json').read_text(encoding='utf8'));self.assertEqual(self.metadata['version'],manifest['version'])
        with urlopen(self.base) as response:html=response.read().decode()
        self.assertNotIn('id="g-etm-root"',html);self.assertNotIn('id="g-etm-serial-root"',html)
        self.assertIn('下载完整 ETM 桥包',html)
        for path in ['etm/?embedded=1','etm/app/view.js','app/site/main.js','app/app.css']:
            with urlopen(self.base+path) as response:self.assertEqual(response.status,200)
        # The embedded page injects the toolbox driver, not ETM's standalone copy.
        # Both source mode and the default bundle must contain the control contract.
        for path in ['app/rtt/dap-webusb.js','app/site/main.js']:
            with urlopen(self.base+path) as response:driver=response.read().decode()
            for method in ['writeMemDiagnostic','recoverDebugPort']:self.assertIn(method,driver)
        self.assertEqual(self.run_exe('--check').returncode,0)
    def test_optional_firmware_and_interrupted_demo_repair_in_compiled_exe(self):
        for path in ['etm/api/default-elf','etm/api/firmware','etm/api/profile-firmware/spi-280']:
            with self.assertRaises(HTTPError) as caught:self.api(path)
            self.assertEqual(caught.exception.code,404);self.assertIn('未随',json.loads(caught.exception.read())['error'])
        isolated=self.root/'中断播种 恢复/data';folder=isolated/'records/demo-spi-70-35-v1';folder.mkdir(parents=True)
        (folder/'session.json').write_text('{broken');(folder/'user-evidence.txt').write_text('preserve')
        result=self.run_exe('--check','--data-dir',str(isolated));self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertTrue(json.loads((folder/'decoded.json').read_text(encoding='utf8'))['events'])
        backups=list(isolated.glob('demo-recovery-*'));self.assertEqual(len(backups),1);self.assertEqual((backups[0]/'user-evidence.txt').read_text(),'preserve')
    def test_reuse_and_invalid_ports(self):
        self.assertEqual(self.run_exe('--no-browser').returncode,0)
        self.assertEqual(self.run_exe('--port','70000','--check').returncode,1)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));listener.listen()
            self.assertEqual(self.run_exe('--no-browser','--port',str(listener.getsockname()[1])).returncode,1)
    def test_bat_from_other_directory(self):
        result=subprocess.run(['cmd.exe','/d','/c',str(self.home/'start-etm-bridge.bat'),'-NoBrowser'],input='\n',cwd=self.root,env=self.env,capture_output=True,encoding='utf8',errors='replace',timeout=20)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
    def test_redecode_demo_under_chinese_and_space_path(self):
        self.assertEqual(len(self.api('etm/api/records')),1)
        self.assertEqual(self.api('etm/api/records')[0]['recordKind'],'demo')
        sid='demo-spi-70-35-v1';expected=self.api('etm/api/browse/'+sid+'/overview')['summary']['instructions']
        job=self.api('etm/api/decode/'+sid,{})['job']
        for attempt in range(180):
            state=self.api('etm/api/jobs/'+job)
            if state['state'] in ['done','error']:break
            time.sleep(.2)
        self.assertEqual(state['state'],'done',state.get('error'))
        actual=self.api('etm/api/browse/'+sid+'/overview')['summary']['instructions'];self.assertEqual(actual,expected)
        self.results.append(dict(demoInstructions=actual,job=job,decodeState=state['state']))
    def test_redownload_excludes_user_records(self):
        metadata=self.api('bridge/etm/downloads/manifest.json')
        with urlopen(self.base+'bridge/etm/downloads/etm-bridge-win64.zip',timeout=90) as response:content=response.read()
        self.assertEqual(hashlib.sha256(content).hexdigest(),metadata['sha256'])
        output=self.root/'portable-redownload.zip';output.write_bytes(content)
        with zipfile.ZipFile(output) as archive:
            self.assertFalse(any('/data/' in name for name in archive.namelist()))
            manifest=json.loads(archive.read('etm-bridge-kit/package-manifest.json'))
            for item in manifest['files']:
                self.assertEqual(hashlib.sha256(archive.read('etm-bridge-kit/'+item['name'])).hexdigest(),item['sha256'])
    def test_source_snapshot_refreshes_an_already_built_index(self):
        import io
        sample=self.home/'runtime/backend/demo/sample.etmrecord'
        buffer=io.BytesIO()
        with zipfile.ZipFile(sample) as original,zipfile.ZipFile(buffer,'w',zipfile.ZIP_DEFLATED) as copy:
            sources=json.loads(original.read('sources.json'))
            for name in original.namelist():copy.writestr(name,b'{}' if name=='sources.json' else original.read(name))
        boundary='portable-source-regression'
        body=(f'--{boundary}\r\nContent-Disposition: form-data; name="capture"; filename="without-sources.etmrecord"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+buffer.getvalue()+f'\r\n--{boundary}--\r\n'.encode())
        request=Request(self.base+'etm/api/import',data=body,headers={'Content-Type':'multipart/form-data; boundary='+boundary})
        with urlopen(request,timeout=90) as response:sid=json.load(response)['record']
        job=self.api('etm/api/decode/'+sid,{})['job']
        for attempt in range(180):
            state=self.api('etm/api/jobs/'+job)
            if state['state'] in ['done','error']:break
            time.sleep(.2)
        self.assertEqual(state['state'],'done',state.get('error'))
        overview=self.api('etm/api/browse/'+sid+'/overview')
        file=next(name for name in overview['sourceFiles'] if name.endswith('/main.c') and sources.get(name))
        from urllib.parse import quote
        source_route='etm/api/browse/'+sid+'/source?file='+quote(file,safe='')
        self.assertFalse(self.api(source_route)['text'])
        elf=self.api('etm/api/record-elf/'+sid)
        saved=self.api('etm/api/source-snapshots',dict(elfId=elf['elfId'],sources={name:text for name,text in sources.items() if name in elf['sourceFiles']},complete=True))
        self.api('etm/api/sources/'+sid,dict(elfId=elf['elfId'],sourceSnapshot=saved['snapshot']))
        self.assertEqual(self.api(source_route)['text'],sources[file])
        self.results.append(dict(sourceRefreshRecord=sid,sourceFile=file,bytes=len(sources[file].encode()),indexRebuilt=True))

if __name__=='__main__':unittest.main()
