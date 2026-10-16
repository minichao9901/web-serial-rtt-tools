import hashlib,json,pathlib,shutil
out=pathlib.Path(__file__).resolve().parent;root=out.parents[2]
campaign=json.loads((out/'campaign-second-failure.json').read_text(encoding='utf8'))
record=campaign['cycles'][0]['fwd']['record'];source=root/record['path']
destination=out/'rtt-forward-10s.bin';shutil.copy2(source,destination)
data=destination.read_bytes();pattern=b'hello world!\n'
phase=next((i for i in range(len(pattern)) if data[:128]==(pattern*16)[i:i+128]),None)
match=phase is not None and data==(pattern*((len(data)+2*len(pattern))//len(pattern)))[phase:phase+len(data)]
result=dict(bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),source=str(source),archived=str(destination),expectedPattern='hello world!\\n',phase=phase,everyByteMatchesPeriodicPattern=match,limitation='A periodic payload cannot detect a missing whole multiple of 13 bytes. Sequence-number RTT is tested separately.',windowFileRatio=len(data)/record['rxBytes'],seconds=record['seconds'])
(out/'recording-integrity.json').write_text(json.dumps(result,indent=2),encoding='utf8');print(json.dumps(result))
