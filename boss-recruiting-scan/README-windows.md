# Windows 使用说明（boss-recruiting-scan v1.8.2 + 本地补丁 4）

本 skill 的文档与默认值原本按 macOS 写（`/tmp/boss`、`python3`、osascript）。**流程、节奏、配额、审核闸门、判定口径一律未改**，Windows 适配只做了两件事：

1. 把「写死的 POSIX 路径 + 解释器假设」改成按平台判断（默认值与文档保持一致，显式设 `BOSS_WORK`/`PYTHON_BIN` 时行为与上游完全相同）；
2. 补这份 Windows 说明。

本机安装位置示例：`C:\Users\<你>\.dsh\skills\boss-recruiting-scan`（下文 `<skill>` 都指这个目录；放别处也能跑）。

拿代码（国内网络三选一，`clone` 后**不需要**装任何 npm/pip 依赖）：

```powershell
git clone https://github.com/YI163/boss-recruiting-scan.git
git clone https://gh-proxy.com/https://github.com/YI163/boss-recruiting-scan.git   # 镜像（实测 3.4s）
curl.exe -L -o skill.zip https://codeload.github.com/YI163/boss-recruiting-scan/zip/refs/heads/main
```

`gh-proxy.com` 不通时换 `ghproxy.net`（时好时坏）；只读镜像可在 Gitee「从 GitHub 导入」。

---

## 1. 起一个带调试端口的 Chrome

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --user-data-dir="$env:USERPROFILE\.boss-prof" `
  --remote-debugging-port=9333 `
  https://www.zhipin.com/web/chat/index
```

> **受管终端（DSH 等）必须脱离启动**，否则命令一结束 Chrome 被连带杀掉、9333 消失：
> ```powershell
> powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\tools\start-detached.ps1" `
>   -Path "C:\Program Files\Google\Chrome\Application\chrome.exe" `
>   -Arguments "--user-data-dir=$env:USERPROFILE\.boss-prof --remote-debugging-port=9333 --no-first-run --no-default-browser-check --new-window https://www.zhipin.com/web/chat/index"
> ```
> 没有该脚本时用 `Invoke-CimMethod -ClassName Win32_Process -MethodName Create` 等价启动。

- 必须用**独立 user-data-dir**（不碰日常主窗口），首次要在这个实例里登录 BOSS 直聘，**登录时选「我要招聘」**再扫码/输验证码（落到求职端首页是扫不出招聘端的）。Chrome 136+ 不允许默认 profile 开调试端口，Windows 上也不能靠复制 cookie 搬登录态（v20 App-Bound Encryption 会删掉解不开的 cookie）。
- 检查端口是否真的在听：

```powershell
Invoke-RestMethod http://127.0.0.1:9333/json/version | Select-Object Browser
```

- 卡住时看谁占着 9333：

```powershell
Get-NetTCPConnection -LocalPort 9333 -State Listen | Select-Object OwningProcess
# 需要时结束该进程（确认 Pid 是上面那个调试实例再执行）
Stop-Process -Id <Pid>
```

- 窗口**不能最小化**（CDP 点击无效、截图会超时）。Windows 上没有 `osascript`，脚本的「强制置前」只有 CDP 的 `setWindowBounds`+`bringToFront`，必要时手动还原窗口。

## 2. Python：三选一，别指望 `python3`

| 来源 | 路径 / 命令 | 有 openpyxl（出 xlsx 台账用） | 适合 |
|---|---|---|---|
| `py` 启动器 | `py` → `C:\Users\<you>\AppData\Local\Programs\Python\Python313\python.exe`（3.13.7） | ❌ 需 `py -m pip install openpyxl` | 跑判定器、自检 |
| DSH 自带 runtime | `C:\Users\<you>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe` | ✅ openpyxl 3.1.5 | 判定器 + 台账 xlsx |
| 官方安装包 | 自行安装路径 | 视安装而定 | 通用 |

**坑**：Windows 上 PATH 里的 `python3.exe` / `python.exe` 很可能是 Microsoft Store 的空壳——能执行，但 `exit 9009` 且不输出任何东西。judge 因此会「静默失败」，所以必须显式指定解释器。

- `PYTHON_BIN` 已设置时脚本**只**用它；
- 未设置时按平台探测 `python3` → `python` → `py`，取第一个真能 `import sys` 的；
- 全部不可用时报：`FATAL 找不到可用的 Python 解释器：PYTHON_BIN="..."`（exit 2），而不是含糊的 `judge failed`。
- `make_ledger.py` 没 openpyxl 时**自动退化为只产 md**，不静默失败也不假称出了 xlsx。

## 3. 环境变量（每开一个新 PowerShell 都要设）

