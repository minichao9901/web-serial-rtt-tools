"""One loopback origin for the toolbox and the sibling ETM project.

python tools/dev/serve-etm.py --etm-root ../web-etm-trace --port 8878
The ETM backend, decoder and records stay in their own repository.
"""
import argparse
import importlib.util
import mimetypes
import re
import sys
from html import escape
from html.parser import HTMLParser
from urllib.parse import urlsplit
from pathlib import Path
from flask import Flask,abort,jsonify,request,send_from_directory
from werkzeug.middleware.dispatcher import DispatcherMiddleware
from werkzeug.serving import run_simple

ROOT=Path(__file__).resolve().parents[2]

class EmbeddedDocument(HTMLParser):
    """Rewrite parsed attributes; quote style/order must not affect embedding."""
    def __init__(self,text):
        super().__init__(convert_charrefs=False);self.tokens=[];self.feed(text);self.close()
    def handle_starttag(self,tag,attrs):self.tokens.append(('start',tag,attrs))
    def handle_startendtag(self,tag,attrs):self.tokens.append(('empty',tag,attrs))
    def handle_endtag(self,tag):self.tokens.append(('end',tag,None))
    def handle_data(self,text):self.tokens.append(('raw',text,None))
    def handle_entityref(self,name):self.handle_data('&'+name+';')
    def handle_charref(self,name):self.handle_data('&#'+name+';')
    def handle_comment(self,text):self.handle_data('<!--'+text+'-->')
    def handle_decl(self,text):self.handle_data('<!'+text+'>')
    @staticmethod
    def render(token):
        kind,tag,attrs=token
        if kind=='raw':return tag
        if kind=='end':return '</'+tag+'>'
        return '<'+tag+''.join(' '+key+('="'+escape(value,quote=True)+'"' if value is not None else '') for key,value in attrs)+(' />' if kind=='empty' else '>')
    def mounted(self,embedded):
        moved=[];removed=set();body=False;toolbar=False;head=False
        if embedded:
            for identifier in ('toggle-settings','help'):
                indices=[i for i,(kind,tag,attrs) in enumerate(self.tokens) if kind=='start' and tag=='button' and dict(attrs).get('id')==identifier]
                if len(indices)!=1:raise ValueError('ETM 内嵌页缺少或重复控件：'+identifier)
                start=indices[0];end=next((i for i in range(start+1,len(self.tokens)) if self.tokens[i][:2]==('end','button')),None)
                if end is None:raise ValueError('ETM 内嵌按钮标签未闭合：'+identifier)
                moved.extend(self.tokens[start:end+1]);removed.update(range(start,end+1))
        output=[]
        for i,token in enumerate(self.tokens):
            if i in removed:continue
            kind,tag,attrs=token
            if kind in ('start','empty'):
                attrs=[(key,'/etm'+value if key in ('href','src') and value and value.startswith('/') and not value.startswith(('//','/etm/')) else value) for key,value in attrs]
                if tag=='body' and dict(attrs).get('id')=='etm-app':
                    body=True;attrs=[(k,v) for k,v in attrs if k not in ('data-api-base','data-embedded')]+[('data-api-base','/etm/api/')]
                    if embedded:attrs.append(('data-embedded','1'))
                token=(kind,tag,attrs)
            if kind=='end' and tag=='head':
                head=True
                if embedded:output.append(EMBEDDED_STYLE+EMBEDDED_DIAGNOSTICS)
            output.append(self.render(token))
            if embedded and kind=='start' and tag=='div' and 'record-toolbar' in dict(attrs).get('class','').split():
                if toolbar:raise ValueError('ETM 内嵌页出现重复记录工具栏')
                toolbar=True;output.append('<div class="embedded-actions">'+''.join(map(self.render,moved))+'</div>')
        if not body or embedded and not (head and toolbar):raise ValueError('ETM 网页结构与内嵌协议不匹配，请同时更新完整桥包和主页面')
        return ''.join(output)

EMBEDDED_STYLE='<style>body#etm-app[data-embedded]{min-height:0}body#etm-app[data-embedded]>header{display:none}body#etm-app[data-embedded]>.workspace{height:100vh}body#etm-app .embedded-actions{display:flex;gap:4px}</style>'
EMBEDDED_DIAGNOSTICS="""<script>function etmPageError(message){var el=document.getElementById('job-state');if(el){el.textContent='页面发生错误：'+message;el.classList.add('bad');}}window.addEventListener('error',function(e){etmPageError(e.message);});window.addEventListener('unhandledrejection',function(e){etmPageError(e.reason&&e.reason.message||e.reason);});</script>"""


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
        return EmbeddedDocument(text).mounted(request.args.get('embedded')=='1')
    backend.app.view_functions['index']=embedded_index
    backend.app.add_url_rule('/integration.json','toolbox_integration',lambda:jsonify(protocol=1,backend='kingst',embedded=True))
    @backend.app.after_request
    def fresh_backend(response):
        response.headers['Cache-Control']='no-store';return response
    app=Flask('serial_etm_workbench',static_folder=None)
    @app.before_request
    def local_only():
        if request.remote_addr not in ('127.0.0.1','::1'):abort(403)
        if urlsplit('//'+request.host).hostname not in ('127.0.0.1','localhost','::1'):abort(403)
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
