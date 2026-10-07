/** Raw ADC measurements; display envelopes must never substitute for samples. */
export function measureAdc(codes,{rate,bits=16,reference=3.3}={}){
  const result={min:null,max:null,average:null,peakToPeak:null,period:null,frequency:null,reason:'等待采集'};
  if(!codes?.length||!(reference>0)||!(bits>0))return result;
  let min=Infinity,max=-Infinity,sum=0;
  for(const v of codes){min=Math.min(min,v);max=Math.max(max,v);sum+=v;}
  const scale=reference/(2**bits-1),mean=sum/codes.length,range=max-min;
  Object.assign(result,{min:min*scale,max:max*scale,average:mean*scale,peakToPeak:range*scale});
  if(range<Math.max(8,(2**bits-1)*0.001)){result.reason='直流或幅度不足';return result;}
  if(!(rate>0)){result.reason='缺少采样时基';return result;}
  const middle=(min+max)/2,low=middle-range*.15,crossings=[];
  let armed=codes[0]<=low;
  for(let i=1;i<codes.length;i++){
    const a=codes[i-1],b=codes[i];
    if(b<=low)armed=true;
    if(armed&&a<middle&&b>=middle){crossings.push(i-1+(middle-a)/(b-a));armed=false;}
  }
  if(crossings.length<3){result.reason='不足两个完整周期';return result;}
  const gaps=crossings.slice(1).map((v,i)=>v-crossings[i]),sorted=[...gaps].sort((a,b)=>a-b);
  const n=sorted.length,periodSamples=(sorted[(n-1)>>1]+sorted[n>>1])/2;
  if(periodSamples<4){result.reason='每周期采样点不足';return result;}
  if(gaps.some(v=>Math.abs(v-periodSamples)>Math.max(1,.12*periodSamples))){result.reason='周期不稳定';return result;}
  // Reject random threshold crossings: a periodic waveform must also repeat
  // its shape at the measured lag, rather than merely having similar gaps.
  const lag=Math.round(periodSamples);let dot=0,aa=0,bb=0;
  for(let i=lag;i<codes.length;i++){
    const a=codes[i]-mean,b=codes[i-lag]-mean;dot+=a*b;aa+=a*a;bb+=b*b;
  }
  if(!(aa>0&&bb>0)||dot/Math.sqrt(aa*bb)<.75){result.reason='未找到稳定周期';return result;}
  result.period=(crossings.at(-1)-crossings[0])/(crossings.length-1)/rate;
  result.frequency=1/result.period;result.reason='';return result;
}

export function cursorDelta(cursors){
  const dt=cursors.x?cursors.x[1]-cursors.x[0]:null;
  return {dt,frequency:dt===null||Math.abs(dt)<1e-15?null:1/Math.abs(dt),
    dv:cursors.y?cursors.y[1]-cursors.y[0]:null};
}
export function formatMeasure(value,unit){
  if(value===null||!Number.isFinite(value))return '—';
  const n=Math.abs(+value.toPrecision(5)); // Unit choice follows displayed precision at boundaries.
  if(unit==='s'){
    if(n>0&&n<1e-6)return `${+(value*1e9).toPrecision(5)} ns`;
    if(n<.001)return `${+(value*1e6).toPrecision(5)} µs`;
    if(n<1)return `${+(value*1e3).toPrecision(5)} ms`;
  }
  if(unit==='Hz'&&n>=1e6)return `${+(value/1e6).toPrecision(5)} MHz`;
  if(unit==='Hz'&&n>=1e3)return `${+(value/1e3).toPrecision(5)} kHz`;
  if(unit==='V'&&n>0&&n<.1)return `${+(value*1e3).toPrecision(5)} mV`;
  return `${+value.toPrecision(5)} ${unit}`;
}
