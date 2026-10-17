"""本地 ETM 页面、Kingst 采集任务、OpenCSD 解码与记录文件服务。"""
import base64
import os
import csv
import hashlib
import io
import json
import math
import re
import socket
import sys
import threading
import time
import uuid
import zipfile
from urllib.parse import urlsplit
from pathlib import Path
from contextlib import contextmanager

from flask import Flask, jsonify, request, send_file, send_from_directory, abort, g

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'tools'))
sys.path.insert(0, str(ROOT / 'tools/la'))
from decode_trace import DEFAULT_CONFIG, Image, decode_capture, export_source, decoder_config
from flow_analysis import enrich
from kingst_la import Vis, do_export, read_glitch_settings
from record_store import RecordStore
from stream_store import attach_streams, JsonLines
from decode_stream import decode_capture_stream, decode_stream, export_simplified_stream
from breakpoint_resolver import resolve_breakpoint
from source_export import simplified_html

app = Flask(__name__, static_folder='web', static_url_path='')
app.config['MAX_CONTENT_LENGTH'] = 150 * 1024 * 1024
RECORDS = Path(os.environ.get('WEB_ETM_RECORDS', str(ROOT / 'records')))
RECORDS.mkdir(exist_ok=True)
jobs = {}
CAPTURE_PROTOCOL=2
lock = threading.RLock()
stop_guard = threading.Lock()
def file_hash(path):
    # Do not cache solely by size/mtime: Windows permits both to be preserved
    # after edits. Integrity checks must still detect changed capture/ELF bytes.
    digest=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):
            digest.update(chunk)
    return digest.hexdigest()

ACTIVE = ('queued', 'starting', 'armed', 'saving', 'decoding')


@app.before_request
def local_only():
    if request.remote_addr not in ('127.0.0.1', '::1'):
        abort(403)
    if urlsplit('//'+request.host).hostname not in ('127.0.0.1','localhost','::1'):
        abort(403)
    if request.method != 'GET' and request.headers.get('Origin') not in (None, request.host_url.rstrip('/')):
        abort(403)


@app.errorhandler(Exception)
def errors(error):
    if getattr(error,'code',None)==413:
        return jsonify(error='提交内容超过本地服务的 150 MiB 限制；请更新页面并按 ELF 匹配配套源码，采集请求只传源码快照编号'),413
    return jsonify(error=str(error)), getattr(error, 'code', 400)


def directory(sid):
    if not sid or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in sid):
        raise ValueError('记录 ID 无效。')
    return RECORDS / sid


class RecordGate:
    def __init__(self):
        self.condition=threading.Condition();self.readers=0;self.writer=False;self.waiting=0
    def try_read(self):
        with self.condition:
            if self.writer or self.waiting:return False
            self.readers+=1;return True
    def end_read(self):
        with self.condition:
            self.readers-=1;self.condition.notify_all()
    def try_write(self):
        with self.condition:
            if self.writer or self.readers or self.waiting:return False
            self.writer=True;return True
    def end_write(self):
        with self.condition:self.writer=False;self.condition.notify_all()
    @contextmanager
    def write(self):
        with self.condition:
            self.waiting+=1
            try:
                self.condition.wait_for(lambda:not self.writer and not self.readers)
                self.writer=True
            finally:self.waiting-=1
        try:yield
        finally:self.end_write()

_record_locks={}
def record_guard(sid):
    with lock:return _record_locks.setdefault(sid,RecordGate())

@app.before_request
def decoded_record_guard():
    sid=(request.view_args or {}).get('sid')
    if sid and request.endpoint!='start_decode':
        guard=record_guard(sid);write=request.method!='GET'
        if not (guard.try_write() if write else guard.try_read()):
            return jsonify(error='该记录正在解码或更新索引，请等待当前任务完成后重试；原始采集保留'),409
        g.decoded_record_guard=(guard,write)
        needs_result=request.endpoint.startswith('browse_') or request.endpoint in ('get_record','attach_sources') or request.endpoint=='download' and request.view_args.get('kind') not in ('raw','kvdat','record')
        if needs_result and (directory(sid)/'decode-in-progress.json').exists():
            return jsonify(error='上次解码未完成，请重新解码；原始采集与ELF仍保留'),409

@app.teardown_request
def release_decoded_record_guard(error):
    held=g.pop('decoded_record_guard',None)
    if held:
        guard,write=held
        if write:guard.end_write()
        else:guard.end_read()


def save(sid, metadata):
    folder = directory(sid)
    folder.mkdir(exist_ok=True)
    save_json(folder/'session.json',metadata)


def save_json(path,value):
    temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    try:
        temporary.write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8')
        # Windows cannot replace a file while another request has it open.
        # Retry only the atomic rename, never repeat the operation that produced it.
        for attempt in range(50):
            try:
                with lock:temporary.replace(path)
                break
            except PermissionError:
                if attempt==49:raise
                time.sleep(.01)
    finally:
        temporary.unlink(missing_ok=True)


def load_json(path):
    with lock:return json.loads(path.read_text(encoding='utf-8'))


def meta(sid):
    value=load_json(directory(sid)/'session.json')
    if 'input' in value and value['input'] not in ('capture.csv','capture.bin'):
        raise ValueError('记录输入文件名无效，不能读取记录目录之外的文件。')
    return value