```powershell
chcp 65001 | Out-Null
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8   # 中文不乱码
$env:CDP_URL    = 'http://127.0.0.1:9333'
$env:BOSS_WORK  = "$env:USERPROFILE\boss-work"        # 建议放用户目录，见 §6 隐私
$env:PYTHON_BIN = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
# 可选
$env:JUDGE_PY   = 'C:\path\to\my_judge.py'             # 换口径时用
$env:FAV_DRY_RUN = '1'                                 # 只判定不点收藏（联调首选）
```

默认值（不设环境变量时）：

| 变量 | Windows 默认 |
|---|---|
| `BOSS_WORK` | `%TEMP%\boss`（即 `C:\Users\<你>\AppData\Local\Temp\boss`） |
| `PYTHON_BIN` | 自动探测 `python3`→`python`→`py` |
| `CDP_URL` | `http://127.0.0.1:9333` |
| `FAV_OUT` | `<BOSS_WORK>\fav_capture.json` |

> 路径建议**纯 ASCII 且不带空格**（`%TEMP%` 满足）。中文路径在 node/python 双栈里容易踩编码，没必要冒这风险。

## 4. 冒烟验收（照抄即可，逐条比结果）

在 `<skill>` 目录下执行：

| # | 命令 | 期望 |
|---|---|---|
| 1 | `node --check scripts/scan-favorite.mjs` | 无输出、`exit 0` |
| 2 | `py scripts/judge.py --selftest` | `selftest: 12/12 passed`、`exit 0` |
| 3 | `py scripts/judge_template.py --selftest` | `selftest: 5/5 passed`、`exit 0` |
| 4 | `py scripts/strict2.py --selftest` | 打印 `SKIP: strict2_fixtures.json 未随包提供…`、`exit 0`（真实回归样例不随包分发，属正常） |
| 5 | `node scripts/scan-favorite.mjs --selfcheck-judge` | 6 条 `ok`、`judge-contract selftest: 6/6 passed`、`exit 0`，且 `%TEMP%` 下**无** `boss-judgecheck-*` 残留 |
| 6 | `node scripts/cdp.mjs state` | Chrome 已起：打印目标/帧信息；未起：`ERR fetch failed` + `exit 1`（干净失败，不挂死） |

第 5 条是本次修复的核心：旧版在 Windows 上会直接 `ENOENT: mkdtemp '/tmp/boss-judgecheck-…'`。

> 两个常见误判：①首次 `cdp.mjs shot` 可能拍到**全白**（页面还没渲染完）→ 等 8 秒重拍，别据此判断页面坏了；②`cdp.mjs state` 的 `login` 旧版按推荐帧里的「退出登录」文本判定，登录成功也报 `false`；本地补丁 3 起改为「顶层 DOM + URL `/web/user/` + cookie `wt2=`」三处判定，`login:false` 时看同条输出的 `loginDetail`。

真实判定链路（不经浏览器）也可以先跑通再动页面：

```powershell
# cards.jsonl 每行一个 {"card":"<推荐牛人卡片 innerText>"}
$env:BOSS_WORK = "$env:USERPROFILE\boss-work"
node scripts/scan-favorite.mjs --judge-run C:\path\to\cards.jsonl
# 期望：JUDGE_OK [...] + exit 0，并在 $env:BOSS_WORK 下生成 strict3v2_{ok,near,all,summary}.json
```

## 5. 与 macOS 文档（README.md / SKILL.md）的差异

| 项目 | macOS 文档 | Windows 实际 |
|---|---|---|
| 工作目录 | `/tmp/boss` | 默认 `%TEMP%\boss`；显式 `BOSS_WORK` 最稳 |
| 解释器 | `python3` | 自动探测，回退到 `py`；Store 空壳不可用 |
| Chrome 可执行 | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| 查端口 | `lsof -i :9333` | `Get-NetTCPConnection -LocalPort 9333 -State Listen` |
| 强制置前 | `osascript … activate` | 无等价步骤（脚本跳过）；手动还原窗口 |
| 文件权限 600 | 真实的 POSIX 权限位 | `chmodSync(…,0o600)` 在 Windows 是 **no-op**（不映射 NTFS ACL），见 §6 |
| 台账 xlsx | 系统 python3 有 openpyxl 即可 | 用 DSH 自带 python，或 `py -m pip install openpyxl` |

其余（CDP 连接方式、`Input.dispatchMouseEvent` 坐标点击、Escape 关浮层、审核闸门 `exit 42`、`STOP_TODAY`）都是纯 CDP + Node/Python，Windows 与 macOS 行为一致。

## 6. 运行注意

