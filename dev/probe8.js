(() => {
  const rf = [...document.querySelectorAll('iframe')].find((i) => (i.src || '').includes('/web/frame/recommend/'));
  const d = rf ? rf.contentDocument : null;
  const t = d && d.body ? d.body.innerText.replace(/\s+/g, ' ').trim() : '';
  return {
    frameOk: !!d,
    cards: d ? d.querySelectorAll('.candidate-card-wrap').length : -1,
    frameText: t.slice(0, 240),
    loading: d ? !!d.querySelector('[class*="loading"], .loading') : null,
    ready: document.readyState,
  };
})()
