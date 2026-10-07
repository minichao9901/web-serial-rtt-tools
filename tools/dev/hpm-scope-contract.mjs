// The target updates volatile fields sequentially; an SBA frame may straddle
// one 100 us tick. Accept each field at tick-1/tick/tick+1, report tearing
// separately. A skipped sample is not itself a corrupt waveform value.
export function checkHpmFrame(v,hiPhaseBudget=2){
  const sin=[0,.309017,.587785,.809017,.951057,1,.951057,.809017,.587785,.309017,
    0,-.309017,-.587785,-.809017,-.951057,-1,-.951057,-.809017,-.587785,-.309017];
  if('g_v_hi.tick' in v && 'g_v_hi.f_sin' in v){
    const t=v['g_v_hi.tick']>>>0,value=v['g_v_hi.f_sin'];
    const match=d=>Number.isFinite(value)&&Math.abs(value-Math.sin((((t+d)>>>0)%400)*Math.PI/200))<2e-6;
    if(match(0))return {bad:false,torn:false,phaseSkew:0};
    // SBA is asynchronous: SBADDRESS starts reading tick before the two
    // posted DMI scans that start reading f_sin. At ~2.59 us/scan, the
    // target's 5 us counter can advance twice between the two bus reads.
    for(let d=-1;d<=hiPhaseBudget;d++)if(d!==0&&match(d))
      return {bad:false,torn:true,phaseSkew:d,phaseOutlier:d>2};
    return {bad:true,torn:false,name:'g_v_hi.f_sin',value,tick:t};
  }
  const tick=v['g_v.tick']>>>0;
  const expected=t=>{
    const p=t%20;
    return {'g_v.u_hi':(0x10000000|(t&65535))>>>0,'g_v.f_sin':sin[p],
      'g_v.f_tri':Math.min(p,20-p)/10-1,'g_v.i_sq1k':t%10<5?1000:-1000,
      'g_v.i_sq5k':t&1?1000:-1000,'g_v.u_ramp':t%1000};
  };
  const candidates=[expected(tick),expected((tick-1)>>>0),expected((tick+1)>>>0)];
  let torn=false;
  for(const name of Object.keys(candidates[0])){
    if(!(name in v))continue;
    const match=e=>Number.isFinite(v[name])&&Math.abs(v[name]-e[name])<1e-5;
    if(match(candidates[0]))continue;
    if(!candidates.slice(1).some(match))return {bad:true,torn:false,name,value:v[name],tick};
    torn=true;
  }
  return {bad:false,torn};
}
