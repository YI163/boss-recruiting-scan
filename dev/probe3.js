(() => {
  const rf = [...document.querySelectorAll('iframe')].find((i) => (i.src || '').includes('/web/frame/recommend/'));
  const d = rf ? rf.contentDocument : null;
  const txt = (doc) => (doc && doc.body ? doc.body.innerText.replace(/\s+/g, ' ').trim() : '');
  return {
    top: txt(document).slice(0, 800),
    frame: d ? txt(d).slice(0, 800) : 'no frame',
    frameHtmlHead: d && d.body ? d.body.innerHTML.slice(0, 1200) : '',
    hasLoading: d ? !!d.querySelector('[class*="loading"]') : null,
    navItems: [...document.querySelectorAll('.menu-item, [class*="nav"] li, [class*="menu"] a')].map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 20),
  };
})()
