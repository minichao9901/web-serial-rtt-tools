"""Verify an extracted portable bridge with Python/Node/toolchain absent from its PATH.

VALIDATION_DIR selects a persistent run; this test does not touch SWD or flash.
"""
import hashlib,json,os,socket,subprocess,time,unittest,uuid,zipfile
from pathlib import Path
from urllib.request import Request,urlopen
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
        with urlopen(self.base) as response:html=response.read().decode()
        self.assertNotIn('id="g-etm-root"',html);self.assertNotIn('id="g-etm-serial-root"',html)
        self.assertIn('下载完整 ETM 桥包',html)
        for path in ['etm/?embedded=1','etm/app/view.js','app/site/main.js','app/app.css']:
            with urlopen(self.base+path) as response:self.assertEqual(response.status,200)
        self.assertEqual(self.run_exe('--check').returncode,0)
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

if __name__=='__main__':unittest.main()
