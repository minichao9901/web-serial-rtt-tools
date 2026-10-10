/** 侧栏显示分组。复用原控件节点，不修改会话、配置或采集状态。 */
import { store } from '../core/store.js';

export function initSidebarTabs(){
  for (const side of document.querySelectorAll('[data-sidebar-tabs]')){
    const name = side.dataset.sidebarTabs;
    const tabs = [...side.querySelectorAll('[data-side-tab]')];
    const pages = [...side.querySelectorAll('[data-side-panel]')];
    const help = pages.find(p => p.dataset.sidePanel === 'help');
    if (!tabs.length || !help) continue;
    const select = (key, remember = true) => {
      if (!tabs.some(t => t.dataset.sideTab === key)) key = tabs[0].dataset.sideTab;
      for (const t of tabs){
        const active = t.dataset.sideTab === key;
        t.setAttribute('aria-selected', String(active)); t.tabIndex = active ? 0 : -1;
      }
      for (const p of pages) p.hidden = p.dataset.sidePanel !== key;
      if (remember) store.set(`sidebar.${name}.tab`, key);
    };
    for (const [index, tab] of tabs.entries()){
      tab.addEventListener('click', () => select(tab.dataset.sideTab));
      tab.addEventListener('keydown', e => {
        let next;
        if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
        if (e.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
        if (e.key === 'Home') next = 0;
        if (e.key === 'End') next = tabs.length - 1;
        if (next == null) return;
        e.preventDefault(); select(tabs[next].dataset.sideTab); tabs[next].focus();
      });
    }
    select(store.get(`sidebar.${name}.tab`, tabs[0].dataset.sideTab), false);

    const heading = node => node.closest('fieldset')?.querySelector('legend')?.textContent || '使用说明';
    const note = (title, node) => {
      const details = document.createElement('details'); details.className = 'helpnote sidebar-help-section';
      const summary = document.createElement('summary'); summary.textContent = title;
      details.append(summary, node); help.append(details);
    };
    const connection = document.createElement('p'); connection.className = 'hint';
    connection.textContent = name === 'i2c'
      ? '在“连接”中选择探针并完成 HID 授权，再到“总线”读取或写入配置，最后使能。模拟探针无需设备。'
      : name === 'panel'
        ? '与 USB→SPI/QSPI 共用连接。在“连接”中授权探针和数据端点，再设置屏型号、SCLK、通信档位并使能；模式、CS 策略与辅助脚在桥页面配置。模拟探针无需数据端点。'
        : name === 'scope'
          ? '在“采集”中连接探针和数据端点，在“变量”中载入 ELF 并选通道，再开始采样。模拟探针无需设备和数据端点。'
          : '在“连接”中授权探针和数据端点，在“总线”中配置时钟、模式和引脚，再使能。模拟探针无需数据端点。';
    note('连接与上手', connection);
    // 已有折叠项中包含操作控件的（如数组元素）仍保留在原位置。
    for (const details of side.querySelectorAll('.tool-side-panel:not([data-side-panel="help"]) details.helpnote')){
      if (details.classList.contains('sidebar-note') || details.querySelector('button,input,select,textarea')) continue;
      const title = heading(details), summary = details.querySelector('summary');
      if (summary) summary.textContent = `${title} · ${summary.textContent}`;
      help.append(details);
    }
    // 只收静态说明；命名状态和包含动态读数的段落继续显示。
    for (const p of side.querySelectorAll('.tool-side-panel:not([data-side-panel="help"]) p.hint:not([id])')){
      if (p.closest('details') || p.querySelector('[id]')) continue;
      const title = heading(p);
      note(title, p);
    }
    // 长参数说明也可在帮助中阅读，触屏用户无需依赖悬停提示。
    for (const page of pages.filter(p => p !== help)){
      for (const card of page.querySelectorAll('fieldset')){
        const list = document.createElement('dl'); list.className = 'sidebar-parameter-help';
        for (const control of card.querySelectorAll('input[title],select[title],label[title]')){
          if (control.title.length < 80 || (control.matches('label') && control.querySelector('[title]'))) continue;
          const label = control.closest('label');
          const title = label?.querySelector('span')?.textContent || label?.textContent.trim() || control.getAttribute('aria-label') || '参数';
          const dt = document.createElement('dt'), dd = document.createElement('dd');
          dt.textContent = title; dd.textContent = control.title; list.append(dt, dd);
        }
        if (list.children.length) note(`${heading(card)} · 参数`, list);
      }
    }
  }
}
