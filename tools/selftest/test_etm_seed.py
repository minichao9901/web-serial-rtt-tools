"""Portable first-start and interrupted-seed regressions; no hardware access."""
import gzip,importlib.util,json,tempfile,unittest,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('portable_seed',ROOT/'bridge/etm/etm_bridge.py')
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
class DemoSeedTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.backend=self.root/'backend';(self.backend/'demo').mkdir(parents=True)
        self.records=self.root/'data/records';self.records.mkdir(parents=True);self.folder=self.records/'demo-spi-70-35-v1'
        with zipfile.ZipFile(self.backend/'demo/sample.etmrecord','w') as z:
            for name,data in [('session.json','{}'),('sources.json','{}'),('capture.csv','trace'),('firmware.elf','elf')]:z.writestr(name,data)
        (self.backend/'demo/decoded.json.gz').write_bytes(gzip.compress(b'{"events":[]}'))
    def tearDown(self):self.tmp.cleanup()
    def test_first_seed_and_repeat_preserve_user_changes(self):
        bridge.seed_demo(self.backend,self.records);self.assertTrue(bridge.valid_demo(self.folder))
        (self.folder/'user.txt').write_text('preserve');before=(self.folder/'session.json').read_bytes()
        bridge.seed_demo(self.backend,self.records);self.assertEqual((self.folder/'session.json').read_bytes(),before);self.assertEqual((self.folder/'user.txt').read_text(),'preserve')
    def test_failure_never_publishes_a_partial_demo_and_can_retry(self):
        (self.backend/'demo/decoded.json.gz').write_bytes(b'broken')
        with self.assertRaises(Exception):bridge.seed_demo(self.backend,self.records)
        self.assertFalse(self.folder.exists());self.assertEqual(list(self.records.iterdir()),[])
        (self.backend/'demo/decoded.json.gz').write_bytes(gzip.compress(b'{}'));bridge.seed_demo(self.backend,self.records);self.assertTrue(bridge.valid_demo(self.folder))
    def test_old_partial_demo_is_repaired_without_deleting_evidence(self):
        self.folder.mkdir();(self.folder/'session.json').write_text('{broken');(self.folder/'user.txt').write_text('evidence')
        bridge.seed_demo(self.backend,self.records);self.assertTrue(bridge.valid_demo(self.folder))
        backups=list(self.records.parent.glob('demo-recovery-*'));self.assertEqual(len(backups),1);self.assertEqual((backups[0]/'user.txt').read_text(),'evidence')
if __name__=='__main__':unittest.main()
