const NS='http://www.w3.org/2000/svg';
const ICONS={
  out:['circle',{cx:6.2,cy:6.2,r:4.2},'M9.4 9.4 14 14 M4.2 6.2h4'],
  in:['circle',{cx:6.2,cy:6.2,r:4.2},'M9.4 9.4 14 14 M6.2 4.2v4 M4.2 6.2h4'],
  fit:[null,null,'M5.5 2H2v3.5 M10.5 2H14v3.5 M2 10.5V14h3.5 M14 10.5V14h-3.5'],
};

function icon(kind){
  const svg=document.createElementNS(NS,'svg');svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('aria-hidden','true');
  const [tag,attrs,path]=ICONS[kind];
  if(tag){const shape=document.createElementNS(NS,tag);for(const [key,value]of Object.entries(attrs))shape.setAttribute(key,String(value));svg.append(shape);}
  const stroke=document.createElementNS(NS,'path');stroke.setAttribute('d',path);svg.append(stroke);return svg;
}

export function createZoomControls({onZoomOut,onZoomIn,onFit,disabled={}}){
  const group=document.createElement('div');group.className='zoom-controls';group.setAttribute('role','group');group.setAttribute('aria-label','图表缩放');
  const buttons={};
  for(const [kind,label,action]of [['out','缩小',onZoomOut],['in','放大',onZoomIn],['fit','适配全部区间',onFit]]){
    const button=document.createElement('button');button.type='button';button.className='zoom-button zoom-'+kind;button.title=label;button.setAttribute('aria-label',label);button.append(icon(kind));button.onclick=action;group.append(button);buttons[kind]=button;
  }
  return {element:group,setDisabled(state={}){buttons.out.disabled=!!state.zoomOut;buttons.in.disabled=!!state.zoomIn;buttons.fit.disabled=!!state.fit;}};
}
