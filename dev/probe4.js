(() => {
  const b = document.body;
  return {
    href: location.href,
    ready: document.readyState,
    vis: document.visibilityState,
    hasFocus: document.hasFocus(),
    cssW: document.documentElement.clientWidth,
    cssH: document.documentElement.clientHeight,
    bodyLen: b ? b.innerHTML.length : -1,
    textLen: b ? b.innerText.length : -1,
    htmlHead: b ? b.innerHTML.slice(0, 700) : '',
    idApp: !!document.querySelector('#app, .page-top, .chat-container, [class*="chat"]'),
    scripts: [...document.scripts].map(s => (s.src || '').split('/').pop()).filter(Boolean).slice(0, 12),
  };
})()