def verify_record_inputs(sid,r,metadata):
    folder=directory(sid);raw=folder/metadata.get('input','capture.csv')
    if r.get('capture',{}).get('sha256') and file_hash(raw)!=r['capture']['sha256']:
        raise ValueError('原始输入与解码结果指纹不一致，请重新解码；旧结果不作为当前执行历史')
    if r.get('elf',{}).get('sha256') and file_hash(folder/'firmware.elf')!=r['elf']['sha256']:
        raise ValueError('ELF 与解码结果指纹不一致，请重新载入匹配镜像并解码')
    if r.get('config') and metadata.get('config') and r['config']!=metadata['config']:
        raise ValueError('保存的 ETM 配置与解码结果不一致，请重新解码')


def result(sid):
    folder = directory(sid)
    decoded=folder/'decoded.json'
    if decoded.stat().st_size>384*1024*1024:
        raise ValueError('旧版整段结果超过安全内存限额，请点击单独解码，重新建立流式记录；原始记录保留')
    r = attach_streams(load_json(decoded),folder)
    if r.get('version', 1) < 3:
        enrich(r, Image(folder / 'firmware.elf'))
        save_json(folder/'decoded.json',r)
    metadata=meta(sid)
    verify_record_inputs(sid,r,metadata)
    if (folder/'etm.bin').exists() and r.get('quality') and 'processedBytes' in r['quality']:
        size=r.get('inputBytes',(folder/'etm.bin').stat().st_size)
        r['quality'].update(inputBytes=size,unprocessedBytes=max(0,size-r['quality']['processedBytes']),
                            unaccountedBytes=max(0,size-r['quality'].get('accountedBytes',0)))
    r.setdefault('targetSnapshot',metadata.get('targetSnapshot'))
    r.setdefault('captureScope',metadata.get('captureScope','unfiltered-window'))
    if 'captureStart' not in r:r['captureStart']=capture_start_info(r.get('events',[]),metadata)
    r['laFilter']=metadata.get('laFilter')
    phase_file=folder/'phase-validation.json'
    if phase_file.exists():
        phases=json.loads(phase_file.read_text(encoding='utf8'))
        selected=meta(sid).get('fraction',.25)
        canonical=hashlib.sha256((folder/'etm.bin').read_bytes()).hexdigest()
        matching=sorted(p['fraction'] for p in phases if p.get('sha')==canonical)
        groups=[]
        for fraction in matching:
            if groups and fraction-groups[-1][-1]<=.11:groups[-1].append(fraction)
            else:groups.append([fraction])
        stable=next((g for g in groups if g[0]<=selected<=g[-1]),[selected])
        width=(stable[-1]-stable[0])*r.get('physical',{}).get('half_period_ns',0)
        r['samplingValidation']=dict(phases=phases,distinctStreams=len({p['sha'] for p in phases if p.get('sha')}),
                                    selected=selected,stableWindow=[stable[0],stable[-1]],stableWindowNs=width,
                                    sensitive=width<2 or r.get('physical',{}).get('min_data_transition_distance_ns',0)<1)
    validation=folder/'spi-validation.json'
    if validation.exists():r['spiValidation']=json.loads(validation.read_text(encoding='utf8'))
    return r

def browse_store(sid):
    return RecordStore(directory(sid),lambda:result(sid))

@app.get('/api/browse/<sid>/overview')
def browse_overview(sid):
    r=browse_store(sid).overview();m=meta(sid)
    verify_record_inputs(sid,r,m)
    r.update(name=m.get('name',sid),laFilter=m.get('laFilter'),targetSnapshot=m.get('targetSnapshot'),
             targetVerified=bool(m.get('targetVerified')),captureScope=m.get('captureScope'),captureEntry=m.get('captureEntry'),recordError=m.get('error'))
    return jsonify(r)

@app.get('/api/browse/<sid>/page')
def browse_page(sid):
    return jsonify(browse_store(sid).page(request.args.get('view','events'),request.args.get('offset',0),
           request.args.get('limit',150),request.args.get('search',''),request.args.get('hideSkipped')=='1',request.args.get('fromSeq'),request.args.get('toSeq')))

@app.get('/api/browse/<sid>/window')
def browse_window(sid):
    return jsonify(browse_store(sid).window(request.args.get('fromSeq'),request.args.get('toSeq'),request.args.get('bins',1200)))

@app.get('/api/browse/<sid>/timeline')
def browse_function_timeline(sid):
    return jsonify(browse_store(sid).function_timeline(request.args.get('fromSeq'),request.args.get('toSeq'),
           request.args.get('search',''),request.args.get('hideSkipped')=='1',request.args.get('bins',1600)))

@app.get('/api/browse/<sid>/event/<int:seq>')
def browse_event(sid,seq):return jsonify(browse_store(sid).event(seq))

@app.get('/api/browse/<sid>/source')
def browse_source(sid):return jsonify(browse_store(sid).source(request.args.get('file','')))

@app.get('/api/browse/<sid>/navigate')
def browse_navigate(sid):
    pc=request.args.get('pc')
    return jsonify(browse_store(sid).navigate(request.args.get('seq',0),request.args.get('direction',1),
                   request.args.get('mode','instruction'),int(pc,0) if pc else None,request.args.get('fromSeq'),request.args.get('toSeq')))

@app.get('/api/browse/<sid>/issues')
def browse_issues(sid):return jsonify(browse_store(sid).issues(request.args.get('offset',0),request.args.get('limit',100)))


