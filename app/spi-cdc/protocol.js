export const CMD=0x39, MAGIC=0x31435053;
export const ACT={STATUS:0,START:1,STOP:2};
export function startData({mode=0,lsb=false}={}){
  if(!Number.isInteger(mode)||mode<0||mode>3||typeof lsb!=='boolean')throw Error('SPI 模式或位顺序无效');
  return Uint8Array.of(ACT.START,mode,+lsb);
}
export function decodeReply(payload,action=ACT.STATUS){
  if(!(payload instanceof Uint8Array)||payload.length<55||payload[0]<54||payload[0]>payload.length-1||payload[1]!==CMD||payload[2]!==action)
    throw Error('SPI转发 响应无效；请更新探针固件');
  const d=new DataView(payload.buffer,payload.byteOffset+3,52),w=i=>d.getUint32(i*4,true);
  if(w(0)!==MAGIC)throw Error('探针固件尚未支持 SPI转发');
  const flags=w(1),config=w(3);
  return {supported:!!(flags&1),running:!!(flags&2),pending:!!(flags&4),rc:d.getInt32(8,true),
    mode:config&3,lsb:!!(config&256),bufferBytes:w(4),received:w(5),forwarded:w(6),dropped:w(7),
    fifoOverflows:w(8),pendingBytes:w(9),cdcQueued:w(10),generation:w(11),dmaErrors:w(12)};
}
export function resultText(rc){
  return ({0:'正常',[-100]:'请求处理中',[-1]:'当前板型未支持 SPI 从机',[-2]:'SPI 缓冲或 CDC 数据源仍被占用，请先停止对应功能',[-3]:'DMA 资源或传输失败',[-4]:'SPI 从机配置失败',[-5]:'配置参数或动作无效'})[rc]||`错误 ${rc}`;
}
