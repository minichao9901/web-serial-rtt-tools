import json,pathlib,sys
out=pathlib.Path(__file__).resolve().parent;root=out.parents[2]
sys.path.insert(0,str(root/'bridge/etm/backend/tools/la'))
from kingst_la import Vis,do_export
sys.path.insert(0,str(root/'bridge/etm/backend/tools'))
from trace_port import read_tracks
v=Vis()
try:do_export(v,str(out/'pe6-all-channels.csv'),channels=list(range(16)))
finally:v.close()
initial,tracks,start,end=read_tracks(out/'pe6-all-channels.csv')
result=dict(initial=initial,transitions={k:len(t) for k,t in tracks.items()},possibleMiswiredChannels=[k for k,t in tracks.items() if len(t)>=30])
(out/'pe6-all-channels.json').write_text(json.dumps(result,indent=2),encoding='utf8');print(json.dumps(result))