def elf_info(path):
    image = Image(path)
    flash=[s for s in image.elf.iter_segments() if s['p_type']=='PT_LOAD'
           and 0x08000000<=s['p_paddr']<0x08200000 and s['p_filesz']]
    if not flash or any(s['p_paddr']+s['p_filesz']>0x08200000 for s in flash):
        raise ValueError('当前调试支持 STM32 内部 Flash 范围 0x08000000–0x08200000 的 ELF')
    if any(s['p_type']=='PT_LOAD' and s['p_flags']&1 and s['p_filesz'] and
           not (0x08000000<=s['p_vaddr'] and s['p_vaddr']+s['p_filesz']<=0x08200000) for s in image.elf.iter_segments()):
        raise ValueError('当前验收范围限内部 Flash 执行代码；RAM/外部存储执行镜像尚未验收')
    functions={name:address for address,size,name in image.functions}
    executable=[(s['p_vaddr'],s['p_vaddr']+s['p_filesz']) for s in image.elf.iter_segments() if s['p_type']=='PT_LOAD' and s['p_flags']&1]
    return dict(name=Path(path).name, sha256=hashlib.sha256(image.bytes).hexdigest(),
                sourceFiles=sorted({file for _,file,_ in image.lines.values() if file}),
                functions=[dict(name=name,address=address,size=size,file=image.location(address)[1],line=image.location(address)[2])
                  for address,size,name in image.functions if any(a<=address<b for a,b in executable)],
                captureEntry=functions.get('spi_trace_ready',functions.get('trace_hook_entry',functions.get('trace_workload',functions.get('main')))),
                segments=[dict(address=s['p_paddr'], data=base64.b64encode(s.data()).decode())
                          for s in flash])


@app.get('/')
def index():
    return send_from_directory(ROOT / 'web', 'index.html')


@app.get('/app/shared/dbg/source.js')
def shared_source_store():
    # Serve the copy committed with this project so page behavior is stable
    # regardless of which SWO checkout happens to be beside it at runtime.
    return send_file(ROOT/'web/app/shared/dbg/source.js',mimetype='text/javascript')


@app.get('/api/status')
def status():
    v = Vis()
    try:
        rates = v.cmd('get-supported-sample-rate')
        error = v.cmd('get-last-error')
    finally:
        v.close()
    return jsonify(connected=True, rates=[int(n) for n in rates.split()], error=error,
                   captureProtocol=CAPTURE_PROTOCOL,softwareFilter=True,
                   decoder=(ROOT / 'build-native/etm_decode.exe').exists())


@app.get('/api/default-elf')
def default_elf():
    return jsonify(elf_info(firmware_path('fixture')))


@app.get('/api/firmware')
def firmware():
    return send_file(firmware_path('fixture'), as_attachment=True)


PROFILES = {
    'h743-cdc-60': ('H743 CDC · CPU 60 / TRACECLK 30 MHz · 实验档', 'stm32h743_cdc_trace/fw.elf'),
    'spi-70': ('SPI · 70 MHz CPU / 35 MHz trace · 稳定基准 v1', 'stm32h7b0_spi_trace/stable-70-35-v1/fw.elf'),
    'spi-140-r8': ('SPI · 140 MHz CPU / 35 MHz trace · 对照档', 'stm32h7b0_spi_trace/fw-140-r8.elf'),
    'spi-140': ('SPI · 140 MHz CPU / 70 MHz trace · DDR/滤波验证档', 'stm32h7b0_spi_trace/fw-140.elf'),
    'fixture': ('8 MHz CPU / 4 MHz trace · 原示例', 'stm32h7b0_etm_board_v1/fw.elf'),
    'spi-280': ('SPI · 280 MHz CPU / 70 MHz trace · 验证档', 'stm32h7b0_spi_trace/fw-280.elf'),
    'spi-280-r5': ('SPI · 280 MHz CPU / 56 MHz trace', 'stm32h7b0_spi_trace/fw-280-r5.elf'),
    'spi-280-r6': ('SPI · 280 MHz CPU / 46.667 MHz trace', 'stm32h7b0_spi_trace/fw-280-r6.elf'),
    'spi-280-r8': ('SPI · 280 MHz CPU / 35 MHz trace · 历史验收档', 'stm32h7b0_spi_trace/fw-280-r8.elf'),
}

def firmware_path(key):
    if key not in PROFILES:abort(404,description='未知固件档位，请先查询可用固件列表')
    title,path=PROFILES[key];source=ROOT/'firmware'/path
    if not source.is_file():abort(404,description='该固件档位未随当前工程或便携包提供：'+title+'；请浏览载入自己的 ELF')
    return source


@app.get('/api/profiles')
def profiles():
    return jsonify([dict(id=key,name=title,available=(ROOT/'firmware'/path).exists())
                    for key,(title,path) in PROFILES.items()])


@app.get('/api/spi-sample')
def spi_sample():
    baseline=stable_baseline()
    if baseline:return jsonify(record=baseline['record'])
    candidates=[p.parent for p in RECORDS.glob('*/spi-validation.json')]
    if not candidates:raise ValueError('尚无通过发送结构核对的 SPI 实测记录')
    folder=max(candidates,key=lambda p:meta(p.name).get('created',0))
    return jsonify(record=folder.name)


def stable_baseline():
    path=ROOT/'baselines/spi-70-35-v1/manifest.json'
    if not path.exists():return None
    data=json.loads(path.read_text(encoding='utf8'))
    if not all((directory(sid)/'decoded.json').exists() for sid in (data['record'],data['previewRecord'])):return None
    if not (directory(data['record'])/'spi-validation.json').exists():return None
    return data


@app.get('/api/stable-baseline')
def baseline_info():
    data=stable_baseline()
    return jsonify(available=bool(data),**(data or {}))


