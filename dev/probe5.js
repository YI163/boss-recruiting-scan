(() => {
  const pend = [];
  for (const s of document.querySelectorAll('script[src]')) if (!s.complete) pend.push('script ' + s.src);
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) if (!l.sheet) pend.push('css ' + l.href);
  for (const i of document.querySelectorAll('img')) if (!i.complete) pend.push('img ' + (i.currentSrc || i.src));
  return {
    ready: document.readyState,
    appChildren: document.querySelector('#app') ? document.querySelector('#app').children.length : -1,
    pending: pend.slice(0, 15),
    pendingCount: pend.length,
    perf: performance.now() | 0,
    scriptCount: document.scripts.length,
  };
})()
