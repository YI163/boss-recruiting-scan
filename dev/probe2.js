(() => {
  const out = { href: location.href, title: document.title, cssW: document.documentElement.clientWidth, cssH: document.documentElement.clientHeight, dpr: window.devicePixelRatio };
  const walk = (doc, depth, acc) => {
    if (!doc || depth > 3) return acc;
    for (const f of doc.querySelectorAll('iframe')) {
      let u = '';
      try { u = f.contentWindow.location.href; } catch (e) { u = f.src; }
      const r = f.getBoundingClientRect();
      acc.push({ d: depth, url: u, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      try { walk(f.contentDocument, depth + 1, acc); } catch (e) { /* cross-origin */ }
    }
    return acc;
  };
  out.frames = walk(document, 0, []);
  const rf = [...document.querySelectorAll('iframe')].find((i) => (i.src || '').includes('/web/frame/recommend/'));
  if (!rf) { out.err = 'recommend frame missing'; return out; }
  let d = null;
  try { d = rf.contentDocument; } catch (e) { out.err = 'frame blocked: ' + e.message; return out; }
  out.frameDoc = { url: d.location ? d.location.href : '?', ready: d.readyState, bodyLen: d.body ? d.body.innerText.length : -1 };
  out.cardCount = d.querySelectorAll('.candidate-card-wrap').length;
  out.cardSelectors = [...d.querySelectorAll('[class*="candidate-card"]')].slice(0, 5).map((e) => e.className);
  const first = d.querySelector('.candidate-card-wrap');
  out.firstCard = first ? first.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
  out.firstCardRect = first ? (() => { const r = first.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })() : null;
  out.btnFav = d.querySelectorAll('.btn-fav').length;
  out.btnCandidates = [...new Set([...d.querySelectorAll('[class*="btn"],[class*="fav"]')].map((e) => e.className))].slice(0, 20);
  return out;
})()
