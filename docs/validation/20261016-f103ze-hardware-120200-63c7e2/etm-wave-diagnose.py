import json,pathlib,sys
out=pathlib.Path(__file__).resolve().parent;root=out.parents[2]
sys.path.insert(0,str(root/'bridge/etm/backend/tools'))
from trace_port import read_tracks,extract
reports=[]
for csv in sorted((out/'etm-records').glob('capture-*/capture.csv')):
    initial,tracks,start,end=read_tracks(csv)
    row=dict(record=csv.parent.name,initial=initial,transitions={k:len(v) for k,v in tracks.items()},phases=[])
    for phase in [.1,.25,.5,.75,.9]:
        r,streams=extract(csv,0,[1,2,3,4],phase)
        row['phases'].append(r)
    reports.append(row)
(out/'etm-wave-diagnose.json').write_text(json.dumps(reports,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps([dict(record=r['record'],initial=r['initial'],transitions=r['transitions'],phases=[dict(fraction=p['sample_fraction_after_each_edge'],clockHz=p['clock_hz_average'],sync=[c['frame_sync_matches'] for c in p['candidates']]) for p in r['phases']]) for r in reports],ensure_ascii=False))
