import { esc } from './dom.js';
import { EVKLITE_J3 } from './board-pinout.js';

const FEATURES=Object.freeze({
  spicdc:{title:'SPI转发 · 引脚分配图',signals:{13:'SCK IN · PB11',26:'CS IN · PB10',28:'MOSI IN · PB13'},
    wiring:'外部主机 CS → J3[26] / PB10；SCK → J3[13] / PB11；MOSI → J3[28] / PB13；主机 GND → 任一 J3 GND。PB12 / J3[27] MISO 可不接。',
    notes:['探针作为 SPI 从机接收，时钟由外部主机提供；3.3 V 电平、CS 低有效、8 位数据，模式和位顺序需与主机一致。',
      '接收数据经探针 CDC 串口输出，先连接接收串口，再启动外部主机发送。',
      '与 USB→SPI/QSPI、SPI/QSPI 屏及 ADC 共用资源；CDC 与 UART、RTT 转发共用串口，使用前停止对应功能。']},
  i2c:{title:'I²C 接线',signals:{19:'SCL · PA29',21:'SDA · PA28'},
    wiring:'SCL → J3[19] / PA29；SDA → J3[21] / PA28；器件 GND → 任一 J3 GND。',
    notes:['SDA 板上没有上拉；SCL 有 R6 10 kΩ 上拉。核对模块已有上拉，裸器件需配外部上拉至 3.3 V；内部上拉只作低速短线应急。',
      '不要把 SDA/SCL 上拉到 5 V。J3 的 3V3 是供电节点，外部供电器件仅需共地，避免两路电源互相回灌。',
      'PA29/SCL 与 USB0_OC 故障线共用，USB 限流故障可能拉低 SCL。板丝印的 SPI_MOSI/MISO 是旧标注，以 MCU 引脚号为准。',
      'PA28/PA29 也可被 SPI 辅助脚使用；切换前释放对应功能，不要同时驱动。']},
  adc:{title:'ADC 接线',signals:{10:'ADC0.6 IN · PB14'},
    wiring:'信号输入 → J3[10] / PB14 / ADC0_IN6；信号地 → 任一 J3 GND。',
    notes:['输入必须在 0–VREFH 范围内，VREFH 默认 3.3 V；禁止接 5 V、负电压或超出参考的信号。',
      '网页“ADC 参考 V”只校准电压换算，不改变硬件输入范围。J3 的 3V3 供电节点不是独立可调 ADC 参考端。',
      'PB14 与 QSPI IO2 共脚。使用 ADC 前停止 SPI/QSPI，并断开外设对 PB14 的驱动；软件互斥不能断开外部电气连接。',
      '高速采样宜使用低阻信号源。信号源与 probe 共地；不要将未知电位的地线直接短接。']},
});

/** Board ID is absent from current HID ABI: never infer pinout from a product name. */
export function pinMapModel(feature,board,{connected=false,supported, mock=false,lost=false}={}){
  const spec=FEATURES[feature];if(!spec)throw Error('未知引脚图功能');
  if(connected&&supported===false)return {title:spec.title,available:false,message:'当前固件未提供此功能，请勿按参考图接线。'};
  if(board!=='hpm5301evklite')return {title:spec.title,available:false,message:'请先确认并选择板型。当前协议不返回板卡 ID，未知板型不显示固定接线。'};
  return {...spec,available:true,message:`HPM5301EVKLite · J3 40 针 · ${mock?'模拟会话，无真实硬件':lost?'连接已失联，仅作参考':connected?'板型由你选择，未自动识别':'未连接，离线参考图'}。请与实物核对。`};
}

export function pinMapTable(model){
  if(!model.available)return '';
  const cell=([pin,name])=>{
    const signal=model.signals[pin],ground=name==='GND';
    const cls=signal?'is-signal':ground?'is-ground':name==='5V0'?'is-no':'is-plain';
    return `<td class="p-pin">${pin}</td><td class="p-name ${cls}"><span class="p-mark">${signal?'★':ground?'●':'·'}</span>${esc(name)}${signal?`<span class="p-note">${esc(signal)}</span>`:''}</td>`;
  };
  const rows=[];for(let i=0;i<EVKLITE_J3.length;i+=2)rows.push(`<tr>${cell(EVKLITE_J3[i])}${cell(EVKLITE_J3[i+1])}</tr>`);
  return '<table class="pintab" aria-label="J3 实物针号，奇数在左、偶数在右"><tbody>'+rows.join('')+'</tbody></table>';
}

/** Read-only, lazy modal. No hardware requests, timers or resource acquisition. */
export class PinMap {
  constructor({buttonId,feature,state=()=>({})}){this.buttonId=buttonId;this.feature=feature;this.state=state;}
  init(){
    this.button=document.getElementById(this.buttonId);
    this.button?.setAttribute?.('aria-haspopup','dialog');
    this.button?.addEventListener('click',()=>this.open());
  }
  _create(){
    const box=document.createElement('div');box.className='pinmodal';box.hidden=true;
    box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-labelledby',this.buttonId+'-title');
    box.innerHTML=`<div class="pinmodal-box"><div class="pinmodal-head"><b id="${esc(this.buttonId)}-title">${esc(FEATURES[this.feature].title)}</b><button class="mini" data-close>关闭 ✕</button></div><div class="pinmodal-body"><label class="pinmap-board">确认板型 <select data-board><option value="">未知 / 其他板型</option><option value="hpm5301evklite">HPM5301EVKLite（J3 · 40 针）</option></select></label><p class="hint" data-message></p><div data-chart></div><p data-wiring></p><ul class="pinmap-notes" data-notes></ul><p class="hint">数字是 J3 实物针号，奇数在左、偶数在右。按板上 J3 的 1 脚标记辨认方向；图不是 USB 接口朝向图。</p></div></div>`;
    document.body.appendChild(box);this.box=box;
    this.board=box.querySelector('[data-board]');this.closeButton=box.querySelector('[data-close]');
    this.closeButton.addEventListener('click',()=>this.close());
    this.board.addEventListener('change',()=>this.refresh());
    box.addEventListener('click',e=>{if(e.target===box)this.close();});
    box.addEventListener('keydown',e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();this.close();}
      if(e.key==='Tab'){
        if(e.shiftKey&&document.activeElement===this.closeButton){e.preventDefault();this.board.focus();}
        else if(!e.shiftKey&&document.activeElement===this.board){e.preventDefault();this.closeButton.focus();}
      }
    });
  }
  open(){if(!this.box)this._create();this.box.hidden=false;this.refresh();this.closeButton.focus();}
  close(){if(this.box)this.box.hidden=true;this.button?.focus?.();}
  refresh(){
    if(!this.box)return;
    const state=this.state(),connection=state.connected?(state.connectionKey||true):null;
    if(this._connection!==undefined&&this._connection!==connection)this.board.value='';
    this._connection=connection;
    if(this.box.hidden)return;
    const model=pinMapModel(this.feature,this.board.value,state);
    this.box.querySelector('[data-message]').textContent=model.message;
    this.box.querySelector('[data-chart]').innerHTML=pinMapTable(model);
    this.box.querySelector('[data-wiring]').textContent=model.available?model.wiring:'';
    this.box.querySelector('[data-notes]').innerHTML=model.available?model.notes.map(n=>`<li>${esc(n)}</li>`).join(''):'';
  }
}
