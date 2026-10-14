"""Simplified execution excerpts and an offline, paired source viewer."""
import html
import json
from pathlib import PurePosixPath

def base(file):return PurePosixPath(file.replace('\\','/')).name

def simplified_rows(result):
    source_lines={file:text.splitlines() for file,text in result['sources'].items()}
    rows=[];last=None
    for index,event in enumerate(result['events']):
        seq=event.get('seq',index)
        if event['kind']!='instruction':
            if event['type'] in (1,2,3,6,7,8,9,10):
                rows.append(dict(kind='event',seq=seq,endSeq=seq,text=event['text']))
                last=None
            continue
        number=event.get('line');file=event.get('file','');key=(event.get('function',''),file,number)
        if event.get('executionState')=='unknown' or event.get('executed') is None:
            rows.append(dict(kind='unknown',seq=event['seq'],endSeq=event['seq'],pc=event['pc'],file=file,line=number,
                             function=key[0],text='条件执行状态未知，不视为已证实执行'));last=None;continue
        if not event['executed']:continue
        content=source_lines.get(file,[])
        if not number or not 0<number<=len(content):
            rows.append(dict(kind='missing',seq=event['seq'],endSeq=event['seq'],pc=event['pc'],file=file,line=number,
                             function=key[0],text='无配套源码'));last=None;continue
        if key==last:
            rows[-1]['endSeq']=event['seq'];rows[-1]['records']+=1
            continue
        rows.append(dict(kind='code',seq=event['seq'],endSeq=event['seq'],pc=event['pc'],file=file,line=number,
                         function=key[0],text=content[number-1],records=1));last=key
    return rows

def simplified_c(result):
    clean=lambda text:str(text).replace('*/','* /')
    lines=[f"/* {result.get('protocol','ETMv4')} 简化源码执行流：按恢复顺序排列，不是可编译程序。 */"]
    if result.get('exportRange'):lines.append('/* 导出执行序号区间 '+str(result['exportRange'])+'；不是微秒时间区间。 */')
    if result.get('quality',{}).get('unprocessedBytes'):lines.append('/* ETM 输入仍有未处理字节，缺失路径保持未知。 */')
    rows=simplified_rows(result)
    paths=list(dict.fromkeys(r['file'] for r in rows if r.get('file')))
    lines+=['/* 配套文件：'+clean(base(file))+' = '+clean(file)+' */' for file in paths]
    context=None
    for row in rows:
        if row['kind']=='code':
            key=(row['function'],row['file'])
            if key!=context:lines.append('/* '+clean(row['function'])+' · '+clean(base(row['file']))+' */');context=key
            lines.append(row['text'])
        else:
            lines.append('/* #'+str(row['seq'])+(f" PC=0x{row['pc']:08x}" if 'pc' in row else '')+' '+clean(row['text'])+' */');context=None
    return '\n'.join(lines)+'\n'

def simplified_html(result):
    rows=simplified_rows(result)
    payload=json.dumps(dict(rows=rows,sources=result['sources']),ensure_ascii=False,separators=(',',':')).replace('&','\\u0026').replace('<','\\u003c').replace('>','\\u003e')
    bounds=result.get('exportRange')
    scope=html.escape(f"#{bounds['start']}～#{bounds['end']}" if bounds else '整个已恢复记录')
    return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ETM 简化执行流与源码对照</title><style>