- **隐私**：Windows 上 `600` 不生效，故 `BOSS_WORK` 默认放 `%TEMP%`（当前用户私有），**不要**指到 `C:\`、共享盘或公共目录。`dump-*.json` / `security_*.jpg` 含完整卡片与截图，用完即删。
- **日切**：仍按 `Asia/Shanghai` 本地日计算，与系统时区无关；跨时区出差不会多算额度。
- **缩放**：坐标点是 CSS 像素，Chrome 窗口保持最大化、缩放 100% 时最稳；改窗口宽度后按钮坐标由 `clientWidth` 动态算出，无须手工调。
- **额度**：日收藏 ≤60、轮次 ≤200、连续运行 ≤180 分钟——Windows 上同样硬夹，env/config 只能更严。
- **首次运行**会提示 `未找到 config.json，使用内置默认值`；要改节奏从 `config.example.json` 复制成 `config.json`（配额只能调小）。
- **默认判定器不是通用口径**：`judge.py` 依赖卡片起止日期，而 BOSS 推荐卡多数没有日期 → 真实卡上常 `0 PASS`（实测 14 张 0 PASS）。第一次用请按 `scripts/judge_template.py` 改写口径，别把 `0 PASS` 当结论。

## 7. 本地补丁清单（相对 zip 内的 v1.8.2）

**补丁 1（Windows 适配）**

| 文件 | 改动 | 为什么 |
|---|---|---|
| `scripts/scan-favorite.mjs` | 自检临时目录 `'/tmp/boss-judgecheck-'` → `path.join(os.tmpdir(), 'boss-judgecheck-')`；新增 `resolvePython()` 探测；`PYTHON_BIN` 为商店空壳时打 `FATAL … 找不到可用的 Python 解释器`；默认 `BOSS_WORK` 在 Windows 用 `%TEMP%\boss` | 旧版自检在 Windows 直接 ENOENT 崩溃 |
| `scripts/scan-favorite.mjs` / `cdp.mjs` / `favcapture.mjs` | 默认 `BOSS_WORK` 按平台判断（POSIX 仍 `/tmp/boss`） | 避免落到 `C:\tmp\boss` |
| `scripts/judge.py` / `judge_template.py` / `make_ledger.py` / `strict2.py` | 同上，`DEFAULT_WORK` 在 Windows 用 `%TEMP%\boss`；`strict2.py` 落盘前 `makedirs` | 让不设环境变量也能跑通 |
| `SKILL.md` | 前置条件/环境变量/已知坑补 Windows 说明与版本记录条目 | 避免下次照 macOS 文档踩坑 |
| `README-windows.md` | 本文件 | — |

**补丁 2（点收藏链路）**：开卡/收藏/关闭全部改**元素点击 + 控件文案自证**（推荐帧内 `.row.name-wrap`、`.like-icon-and-text`、`.close-btn`），魔法坐标只作兜底；浮层判据改为「最后一个非 `v-leave` 的 `.boss-popup__wrapper`」并清理卡死节点。旧坐标实测横偏 44px、关闭钮偏 99px，是「点了没反应/点歪」的根因。

**补丁 3（新人外测 24 条）**：`cdp.mjs` 修 `login` 判据、新增 `navigate <url>`、`cards` 在收藏页回退读 `.card-item`、`shot` 用 `fromSurface:false`；`scan-favorite.mjs` 收藏顺序真正按判定器排序（原来按 DOM 顺序）、新增 `--accept-only` 且接受早于配额检查、`--batch` 批号取最大值、`--rollback` 就绪轮询 + 回退 `state.favorites`/`pendingRecords`/`passes.jsonl`；`make_ledger.py` 的 `--out` 默认 `$BOSS_WORK`、时间转本地、缺 openpyxl 给修法；`favcapture.mjs` 区分本轮与历史。文档补齐取仓库三路径、脱离启动、招聘端登录、自检顺序、编码、默认口径 0 PASS 警告。

**回滚**：重新解压原始 zip 覆盖 `<skill>` 目录即可（本补丁没有新增运行时状态文件，`BOSS_WORK` 里的数据不受影响）。换回 macOS/Linux 使用也无需回滚——POSIX 分支保持上游原值。

## 8. 不变的铁律（与平台无关）

- **零外联**：只点「收藏」和关浮层，绝不「打招呼 / 联系Ta / 搜索畅聊卡」。
- 每累计 5 个收藏 `exit 42` 停轮审核；`review_ok_N.json` 必须覆盖全部候选，被拒者先 `--rollback`；只想接受审批（不再收藏人）用 `node scripts/scan-favorite.mjs --accept-only`。
- 发现登录失效 / 安全验证 / 操作频繁 / 收藏失败率 >50% → 截图 + 写 `STOP_TODAY` + 非零退出，当天不再跑。
- 姓名：推荐流真实姓名（`.name`）与判定器掩码名并存，只落本机 `real_names.json`/台账；不导出手机号/微信/邮箱。

**补丁 4 追加两条（与平台无关）**：

1. 不在「精选」页收藏——那页开聊要「搜索畅聊卡」（付费），卡片姓名还是加密掩码；脚本运行中检测到精选页会整轮 `SKIP 精选页`，`config.batch.tabs` 里的「精选」也会被忽略。
2. 掩码姓名不收藏——推荐流卡片上是真实姓名（`.name`），判定器输出才是掩码；卡片姓名带 `*` 的候选直接跳过，收藏成功写 `$BOSS_WORK\real_names.json` 供审核/台账/回滚使用。
