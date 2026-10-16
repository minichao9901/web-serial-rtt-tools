"""Run the existing native integrity checker and persist its exact input."""
import importlib.util,json,pathlib,sys
out=pathlib.Path(__file__).resolve().parent;root=out.parents[2]
spec=importlib.util.spec_from_file_location('probe_diag_accept',root/'tools/selftest/probe-hid-diag.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
original=module.analyze_seq;results=[]
def capture(stream,dump=True):
    data=bytes(stream);number=len(results)+1
    (out/('rtt-seq-72-round-'+str(number)+'.bin')).write_bytes(data)
    result=original(stream,dump)
    malformed=[];pos=0
    while True:
        pos=data.find(b'seq ',pos)
        if pos<0 or pos+13>len(data):break
        record=data[pos:pos+13]
        if record[11:13]!=b'\r\n' or not all(48<=c<=57 for c in record[4:11]):malformed.append(dict(offset=pos,hex=data[max(0,pos-16):pos+32].hex()))
        pos+=1
    result.update(bytes=len(data),malformed=malformed[:20]);results.append(result)
    (out/'rtt-seq-72-results.json').write_text(json.dumps(results,indent=2),encoding='utf8')
    return result
module.analyze_seq=capture
sys.argv=['probe-hid-diag.py','--mode=loss','--seq','--clk=45','--com=COM43','--iters=3','--window=5','--rxbuf=1048576']
module.main()
assert len(results)==3
assert all(r['records']>100000 and all(r[k]==0 for k in ['missing','extra','bad','rewound','jumps']) for r in results),'Nonzero integrity counters; exact raw streams archived'
