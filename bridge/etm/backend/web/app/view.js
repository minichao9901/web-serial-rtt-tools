import {SourceStore} from './shared/dbg/source.js';
import {readReferencedSources,sourceBatches} from './source-snapshot.js';
import {withCleanup} from './operation.js';
import {requestJson,pollJob} from './jobs.js';
import {embeddedHost,runEmbedded,PROBE_ACTIONS} from './embedding.js';
import {EtmTarget} from './target.js';
import {traceSettings,traceSettingsText} from './trace-options.js';
import {HistoryView} from './history.js';
import {COMMON_TARGETS,completeClocks,targetPort} from './clock.js';
const $=id=>document.getElementById(id),hex=n=>'0x'+(n>>>0).toString(16).padStart(8,'0'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const state={records:[],current:null,job:null,operation:false,elfInfo:null,elfId:null,elfFile:null,sourceFiles:{},sourceSnapshot:null,sourceCompat:false,sources:new SourceStore(),entryAddress:null,hseValues:{stm32h7b0:25,stm32h743:25,stm32f103ze:8},symbolAddress:null,pendingBreakpointRestore:[],lastTraceConfig:null,waiting:false,traceConfigDirty:false};
const host=embeddedHost(),target=new EtmTarget(log,{host});
const apiBase=document.body.dataset.apiBase||'/api/';
async function api(path,body){return requestJson(apiBase+path,body===undefined?{}:{method:'POST',...(body instanceof FormData?{body}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})},{timeout:path.endsWith('/overview')?300000:45000});}
function log(message){$('log').textContent=new Date().toLocaleTimeString('zh-CN')+' '+message+'\n'+$('log').textContent;controls();}
function error(e){log(e.message);$('job-state').textContent=e.message;$('job-state').classList.add('bad');}
const history=new HistoryView(api,error);
function on(id,fn,{exclusive=true}={}){$(id).onclick=async()=>{if(exclusive&&state.operation)return;const button=$(id),recordAction=id==='open-record',hardware=exclusive&&(id==='connect'||PROBE_ACTIONS.has(id)&&!!target.probe||id==='start'&&$('sync').checked);if(exclusive)state.operation=true;if(hardware)state.hardwareOperation=true;if(recordAction)history.setLoading(true);button.disabled=true;controls();try{await(hardware?runEmbedded(host,fn):fn());}catch(e){error(e);}finally{if(exclusive)state.operation=false;if(hardware)state.hardwareOperation=false;if(recordAction)history.setLoading(false);button.disabled=false;controls();}};}
function controls(){const busy=state.operation||!!state.job,connected=!!target.probe;
  for(const id of ['reset','halt','run','read-config','read-clock','apply-config','restore-config','run-to'])$(id).disabled=!connected||busy;
  $('reset').disabled=!connected||busy||state.entryAddress===null;$('run-to').disabled=!connected||busy||state.entryAddress===null;
  $('apply-config').disabled=!connected||busy||!target.info?.traceSupported||!state.elfInfo||state.entryAddress===null;
  $('connect').disabled=connected||busy;$('disconnect').disabled=!connected||busy;$('remove-break').disabled=busy||!target.breakpoints.items.length;$('cancel-wait').hidden=!target.entryBreak&&!state.waiting;
  $('start').disabled=!!state.failedCaptureJob||busy||!state.elfInfo||($('sync').checked&&(!target.info?.traceSupported||!connected||$('entry-before').checked&&state.entryAddress===null));$('stop').disabled=!state.failedCaptureJob&&!(state.jobKind==='capture'&&['queued','starting','armed'].includes(state.jobPhase));
  for(const id of ['open-record','choose-elf','choose-sources','import'])$(id).disabled=busy;
  $('choose-sources').disabled=busy||(!state.elfInfo&&!history.result);
  for(const id of ['symbol-search','break-command','add-break'])$(id).disabled=busy||!state.elfInfo;
  for(const b of document.querySelectorAll('.symbol-row button,.breakpoint-row button,.breakpoint-row input,#break-candidates button'))b.disabled=busy;
  $('target-profile').disabled=busy||connected;$('show-experiments').disabled=busy;
  $('save-record').disabled=!state.current;$('decode').disabled=!state.current||busy;$('export').disabled=!state.current;
  for(const id of ['rate','duration','threshold','fraction','glitch-ns','channels','hse','expected-cpu','expected-trace','sync','reset-before','entry-before','pin-speed','traceid','branch-broadcast','return-stack','cycles','auto-clock'])$(id).disabled=busy;
  for(const [id,option]of [['branch-broadcast','branchBroadcast'],['return-stack','returnStack'],['cycles','cycleCount']])$(id).disabled=busy||target.info?.traceOptions?.[option]===false;
  if(target.info?.profile==='stm32f103ze')$('pin-speed').disabled=true;
  $('reset-before').disabled=busy||!$('entry-before').checked;
  $('expected-cpu').disabled=busy||$('auto-clock').checked;$('expected-trace').disabled=busy||$('auto-clock').checked;
  if(target.transportFault){for(const id of ['reset','halt','run','read-config','read-clock','apply-config','restore-config','run-to','start','remove-break'])$(id).disabled=true;for(const b of document.querySelectorAll('.symbol-row button,.breakpoint-row button,.breakpoint-row input'))b.disabled=true;}
  $('recover-debug').hidden=!connected||!target.transportFault;$('recover-debug').disabled=busy;
  $('start').textContent=$('sync').checked?'联动采集':'直接采集';
}
function panel(name){for(const b of document.querySelectorAll('[data-panel]')){const active=b.dataset.panel===name;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;$('panel-'+b.dataset.panel).hidden=!active;}document.querySelector('.sidebar-content').scrollTop=0;}
for(const b of document.querySelectorAll('[data-panel]')){b.onclick=()=>panel(b.dataset.panel);b.onkeydown=e=>{const names=['target','clock','trace','files'],i=names.indexOf(b.dataset.panel);if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?3:(i+(e.key==='ArrowLeft'?3:1))%4;panel(names[next]);$('tab-'+names[next]).focus();}};}
function externalDecodeConfig(){
  const config=target.config||state.lastTraceConfig;
  if(!config)throw Error('直接采集或导入原始波形前，请先连接目标并读取 ETM 配置；不能假定 ETMv4。记录包可直接导入');
  return {...config,traceid:Number($('traceid').value)};
}
function options(){return {traceid:Number($('traceid').value),branchBroadcast:$('branch-broadcast').checked,returnStack:$('return-stack').checked,cycleCount:$('cycles').checked,pinSpeed:Number($('pin-speed').value)};}
function updateTraceConfigState(info=target.info){
  const label=$('trace-config-state');if(!label)return;
  label.textContent=(state.traceConfigDirty?'待应用；当前：':'回读：')+traceSettingsText(info?.config);
  label.classList.toggle('pending',state.traceConfigDirty);
  label.title=info?.config?`硬件回读：Trace ID ${info.config.traceid??'未知'} · ${traceSettingsText(info.config)}`:'';
}
for(const id of ['traceid','branch-broadcast','return-stack','cycles'])$(id).addEventListener(id==='traceid'?'input':'change',()=>{state.traceConfigDirty=true;updateTraceConfigState();});
const startupNames=new Set(['Reset_Handler','SystemInit','SystemClock_Config','main']);
function entry(trace=false){
  if(!state.elfInfo)throw Error('先载入匹配的 ELF');
  const bp=target.breakpoints.items.find(b=>b.enabled&&b.address===state.entryAddress);
  if(!bp)throw Error('请在断点列表中选择采集起点');
  const fn=state.elfInfo.functions?.find(f=>f.address===bp.address);
  if(trace&&fn&&startupNames.has(fn.name))throw Error('该启动入口尚未验收；可调试断点，请选择初始化后的业务位置采集');
    if(trace&&bp.address>=(target.info?.flashLimit||0x08020000))throw Error('断点超出当前目标的 Trace Flash 范围');
  return bp.address;
}
function renderSymbols(){
  const query=$('symbol-search').value.trim().toLowerCase(),all=state.elfInfo?.functions||[];
  const filtered=all.filter(f=>(f.name+' '+hex(f.address)).toLowerCase().includes(query));
  const rows=filtered.map(f=>{const row=document.createElement('div');row.className='symbol-row';
    const add=document.createElement('button'),has=target.breakpoints.items.some(b=>b.address===f.address);add.textContent=has?'●':'＋';add.title=has?'已添加；点击选择为起点':'添加 '+f.name+' 硬件断点';add.setAttribute('aria-label',(has?'选择断点 ':'添加断点 ')+f.name);
    add.onclick=()=>perform(async()=>{const bp=target.breakpoints.items.find(b=>b.address===f.address);if(bp){if(!bp.enabled)throw Error('请先启用该断点');state.entryAddress=bp.address;if(target.probe&&!bp.lease){await target.verifyElf(state.elfInfo);await target.breakpoints.arm(bp);await showTarget(await target.inspect());}}else await addBreakpoint({address:f.address,label:f.name,function:f.name,file:f.file,line:f.line});});
    const label=document.createElement('span');label.className='symbol-label';label.textContent=f.name;label.title=f.name+' · '+hex(f.address)+(f.file?' · '+f.file+':'+f.line:'');label.onclick=()=>{state.symbolAddress=f.address;updateSymbol();};row.append(add,label);return row;});
  $('capture-symbol').replaceChildren(...rows);if(!rows.length)$('capture-symbol').textContent=state.elfInfo?'没有匹配函数':'先浏览载入 ELF';updateSymbol();controls();
}
function updateSymbol(){const fn=state.elfInfo?.functions?.find(f=>f.address===state.symbolAddress);$('symbol-info').textContent=fn?fn.name+' · '+hex(fn.address)+(fn.line?' · 第 '+fn.line+' 行':''):'＋ 添加断点，圆点选择采集起点。';}
function renderBreakpoints(){
  const rows=target.breakpoints.items.map(bp=>{const row=document.createElement('div');row.className='breakpoint-row'+(bp.address===state.entryAddress?' selected':'');
    const enabled=document.createElement('input');enabled.type='checkbox';enabled.checked=bp.enabled;enabled.title='启用 / 禁用断点';enabled.setAttribute('aria-label','启用断点 '+bp.label);enabled.onchange=()=>perform(async()=>{if(target.probe)await target.halt();if(!enabled.checked){await target.breakpoints.disarm(bp);bp.enabled=false;bp.status='已禁用';if(state.entryAddress===bp.address)state.entryAddress=null;}else{bp.enabled=true;bp.status='待下发';if(target.probe){await target.verifyElf(state.elfInfo);await target.breakpoints.arm(bp);}}if(target.probe)await showTarget(await target.inspect());});
    const start=document.createElement('input');start.type='radio';start.name='capture-entry';start.checked=bp.address===state.entryAddress;start.title='选择为采集起点';start.setAttribute('aria-label','采集起点 '+bp.label);start.onchange=()=>{if(!bp.enabled){error(Error('请先启用此断点'));renderBreakpoints();return;}state.entryAddress=bp.address;renderBreakpoints();controls();};
    const desc=document.createElement('span');desc.className='bp-description';desc.textContent=bp.label;desc.title=bp.file||bp.label;const status=document.createElement('small');status.textContent=hex(bp.address)+' · '+bp.status+(bp.address===state.entryAddress?' · 采集起点':'');desc.append(status);
    const del=document.createElement('button');del.textContent='×';del.title='删除此断点';del.setAttribute('aria-label','删除断点 '+bp.label);del.onclick=()=>perform(async()=>{if(target.probe)await target.halt();await target.breakpoints.remove(bp);if(state.entryAddress===bp.address)state.entryAddress=null;if(target.probe)await showTarget(await target.inspect());});row.append(enabled,start,desc,del);return row;});
  $('breakpoint-list').replaceChildren(...rows);if(!rows.length)$('breakpoint-list').textContent='无断点；从函数前 ＋ 或命令添加。';
  $('break-capacity').textContent=target.probe&&target.breakpoints.capacity!==null?target.breakpoints.items.filter(b=>b.lease).length+' / '+target.breakpoints.capacity:'未连接';
  $('break-state').textContent=state.entryAddress===null?'请选择一个断点作为采集起点':'采集起点 '+hex(state.entryAddress);controls();
}
async function perform(fn,{hardware=!!target.probe}={}){if(state.operation||state.job)return;state.operation=true;state.hardwareOperation=hardware;$('job-state').classList.remove('bad');controls();try{await(hardware?runEmbedded(host,fn):fn());}catch(e){error(e);}finally{state.operation=false;state.hardwareOperation=false;renderSymbols();renderBreakpoints();controls();}}
async function addBreakpoint(item){const bp=target.breakpoints.add(item);if(state.entryAddress===null)state.entryAddress=bp.address;
  if(target.probe){await target.verifyElf(state.elfInfo);await target.breakpoints.arm(bp);await showTarget(await target.inspect());}$('job-state').textContent='已添加 '+bp.label+(target.probe?' · 硬件断点已生效':' · 待连接后下发');log('添加断点 '+bp.label+' · '+hex(bp.address)+(target.probe?'；目标暂停':'；连接后下发'));}
