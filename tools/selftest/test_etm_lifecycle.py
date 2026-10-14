"""Independent regression against the reviewed runtime shipped in this repository. No SWD/LA access."""
import concurrent.futures,itertools,json,sys,tempfile,time,unittest,os,importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch,Mock
ROOT=Path(__file__).resolve().parents[2]
_boot=tempfile.TemporaryDirectory();_previous=os.environ.get('WEB_ETM_RECORDS');os.environ['WEB_ETM_RECORDS']=_boot.name
try:
    _spec=importlib.util.spec_from_file_location('reviewed_etm_backend',ROOT/'bridge/etm/backend/server.py')
    server=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(server)
finally:
    if _previous is None:os.environ.pop('WEB_ETM_RECORDS',None)
    else:os.environ['WEB_ETM_RECORDS']=_previous
import kingst_la

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.previous=server.RECORDS;server.RECORDS=Path(self.tmp.name)
        server.jobs.clear();self.elf='elf-'+'a'*32;server.directory(self.elf).mkdir();(server.directory(self.elf)/'firmware.elf').write_bytes(b'elf')
        self.info=patch.object(server,'elf_info',return_value={'sha256':'same'});self.info.start()
    def tearDown(self):self.info.stop();server.jobs.clear();server.RECORDS=self.previous;self.tmp.cleanup()
    def capture(self,**options):return server.app.test_client().post('/api/capture',json={'elfId':self.elf,'seconds':.001,**options})
    def test_offline_la_constructor_is_a_catchable_error(self):
        with patch.object(kingst_la.socket,'create_connection',side_effect=ConnectionRefusedError('offline')):
            try:kingst_la.Vis()
            except Exception:return
            except SystemExit:self.fail('LA offline exits the worker instead of reporting a task error')
        self.fail('offline LA unexpectedly connected')
    def test_la_worker_exit_cannot_leave_job_queued(self):
        sid='capture-offline';server.save(sid,{'input':'capture.csv'});jid=server.new_job(sid,'queued')
        with patch.object(server,'Vis',side_effect=SystemExit('offline')):
            try:server.capture_job(jid,sid,{})
            except SystemExit:pass
        self.assertEqual(server.jobs[jid]['state'],'error')
    def test_empty_csv_failure_terminates_decode_job(self):
        sid='record-empty';server.save(sid,{'input':'capture.csv','config':{}});jid=server.new_job(sid,'queued')
        with patch.object(server,'decode_capture',side_effect=SystemExit('empty CSV')):
            try:server.decode_job(jid,sid)
            except SystemExit:pass
        self.assertEqual(server.jobs[jid]['state'],'error')
    def test_concurrent_capture_admission_is_atomic(self):
        real=server.new_job
        def delayed(*args,**kwargs):time.sleep(.025);return real(*args,**kwargs)
        with patch.object(server,'threading',SimpleNamespace(Thread=Mock())),patch.object(server,'new_job',side_effect=delayed):
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                codes=sorted(r.status_code for r in pool.map(lambda _:self.capture(),range(2)))
        self.assertEqual(codes,[200,400]);self.assertEqual(len(server.jobs),1)
    def test_duplicate_decode_returns_same_job(self):
        server.save('record-a',{'input':'capture.bin'})
        with patch.object(server.threading,'Thread'):
            a=server.app.test_client().post('/api/decode/record-a').json
            b=server.app.test_client().post('/api/decode/record-a').json
        self.assertEqual(a['job'],b['job']);self.assertEqual(len(server.jobs),1)
    def test_missing_optional_firmware_has_actionable_404_without_creating_records(self):
        with patch.object(server,'ROOT',Path(self.tmp.name)):
            client=server.app.test_client()
            for path,method in [('/api/default-elf','get'),('/api/firmware','get'),('/api/profile-firmware/spi-280','get'),('/api/profiles/spi-280','post'),('/api/profiles/unknown','post')]:
                response=getattr(client,method)(path);self.assertEqual(response.status_code,404,response.json);self.assertIn('固件',response.json['error'])
        self.assertEqual([p.name for p in server.RECORDS.iterdir()],[self.elf])
    def test_terminal_jobs_are_bounded_but_active_and_failed_cleanup_are_retained(self):
        active=server.new_job('active','armed');failed=server.new_job('failed','error');server.change(failed,cleanupPending=True)
        for i in range(350):
            jid=server.new_job(str(i),'queued');server.change(jid,state='done')
        server.prune_jobs();self.assertLessEqual(len(server.jobs),258);self.assertIn(active,server.jobs);self.assertIn(failed,server.jobs)
        server.prune_jobs(now=time.time()+86401);self.assertEqual(set(server.jobs),{active,failed})
    def test_nonfinite_threshold_is_rejected_before_job(self):
        for value in [float('nan'),float('inf'),-float('inf'),-5,5]:
            with self.subTest(value=value),patch.object(server.threading,'Thread'):
                r=self.capture(threshold=value);self.assertEqual(r.status_code,400,r.json);self.assertEqual(len(server.jobs),0)
    def test_queued_capture_can_be_cancelled_without_talking_to_la(self):
        jid=server.new_job('capture-a','queued')
        with patch.object(server,'Vis',side_effect=AssertionError('must not connect')):
            r=server.app.test_client().post('/api/stop/'+jid)
        self.assertEqual(r.status_code,200,r.json);self.assertEqual(server.jobs[jid]['state'],'cancelled')
    def test_thread_start_failure_does_not_leave_busy_job(self):
        with patch.object(server.threading,'Thread') as thread:
            thread.return_value.start.side_effect=RuntimeError('cannot start')
            r=self.capture()
        self.assertEqual(r.status_code,400);self.assertTrue(server.jobs);self.assertEqual(next(iter(server.jobs.values()))['state'],'error')
    def test_closed_socket_and_cancelled_wait_never_export_previous_buffer(self):
        for cancelled in [False,True]:
            with self.subTest(cancelled=cancelled):
                sid='capture-socket-'+str(cancelled);server.save(sid,{'input':'capture.csv'});jid=server.new_job(sid,'queued')
                class Socket:
                    def settimeout(self,_):pass
                    def sendall(self,_):pass
                    def recv(self,_):
                        if cancelled:server.jobs[jid].update(_stopped=True,_stop_confirmed=True)
                        return b''
                class Vis:
                    def __init__(self):self.sock=Socket()
                    def cmd(self,command):return '500000000' if command=='get-supported-sample-rate' else ''
                    def close(self):pass
                with patch.object(server,'Vis',Vis),patch.object(server,'do_export') as export,patch.object(server,'stop_owned_la'):
                    server.capture_job(jid,sid,{'rate':500000000,'seconds':.01,'threshold':1.65,'sync':True,'data':[1,2,3,4],'clock':0,'decode':False})
                export.assert_not_called();self.assertEqual(server.jobs[jid]['state'],'cancelled' if cancelled else 'error')
    def test_incomplete_record_cannot_export_as_complete_package(self):
        server.save('cancelled-record',{'input':'capture.csv'})
        r=server.app.test_client().get('/api/download/cancelled-record/record')
        self.assertEqual(r.status_code,400);self.assertIn('原始波形',r.json['error'])
    def test_bad_config_register_words_never_start_a_job(self):
        for value in [-1,2**32,True,1.5,'0x1']:
            with self.subTest(value=value):
                r=self.capture(config={'config':value});self.assertEqual(r.status_code,400,r.json);self.assertEqual(len(server.jobs),0)
    def test_missing_jobs_are_actionable_and_never_stop_foreign_la(self):
        with patch.object(server,'Vis',side_effect=AssertionError('must not touch LA')):
            for path in ['/api/jobs/missing','/api/stop/missing']:
                r=server.app.test_client().get(path) if '/jobs/' in path else server.app.test_client().post(path)
                self.assertEqual(r.status_code,404);self.assertIn('任务',r.json['error'])
    def test_sources_from_different_elf_are_rejected(self):
        with patch.object(server,'result',return_value={'elf':{'sha256':'different'},'sources':{}}):
            r=server.app.test_client().post('/api/sources/record-a',json={'elfId':self.elf,'sources':{}})
        self.assertEqual(r.status_code,400);self.assertIn('不同 ELF',r.json['error'])
    def test_missing_capture_entry_is_not_disguised_by_zero_packet_errors(self):
        es=[{'kind':'instruction','pc':0x080005a0}]
        marker=server.capture_start_info(es,{'captureEntry':0x080004d0})
        self.assertFalse(marker['entryRecovered']);self.assertFalse(marker['firstMatchesEntry']);self.assertEqual(marker['firstRecoveredPC'],0x080005a0)
        marker=server.capture_start_info(es+[{'kind':'instruction','pc':0x080004d0}],{'captureEntry':0x080004d0})
        self.assertTrue(marker['entryRecovered']);self.assertFalse(marker['firstMatchesEntry'])

class MatrixTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.old=server.RECORDS;server.RECORDS=Path(self.tmp.name);server.jobs.clear()
        self.elf='elf-'+'b'*32;server.directory(self.elf).mkdir();(server.directory(self.elf)/'firmware.elf').write_bytes(b'fixture')
        self.info=patch.object(server,'elf_info',return_value={});self.info.start()
        self.worker=patch.object(server,'threading',SimpleNamespace(Thread=Mock()));self.worker.start()
    def tearDown(self):self.worker.stop();self.info.stop();server.jobs.clear();server.RECORDS=self.old;self.tmp.cleanup()
    def post(self,**opts):return server.app.test_client().post('/api/capture',json={'elfId':self.elf,**opts})
    def release(self):
        for job in server.jobs.values():job['state']='done'
    def test_numeric_boundaries_336_requests(self):
        count=0
        for rate,seconds,fraction in itertools.product([0,1,50000000,100000000,500000000,500000001,10**10],[-1,0,.001,.01,2,2.001,float('nan'),float('inf')],[-.1,0,.25,1,float('nan'),float('inf')]):
            expected=0<rate<=500000000 and 0<seconds<=2 and rate*seconds<=100000000 and 0<fraction<1
            r=self.post(rate=rate,seconds=seconds,fraction=fraction)
            self.assertEqual(r.status_code,200 if expected else 400,(rate,seconds,fraction,r.json));self.release();count+=1
        self.assertEqual(count,336)
    def test_all_120_channel_permutations_and_20_duplicate_orders(self):
        for channels in itertools.permutations(range(5)):
            r=self.post(seconds=.001,clock=channels[0],data=list(channels[1:]));self.assertEqual(r.status_code,200,r.json);self.release()
        for a,b in itertools.permutations(range(5),2):
            channels=list(range(5));channels[b]=channels[a]
            self.assertEqual(self.post(clock=channels[0],data=channels[1:]).status_code,400)
    def test_25_simultaneous_capture_pairs_only_one_admitted(self):
        real=server.new_job
        def delayed(*args,**kwargs):time.sleep(.002);return real(*args,**kwargs)
        for _ in range(25):
            with patch.object(server,'new_job',side_effect=delayed),concurrent.futures.ThreadPoolExecutor(2) as pool:
                r=list(pool.map(lambda _:self.post(seconds=.001),range(2)))
            self.assertEqual(sorted(x.status_code for x in r),[200,400]);self.release()
    def test_22_job_phase_kind_cleanup_stop_orders(self):
        count=0
        for phase,kind,pending in itertools.product(['queued','starting','armed','saving','decoding','done','cancelled','error'],['capture','decode'],[False,True]):
            if pending and phase not in ('error','done','cancelled'):continue
            jid=server.new_job('capture-stop',phase,kind=kind);server.jobs[jid]['cleanupPending']=pending
            with patch.object(server,'stop_owned_la') as stop:
                r=server.app.test_client().post('/api/stop/'+jid)
            allowed=kind=='capture' and (phase in ('queued','starting','armed','done','cancelled','error') or pending)
            self.assertEqual(r.status_code,200 if allowed else 400,(phase,kind,pending,r.json))
            if kind=='decode':stop.assert_not_called()
            count+=1
        self.assertEqual(count,22)
    def test_metadata_100_writes_and_1000_reads_are_never_partial_json(self):
        sid='atomic';server.save(sid,{'input':'capture.csv','value':-1});errors=[]
        def writer(index):
            for j in range(25):server.save(sid,{'input':'capture.csv','value':index*25+j,'payload':'中文'*1000})
        def reader():
            for _ in range(1000):
                try:self.assertIsInstance(server.meta(sid)['value'],int)
                except Exception as e:errors.append(str(e))
        with concurrent.futures.ThreadPoolExecutor(5) as pool:
            tasks=[pool.submit(writer,i) for i in range(4)]+[pool.submit(reader)]
            for task in tasks:task.result(timeout=20)
        self.assertEqual(errors,[]);self.assertEqual(list(server.directory(sid).glob('*.tmp')),[])
    def test_untrusted_host_and_foreign_input_paths_are_rejected(self):
        for host in ['attacker.example:8878','localhost.evil:8878','127.0.0.1.evil:8878']:
            self.assertEqual(server.app.test_client().get('/api/records',headers={'Host':host}).status_code,403)
        folder=server.directory('foreign');folder.mkdir();(folder/'session.json').write_text(json.dumps({'input':'../../secret.txt'}))
        self.assertEqual(server.app.test_client().get('/api/download/foreign/raw').status_code,400)


class IndexReplacementTests(unittest.TestCase):
    def test_old_windows_reader_does_not_break_new_index(self):
        import threading,sqlite3
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);data={'events':[],'packets':[],'sources':{},'elements':[],'quality':{},'summary':{},'analysis':{}}
            (folder/'decoded.json').write_text(json.dumps(data),encoding='utf8');store=server.RecordStore(folder,lambda:data);store.ensure();ready=threading.Event()
            def reader():
                db=sqlite3.connect(store.path);db.execute('SELECT * FROM meta').fetchall();ready.set();time.sleep(.3);db.close()
            worker=threading.Thread(target=reader);worker.start();self.assertTrue(ready.wait(2));(folder/'decoded.json').write_text(json.dumps(data)+' ',encoding='utf8')
            try:store.ensure();self.assertTrue(store.ready())
            finally:worker.join(2)

if __name__=='__main__':unittest.main()
