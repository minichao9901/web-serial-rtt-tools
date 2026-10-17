// Decode actual ETM register snapshots, not UI checkbox state.
export function traceSettings(config){
  if(!config)return null;
  if(config.protocol==='ETMv3'||Number.isInteger(config.ctrl)){
    if(!Number.isInteger(config.ctrl))return null;
    return {branchBroadcast:!!(config.ctrl&0x100),returnStack:false,cycleCount:false};
  }
  if(!Number.isInteger(config.config))return null;
  return {branchBroadcast:!!(config.config&8),returnStack:!!(config.config&0x1000),cycleCount:!!(config.config&0x10)};
}

export function traceCapabilities(profile,config){
  if(profile==='stm32f103ze')return {branchBroadcast:true,returnStack:false,cycleCount:false};
  if(profile==='stm32h7b0'||profile==='stm32h743')return {branchBroadcast:!!(config.idr0&0x20),returnStack:!!(config.idr0&0x200),cycleCount:!!(config.idr0&0x80)};
  return {branchBroadcast:false,returnStack:false,cycleCount:false};
}

export function traceSettingsText(config){
  const s=traceSettings(config),on=v=>v?'开':'关';
  return s?`分支广播 ${on(s.branchBroadcast)} · 返回栈 ${on(s.returnStack)} · 周期计数 ${on(s.cycleCount)}`:'未记录 ETM 选项回读';
}
