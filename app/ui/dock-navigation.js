/** Layout-only keyboard/ARIA behavior for dock and generated-file tabs. */
export function initDockNavigation(){
  const groups = [...document.querySelectorAll('.docktabs')].filter(g => g.querySelector('button[data-dock]'));
  groups.push(...['g-files','g-kit-files','g-etm-files'].map(id => document.getElementById(id)).filter(Boolean));
  for (const group of groups){
    group.setAttribute('role','tablist');
    const sync = () => {
      const buttons = [...group.querySelectorAll('button')], active = buttons.find(b => b.classList.contains('on')) || buttons[0];
      for (const [index,b] of buttons.entries()){
        b.id ||= `${group.id}-tab-${b.dataset.dock || index}`;
        b.setAttribute('role','tab'); b.setAttribute('aria-selected',String(b===active)); b.tabIndex=b===active?0:-1;
        const panel = b.dataset.dock
          ? [...group.closest('.panel').querySelectorAll('.dockpage')].find(p=>p.dataset.dock===b.dataset.dock)
          : document.getElementById({'g-files':'g-preview','g-kit-files':'g-kit-preview','g-etm-files':'g-etm-preview'}[group.id]);
        if (panel){
          panel.id ||= `${group.id}-panel-${b.dataset.dock}`;
          b.setAttribute('aria-controls',panel.id); panel.setAttribute('role','tabpanel');
          if (b===active || b.dataset.dock) panel.setAttribute('aria-labelledby',b.id);
        }
      }
    };
    group.addEventListener('keydown',event=>{
      if(event.defaultPrevented||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      const buttons=[...group.querySelectorAll('button')].filter(b=>!b.disabled),at=buttons.indexOf(event.target.closest('button'));
      if(at<0||!buttons.length)return;
      const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(at+(event.key==='ArrowRight'?1:buttons.length-1))%buttons.length;
      event.preventDefault();buttons[next].click();sync();
      // File preview clicks replace their buttons; focus the new active node.
      group.querySelector('[aria-selected="true"]')?.focus();
    });
    new MutationObserver(sync).observe(group,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
    sync();
  }
}