@app.get('/api/record-elf/<sid>')
def record_elf(sid):
    info=elf_info(directory(sid)/'firmware.elf')
    profile=next((key for key,(_,path) in PROFILES.items() if (ROOT/'firmware'/path).exists()
                  and hashlib.sha256((ROOT/'firmware'/path).read_bytes()).hexdigest()==info['sha256']),None)
    return jsonify(**info,elfId=sid,profile=profile,download=request.script_root+'/api/record-firmware/'+sid)


@app.get('/api/record-firmware/<sid>')
def record_firmware(sid):
    return send_file(directory(sid)/'firmware.elf',as_attachment=True)


@app.post('/api/profiles/<key>')
def select_profile(key):
    source=firmware_path(key);title=PROFILES[key][0]
    info=elf_info(source)
    sid='elf-'+uuid.uuid4().hex
    folder=directory(sid)
    folder.mkdir()
    (folder/'firmware.elf').write_bytes(source.read_bytes())
    return jsonify(**info,elfId=sid,title=title,download=request.script_root+'/api/profile-firmware/'+key)


@app.get('/api/profile-firmware/<key>')
def profile_firmware(key):
    return send_file(firmware_path(key),as_attachment=True)


@app.post('/api/elf')
def upload_elf():
    sid = 'elf-' + uuid.uuid4().hex
    folder = directory(sid)
    folder.mkdir()
    file = folder / 'firmware.elf'
    request.files['elf'].save(file)
    info = elf_info(file)
    info.update(elfId=sid, name=request.files['elf'].filename)
    return jsonify(info)


@app.post('/api/elf/<sid>/breakpoint')
def breakpoint_location(sid):
    if not sid.startswith('elf-'):
        raise ValueError('请先载入目标 ELF')
    image = Image(directory(sid) / 'firmware.elf')
    return jsonify(candidates=resolve_breakpoint(image, request.json.get('spec', '')))


def source_snapshot(elf_id,snapshot):
    if not isinstance(snapshot,str) or not re.fullmatch(r'source-[0-9a-f]{32}',snapshot):
        raise ValueError('源码快照编号无效')
    return directory(elf_id)/(snapshot+'.json')


@app.post('/api/source-snapshots')
def upload_source_snapshot():
    body=request.get_json()
    elf_id=body['elfId']
    image=Image(directory(elf_id)/'firmware.elf')
    allowed={file for _,file,_ in image.lines.values() if file}
    snapshot=body.get('snapshot') or 'source-'+uuid.uuid4().hex
    path=source_snapshot(elf_id,snapshot)
    with lock:
        saved=json.loads(path.read_text(encoding='utf-8')) if path.exists() else dict(complete=False,sources={})
        if saved['complete']:
            raise ValueError('已完成的源码快照不可改写；请创建新的快照')
        sources=body.get('sources',{})
        if not isinstance(sources,dict) or any(name not in allowed or not isinstance(text,str) for name,text in sources.items()):
            raise ValueError('只接受此 ELF 的 DWARF 引用路径及对应源码文本')
        saved['sources'].update(sources)
        saved['complete']=bool(body.get('complete'))
        size=sum(len(text.encode('utf-8')) for text in saved['sources'].values())
        if size>150*1024*1024:
            raise ValueError('所需源码快照超过 150 MiB；请检查 ELF 和源码目录')
        temporary=path.with_suffix('.tmp')
        temporary.write_text(json.dumps(saved,ensure_ascii=False),encoding='utf-8')
        temporary.replace(path)
    return jsonify(snapshot=snapshot,complete=saved['complete'],files=len(saved['sources']),bytes=size)


def read_source_snapshot(elf_id,snapshot):
    saved=load_json(source_snapshot(elf_id,snapshot))
    if not saved.get('complete'):
        raise ValueError('源码快照尚未上传完成')
    return saved['sources']


@app.get('/api/records')
def records():
    rows = []
    demo=(stable_baseline() or {}).get('previewRecord')
    for file in RECORDS.glob('*/session.json'):
        row = meta(file.parent.name)
        sid=file.parent.name
        rows.append({**row, 'id':sid,'recordKind':record_kind(sid,row,demo),'decoded': (file.parent / 'decoded.json').exists() and not (file.parent/'decode-in-progress.json').exists()})
    return jsonify(sorted(rows, key=lambda r: r.get('created', 0), reverse=True))


def record_kind(sid,row,demo=None):
    if sid==demo:return 'demo'
    if row.get('libraryOrigin')=='validation':return 'experiment'
    if row.get('libraryOrigin')=='user' or row.get('configBasis')=='user-provided':return 'user'
    if row.get('captureScope')=='externally-configured-window':return 'user'
    if row.get('captureScope')=='business-unfiltered-window' and row.get('captureEntry') is not None:return 'user'
    return 'experiment'


@app.get('/api/records/<sid>')
def get_record(sid):
    r=result(sid)
    if r.get('streamed',{}).get('schema')==2:
        r={k:v for k,v in r.items() if k not in ('events','packets','elements','sources')}
    return jsonify(r)


@app.post('/api/sources/<sid>')
def attach_sources(sid):
    r = result(sid)
    body=request.get_json()
    if body.get('elfId') and hashlib.sha256((directory(body['elfId'])/'firmware.elf').read_bytes()).hexdigest()!=r.get('elf',{}).get('sha256'):
        raise ValueError('配套源码来自不同 ELF，请为当前记录载入匹配的 ELF 和源码。')
    provided = read_source_snapshot(body['elfId'],body['sourceSnapshot']) if body.get('sourceSnapshot') else body['sources']
    for file in r['sources']:
        matches = [text for name, text in provided.items() if file.replace('\\', '/')==name.replace('\\','/') or file.replace('\\', '/').endswith('/' + name.replace('\\', '/'))]
        if len(matches) == 1:
            r['sources'][file] = matches[0]
    folder = directory(sid)
    save_json(folder/'sources.json',r['sources'])
    if r.get('streamed',{}).get('schema')!=2:save_json(folder/'decoded.json',r)
    return jsonify(sources=r['sources'])


