# 把 ego lite 接进这个 skill（三条路线，实测结论）

最后更新：2026-11-08。结论先说：**不需要从 ego 里"提取"浏览器能力**——ego lite 本身就是 Chromium，
只要给它 `--remote-debugging-port`，它就吐出标准 CDP，现有 CDP 脚本可以一行不改地跑在它上面。

## 实测证据（2026-11-08，ego 0.6.2.8 / Chromium 156.0.8078.74）

```powershell
& "C:\Program Files\Citro Labs\ego lite\Application\ego.exe" `
  --user-data-dir="$env:TEMP\ego-cdp-test" --remote-debugging-port=9444 `
  --no-first-run --no-default-browser-check about:blank
```

- `http://127.0.0.1:9444/json/version` → `{"Browser":"Chrome/156.0.8078.74","Protocol-Version":"1.3","webSocketDebuggerUrl":"ws://127.0.0.1:9444/devtools/browser/…"}`。
- 原生 WebSocket CDP 客户端实测通过：`Target.createTarget` → `Page.navigate` → `Runtime.evaluate`（返回 `"Example Domain @ https://example.com/"`）→ `Page.captureScreenshot`（base64 约 84 700 字节）。
- 注意：ego 首次启动会落在 `chrome://onboarding/`（type=`browser_ui`，没有 page target），
  所以驱动器要先 `Target.createTarget` 自己开一个 tab——这反而是好事：**不碰用户已经开着的标签**。

## 三条路线

| | 路线 | 怎么做 | 能力 | 代价 |
|---|---|---|---|---|
| **1（推荐）** | ego 当"带登录态的浏览器"，走 CDP | ego 带 `--remote-debugging-port=9444` 启动；skill 侧 `set CDP_URL=http://127.0.0.1:9444`，**现有 `scan-favorite.mjs` / `cdp.mjs` / 判定器 / 闸门 / 台账全部复用** | 采集 + 判定 + 收藏 + 回滚 + 台账，全自动 | 要用 ego 自己的 profile 启动，必须先关掉正在跑的 ego（SingletonLock）；调试端口只监听回环，用完要关 |
| **2（已实现）** | ego-browser CLI 驱动 | `scripts/ego/ego-driver.mjs`（语义快照、跨 iframe `>> nth=` 选择器、`page.cdp()` 兜底） | 读页面/截图/点元素更稳，适合 agent 逐张审 | 命令要走 `%TEMP%\boss-ego-cmd.json` 文件；不能在脚本里直接调 model，agent 必须逐步驱动 |
| **3（不建议）** | 抽 `local-ego-daemon` 的内部协议 | 直接对接 daemon/ACP | — | daemon 打包产物里 `remote-debugging` / `webSocketDebuggerUrl` **0 命中**，走 pipe + ACP 内部协议；耦合、许可证、随版本变化三重风险，且 Chromium 层已经给了标准 CDP，没有收益 |

## 路线 1 的启动命令

```powershell
# 1) 先退出 ego（任务栏右下角退出，或结束 ego 进程），否则 profile 被占用
# 2) 用 ego 自己的 User Data 带调试端口启动（注意：`Application\ego.exe` 才是主程序，版本目录里只有 .sig）
$ego = "C:\Program Files\Citro Labs\ego lite\Application\ego.exe"
$ud  = "$env:LOCALAPPDATA\Citro Labs\ego lite\User Data"
& $ego --user-data-dir="$ud" --profile-directory="Profile 1" --remote-debugging-port=9444 --no-first-run
# 3) 验证
Invoke-RestMethod http://127.0.0.1:9444/json/version
$env:CDP_URL = "http://127.0.0.1:9444"
node scripts/cdp.mjs state
```

macOS 上同样的参数换成 `open -a "ego lite" --args --remote-debugging-port=9444`，
User Data 在 `~/Library/Application Support/Citro Labs/ego lite/User Data`。

## 选型建议
- **要"全自动跑完两轮"**：走路线 1（CDP），因为它复用已经验证过的整套脚本与账本。
- **要"agent 逐张审、绝点歪"**：走路线 2（ego CLI），语义快照 + 选择器点击最稳。
- 两者可以共存：同一个 ego profile 先按路线 1 启动（占 9444），需要人工/agent 看页面时用 ego 窗口操作；不建议同时用两套驱动写同一个标签。

## 安全边界（跟风控无关，单纯是端口）
- 调试端口等于完整浏览器控制权，`--remote-debugging-port` 只绑 `127.0.0.1`，不要改成 `0.0.0.0`。
- 跑完就退出带端口的那个实例，别长期开着。
