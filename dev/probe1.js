(() => {
  const fs = [...document.querySelectorAll('iframe')].map((i) => ({
    src: i.src,
    id: i.id,
    cls: i.className,
    rect: (() => { const r = i.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    sameOrigin: (() => { try { return !!i.contentDocument; } catch (e) { return 'cross'; } })(),
  }));
  return {
    href: location.href,
    title: document.title,
    bodyLen: document.body ? document.body.innerText.length : -1,
    hasLogin: !!document.querySelector('.login, .login-wrap, [class*="login"]'),
    iframes: fs,
  };
})()
