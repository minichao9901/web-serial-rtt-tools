import { toast } from './toast.js';

/** Browser fullscreen follows the actual document state, including Escape. */
export function initFullscreen(){
  const button = document.getElementById('btn-fullscreen');
  if (!button) return;
  let busy = false;
  const supported = !!(document.documentElement.requestFullscreen && document.exitFullscreen && document.fullscreenEnabled !== false);
  const sync = () => {
    const active = !!document.fullscreenElement;
    button.textContent = active ? '退出全屏' : '全屏';
    button.setAttribute('aria-pressed', String(active));
    button.title = supported ? (active ? '退出全屏（也可按 Esc）' : '全屏显示工作台') : '当前浏览器不支持全屏';
    button.disabled = busy || !supported;
  };
  button.addEventListener('click', async () => {
    if (busy || !supported) return;
    busy = true; sync();
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (error){
      toast('无法切换全屏：' + (error?.message || error), 'err');
    } finally { busy = false; sync(); }
  });
  document.addEventListener('fullscreenchange', sync);
  sync();
}
