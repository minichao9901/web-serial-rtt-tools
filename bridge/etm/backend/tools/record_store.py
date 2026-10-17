"""可重建的 SQLite 浏览索引；原始记录/decoded.json 是证据，不改写它们。"""
import json
import math
import sqlite3
import threading
import time
from contextlib import closing
from pathlib import Path

VERSION=3
_guard=threading.Lock()
def dumps(value):return json.dumps(value,ensure_ascii=False,separators=(',',':'))

class RecordStore:
    def __init__(self,folder,loader):
        self.folder=Path(folder);self.path=self.folder/'browse-v3.sqlite';self.loader=loader
    def signature(self):
        p=self.folder/'decoded.json';s=p.stat()
        parts=[f'{VERSION}:{s.st_size}:{s.st_mtime_ns}']
        for name in ('spi-validation.json','phase-validation.json','firmware.elf','capture.csv','capture.bin','etm.bin','session.json','events.jsonl','packets.jsonl','elements.jsonl','sources.json'):
            side=self.folder/name
            if side.exists():t=side.stat();parts.append(f'{name}:{t.st_size}:{t.st_mtime_ns}')
        return '|'.join(parts)
    def ready(self):
        if not self.path.exists():return False
        try:
            with closing(sqlite3.connect(self.path)) as db:
                return db.execute("SELECT value FROM meta WHERE key='signature'").fetchone()==(self.signature(),)
        except sqlite3.DatabaseError:return False
    def ensure(self):
        if self.ready():return
        with _guard:
            if self.ready():return
            r=self.loader();temporary=self.path.with_suffix('.building')
            if temporary.exists():temporary.unlink()
            with closing(sqlite3.connect(temporary)) as db:
                db.executescript('''
                CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
                CREATE TABLE events(seq INTEGER PRIMARY KEY,kind TEXT,pc INTEGER,fn TEXT,file TEXT,line INTEGER,
                   flow TEXT,state TEXT,type INTEGER,search TEXT,data TEXT);
                CREATE INDEX events_pc ON events(pc,seq);
                CREATE INDEX events_flow ON events(flow,seq);
                CREATE INDEX events_kind ON events(kind,seq);
                CREATE INDEX events_state ON events(state,seq);
                CREATE TABLE packets(id INTEGER PRIMARY KEY,search TEXT,data TEXT);
                CREATE TABLE sources(file TEXT PRIMARY KEY,text TEXT);
                CREATE TABLE issues(id INTEGER PRIMARY KEY,startSeq INTEGER,endSeq INTEGER,data TEXT);
                ''')
                summary={k:v for k,v in r.items() if k not in ('events','elements','packets','sources')}
                summary['eventCount']=len(r['events']);summary['packetCount']=len(r['packets'])
                summary['sourceFiles']=list(r.get('sources',{}));summary['firstSeq']=next((e['seq'] for e in r['events'] if e['kind']=='instruction'),None)
                db.executemany('INSERT INTO meta VALUES (?,?)',[('signature',self.signature()),('overview',dumps(summary))])
                def event_row(e):
                    search=' '.join(str(e.get(k,'') or '') for k in ('function','file','mnemonic','operands','text'))
                    if 'pc' in e:search+=f" 0x{e['pc']:08x} {e['pc']}"
                    return (e['seq'],e['kind'],e.get('pc'),e.get('function'),e.get('file'),e.get('line'),
                            e.get('flow'),e.get('executionState'),e.get('type'),search.lower(),dumps(e))
                db.executemany('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?)',(event_row(e) for e in r['events']))
                db.executemany('INSERT INTO packets VALUES (?,?,?)',((i,(p.get('text','')+' '+str(p.get('offset'))+' '+p.get('hex','')).lower(),dumps(p)) for i,p in enumerate(r['packets'])))
                db.executemany('INSERT INTO sources VALUES (?,?)',r.get('sources',{}).items())
                issues=[];run=None
                def end_run():
                    nonlocal run
                    if run:issues.append(run);run=None
                for e in r['events']:
                    if e.get('executionState')=='unknown':
                        if run and e['seq']==run['endSeq']+1:run['endSeq']=e['seq'];run['records']+=1
                        else:
                            end_run();run=dict(category='predicate',startSeq=e['seq'],endSeq=e['seq'],records=1,
                                  offset=e.get('offset'),reason=e.get('executionReason') or '条件执行结果未被当前 trace 证实')
                    else:end_run()
                    if e['kind']=='event' and e['type'] in (1,2,6,7,8):
                        issues.append(dict(category='boundary',startSeq=e['seq'],endSeq=e['seq'],offset=e.get('offset'),
                                           reason=e.get('text','边界事件'),records=1))
                end_run()
                q=r.get('quality',{})
                packet_end=0
                for p in (sorted(r['packets'],key=lambda p:p['offset']) if isinstance(r['packets'],list) else r['packets']):
                    start,stop=p['offset'],p['offset']+p['size']
                    if start>packet_end:issues.append(dict(category='gap',startSeq=None,endSeq=None,records=0,offset=packet_end,bytes=start-packet_end,reason='ETM 包字节覆盖缺口；不能据此补造指令'))
                    if start<packet_end:issues.append(dict(category='overlap',startSeq=None,endSeq=None,records=0,offset=start,bytes=max(0,min(stop,packet_end)-start),reason='ETM 包字节覆盖重叠'))
                    packet_end=max(packet_end,stop)
                    if any(t in p.get('text','').upper() for t in ('OVERFLOW','BAD_','RESERVED','INCOMPLETE_EOT')):
                        issues.append(dict(category='packet',startSeq=None,endSeq=None,records=0,offset=start,bytes=p['size'],reason='包问题：'+p['text']))
                input_size=q.get('inputBytes',q.get('processedBytes',0))
                if input_size>packet_end:issues.append(dict(category='gap',startSeq=None,endSeq=None,records=0,offset=packet_end,bytes=input_size-packet_end,reason='ETM 输入尾部未被包记录覆盖'))
                if r.get('status',{}).get('lastErrorCode'):issues.append(dict(category='decoder',startSeq=None,endSeq=None,records=0,offset=r['status'].get('processed'),reason='解码器错误：'+r['status'].get('lastError','未知错误')))
                for key,label in [('initialPhysicalBytes','TPIU 同步前物理字节'),('trailingFrameBytes','不完整的 TPIU 尾帧'),('unknownSourceBytes','未知源 ID 字节')]:
                    if q.get(key):issues.append(dict(category='physical',startSeq=None,endSeq=None,records=0,bytes=q[key],reason=label))
                db.executemany('INSERT INTO issues VALUES (?,?,?,?)',((i,p['startSeq'],p['endSeq'],dumps(p)) for i,p in enumerate(issues)))
                db.commit()
            deadline=time.monotonic()+10
            while True:
                try:temporary.replace(self.path);break
                except PermissionError:
                    # A previous read request may still hold the old SQLite
                    # handle on Windows. Wait boundedly; keep the old index intact.
                    if time.monotonic()>=deadline:raise
                    time.sleep(.02)
    def connect(self):
        self.ensure();return sqlite3.connect(f'{self.path.as_uri()}?mode=ro',uri=True)
    def overview(self):
        with closing(self.connect()) as db:return json.loads(db.execute("SELECT value FROM meta WHERE key='overview'").fetchone()[0])
    def page(self,view='events',offset=0,limit=150,search='',hide_skipped=False,start=None,end=None):
        offset=max(0,int(offset));limit=max(1,min(500,int(limit)))
        table='packets' if view=='packets' else 'events';order='id' if table=='packets' else 'seq'
        where=[];params=[]
        if table=='events':
            if start is not None:where.append('seq>=?');params.append(int(start))
            if end is not None:where.append('seq<=?');params.append(int(end))
        if search:
            literal=search.lower().replace('\\','\\\\').replace('%','\\%').replace('_','\\_')
            where.append("search LIKE ? ESCAPE '\\'");params.append('%'+literal+'%')
        if hide_skipped and table=='events':where.append("(state IS NULL OR state!='not-taken')")
        clause=' WHERE '+' AND '.join(where) if where else ''
        with closing(self.connect()) as db:
            total=db.execute(f'SELECT count(*) FROM {table}'+clause,params).fetchone()[0]
            offset=min(offset,max(0,((total-1)//limit)*limit))
            rows=[json.loads(r[0]) for r in db.execute(f'SELECT data FROM {table}'+clause+f' ORDER BY {order} LIMIT ? OFFSET ?',params+[limit,offset])]
        return dict(rows=rows,total=total,offset=offset,limit=limit)
    def function_timeline(self,start=None,end=None,search='',hide_skipped=False,bins=1600,max_functions=6):
        """Compact function-lane activity indexed by execution sequence, never by inferred time."""
        bins=max(240,min(2400,int(bins)));max_functions=max(1,min(10,int(max_functions)))
        with closing(self.connect()) as db:
            bounds=db.execute('SELECT min(seq),max(seq) FROM events').fetchone()
            total_start,total_end=bounds if bounds[0] is not None else (0,0)
            lo=total_start if start is None else max(total_start,min(total_end,int(start)))
            hi=total_end if end is None else max(total_start,min(total_end,int(end)))
            if hi<lo:raise ValueError('区间结束序号不能小于起点')
            query_where=[];query_params=[]
            if search:
                literal=search.lower().replace('\\','\\\\').replace('%','\\%').replace('_','\\_')
                query_where.append("search LIKE ? ESCAPE '\\'");query_params.append('%'+literal+'%')
            if hide_skipped:query_where.append("(state IS NULL OR state!='not-taken')")
            query_where.append('seq>=?');query_params.append(lo)
            query_where.append('seq<=?');query_params.append(hi)
            clause=' AND '.join(query_where)
            counts={name:count for name,count in db.execute(
                'SELECT coalesce(fn,\'(未知函数)\'),count(*) FROM events WHERE '+clause+
                " AND kind='instruction' AND state='executed' GROUP BY coalesce(fn,\'(未知函数)\')",query_params)}
            state_counts=dict(db.execute('SELECT state,count(*) FROM events WHERE '+clause+
                " AND kind='instruction' GROUP BY state",query_params))
            unknown=sum(count for state,count in state_counts.items() if state not in ('executed','not-taken'))
            not_taken=state_counts.get('not-taken',0)
            filtered_records=db.execute('SELECT count(*) FROM events WHERE '+clause,query_params).fetchone()[0]
            top=[name for name,_ in sorted(counts.items(),key=lambda item:(-item[1],item[0]))[:max_functions]]
            other=sum(value for name,value in counts.items() if name not in top)
            labels=[dict(key='fn:'+name,name=name,kind='function',records=counts[name]) for name in top]
            if other:labels.append(dict(key='other',name='其他函数',kind='other',records=other))
            if unknown:labels.append(dict(key='unknown',name='执行状态未知',kind='unknown',records=unknown))
            if not hide_skipped and not_taken:labels.append(dict(key='not-taken',name='未成立路径（未证实执行）',kind='not-taken',records=not_taken))
            span=max(1,hi-lo+1);values={lane['key']:[0]*bins for lane in labels};marker_bins={};marker_count=0
            for seq,kind,fn,state,event_type in db.execute(
                    'SELECT seq,kind,fn,state,type FROM events WHERE '+clause+' ORDER BY seq',query_params):
                if kind!='instruction':
                    if event_type in (1,2,3,6,7,8,9,10):
                        marker_count+=1
                        index=min(bins-1,max(0,(seq-lo)*bins//span))
                        bucket=marker_bins.setdefault(index,dict(startSeq=seq,endSeq=seq,seq=seq,types={}))
                        bucket['endSeq']=seq
                        bucket['types'][str(event_type)]=bucket['types'].get(str(event_type),0)+1
                    continue
                if state=='executed':
                    name=fn or '(未知函数)';key='fn:'+name if ('fn:'+name) in values else 'other'
                elif state=='not-taken':key='not-taken'
                else:key='unknown'
                if key not in values:continue
                index=min(bins-1,max(0,(seq-lo)*bins//span));values[key][index]+=1
            for lane in labels:lane['bins']=values[lane['key']]
            markers=[]
            for bucket in marker_bins.values():
                bucket['count']=sum(bucket['types'].values())
                markers.append(bucket)
        return dict(range=dict(start=lo,end=hi,totalStart=total_start,totalEnd=total_end),
                    lanes=labels,binCount=bins,markers=markers,markerCount=marker_count,
                    summary=dict(executed=sum(counts.values()),unknown=unknown,notTaken=not_taken,
                                 filteredRecords=filtered_records,markers=marker_count),
                    timing=dict(axis='execution-order',verifiedTime=False,
                                reason='当前记录没有已验收的逐指令时间戳，横轴只表示执行序号'))
    def window(self,start=None,end=None,bins=1200):
        bins=max(100,min(2000,int(bins)))
        with closing(self.connect()) as db:
            bounds=db.execute('SELECT min(seq),max(seq) FROM events').fetchone()
            total_start,total_end=bounds if bounds[0] is not None else (0,0)
            lo=total_start if start is None else max(total_start,min(total_end,int(start)))
            hi=total_end if end is None else max(total_start,min(total_end,int(end)))
            if hi<lo:raise ValueError('区间结束序号不能小于起点')
            step=max(1,math.ceil((hi-lo+1)/bins))
            root=dict(name='所选执行区间',value=0,self=0,children={})
            buckets={};functions={};hotspots={};previous=None;observed=0;first=None;pending_irq=False
            for row in db.execute('SELECT data FROM events WHERE seq BETWEEN ? AND ? ORDER BY seq',(lo,hi)):
                e=json.loads(row[0]);key=(e['seq']-lo)//step
                bucket=buckets.setdefault(key,dict(startSeq=e['seq'],endSeq=e['seq'],firstSeq=e['seq'],path=None,records=0,unknown=0,notTaken=0,mixed=False,events=[]))
                bucket['endSeq']=e['seq']
                if e['kind']!='instruction':
                    bucket['events'].append(dict(seq=e['seq'],type=e['type'],text=e.get('text','')))
                    pending_irq=e['type']==9
                    previous=None
                    continue
                if first is None:first=e['seq']
                fn=e.get('function') or '(未知函数)'
                path=e.get('callPath') or ['调用栈未知',fn]
                if bucket['path'] is None:bucket['path']=list(path)
                elif bucket['path']!=path:
                    common=[]
                    for a,b in zip(bucket['path'],path):
                        if a!=b:break
                        common.append(a)
                    bucket['path']=common;bucket['mixed']=True
                bucket['records']+=1;bucket['unknown']+=e.get('executed') is None;bucket['notTaken']+=e.get('executed') is False
                node=root;node['value']+=1
                for name in path:
                    node=node['children'].setdefault(name,dict(name=name,value=0,self=0,children={}))
                    node['value']+=1
                node['self']+=1
                stat=functions.setdefault(fn,dict(function=fn,instructions=0,knownExecuted=0,unknownExecution=0,notTaken=0,calls=0,interruptEntries=0))
                stat['instructions']+=1;stat['knownExecuted']+=e.get('executed') is True;stat['unknownExecution']+=e.get('executed') is None;stat['notTaken']+=e.get('executed') is False
                if pending_irq:stat['interruptEntries']+=1;pending_irq=False
                if previous and previous.get('flow')=='call' and previous.get('executed') is True:stat['calls']+=1;observed+=1
                hotkey=(fn,e.get('file',''),e.get('line'))
                hot=hotspots.setdefault(hotkey,dict(function=fn,file=e.get('file',''),line=e.get('line'),records=0,unknown=0,pc=e['pc']))
                hot['records']+=1;hot['unknown']+=e.get('executed') is None;previous=e
            def serialize(node):return {**node,'children':[serialize(c) for c in node['children'].values()]}
            for b in buckets.values():
                b['path']=b['path'] or []
                if b['mixed']:b['path'].append('多段调用（放大查看）')
            return dict(range=dict(start=lo,end=hi,totalStart=total_start,totalEnd=total_end),firstSeq=first,
                timing=dict(axis='execution-order',verifiedTime=False,reason='当前记录没有已验收的逐指令时间戳，执行序号不能换算为微秒'),
                timeline=list(buckets.values()),resolution=step,
                analysis=dict(flame=serialize(root),functions=sorted(functions.values(),key=lambda x:x['instructions'],reverse=True),
                    hotspots=sorted(hotspots.values(),key=lambda x:x['records'],reverse=True),observedCalls=observed,
                    weight='所选区间的路径记录数（含未成立/未知状态），不是耗时'))
    def event(self,seq):
        with closing(self.connect()) as db:row=db.execute('SELECT data FROM events WHERE seq=?',(int(seq),)).fetchone()
        if not row:raise ValueError('记录序号不存在')
        e=json.loads(row[0]);return dict(event=e,callPath=e.get('callPath',[]),stackBasis='历史 trace 重建，包含未证实祖先；不是当前寄存器快照')
    def source(self,file):
        with closing(self.connect()) as db:row=db.execute('SELECT text FROM sources WHERE file=?',(file,)).fetchone()
        return dict(file=file,text=row[0] if row else '')
    def navigate(self,seq=0,direction=1,mode='instruction',pc=None,start=None,end=None):
        seq=int(seq);direction=1 if int(direction)>0 else -1;op='>' if direction>0 else '<';order='ASC' if direction>0 else 'DESC'
        modes={'instruction':"kind='instruction'",'call':"flow='call' AND state='executed'",'return':"flow='return' AND state='executed'",'exception':'type IN (9,10)','issue':"state='unknown' OR type IN (1,2,6,7,8)",'source':"kind='instruction' AND line IS NOT NULL"}
        if mode not in modes:raise ValueError('未知导航类型')
        params=[seq];clause=modes[mode]
        if pc is not None:clause="kind='instruction' AND pc=?";params.append(int(pc))
        if mode=='source' and pc is None:
            current=self.event(seq)['event'];clause+=' AND (coalesce(file,\'\')!=? OR coalesce(line,0)!=?)';params.extend([current.get('file',''),current.get('line') or 0])
        scope='';scope_params=[]
        if start is not None:scope+=' AND seq>=?';scope_params.append(int(start))
        if end is not None:scope+=' AND seq<=?';scope_params.append(int(end))
        with closing(self.connect()) as db:
            row=db.execute(f'SELECT seq FROM events WHERE seq {op} ? AND ({clause})'+scope+f' ORDER BY seq {order} LIMIT 1',params+scope_params).fetchone()
            wrapped=False
            if not row and pc is not None:
                row=db.execute('SELECT seq FROM events WHERE pc=?'+scope+' ORDER BY seq LIMIT 1',[int(pc),*scope_params]).fetchone();wrapped=bool(row)
        return dict(seq=row[0] if row else None,wrapped=wrapped)
    def issues(self,offset=0,limit=100):
        with closing(self.connect()) as db:
            count=db.execute('SELECT count(*) FROM issues').fetchone()[0]
            rows=[json.loads(r[0]) for r in db.execute('SELECT data FROM issues ORDER BY id LIMIT ? OFFSET ?',(min(500,max(1,int(limit))),max(0,int(offset))))]
        return dict(rows=rows,total=count)
