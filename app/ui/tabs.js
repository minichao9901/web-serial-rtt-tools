/** 顶部标签页的切换。支持 #serial / #terminal / #rtt / #flash / #gen 直达（也方便做演示链接）。 */
export function initTabs(onSwitch){
  const tabs = [...document.querySelectorAll('#tabs .tab')];
  const panels = [...document.querySelectorAll('.panel')];
  const names = tabs.map(t => t.dataset.tab);   // 从 DOM 取，别再手写一份（加页时容易漏）
  const menu=document.getElementById('tool-switch');
  const summary=menu?.querySelector('summary');
  const moreTabs=menu?[...menu.querySelectorAll('[data-tab]')]:[];
  function show(name, push = true){
    for (const t of tabs){
      const active=t.dataset.tab===name;
      t.classList.toggle('active',active);
      if(active)t.setAttribute('aria-current','page');else t.removeAttribute('aria-current');
    }
    const extra=moreTabs.find(t=>t.dataset.tab===name);
    menu?.classList.toggle('has-current',!!extra);
    summary?.setAttribute('aria-label',extra?`更多功能，当前页面：${extra.textContent}`:'更多功能');
    if(menu){const wasOpen=menu.open;menu.open=false;if(wasOpen)summary.focus();}
    for (const p of panels) p.classList.toggle('active', p.id === 'tab-' + name);
    try {
      localStorage.setItem('serial-rtt-tools:tab', name);
      if (push) history.replaceState(null, '', '#' + name);
    } catch {}
    onSwitch?.(name);
  }
  for (const t of tabs) t.addEventListener('click', () => show(t.dataset.tab));
  menu?.addEventListener('toggle',()=>{if(menu.open){const more=document.getElementById('app-more');if(more)more.open=false;}});
  document.addEventListener('click',e=>{if(menu&&!menu.contains(e.target))menu.open=false;});
  menu?.addEventListener('keydown',e=>{
    if(e.key==='Escape'){menu.open=false;summary.focus();e.preventDefault();return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
    menu.open=true;
    const at=moreTabs.indexOf(document.activeElement);
    const next=e.key==='Home'?0:e.key==='End'?moreTabs.length-1:at<0?(e.key==='ArrowDown'?0:moreTabs.length-1):(at+(e.key==='ArrowDown'?1:-1)+moreTabs.length)%moreTabs.length;
    moreTabs[next]?.focus();e.preventDefault();
  });
  const hash = (location.hash || '').replace('#', '');
  let last = null;
  try { last = localStorage.getItem('serial-rtt-tools:tab'); } catch {}
  show(names.includes(hash) ? hash : (names.includes(last) ? last : 'serial'), false);
  window.addEventListener('hashchange', () => {
    const h = (location.hash || '').replace('#', '');
    if (names.includes(h)) show(h, false);
  });
  return { show };
}