:root{color-scheme:dark;font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#0d1117;color:#e6edf3}*{box-sizing:border-box}body{margin:0}header{padding:8px 12px;background:#161b22;border-bottom:1px solid #28313b}header strong{display:block}header span{color:#9aa4af;font-size:12px}.tools{display:flex;gap:6px;padding:8px 12px;align-items:center;flex-wrap:wrap}input,button{font:inherit;background:#1c232c;color:inherit;border:1px solid #28313b;border-radius:4px;padding:4px 8px}input{min-width:0}#filter{flex:1}main{display:grid;grid-template-columns:50% 50%;height:calc(100vh - 112px);min-height:250px;padding:0 12px 10px;gap:8px}section{min-width:0;display:flex;flex-direction:column;border:1px solid #28313b;border-radius:5px;overflow:hidden}.title{padding:5px 8px;background:#161b22;color:#58a6ff;flex-shrink:0}#list,#source{overflow:auto;flex:1;min-height:0;font:12px/1.65 Consolas,"Cascadia Mono",monospace}.entry{display:grid;grid-template-columns:90px minmax(0,1fr);gap:7px;padding:3px 6px;border-bottom:1px solid #242c35;cursor:pointer}.entry:hover{background:#1c232c}.entry.selected,.src.current{background:#5bae4426}.entry small{color:#9aa4af}.entry pre{font:inherit;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.entry.event,.entry.unknown,.entry.missing{color:#d29922}.src{display:flex;white-space:pre;min-width:max-content}.src .number{width:55px;flex:none;text-align:right;padding-right:12px;background:#161b22;color:#71808f}.src .text{padding-left:8px}#details{padding:5px 8px;background:#161b22;font:12px Consolas,monospace;overflow-wrap:anywhere}.pager{display:flex;justify-content:space-between;padding:4px 8px;border-top:1px solid #28313b}.muted{color:#9aa4af}@media(max-width:760px){main{grid-template-columns:1fr;height:auto}section{height:65vh}}
</style><header><strong>ETM 简化执行流 / 原始源码</strong><span>执行序号范围：'''+scope+''' · 按执行先后排列；当前没有逐指令时间戳。未知状态与边界保留。连续相同源码位置合并，循环顺序保留。</span></header>
<div class="tools"><input id="filter" placeholder="搜索函数、文件或代码"><input id="seek" placeholder="执行序号" size="12"><button id="locate">定位</button><span id="count"></span></div>
<main><section><div class="title">简化执行流（点击定位右侧源码）</div><div id="list"></div><div class="pager"><button id="prev">上一页</button><span id="page"></span><button id="next">下一页</button></div></section><section><div class="title" id="file">原始源码</div><div id="details">选择左侧一条记录。</div><div id="source"></div></section></main>
<script id="data" type="application/json">'''+payload+'''</script><script>
'use strict';const data=JSON.parse(document.getElementById('data').textContent),$=id=>document.getElementById(id);let indexes=data.rows.map((r,i)=>i),offset=0,selected=null,currentFile=null;const size=150;
const node=(tag,text,cls)=>{const e=document.createElement(tag);e.textContent=text??'';if(cls)e.className=cls;return e;};
function choose(index){selected=index;const r=data.rows[index];for(const e of $('list').children)e.classList.toggle('selected',Number(e.dataset.index)===index);$('file').textContent=r.file||'事件 / 无源码位置';$('details').textContent='#'+r.seq+(r.endSeq!==r.seq?'～'+r.endSeq:'')+(r.pc!=null?' · PC=0x'+r.pc.toString(16).padStart(8,'0'):'')+(r.function?' · '+r.function:'')+(r.line?' · 第 '+r.line+' 行':'')+(r.records?' · 合并 '+r.records+' 条指令记录':'')+(r.kind==='code'?'':' · '+r.text);
if(!r.file||!data.sources[r.file]){$('source').textContent=r.text||'无配套源码';currentFile=null;return;}if(currentFile!==r.file){const frag=document.createDocumentFragment();data.sources[r.file].split(/\\r?\\n/).forEach((text,i)=>{const e=node('div',null,'src');e.dataset.line=i+1;e.append(node('span',i+1,'number'),node('span',text||' ','text'));frag.append(e);});$('source').replaceChildren(frag);currentFile=r.file;}
for(const e of $('source').children)e.classList.toggle('current',Number(e.dataset.line)===r.line);const active=$('source').querySelector('.current');if(active)$('source').scrollTop=active.offsetTop-$('source').offsetTop-80;}
function paint(){const frag=document.createDocumentFragment();for(const index of indexes.slice(offset,offset+size)){const r=data.rows[index],row=node('div',null,'entry '+r.kind+(selected===index?' selected':''));row.dataset.index=index;row.tabIndex=0;row.title=(r.function||'')+' '+(r.file||'')+':'+(r.line||'');row.append(node('small','#'+r.seq),node('pre',r.text));row.onclick=()=>choose(index);row.onkeydown=e=>{if(e.key==='Enter')choose(index);};frag.append(row);}$('list').replaceChildren(frag);$('list').scrollTop=0;$('count').textContent=indexes.length+' 条简化记录';$('page').textContent=indexes.length?Math.floor(offset/size)+1+' / '+Math.ceil(indexes.length/size):'0 / 0';$('prev').disabled=!offset;$('next').disabled=offset+size>=indexes.length;}
$('prev').onclick=()=>{offset=Math.max(0,offset-size);paint();};$('next').onclick=()=>{offset+=size;paint();};let timer;$('filter').oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{const q=$('filter').value.toLowerCase();indexes=data.rows.map((r,i)=>i).filter(i=>[data.rows[i].function,data.rows[i].file,data.rows[i].text].join(' ').toLowerCase().includes(q));offset=0;paint();},120);};$('locate').onclick=()=>{const seq=Number($('seek').value);if(!$('seek').value.trim()||!Number.isInteger(seq)){$('count').textContent='请输入整数执行序号';return;}const i=data.rows.findIndex(r=>r.seq<=seq&&r.endSeq>=seq);if(i<0){$('count').textContent='此序号没有简化源码记录；未成立条件不输出为已执行源码';return;}$('filter').value='';indexes=data.rows.map((r,j)=>j);offset=Math.floor(i/size)*size;paint();choose(i);const row=$('list').querySelector('[data-index="'+i+'"]');if(row)$('list').scrollTop=row.offsetTop-$('list').offsetTop-60;};paint();const first=data.rows.findIndex(r=>r.kind==='code');if(first>=0)choose(first);
</script></html>'''
