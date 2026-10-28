// 对 9333 上任意 page 目标截图，用于确认当前窗口显示什么（不依赖 skill 的 pickTarget）
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.CDP_PORT || 9333;
const OUT = process.argv[2] || path.join(process.cwd(), 'shot.png');

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
if (!page) { console.error('没有 page 目标'); process.exit(1); }
console.log('target:', page.url, '|', page.title);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id;
  pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
await send('Page.enable');
try { await send('Page.bringToFront'); } catch { /* 忽略 */ }
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
const text = await send('Runtime.evaluate', { expression: 'document.body.innerText.slice(0,600)', returnByValue: true });
console.log('--- 页面文字 ---');
console.log(text.result.value);
console.log('--- 已保存 ---', OUT);
ws.close();