async function commandBreakpoint(){const data=await api('elf/'+state.elfId+'/breakpoint',{spec:$('break-command').value});
  if(data.candidates.length===1){await addBreakpoint(data.candidates[0]);$('break-command').value='';$('break-candidates').hidden=true;return;}
  const box=$('break-candidates');box.hidden=false;box.textContent='对应多个指令位置，请选择：';for(const item of data.candidates){const button=document.createElement('button');button.textContent=item.file+':'+item.line+' · '+item.function+' · '+hex(item.address);button.onclick=()=>perform(async()=>{await addBreakpoint(item);box.hidden=true;$('break-command').value='';});box.append(button);}}
$('break-command-form').onsubmit=e=>{e.preventDefault();perform(commandBreakpoint);};
function setElf(info,id=null,file=null){if(state.elfInfo&&state.elfInfo.sha256!==info.sha256)state.lastTraceConfig=null;state.pendingBreakpointRestore=[];state.elfInfo=info;state.elfId=id||info.elfId;state.elfFile=file;state.entryAddress=null;state.symbolAddress=null;state.sourceFiles={};state.sourceSnapshot=null;state.sources=new SourceStore();$('symbol-search').value='';$('elf-label').textContent=(file?.name||info.name)+' · '+info.sha256.slice(0,12);$('sources-label').textContent='目标源码尚未选择；历史记录使用自身快照';$('break-candidates').hidden=true;renderSymbols();renderBreakpoints();}
let symbolTimer;
$('symbol-search').oninput=()=>{clearTimeout(symbolTimer);symbolTimer=setTimeout(renderSymbols,120);};
for(const p of COMMON_TARGETS)$('target-profile').append(new Option(p.name,p.id));
$('target-profile').onchange=()=>{target.profile=$('target-profile').value;state.lastTraceConfig=null;const value=state.hseValues[target.profile];$('hse').value=value??'';target.hseHz=value?value*1e6:null;showClocks();};
$('next-clock').onclick=()=>panel('clock');$('next-trace').onclick=()=>panel('trace');
async function resumeBreakpoints(items){
  if(!target.probe)return;const running=!(await target.isHalted());await target.halt();
  await target.breakpoints.resume(items);if(!running)target.breakpoints.hit(await target.pc());
  if(state.pendingBreakpointRestore===items)state.pendingBreakpointRestore=[];
  if(running)await target.run();renderBreakpoints();
}
async function withBreakpointsSuspended(fn){const items=target.breakpoints.items.filter(b=>b.lease);await target.halt();state.pendingBreakpointRestore=items;state.waiting=true;return withCleanup(async()=>{await target.breakpoints.suspend();renderBreakpoints();return await fn();},async()=>{state.waiting=false;await resumeBreakpoints(items);},e=>log('断点恢复失败（保留首次错误）：'+e.message));}
async function showTarget(info){state.lastTraceConfig=info.traceSupported&&info.config?{...info.config}:null;$('target-state').textContent=info.name+' · '+(info.halted?'已暂停':'运行中')+' · DEV_ID '+hex(info.device&4095);$('config-values').textContent=JSON.stringify(info,null,2);
  $('target-capability').textContent=info.etmVersion+(info.traceSupported?info.profile==='stm32h743'?' · 实验适配':' · 已适配':' · Trace 待适配');$('target-capability').title=info.traceStatus;$('expected-cpu').max=String(targetPort(info.profile).maxCoreHz/1e6);
  const f103=info.profile==='stm32f103ze';
  if(info.traceSupported&&!state.traceConfigDirty){
    $('traceid').value=info.config.traceid>=1&&info.config.traceid<=111?info.config.traceid:2;
    const current=traceSettings(info.config);if(current){$('branch-broadcast').checked=current.branchBroadcast;$('return-stack').checked=current.returnStack;$('cycles').checked=current.cycleCount;}
  }
  for(const [id,option]of [['branch-broadcast','branchBroadcast'],['return-stack','returnStack'],['cycles','cycleCount']]){
    if(info.traceOptions?.[option]===false)$(id).checked=false;
  }
  $('branch-broadcast').title=info.traceOptions?.branchBroadcast===false?'当前目标未实现分支广播':'增加分支地址输出，可能引起 overflow；F103 CDC 建议关闭，关闭后仍依赖匹配 ELF 重建执行流';
  if(f103){$('return-stack').checked=false;$('cycles').checked=false;$('pin-speed').value='3';}
  $('return-stack').title=f103?'ETM-M3 返回栈位保留，不支持此选项':info.traceOptions?.returnStack===false?'当前 ETM 回读未实现返回栈压缩':'减少函数返回地址输出，降低带宽';$('cycles').title=f103?'ETM-M3 周期准确模式位保留，不支持此选项':info.traceOptions?.cycleCount===false?'当前 ETM 回读未实现周期计数':'增加周期信息和输出量；当前图表仍按执行序号展示';
  $('pin-speed').querySelector('[value="3"]').textContent=f103?'50 MHz · AF 推挽':'超高速 · 基准值';
  $('pin-speed').closest('details').querySelector('.hint').textContent=f103?'4 位 DDR：ETM → TPIU，PE2～PE6。时钟由固件提供；Web 配置引脚和 Trace 寄存器，并行协议保持 0。':'已验收：4 位并行 DDR，ETM → Funnel → ETF → TPIU。输出时钟由固件提供。';
  if(info.traceSupported)updateTraceConfigState(info);
  $('live-pc').textContent=info.halted?'当前 PC：'+hex(await target.pc()):'当前目标运行中；暂停后读取 PC';if(info.halted)target.breakpoints.hit(await target.pc());showClocks(info);renderBreakpoints();
}
function showClocks(info=target.info){const c=info?.clocks,mhz=n=>n===null||n===undefined?'未知':(n/1e6).toFixed(3)+' MHz';$('clock-state').textContent=info?.clockError||(c?'CPU '+mhz(c.coreHz)+' / HCLK '+mhz(c.hclkHz)+' / TRACECLK '+mhz(c.physicalTraceHz)+'\n'+c.path:'尚未连接；填写的预期值不是回读结果');
  if($('auto-clock').checked){$('expected-cpu').value=c?.coreHz?Number((c.coreHz/1e6).toFixed(6)):'';$('expected-trace').value=c?.physicalTraceHz?Number((c.physicalTraceHz/1e6).toFixed(6)):'';}
  $('expected-cpu').disabled=state.operation||$('auto-clock').checked;$('expected-trace').disabled=state.operation||$('auto-clock').checked;
  if(c?.coreHz&&c?.physicalTraceHz){const match=Math.abs(c.coreHz-Number($('expected-cpu').value)*1e6)<100&&Math.abs(c.physicalTraceHz-Number($('expected-trace').value)*1e6)<100;$('clock-match').textContent=match?'实际时钟与填写的预期值一致':'实际时钟与预期不一致，请核对固件与板级晶振';$('clock-match').classList.toggle('bad',!match);}else $('clock-match').textContent='';clockPlan();}
