"""Verify the small launcher ZIP reports missing full runtime rather than asking for project paths."""
import os,subprocess,unittest,uuid,zipfile
from pathlib import Path

@unittest.skipUnless(os.name=='nt' and os.environ.get('VALIDATION_DIR'),'Windows launcher validation requires VALIDATION_DIR')
class LauncherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root=Path(os.environ['VALIDATION_DIR'])
        cls.extracted=cls.root/('仅启动文件-'+uuid.uuid4().hex[:6])
        with zipfile.ZipFile(cls.root/'browser-downloaded-launchers.zip') as archive:archive.extractall(cls.extracted)
        cls.launcher=cls.extracted/'etm-bridge-kit/etm-launcher.ps1'
    def test_small_zip_requires_complete_runtime(self):
        result=subprocess.run(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(self.launcher),'-CheckOnly'],capture_output=True,timeout=20)
        self.assertEqual(result.returncode,1)
        self.assertFalse(self.launcher.with_name('etm-bridge.exe').exists())

if __name__=='__main__':unittest.main()
