(() => {
  const prev = window.__probeMark || null;
  window.__probeMark = Date.now();
  let navCount = -1;
  try { navCount = performance.getEntriesByType('navigation').length; } catch (e) {}
  return {
    prevMark: prev,
    now: Date.now(),
    perfNow: Math.round(performance.now()),
    ready: document.readyState,
    navCount: navCount,
    appChildren: document.querySelector('#app') ? document.querySelector('#app').children.length : -1,
    bodyHtmlLen: document.body ? document.body.innerHTML.length : -1,
    title: document.title,
  };
})()