@app.get('/api/jobs/<jid>')
def job_state(jid):
    with lock:
        if jid not in jobs:abort(404,description='任务已不存在；本地桥可能已重启，请检查 LA 状态后重新采集')
        job = jobs[jid]
        return jsonify({k: v for k, v in job.items() if not k.startswith('_')})


def prune_jobs(now=None):
    # Keep active tasks and failed LA cleanup leases regardless of age/count.
    # Records and raw evidence are independent and are never removed here.
    now=time.time() if now is None else now
    with lock:
        terminal=sorted((j for j in jobs.values() if j['state'] not in ACTIVE and not j.get('cleanupPending') and not j.get('_socket')),key=lambda j:j.get('_finished',now),reverse=True)
        for index,job in enumerate(terminal):
            if index>=256 or now-job.get('_finished',now)>86400:jobs.pop(job['id'],None)

def new_job(sid, state, kind='capture'):
    jid = uuid.uuid4().hex
    with lock:
        prune_jobs()
        jobs[jid] = dict(id=jid, record=sid, state=state, kind=kind, error=None)
    return jid


def change(jid, **fields):
    with lock:
        jobs[jid].update(fields)
        if fields.get('state') and fields['state'] not in ACTIVE:jobs[jid]['_finished']=time.time()

def record_failure(sid,error,stage):
    try:
        m=meta(sid);m.update(error=str(error),errorStage=stage);save(sid,m)
    except Exception:pass


def capture_start_info(events,metadata):
    entry=metadata.get('captureEntry')
    if entry is None:return None
    first=next((e for e in events if e.get('kind')=='instruction'),None)
    present=any(e.get('kind')=='instruction' and e.get('pc')==entry for e in events)
    return dict(selectedPC=entry,firstRecoveredPC=first.get('pc') if first else None,
                entryRecovered=present,firstMatchesEntry=bool(first and first.get('pc')==entry))


def decode_job(jid,sid):
    change(jid,state='decoding')
    try:
        with record_guard(sid).write():
            marker=directory(sid)/'decode-in-progress.json'
            save_json(marker,dict(started=time.time(),job=jid))
            summary=_decode_job(jid,sid)
            if summary is not None:marker.unlink(missing_ok=True)
        if summary is not None:change(jid,state='done',summary=summary)
    except (Exception,SystemExit) as error:
        record_failure(sid,error,'decode');change(jid,state='error',error=str(error))

def _decode_job(jid, sid):
    try:
        change(jid, state='decoding')
        folder, m = directory(sid), meta(sid)
        sources = load_json(folder/'sources.json') if (folder / 'sources.json').exists() else None
        raw=folder/m['input']
        streamed=bool(raw.suffix.lower()=='.bin' or m.get('seconds',0)>.02 or raw.stat().st_size>50*1024*1024)
        if streamed:
            if raw.suffix.lower()=='.csv':
                r=decode_capture_stream(raw,folder/'firmware.elf',folder,m['config'],sources,
                    fraction=m.get('fraction',.25),clock=m.get('clock',0),data=m.get('data',[1,2,3,4]),glitch_ns=m.get('glitchNs',0))
            else:
                r=decode_stream(raw.read_bytes(),folder/'firmware.elf',folder,m['config'],sources)
                r['capture']={'name':raw.name,'sha256':file_hash(raw)}
        else:
            r = decode_capture(raw, folder / 'firmware.elf', folder, m['config'], sources,
                               fraction=m.get('fraction', .25), clock=m.get('clock', 0), data=m.get('data', [1, 2, 3, 4]),glitch_ns=m.get('glitchNs',0))
        r['targetSnapshot']=m.get('targetSnapshot')
        r['captureScope']=m.get('captureScope','unfiltered-window')
        r['captureStart']=capture_start_info(attach_streams(dict(r),folder)['events'],m)
        r['laFilter']=m.get('laFilter')
        save_json(folder/'decoded.json',r)

        if 'sources' in r:save_json(folder/'sources.json',r['sources'])
        m['summary'] = r['summary']
        m.pop('error',None);m.pop('errorStage',None);m['decodeStatus']='done'
        save(sid, m)
        if streamed:browse_store(sid).ensure()
        return r['summary']
    except (Exception,SystemExit) as error:
        record_failure(sid,error,'decode')
        change(jid, state='error', error=str(error))


@app.post('/api/decode/<sid>')
def start_decode(sid):
    meta(sid)
    with lock:
        active=next((j for j in jobs.values() if j['record']==sid and j['state'] in ACTIVE),None)
        if active:
            if active.get('kind')=='decode':return jsonify(job=active['id'],record=sid)
            raise ValueError('本记录仍在采集中，完成后再解码。')
        jid = new_job(sid, 'queued',kind='decode')
    try:threading.Thread(target=decode_job, args=(jid, sid), daemon=True).start()
    except Exception as error:
        change(jid,state='error',error=str(error));raise
    return jsonify(job=jid, record=sid)


