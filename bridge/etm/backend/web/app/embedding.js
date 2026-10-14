/** Standalone stays independent; an embedded page shares the parent's USB owner. */
export function embeddedHost(windowObject=globalThis.window){
  try{
    if(windowObject?.parent===windowObject||!windowObject?.document?.body?.dataset?.embedded)return null;
    const host=windowObject.parent.__tools?.etm;
    if(!host)throw Error('ETM 内嵌页面需要主工具的探针管理器');
    return host;
  }catch(e){throw new Error('ETM 内嵌页面与主工具必须同源',{cause:e});}
}

export const PROBE_ACTIONS=new Set(['connect','disconnect','recover-debug','reset','halt','run',
  'read-config','read-clock','apply-config','restore-config','run-to','remove-break']);

export function runEmbedded(host,fn){return host?host.run(fn):fn();}
