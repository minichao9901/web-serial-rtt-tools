import importlib.util
import tempfile
import unittest
from pathlib import Path
from werkzeug.test import Client
from werkzeug.wrappers import Response
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('toolbox_etm_launcher',ROOT/'tools/dev/serve-etm.py')
launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(launcher)

class IntegratedServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();root=Path(self.tmp.name)
        self.main=root/'main';self.main.mkdir();(self.main/'index.html').write_text('toolbox')
        self.etm=root/'trace';(self.etm/'web/app').mkdir(parents=True)
        (self.etm/'web/index.html').write_text('<head><link href="/style.css"></head><body id="etm-app"><header><button id="toggle-settings">settings</button><button id="help">help</button></header><div class="record-toolbar"></div><script type="module" src="/app/view.js"></script></body>')
        (self.etm/'web/app/embedding.js').write_text('export const protocol=1;')
        (self.etm/'web/app/view.js').write_text('export const view=1;')
        (self.etm/'server.py').write_text('from flask import Flask,jsonify,request\napp=Flask(__name__,static_folder="web",static_url_path="")\n@app.get("/")\ndef index():return "old"\n@app.get("/api/elf")\ndef elf():return jsonify(download=request.script_root+"/api/record-firmware/test")\n')
        self.client=Client(launcher.create_application(self.etm,self.main),Response)
    def tearDown(self):self.tmp.cleanup()
    def get(self,path):return self.client.get(path,environ_overrides={'REMOTE_ADDR':'127.0.0.1'})
    def test_root_and_embedded_same_origin(self):
        r=self.get('/');self.assertEqual(r.text,'toolbox');r.close()
        r=self.get('/etm/?embedded=1');self.assertEqual(r.status_code,200)
        self.assertIn('data-api-base="/etm/api/"',r.text);self.assertIn('src="/etm/app/view.js"',r.text)
        self.assertEqual(r.text.count('id="toggle-settings"'),1)
        self.assertGreater(r.text.index('id="toggle-settings"'),r.text.index('class="record-toolbar"'))
        self.assertEqual(self.get('/etm/integration.json').json['protocol'],1)
    def test_etm_assets_resolve_to_trace_repository_not_process_cwd(self):
        r=self.get('/etm/app/view.js');self.assertEqual(r.status_code,200);self.assertEqual(r.text,'export const view=1;')
        self.assertIn('javascript',r.content_type);self.assertEqual(r.headers['Cache-Control'],'no-store');r.close()
    def test_download_urls_keep_mount_prefix(self):
        self.assertEqual(self.get('/etm/api/elf').json['download'],'/etm/api/record-firmware/test')
    def test_launcher_identifies_project_pair_only_to_local_clients(self):
        info=self.get('/etm-launcher.json').json
        self.assertEqual(info,dict(protocol=1,serialRoot=str(self.main.resolve()),etmRoot=str(self.etm.resolve())))
        self.assertEqual(self.client.get('/etm-launcher.json',environ_overrides={'REMOTE_ADDR':'192.0.2.5'}).status_code,403)
    def test_private_root_files_and_remote_clients_are_rejected(self):
        for path in ['/.git/config','/records/private.json','/tmp/secret.txt']:
            self.assertEqual(self.get(path).status_code,404)
        self.assertEqual(self.client.get('/',environ_overrides={'REMOTE_ADDR':'192.0.2.5'}).status_code,403)
        self.assertEqual(self.client.get('/',headers={'Host':'attacker.example:8878'},environ_overrides={'REMOTE_ADDR':'127.0.0.1'}).status_code,403)
    def test_quote_style_attribute_order_and_nested_labels(self):
        text="<html><head></head><body class='x' id='etm-app'><button class='mini' id='help'><span>help</span></button><button title='settings' id='toggle-settings'>settings</button><div data-extra='x' class='row record-toolbar other'></div><script src='/app/view.js' type='module'></script><a href='//cdn.example/x'>external</a><link href='/etm/already.css'></body></html>"
        mounted=launcher.EmbeddedDocument(text).mounted(True)
        self.assertIn('data-api-base="/etm/api/"',mounted);self.assertIn('src="/etm/app/view.js"',mounted)
        self.assertIn('href="//cdn.example/x"',mounted);self.assertIn('href="/etm/already.css"',mounted)
        self.assertIn('<span>help</span>',mounted);self.assertEqual(mounted.count('id="help"'),1)
        self.assertGreater(mounted.index('id="help"'),mounted.index('class="row record-toolbar other"'))
    def test_actual_runtime_document_embeds_all_controls_once(self):
        text=(ROOT/'bridge/etm/backend/web/index.html').read_text(encoding='utf8')
        for embedded in (False,True):
            mounted=launcher.EmbeddedDocument(text).mounted(embedded)
            for identifier in ('toggle-settings','help','start','stop','job-state'):
                self.assertEqual(mounted.count('id="'+identifier+'"'),1)
            self.assertIn('data-api-base="/etm/api/"',mounted)
            self.assertIn('src="/etm/app/view.js"',mounted)
    def test_missing_embedding_contract_is_an_explicit_error(self):
        for text in ('<head></head><body id="etm-app"></body>','<head></head><body></body>'):
            with self.assertRaises(ValueError):launcher.EmbeddedDocument(text).mounted(True)

if __name__=='__main__':unittest.main()
