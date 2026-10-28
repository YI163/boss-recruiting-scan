(async () => {
  const names = document.cookie ? document.cookie.split('; ').map((x) => x.split('=')[0]) : [];
  const out = { cookieCount: names.length, cookies: names.slice(0, 40), probes: [] };
  for (const url of ['/wapi/zpuser/welcome/getUserInfo', '/wapi/zpuser/welcome/info', '/wapi/zpgeek/geek/chat/checkLogin']) {
    try {
      const r = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
      const t = await r.text();
      out.probes.push({ url, status: r.status, body: t.slice(0, 300) });
    } catch (e) { out.probes.push({ url, error: String(e).slice(0, 120) }); }
  }
  return out;
})()