@app.post('/api/import')
def import_record():
    sid = 'record-' + uuid.uuid4().hex
    folder = directory(sid)
    folder.mkdir()
    uploaded = request.files['capture']
    if uploaded.filename.lower().endswith('.etmrecord'):
        with zipfile.ZipFile(uploaded.stream) as archive:
            if not {'session.json','firmware.elf'}.issubset(archive.namelist()):raise ValueError('记录包缺少 session.json 或配套 ELF。')
            m = json.loads(archive.read('session.json'))
            if m['input'] not in ('capture.csv', 'capture.bin'):
                raise ValueError('记录格式无效。')
            if m['input'] not in archive.namelist():raise ValueError('记录包缺少原始波形，不能作为完整记录导入。')
            m['config']=decoder_config(m.get('config'))
            for name in ('session.json', m['input'], 'firmware.elf', 'sources.json', 'capture.kvdat'):
                if name in archive.namelist():
                    info = archive.getinfo(name)
                    if info.file_size > 150 * 1024 * 1024:
                        raise ValueError('记录成员过大。')
                    (folder / name).write_bytes(archive.read(name))
    else:
        suffix = Path(uploaded.filename).suffix.lower()
        if suffix not in ('.csv', '.bin'):
            raise ValueError('请选择 CSV、解复用后的 ETM BIN 或 .etmrecord。')
        filename = 'capture' + suffix
        uploaded.save(folder / filename)
        if 'elf' not in request.files:
            raise ValueError('导入原始采集需要配套 ELF。')
        request.files['elf'].save(folder / 'firmware.elf')
        config = json.loads(request.form.get('config', '{}'))
        m = dict(input=filename, name=uploaded.filename, config=decoder_config(config),
                 configBasis='user-provided', fraction=float(request.form.get('fraction', .25)),
                 glitchNs=float(request.form.get('glitchNs',0)) if suffix=='.csv' else 0)
        sources = {}
        for file in request.files.getlist('sources'):
            sources[file.filename.replace('\\', '/')] = file.read().decode('utf-8-sig', 'replace')
        (folder / 'sources.json').write_text(json.dumps(sources), encoding='utf-8')
    m.update(created=time.time(),libraryOrigin='user')
    elf_info(folder / 'firmware.elf')
    save(sid, m)
    return jsonify(record=sid)


def capture_job(jid, sid, options):
    v = None
    started=False
    try:
        with lock:
            if jobs[jid].get('_stopped'):return
        v = Vis()
        rates = [int(n) for n in v.cmd('get-supported-sample-rate').split()]
        if options['rate'] not in rates:
            raise ValueError('LA 不支持所选采样率。')
        v.cmd(f"set-sample-rate {options['rate']}")
        v.cmd(f"set-sample-time {options['seconds']}")
        v.cmd(f"set-threshold-voltage {options['threshold']}")
        # D0 stays high during formatter idle; a clock edge alone would trigger before CPU resumes.
        v.cmd(f"set-trigger --reset --neg-edge {options['data'][0]}" if options['sync'] else 'set-trigger --reset')
        # Cancellation and start send are one transition: stop cannot precede
        # a later start command and accidentally leave the analyser armed.
        with lock:
            if jobs[jid].get('_stopped'):return
            change(jid,state='starting')
            v.sock.settimeout(5)
            v.sock.sendall(b'start');started=True
            v.sock.settimeout(60)
            change(jid, state='armed', started=time.time(), _socket=v.sock)
        raw = b''
        while True:
            try:
                chunk = v.sock.recv(4096)
                if not chunk:
                    break
                raw += chunk
                if raw.startswith(b'ACK') or raw.startswith(b'NAK'):
                    break
            except socket.timeout:
                with lock:
                    stopped = jobs[jid].get('_stopped', False)
                if stopped:
                    break
                raise ValueError('LA 未触发或采集超时。')
            except OSError:
                with lock:
                    stopped = jobs[jid].get('_stopped', False)
                if stopped:
                    break
                raise
        if raw.startswith(b'NAK'):
            raise ValueError(raw.decode('utf-8', 'replace'))
        # stop can consume the start reply: always close and reconnect before export.
        v.close()
        with lock:
            stopped = jobs[jid].get('_stopped', False)
        if stopped:
            for _ in range(100):
                with lock:
                    confirmed = jobs[jid].get('_stop_confirmed', False)
                if confirmed:
                    break
                time.sleep(.1)
            if not confirmed:
                raise ValueError('停止未获得设备空闲回读确认，原始任务保留。')
            # An idle analyser after stop does not prove its buffer belongs to
            # this acquisition. Never relabel a previous capture as new data.
            record_failure(sid,'采集已取消；没有导出或解码可能属于上次采集的 LA 缓存','capture')
            change(jid,state='cancelled')
            return
        if not raw.startswith(b'ACK'):
            raise ValueError('LA 连接关闭或应答不完整；未确认本次采集完成，不导出缓存。')
        v = Vis()
        change(jid, state='saving')
        folder = directory(sid)
        do_export(v, str((folder / 'capture.csv').resolve()), [options['clock']] + options['data'])
        depth = v.cmd('get-actual-sample-depth')
        span = v.cmd('get-actual-sample-time')
        m = meta(sid)
        m.update(actualDepth=depth, actualTime=span, stopped=stopped,captureStatus='saved')
        try:
            m['laFilter']=read_glitch_settings(folder/'capture.kvdat',options['rate'])
        except Exception as error:
            m['laFilter']=dict(basis='unknown',error=str(error))
        save(sid, m)
        if options['decode']:
            decode_job(jid, sid)
        else:
            change(jid, state='done')
    except (Exception,SystemExit) as error:
        record_failure(sid,error,'capture')
        cleanup_error=None
        if started:
            try:stop_owned_la(jid)
            except (Exception,SystemExit) as cleanup:cleanup_error=str(cleanup)
        change(jid, state='error', error=str(error),cleanupPending=bool(cleanup_error),cleanupError=cleanup_error)
    finally:
        try:
            if v:v.close()
        finally:
            with lock:jobs[jid].pop('_socket',None)


