"""One loopback origin for the toolbox and the sibling ETM project.

python tools/dev/serve-etm.py --etm-root ../web-etm-trace --port 8878
The ETM backend, decoder and records stay in their own repository.
"""
import argparse
import importlib.util
import mimetypes
import re
import sys
from pathlib import Path
from flask import Flask,abort,jsonify,request,send_from_directory
from werkzeug.middleware.dispatcher import DispatcherMiddleware
from werkzeug.serving import run_simple

ROOT=Path(__file__).resolve().parents[2]


def create_application(etm_root,serial_root=ROOT):
    etm_root=Path(etm_root).resolve();serial_root=Path(serial_root).resolve()
    source=etm_root/'server.py'
    if not source.is_file():raise ValueError('找不到 ETM 工程，请用 --etm-root 指定其目录')
    spec=importlib.util.spec_from_file_location('etm_toolbox_backend',source)
    backend=importlib.util.module_from_spec(spec);sys.modules[spec.name]=backend;spec.loader.exec_module(backend)
    backend.app.static_folder=str(etm_root/'web')
    if not (etm_root/'web/app/embedding.js').is_file():
        raise ValueError('ETM工程版本过旧，请同时更新两个仓库后再启动')
    # A separate backend namespace preserves standalone ETM /api and records.
    def embedded_index():
        text=(etm_root/'web/index.html').read_text(encoding='utf8')
        text=text.replace('href="/','href="/etm/').replace('src="/','src="/etm/')
        if request.args.get('embedded')=='1':
            buttons=[]
            for identifier in ('toggle-settings','help'):
                match=re.search(r'<button id="'+identifier+r'"[^>]*>.*?</button>',text)
                if match:buttons.append(match[0]);text=text.replace(match[0],'',1)
            text=text.replace('<div class="record-toolbar">','<div class="record-toolbar"><div class="embedded-actions">'+''.join(buttons)+'</div>',1)
            text=text.replace('<body id="etm-app">','<body id="etm-app" data-embedded="1" data-api-base="/etm/api/">')
            style='<style>body#etm-app[data-embedded]{min-height:0}body#etm-app[data-embedded]>header{display:none}body#etm-app[data-embedded]>.workspace{height:100vh}body#etm-app .embedded-actions{display:flex;gap:4px}</style>'
            text=text.replace('</head>',style+'</head>')
            diagnostics="""<script>window.addEventListener('error',function(e){var el=document.getElementById('job-state');if(el){el.textContent='页面初始化失败：'+e.message;el.classList.add('bad');}});window.addEventListener('unhandledrejection',function(e){var el=document.getElementById('job-state');if(el){el.textContent='页面初始化失败：'+(e.reason&&e.reason.message||e.reason);el.classList.add('bad');}});</script>"""
            text=text.replace('<script type="module"',diagnostics+'<script type="module"',1)
        else:
            text=text.replace('<body id="etm-app">','<body id="etm-app" data-api-base="/etm/api/">')
        return text
    backend.app.view_functions['index']=embedded_index
    backend.app.add_url_rule('/integration.json','toolbox_integration',lambda:jsonify(protocol=1,backend='kingst',embedded=True))
    @backend.app.after_request
    def fresh_backend(response):
        response.headers['Cache-Control']='no-store';return response
    app=Flask('serial_etm_workbench',static_folder=None)
    @app.before_request
    def local_only():
        if request.remote_addr not in ('127.0.0.1','::1'):abort(403)
    @app.route('/etm-launcher.json')
    def launcher_info():
        return jsonify(protocol=1,serialRoot=str(serial_root),etmRoot=str(etm_root))
    @app.route('/',defaults={'path':'index.html'})
    @app.route('/<path:path>')
    def static_file(path):
        # Only public files. Never expose Git metadata, backend records or temp files.
        if any(part.startswith('.') for part in Path(path).parts) or Path(path).parts[0] in ('tmp','node_modules','captures','records'):
            abort(404)
        return send_from_directory(serial_root,path)
    @app.after_request
    def fresh_main(response):
        response.headers['Cache-Control']='no-store';return response
    return DispatcherMiddleware(app,{'/etm':backend.app})


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8878)
    parser.add_argument('--etm-root',type=Path,default=ROOT.parent/'web-etm-trace')
    parser.add_argument('--serial-root',type=Path,default=ROOT)
    args=parser.parse_args()
    print(f'统一工作台：http://127.0.0.1:{args.port}/#etm',flush=True)
    run_simple('127.0.0.1',args.port,create_application(args.etm_root,args.serial_root),threaded=True,use_reloader=False)