function clockPlan(){const cpu=Number($('expected-cpu').value),trace=Number($('expected-trace').value),rate=Number($('rate').value),hse=Number($('hse').value);
  if(!(cpu>0&&trace>0&&hse>0)){$('clock-plan').textContent=$('auto-clock').checked?'连接目标并填写板上 HSE 后，根据 RCC 自动计算频率。':'请填写有效的板级和预期频率';return;}
  if(target.info?.profile&&!target.info.profile.startsWith('stm32h7')){$('clock-plan').textContent=target.info.clocks?.path+'\nTrace 输入 = HCLK；TRACECLK = HCLK / 2（4 位 DDR）\n每半周期约 '+(rate/(2*trace*1e6)).toFixed(2)+' 个采样点\n固件负责 HSE/PLL/Flash/业务外设；Web 配置 Trace 引脚、ETM/TPIU 与采样。'+(target.info.traceSupported?'':'\n本型号 Trace 输出仍待适配。');return;}
  const registers=target.info?.rcc,actual=target.info?.clocks;
  const vco=registers&&actual?.coreHz?actual.coreHz*actual.coreDivider*(((registers.pllDiv>>>9)&127)+1)/1e6:null;
  const samples=rate/(2*trace*1e6);
  $('clock-plan').textContent=(vco?'当前 RCC 对应 VCO '+vco.toFixed(3)+' MHz：\nP = '+(vco/cpu).toFixed(3)+'，R = '+(vco/(2*trace)).toFixed(3):'连接目标并识别 RCC 后显示 PLL 分频')+'\nCPU / TRACECLK = '+(cpu/trace).toFixed(2)+'\n每半周期约 '+samples.toFixed(2)+' 个采样点\n固件负责 HSE/PLL、供电、Flash 和业务外设；Web 不改变 CPU/Trace 输入频率。\n零解码错误和频率比例都不能单独证明无损。';

}
$('hse').onchange=()=>{const value=Number($('hse').value),profile=target.info?.profile||$('target-profile').value;target.hseHz=value>0?value*1e6:null;state.hseValues[profile]=value>0?value:null;
  if(target.info){try{target.info.clocks=completeClocks(targetPort(target.info.profile),target.info.rcc,target.hseHz);target.info.clockError=null;}catch(e){target.info.clocks=null;target.info.clockError=e.message;}}showClocks();};
