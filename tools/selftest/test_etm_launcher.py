"""Run Windows PowerShell against the actual browser-downloaded kit.

VALIDATION_DIR must name a new persistent run with browser-downloaded-kit.zip.
Does not access the board or launch a browser.
"""
import json
import os
import socket
import subprocess
import unittest
import zipfile
from pathlib import Path

@unittest.skipUnless(os.name=='nt' and os.environ.get('VALIDATION_DIR'),'需要 Windows、下载包证据目录和已运行工作台')
class LauncherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root=Path(os.environ['VALIDATION_DIR'])
        cls.extracted=cls.root/'浏览器 下载包'
        with zipfile.ZipFile(cls.root/'browser-downloaded-kit.zip') as archive:archive.extractall(cls.extracted)
        cls.launcher=cls.extracted/'etm-bridge-kit/etm-launcher.ps1'
        cls.results=[]
    @classmethod
    def tearDownClass(cls):
        (cls.root/'launcher-cases.json').write_text(json.dumps(cls.results,ensure_ascii=False,indent=2),encoding='utf8')
    def run_launcher(self,*args):
        command=['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(self.launcher),'-NoBrowser',*args]
        result=subprocess.run(command,capture_output=True,encoding='utf8',errors='replace',timeout=20)
        self.results.append(dict(command=command,exitCode=result.returncode,stdout=result.stdout,stderr=result.stderr))
        return result
    def test_downloaded_configuration_reuses_running_workbench(self):
        result=self.run_launcher('-CheckOnly')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
    def test_bat_can_be_started_from_another_directory(self):
        command=['cmd.exe','/d','/c',str(self.launcher.with_name('start-etm-bridge.bat')),'-NoBrowser']
        result=subprocess.run(command,input='\n',cwd=self.root,capture_output=True,encoding='utf8',errors='replace',timeout=20)
        self.results.append(dict(command=command,exitCode=result.returncode,stdout=result.stdout,stderr=result.stderr))
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
    def test_occupied_port_fails_without_stopping_existing_service(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));listener.listen()
            result=self.run_launcher('-CheckOnly','-Port',str(listener.getsockname()[1]))
            self.assertEqual(result.returncode,1,result.stdout+result.stderr)
            self.assertEqual(listener.getsockopt(socket.SOL_SOCKET,socket.SO_ACCEPTCONN),1)
    def test_missing_project_and_invalid_port_fail(self):
        self.assertEqual(self.run_launcher('-CheckOnly','-SerialRoot',str(self.root/'不存在 & 目录')).returncode,1)
        self.assertEqual(self.run_launcher('-CheckOnly','-Port','70000').returncode,1)

if __name__=='__main__':unittest.main()