@app.post('/api/capture')
def start_capture():
    o = request.get_json()
    elf_id=o.get('elfId') if isinstance(o,dict) else None
    if not isinstance(elf_id,str) or not re.fullmatch(r'elf-[0-9a-f]{32}',elf_id):
        raise ValueError('联动采集必须先载入明确的 ELF；不会自动绑定示例固件。')
    elf=directory(elf_id)/'firmware.elf'
    if not elf.is_file():
        raise ValueError('载入的 ELF 已失效，请重新选择固件。')
    elf_info(elf)
    source_files = read_source_snapshot(o['elfId'],o['sourceSnapshot']) if o.get('sourceSnapshot') else o.get('sources', {})
    o = dict(rate=int(o.get('rate', 100000000)), seconds=float(o.get('seconds', .01)),
             threshold=float(o.get('threshold', 1.65)), sync=bool(o.get('sync')),
             decode=bool(o.get('decode')), clock=int(o.get('clock', 0)),
             data=[int(n) for n in o.get('data', [1, 2, 3, 4])],
             config=decoder_config(o.get('config', {})), elfId=o.get('elfId'),sourceSnapshot=o.get('sourceSnapshot'),
             libraryOrigin='validation' if o.get('libraryOrigin')=='validation' else 'user',
             targetVerified=bool(o.get('targetVerified')), fraction=float(o.get('fraction', .25)),glitchNs=float(o.get('glitchNs',0)),
             targetSnapshot=o.get('targetSnapshot'),captureScope=o.get('captureScope','unfiltered-window'),captureEntry=o.get('captureEntry'))
    if not math.isfinite(o['glitchNs']) or not 0<=o['glitchNs']<=100:
        raise ValueError('软件滤波须为 0～100 ns，0 表示关闭')
    if not 0 < o['fraction'] < 1:
        raise ValueError('取样位置必须介于 0 和 1。')
    if not math.isfinite(o['threshold']) or not -4<=o['threshold']<=4:
        raise ValueError('阈值必须是 -4～4 V 的有限数值。')
    if not (0 < o['seconds'] <= 2 and 0 < o['rate'] <= 500000000 and o['seconds']*o['rate'] <= 100000000):
        raise ValueError('初版采集深度上限 1 亿样本，时间上限 2 秒。')
    if len(o['data']) != 4 or len(set([o['clock']] + o['data'])) != 5 or any(n < 0 or n > 15 for n in [o['clock']] + o['data']):
        raise ValueError('请配置五个不同的 CH0~15 通道。')
    with lock:
        if any(j.get('kind','capture')=='capture' and (j['state'] in ('queued', 'starting', 'armed', 'saving') or j.get('cleanupPending')) for j in jobs.values()):
            raise ValueError('已有采集任务进行中。')
        sid = 'capture-' + uuid.uuid4().hex
        jid = new_job(sid, 'queued')
    try:
        folder = directory(sid);folder.mkdir()
        (folder / 'firmware.elf').write_bytes(elf.read_bytes())
        if source_files:save_json(folder/'sources.json',source_files)
        elif (directory(o['elfId'])/'sources.json').exists():
            (folder/'sources.json').write_bytes((directory(o['elfId'])/'sources.json').read_bytes())
        name=(o.get('targetSnapshot') or {}).get('name') or o['config'].get('protocol','ETMv4')
        save(sid, dict(name=name+' · '+time.strftime('%Y-%m-%d %H:%M:%S'), created=time.time(),
                       input='capture.csv', **o, configBasis='SWD snapshot' if o['targetVerified'] else 'provided trace configuration'))
        threading.Thread(target=capture_job, args=(jid, sid, o), daemon=True).start()
    except Exception as error:
        change(jid,state='error',error=str(error));raise
    return jsonify(job=jid, record=sid)


@app.post('/api/stop/<jid>')
def stop_capture(jid):
    with lock:
        if jid not in jobs:abort(404,description='任务记录已丢失，未对 LA 发送停止命令；请在 KingstVIS 停止后重新连接本地桥')
        job=jobs[jid]
        if job.get('kind','capture')!='capture':raise ValueError('解码任务不能向 LA 发送停止命令。')
        if job['state']=='queued':
            job.update(state='cancelled',_stopped=True,_stop_confirmed=True)
            record_failure(job['record'],'采集启动前已取消','capture')
            return jsonify(stopped=True,cancelled=True)
        if job['state'] in ('done','cancelled','error') and not job.get('cleanupPending'):
            return jsonify(stopped=True,alreadyFinished=True)
        if job['state'] not in ('starting', 'armed') and not job.get('cleanupPending'):
            raise ValueError('当前没有等待触发或采集中的 LA 任务。')
        job['_stopped'] = True
    stop_owned_la(jid)
    return jsonify(stopped=True)


def stop_owned_la(jid):
    with stop_guard:
        with lock:
            if jobs[jid].get('_stop_confirmed'):return
        return stop_owned_la_locked(jid)