$('auto-clock').onchange=()=>showClocks();
for(const id of ['expected-cpu','expected-trace','rate'])$(id).onchange=()=>showClocks();
$('sync').onchange=controls;
$('entry-before').onchange=controls;
function renderRecordOptions(){
  const all=$('show-experiments').checked,current=state.current;
  const visible=state.records.filter(r=>!r.id.startsWith('elf-')&&(all||r.recordKind==='demo'||r.recordKind==='user'||r.id===current));
  const groups=[];
  for(const [kind,label]of [['demo','Demo'],['user','我的记录'],['experiment',all?'实验历史':'当前打开的历史']]){
    const items=visible.filter(r=>r.recordKind===kind);if(!items.length)continue;
    const group=document.createElement('optgroup');group.label=label;
    for(const r of items){const option=new Option((kind==='demo'?'Demo · 70/35 MHz · 1 ms':r.name)+(r.decoded?'':' · 未解码'),r.id);option.title=r.name;group.append(option);}groups.push(group);
  }
  $('records').replaceChildren(new Option('选择记录…',''),...groups);if(current)$('records').value=current;
}
async function refreshRecords(){state.records=await api('records');renderRecordOptions();}
$('show-experiments').onchange=renderRecordOptions;
async function loadRecord(id){if(!id)throw Error('请选择记录');history.range=null;history.rangeHistory=[];history.window=null;$('scope-state').hidden=$('clear-scope').hidden=true;state.current=id;renderRecordOptions();$('records').value=id;const m=state.records.find(r=>r.id===id);
  if(m&&!m.decoded){history.unload(id);history.setLoading(false);$('record-description').textContent=m.name;$('metrics').textContent='原始记录';$('quality').textContent=m.error?'失败原因：'+m.error:'已保存波形，尚未解码';$('table-container').textContent='在文件页点击“单独解码”；失败记录保留原始证据';$('source-code').textContent='尚未解码，没有可信源码定位';$('source-location').textContent='';$('selected-instruction').textContent='';$('call-stack').textContent='尚未解码';return;}
  await history.load(id,m?.name);log('已按需载入记录 '+id);controls();
}
async function watchJob(id,{resume=false,kind='decode'}={}){
  state.job=id;state.jobKind=kind;state.jobPhase='queued';state.captureCancelled=false;controls();
  try{await pollJob(id,{read:id=>api('jobs/'+id),shouldResume:()=>!state.captureCancelled,
    onState:job=>{state.jobPhase=job.state;$('job-state').textContent={queued:'准备参数',starting:'LA 正在启动',armed:'LA 等待触发',saving:'保存原始数据',decoding:'解码与源码映射',done:'记录已保存',cancelled:'采集已取消',error:'操作失败'}[job.state];controls();},
    onResume:resume?async()=>{await target.run();log('LA 已就绪，CPU 从暂停位置继续；等待 D0 触发');}:null,
    onDone:async job=>{await refreshRecords();await loadRecord(job.record);}
  });}catch(e){
    if(kind==='capture'){
      state.failedCaptureJob=id;
      try{await api('stop/'+id,{});state.failedCaptureJob=null;}
      catch(cleanup){log('采集停止未确认：'+cleanup.message+'；请点击“停止采集”重试，确认前不能新建采集');}
    }
    throw e;
  }finally{state.job=null;state.jobKind=null;state.jobPhase=null;controls();}
}
on('connect',async()=>{state.lastTraceConfig=null;target.profile=$('target-profile').value;target.hseHz=null;const info=await target.connect();const hse=state.hseValues[info.profile]??state.hseValues.auto;$('hse').value=hse??'';target.hseHz=hse?hse*1e6:null;if(state.hseValues.auto!==undefined){state.hseValues[info.profile]=hse;delete state.hseValues.auto;}await showTarget(await target.inspect());if(state.elfInfo&&target.breakpoints.items.some(b=>b.enabled)){await target.verifyElf(state.elfInfo);await target.breakpoints.resume();await showTarget(await target.inspect());}});
on('recover-debug',async()=>{await target.recoverDebugPort();if(state.pendingBreakpointRestore.length){await target.verifyElf(state.elfInfo);await resumeBreakpoints(state.pendingBreakpointRestore);}await showTarget(await target.inspect());$('job-state').classList.remove('bad');$('job-state').textContent='调试口已恢复，目标暂停；请重新联动采集';});
async function disconnectTarget(){await target.disconnect();target.info=null;showClocks();$('target-state').textContent='探针已断开';$('live-pc').textContent='当前 PC：未连接';renderBreakpoints();controls();}
on('disconnect',disconnectTarget);
on('read-config',async()=>{const info=await target.inspect();state.traceConfigDirty=false;await showTarget(info);});on('read-clock',async()=>showTarget(await target.inspect()));on('halt',async()=>{await target.halt();await showTarget(await target.inspect());});
on('run',async()=>{await target.clearEntryBreak();await target.run();await showTarget(await target.inspect());});
on('reset',async()=>{await target.verifyElf(state.elfInfo);await showTarget(await withBreakpointsSuspended(()=>target.reset({address:entry()})));$('break-state').textContent='已暂停在所选起点；调试断点已恢复';});
on('run-to',async()=>{await target.verifyElf(state.elfInfo);$('break-state').textContent='正在运行至所选断点…';await showTarget(await withBreakpointsSuspended(()=>target.runTo(entry())));$('break-state').textContent='已命中 '+hex(entry())+'；调试断点已恢复';});
on('remove-break',async()=>{if(target.probe)await target.halt();await target.breakpoints.clear();state.entryAddress=null;renderSymbols();renderBreakpoints();if(target.probe)await showTarget(await target.inspect());});
on('cancel-wait',async()=>{target.cancelEntry=true;log('已请求取消等待断点');},{exclusive:false});
on('apply-config',async()=>{entry(true);const info=await target.configure(options());state.traceConfigDirty=false;await showTarget(info);});on('restore-config',async()=>{await target.restore();state.traceConfigDirty=false;await showTarget(await target.inspect());log('原 trace 设置已恢复并重新回读');});
on('check-la',async()=>{const s=await api('status');$('la-state').textContent='Kingst 已连接';$('la-state').className='status good';const old=$('rate').value;$('rate').replaceChildren(...s.rates.filter(n=>n>=50000000).map(n=>new Option(n/1e6+' MSa/s',n)));$('rate').value=s.rates.includes(Number(old))?old:String(s.rates[0]);clockPlan();});
on('open-record',()=>loadRecord($('records').value));
on('start',async()=>{const sync=$('sync').checked,tokens=$('channels').value.split(','),channels=tokens.map(s=>Number(s.trim()));if(tokens.some(t=>!t.trim())||channels.length!==5||new Set(channels).size!==5||channels.some(c=>!Number.isInteger(c)||c<0||c>15))throw Error('需要五个不同且不为空的 CH0～15 通道');
  const glitchNs=Number($('glitch-ns').value);if(!Number.isFinite(glitchNs)||glitchNs<0||glitchNs>100)throw Error('软件滤波须为 0～100 ns，0 表示关闭；尚未操作目标');
  const rate=Number($('rate').value),seconds=Number($('duration').value)/1000,threshold=Number($('threshold').value),fraction=Number($('fraction').value),requested=options();
  if(!Number.isInteger(rate)||!(rate>0&&rate<=500000000&&seconds>0&&seconds<=2&&rate*seconds<=100000000))throw Error('采集参数无效：时间上限 2 秒、深度上限 1 亿样本；尚未操作目标');
  if(!Number.isFinite(threshold)||threshold< -4||threshold>4||!(fraction>0&&fraction<1))throw Error('阈值或取样相位无效；尚未操作目标');
  if(!Number.isInteger(requested.traceid)||requested.traceid<1||requested.traceid>111)throw Error('Trace ID 范围为 1～111；尚未操作目标');
  log('采集步骤：检查逻辑分析仪');const available=await api('status');if(available.captureProtocol!==2)throw Error('本地 ETM 桥版本不匹配，请重启或更新完整桥包，避免新页面混用旧解码器；尚未操作目标');if(!available.rates.includes(rate))throw Error('LA 不支持所选采样率；请选择设备支持的采样率，尚未操作目标');
  const flashLimit=target.info?.flashLimit||0x08020000;
  if(state.elfInfo.segments.some(s=>s.address+atob(s.data).length>flashLimit))throw Error('ELF 超出当前目标的 Trace Flash 范围');
  const captureElf=state.elfInfo,captureElfId=state.elfId,captureSourceSnapshot=state.sourceSnapshot,requestedOptions=options(),selectedEntry=sync&&$('entry-before').checked?entry(true):null;
  let config={traceid:Number($('traceid').value),config:1},captureEntry=null,suspendedBps=[];
  let stage='校验 ELF';
  await withCleanup(async()=>{try{
  log('采集步骤：'+stage);
  if(sync){if(!target.probe)throw Error('请先连接探针');if(!target.info?.traceSupported)throw Error(target.info?.traceStatus||'目标 trace 未适配');await target.verifyElf(captureElf);stage='暂停本页断点';log('采集步骤：'+stage);suspendedBps=target.breakpoints.items.filter(b=>b.lease);state.pendingBreakpointRestore=suspendedBps;await target.breakpoints.suspend();renderBreakpoints();
    stage=$('entry-before').checked?$('reset-before').checked?'复位并停在业务起点':'运行至业务起点':'暂停当前目标';log('采集步骤：'+stage);
    if($('entry-before').checked){captureEntry=selectedEntry;await showTarget($('reset-before').checked?await target.reset({address:captureEntry}):await target.runTo(captureEntry));}
    else await target.halt();
    stage='核对实际时钟';log('采集步骤：'+stage);const before=await target.inspect(),c=before.clocks;
    if(!c?.coreHz||!c?.physicalTraceHz||Math.abs(c.coreHz-Number($('expected-cpu').value)*1e6)>100||Math.abs(c.physicalTraceHz-Number($('expected-trace').value)*1e6)>100){
      const fmt=(hz)=>hz?(hz/1e6).toFixed(3)+' MHz':'未知';
      const detail='实测 CPU '+fmt(c?.coreHz)+' / TRACECLK '+fmt(c?.physicalTraceHz)+
        '；预期 '+($('expected-cpu').value||'未填')+' / '+($('expected-trace').value||'未填')+' MHz';
      const hint=!$('hse').value
        ? '。最可能的原因：『2 时钟』页的 HSE 没填 —— 不填就算不出实际频率（本板 HSE 常见 25 MHz；F103 多为 8 MHz）'
        : '。请在『2 时钟』页核对 HSE 与预期 CPU/TRACECLK';
      throw Error(detail+hint+'；目标保持暂停');
    }
    stage='配置 ETM / TPIU';log('采集步骤：'+stage);await showTarget(await target.configure(requestedOptions));config=target.config;
  }else config=externalDecodeConfig();
  stage='启动 LA 并采集';log('采集步骤：'+stage);const created=await api('capture',{rate:Number($('rate').value),seconds:Number($('duration').value)/1000,threshold:Number($('threshold').value),sync,decode:$('auto-decode').checked,clock:channels[0],data:channels.slice(1),fraction:Number($('fraction').value),glitchNs:Number($('glitch-ns').value),config,elfId:captureElfId,targetVerified:sync,targetSnapshot:sync?target.info:null,captureScope:sync?'business-unfiltered-window':'externally-configured-window',captureEntry,sourceSnapshot:captureSourceSnapshot});
  log('联动任务创建；起点 '+(captureEntry===null?'当前暂停位置':hex(captureEntry)));await watchJob(created.job,{resume:sync,kind:'capture'});
  }catch(e){throw new Error(stage+'失败：'+e.message,{cause:e});}},async()=>{if(sync&&target.probe){target.assertTransport();await target.clearEntryBreak();await target.restore();await resumeBreakpoints(suspendedBps);await showTarget(await target.inspect());log('本次 trace 配置与断点已恢复；目标状态已刷新');}},e=>log('采集后的清理/回读失败（未覆盖首次错误）：'+e.message));
});
on('stop',async()=>{state.captureCancelled=true;const id=state.job||state.failedCaptureJob;if(id){await api('stop/'+id,{});state.failedCaptureJob=null;controls();}},{exclusive:false});
on('decode',async()=>{if(!state.current)throw Error('请选择记录');await watchJob((await api('decode/'+state.current,{})).job);});
function download(kind){if(!state.current)throw Error('请选择记录');const a=document.createElement('a');a.href=apiBase+'download/'+state.current+'/'+kind+(history.range&&['source','simplified','simplified-html','csv'].includes(kind)?'?fromSeq='+history.range.start+'&toSeq='+history.range.end:'');a.download='';a.click();}
on('save-record',()=>download('record'));on('export',()=>download($('export-type').value));on('import',()=>$('capture-file').click());on('choose-elf',()=>$('elf-file').click());on('choose-sources',async()=>{
  if(!SourceStore.supported()||state.sourceCompat){$('sources-files').click();return;}
  const store=new SourceStore(),paths=state.elfInfo?.sourceFiles||history.result?.sourceFiles||[];
  if(!paths.length)throw Error('当前 ELF 没有 DWARF 源码路径，不会扫描整个目录');
  store.setExpectedPaths(paths);
  try{await store.pick();await saveSourceStore(store);}catch(e){if(e.name==='AbortError')return;if(['SecurityError','NotSupportedError','NotAllowedError'].includes(e.name)){state.sourceCompat=true;log('此环境无法使用原生目录授权；再次点击“选择源码目录”将使用兼容选择');return;}throw e;}
});
$('elf-file').onchange=async()=>{if(state.operation||state.job){error(Error('请等待当前操作完成后再载入 ELF'));$('elf-file').value='';return;}try{await perform(async()=>{const file=$('elf-file').files[0];if(!file)return;const form=new FormData();form.append('elf',file);const info=await api('elf',form);if(target.probe)await target.halt();await target.breakpoints.clear();setElf(info,info.elfId,file);log('ELF 已载入，请添加断点并选择采集起点');});}finally{$('elf-file').value='';}};
async function saveSourceStore(store){
  const info=state.elfInfo||(state.current&&await api('record-elf/'+state.current));
  if(!info)throw Error('请先载入 ELF 或打开历史记录，才能读取配套源码');
  const references=info.sourceFiles||[];
  if(!references.length)throw Error('此 ELF 没有 DWARF 源码行路径，不会读取整个目录');
  await store.setExpectedPaths(references);
  const {sources,failed}=await readReferencedSources(store,references),count=Object.keys(sources).length;
  if(!count)throw Error(failed[0]?.error||'所选目录未匹配到配套源码');
  const batches=sourceBatches(sources);let saved=null;
  for(let i=0;i<batches.length;i++){
    $('sources-label').textContent='保存配套源码 '+(i+1)+' / '+batches.length+' 批…';
    saved=await api('source-snapshots',{elfId:info.elfId,snapshot:saved?.snapshot,sources:batches[i],complete:i===batches.length-1});
  }
  state.sources=store;
  if(state.elfInfo){state.sourceFiles=sources;state.sourceSnapshot=saved.snapshot;}
  $('sources-label').textContent='匹配 '+count+' / '+references.length+' 个文件 · '+(saved.bytes/1024/1024).toFixed(2)+' MiB · 已保存本地快照'+(failed.length?' · 未读到 '+failed.length:'');
  log(store.summary()+'；按需读取 '+count+' 个配套文件，采集请求只传快照编号');
  for(const failure of failed)log(failure.error);
  if(state.current&&history.result&&info.sha256===history.result.elf.sha256){
    await api('sources/'+state.current,{elfId:info.elfId,sourceSnapshot:saved.snapshot});await history.refreshSources();
  }
  $('job-state').classList.remove('bad');$('job-state').textContent='配套源码已保存，可继续采集';
}
$('sources-files').onchange=async()=>{
  if(state.operation||state.job){error(Error('请等待当前操作完成后再选择源码'));return;}
  const files=[...$('sources-files').files];if(!files.length)return;
  state.operation=true;controls();
  try{
    const store=new SourceStore(),info=state.elfInfo||(state.current&&await api('record-elf/'+state.current));
    if(!info?.sourceFiles?.length)throw Error('请先载入有 DWARF 源码路径的 ELF，不会读取整个目录');
    await store.setExpectedPaths(info.sourceFiles);store.indexFileList(files);await saveSourceStore(store);
  }catch(e){error(e);}finally{state.operation=false;$('sources-files').value='';controls();}
};
$('capture-file').onchange=async()=>{if(state.operation||state.job){error(Error('请等待当前操作完成后再导入'));$('capture-file').value='';return;}try{await perform(async()=>{const f=$('capture-file').files[0];if(!f)return;const form=new FormData();form.append('capture',f);if(!f.name.toLowerCase().endsWith('.etmrecord')){if(!state.elfInfo)throw Error('导入原始 CSV/BIN 前请在调试页载入匹配 ELF；记录包可直接导入');if(state.elfFile)form.append('elf',state.elfFile);else{const response=await fetch(state.elfInfo.download||apiBase+'record-firmware/'+state.elfId);if(!response.ok)throw Error('先选择匹配 ELF');form.append('elf',new Blob([await response.arrayBuffer()]),'firmware.elf');}form.append('config',JSON.stringify(externalDecodeConfig()));form.append('fraction',$('fraction').value);form.append('glitchNs',$('glitch-ns').value);for(const [name,text]of Object.entries(state.sourceFiles))form.append('sources',new Blob([text]),name);}const saved=await api('import',form);await refreshRecords();await watchJob((await api('decode/'+saved.record,{})).job);},{hardware:false});}catch(e){error(e);}finally{$('capture-file').value='';}};
function sideButtonLabel(){$('toggle-settings').textContent=innerWidth<=780?'采集设置':document.body.classList.contains('side-hidden')?'显示控制':'收起控制';}
$('help').onclick=()=>$('help-dialog').showModal();$('close-help').onclick=()=>$('help-dialog').close();$('toggle-settings').onclick=()=>{document.body.classList.toggle(innerWidth<=780?'settings-open':'side-hidden');sideButtonLabel();};window.addEventListener('resize',sideButtonLabel);sideButtonLabel();
$('toggle-source').onclick=()=>{const open=document.body.classList.toggle('source-open');$('toggle-source').textContent=open?'轨迹':'源码';$('toggle-source').setAttribute('aria-expanded',String(open));};
const divider=document.querySelector('.pane-divider');function setRatio(percent){const value=Math.max(25,Math.min(75,percent));$('analysis-panes').style.setProperty('--trace-width',value+'%');divider.setAttribute('aria-valuenow',String(Math.round(value)));}
divider.onpointerdown=e=>{divider.setPointerCapture(e.pointerId);divider.onpointermove=v=>{if(divider.hasPointerCapture(v.pointerId)){const box=$('analysis-panes').getBoundingClientRect();setRatio((v.clientX-box.left)/box.width*100);}};divider.onpointerup=v=>divider.releasePointerCapture(v.pointerId);};divider.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const value=parseFloat($('analysis-panes').style.getPropertyValue('--trace-width'))||52;setRatio(value+(e.key==='ArrowLeft'?-3:3));}};
async function init(){state.operation=true;controls();history.setLoading(true);renderSymbols();renderBreakpoints();try{await refreshRecords();$('service-state').textContent='本地服务在线';$('service-state').className='status good';showClocks();}catch(e){error(e);}finally{state.operation=false;history.setLoading(false);controls();}}
const embeddedBridge={probe:()=>target.probe,busy:()=>!!(state.hardwareOperation||state.jobKind==='capture'||target.probe&&(state.job||state.waiting)),
  requestStop:async()=>{
    target.cancelEntry=true;state.captureCancelled=true;
    if(state.jobKind==='decode')throw Error('正在解码，等待结束或超时后再重新检测');
    if(state.job)await api('stop/'+state.job,{});
    const until=Date.now()+20000;
    while(state.operation||state.job){if(Date.now()>until)throw Error('旧任务尚未完成清理，保留探针；请等待结束后重试');await sleep(50);}
  },
  release:async()=>{if(target.transportFault)throw Error('旧调试口仍故障；先点击恢复调试口，避免丢失待恢复的配置');if(embeddedBridge.busy())throw Error('ETM正在操作或采集，请先停止');await disconnectTarget();},
  recoverForRelease:async()=>{if(embeddedBridge.busy())throw Error('旧任务仍在清理，不能恢复或释放探针');await target.recoverDebugPort();},
  summary:()=>({record:state.current,job:state.job,target:target.info?.name||null,transportFault:target.transportFault})};
window.__etmBridge=embeddedBridge;
target.canRelease=()=>!embeddedBridge.busy()&&!target.transportFault;
let attached=true;
try{if(host)host.attach(embeddedBridge,window);}catch(e){attached=false;state.operation=true;error(e);controls();}
// Developer diagnostics also used by the integrated page acceptance tests.
window.__etm={target,state,history,api};
if(attached)init();

// 与操作互斥的轻量状态回读，实际命中后刷新 PC 和断点标记。
setInterval(async()=>{if(!target.probe||state.operation||state.job||!target.breakpoints.items.some(b=>b.lease)||target.info?.halted||target.transportFault)return;
  state.operation=true;state.hardwareOperation=true;try{await runEmbedded(host,async()=>{if(await target.isHalted())await showTarget(await target.inspect());});}catch(e){error(e);}finally{state.operation=false;state.hardwareOperation=false;controls();}},800);