def stop_owned_la_locked(jid):
    v = Vis()
    try:
        try:
            v.cmd('stop', timeout=5)
        except (OSError, socket.timeout):
            # Some VIS versions abort both connections while swallowing start.
            # Verify idle on a fresh connection instead of treating send as ACK.
            pass
    finally:
        v.close()
    confirmed = False
    for _ in range(10):
        v = Vis()
        try:
            v.cmd('set-trigger --reset', timeout=3)
            confirmed = True
            break
        except (OSError, RuntimeError, socket.timeout):
            time.sleep(.1)
        finally:
            v.close()
    if not confirmed:
        raise ValueError('LA 停止后的空闲状态尚未确认。')
    with lock:
        jobs[jid]['_stop_confirmed'] = True
        jobs[jid]['cleanupPending'] = False
        capture_socket = jobs[jid].get('_socket')
    if capture_socket:
        try:
            capture_socket.shutdown(socket.SHUT_RD)
        except OSError:
            pass
    # Closing the receive side wakes start even when VIS swallowed its reply.


@app.get('/api/download/<sid>/<kind>')
def download(sid, kind):
    folder = directory(sid)
    if kind in ('raw', 'kvdat'):
        m = meta(sid)
        file = folder / (m['input'] if kind == 'raw' else 'capture.kvdat')
        return send_file(file, as_attachment=True)
    if kind == 'record':
        m = meta(sid)
        if not (folder/m['input']).is_file() or not (folder/'firmware.elf').is_file():
            raise ValueError('本记录尚无本次原始波形或配套 ELF，不能导出为完整记录包。')
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name in ('session.json', m['input'], 'firmware.elf', 'sources.json', 'capture.kvdat'):
                if (folder / name).exists():
                    archive.write(folder / name, name)
        buffer.seek(0)
        return send_file(buffer, as_attachment=True, download_name=sid + '.etmrecord')
    r = result(sid)
    if kind in ('source','simplified','simplified-html','csv') and request.args.get('fromSeq') is not None:
        start=int(request.args['fromSeq']);end=int(request.args.get('toSeq',len(r['events'])-1))
        if start<0 or end<start:raise ValueError('导出序号区间无效')
        if r.get('streamed',{}).get('schema')==2 and end-start>=200000:
            raise ValueError('本导出格式请选取不超过 20 万条记录的局部区间；整段可导出简化源码 .c')
        r={**r,'events':[e for e in r['events'] if start<=e['seq']<=end],'exportRange':dict(start=start,end=end)}
    if r.get('streamed',{}).get('schema')==2 and request.args.get('fromSeq') is None:
        if kind=='simplified':
            path=folder/('export-simplified-'+uuid.uuid4().hex+'.c');export_simplified_stream(folder,path)
            response=send_file(path,as_attachment=True,download_name='etm-simplified.c',mimetype='text/plain; charset=utf-8')
            response.call_on_close(lambda:path.unlink(missing_ok=True))
            return response
        if kind in ('source','simplified-html','csv'):
            raise ValueError('长记录请先在图中选择执行区间再导出，或导出整段简化源码 .c')
    if kind=='simplified-html':
        return send_file(io.BytesIO(simplified_html(r).encode('utf-8')),as_attachment=True,download_name='etm-simplified.html',mimetype='text/html; charset=utf-8')
    if kind in ('source', 'simplified'):
        text = export_source(r, kind == 'simplified')
        return send_file(io.BytesIO(text.encode('utf-8')), as_attachment=True,
                         download_name='etm-' + kind + '.c', mimetype='text/plain; charset=utf-8')
    if kind == 'json' and r.get('streamed',{}).get('schema')==2:
        return send_file(folder/'decoded.json',as_attachment=True,download_name='decoded.json')
    if kind == 'json':
        return send_file(io.BytesIO(json.dumps(r, ensure_ascii=False).encode('utf-8')), as_attachment=True, download_name='decoded.json')
    if kind == 'csv':
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(['seq', 'kind', 'pc', 'executed', 'executionState', 'instruction', 'function', 'file', 'line', 'event'])
        for e in r['events']:
            writer.writerow([e['seq'], e['kind'], hex(e['pc']) if 'pc' in e else '', e.get('executed', ''),
                             e.get('executionState', ''),
                             (e.get('mnemonic', '') + ' ' + e.get('operands', '')).strip(),
                             e.get('function', ''), e.get('file', ''), e.get('line', ''), e.get('text', '')])
        return send_file(io.BytesIO(buffer.getvalue().encode('utf-8-sig')), as_attachment=True,
                         download_name='etm-execution.csv')
    raise ValueError('未知导出类型。')


def samples():
    for name, stem in [('500m', 'trace-20261011-000319'), ('100m', 'trace-20261011-000616')]:
        if not all((ROOT / f'captures/{stem}.{ext}').is_file() for ext in ('csv','kvdat')):
            continue  # Ignored captures are not automatically copied into worktrees.
        sid = 'sample-' + name
        folder = directory(sid)
        folder.mkdir(exist_ok=True)
        (folder / 'capture.csv').write_bytes((ROOT / f'captures/{stem}.csv').read_bytes())
        (folder / 'capture.kvdat').write_bytes((ROOT / f'captures/{stem}.kvdat').read_bytes())
        (folder / 'firmware.elf').write_bytes((ROOT / 'firmware/stm32h7b0_etm_board_v1/fw.elf').read_bytes())
        decoded = ROOT / f'decoded/{name}/decoded.json'
        if decoded.exists():
            (folder / 'decoded.json').write_bytes(decoded.read_bytes())
            (folder / 'sources.json').write_text(json.dumps(json.loads(decoded.read_text())['sources']), encoding='utf-8')
        save(sid, dict(name=f'H7B0 实测 · {name.replace("m", " MSa/s")} · 10 ms', created=1791648000,
                       input='capture.csv', config=DEFAULT_CONFIG, configBasis='SWD readback + Flash comparison'))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8766)
    args = parser.parse_args()
    samples()
    app.run(host='127.0.0.1', port=args.port, threaded=True, debug=False)

