# 故障排查：白屏、卡住、点空（实战记录）

这份文档记录的是**真实踩过的坑**和对应的修法，不是推测。数字都是本机实测值（Chrome 156 / 窗口 CSS 1037×799 / dpr 2 / 推荐 iframe 偏移 (168,40)）。

排查顺序建议：先看 `node scripts/cdp.mjs state` 的帧树，再看页面 `readyState`，最后才怀疑点击逻辑。

---

## 一、白屏（页面一片空白）

三种完全不同的原因，处理方式也不同。

### 1. 调试器 attach 触发了反爬 → 文档反复重建

**现象**：页面长时间白屏或停在「加载中，请稍候」，`#app` 为空、`readyState` 长期 `loading`；`frames` 里反复出现新的 recommend 帧。

**证据**：两个反爬 SDK 脚本长期 `pending`：

```
https://static.zhipin.com/assets/sdk/warlock/warlockdata.min.2.2.15.js
https://static.zhipin.com/assets/sdk/apm/patas-compat.2.1.0.min.js
```

而直接 `Invoke-WebRequest` 取这两个 URL 都是 200（332ms / 489ms），系统也没有代理 → 不是网络问题，是页面主动不放行。

**结论**：这是「用 chrome.debugger 长时间驱动同一个标签」引起的。同一页面改用**内容脚本**（扩展桥）读取，立刻就正常了。所以：

- 原生 CDP 模式（本 skill 的主路径）跑长轮次时，页面被反复重建属于**已知风险**，出现即按风险信号停（见 SKILL.md 铁律 4）。
- 不要用「再刷一次试试」来对抗它，越刷越像机器。

### 2. `Page.navigate` 之后 SPA 重挂（正常的白屏，等就行）

**现象**：换批导航后十几二十秒里，`body.innerText` 只有 36~98 个字符、`#app` 空、`readyState:loading`；帧树里**已经有** recommend 帧，但顶层 `document.querySelectorAll('iframe')` 取不到。

**证据**：连续 20+ 秒轮询都是这个状态，之后自行恢复。

**处理**：脚本已改成**就绪轮询**——不固定 sleep 9s，而是循环取 `rf`/`off` 并读卡片数，要求**卡片数连续两次相同**才继续（`scan-favorite.mjs` 主循环 `stableN/stableHits`）。人工排查时只要 `readyState === 'loading'` 就是还没渲染完，别急着判定失败。

**注意**：如果连续 3 次拿不到偏移，脚本记 `noOffsetStreak` 并最终写 `REST_UNTIL`（停 30 分钟），这是防封的一部分，不要绕过。

### 3. 点歪落到侧栏 / 弹层盖屏（我们自己的误操作）

**现象**：窗口突然变成「沟通」页，上面还盖着「BOSS直聘 Windows 客户端」的推广弹层，看起来就是白屏卡住。

**原因**：旧实现的关闭按钮用魔法坐标 `(clientWidth-126, 57)`，实测真实位置约 `(1010, 46)`，偏约 100px；点空落到左侧菜单上。

**处理**：关闭按钮改建元素点击 + `.close-btn` 真实位置回退（见下文「三」）。日常判断：`cdp.mjs state` 的顶层 URL 变成 `/web/chat/xxx` 就是跑偏了，直接导航回 `/web/chat/recommend` 即可。

---

## 二、长时间"在跑但没进展"

### 1. 浮层判据错误 → 每个候选都被跳过

**现象**：日志连续 `stale overlay, skip <card_id>`，脚本空转。

**根因**：旧判据 `frames().some(f => /c-resume/.test(f.url))`。`c-resume` 是**画布帧**，浮层关掉后它仍常驻（预加载），于是「浮层是否打开」永远为真。

**修法**：改判「推荐帧里是否有**非离场状态**的 `.boss-popup__wrapper`」，见 SKILL.md「坐标与常量」。

### 2. 浮层关不掉 → 后续开卡全失败

**现象**：`overlay not opened <card_id>` 连续出现，只能成功第一个人。

**根因**：点关闭后 Vue 卡在离场过渡里，节点仍是可见的：

```json
{"cls":"... boss-popup__wrapper ... v-leave v-leave-active","op":"1","pe":"auto","disp":"block"}
```

`opacity` 还是 1、`pointerEvents` 还是 auto，而且这个 wrapper 覆盖整个 iframe（868×759）——它把后面的卡片全挡住了。

**更坑的是**：页面会**累积多个** `.boss-popup__wrapper`（一次开卡一个，长时间运行实测累积到 22 个 `c-resume` 帧），而 `querySelector` 只返回第一个——如果第一个是卡死的，就永远判成"浮层还开着"。

**修法**（已进代码）：
1. 只认**最后一个**不在 `v-leave` 里的 wrapper（`LIVE_DLG`）。
2. `closeOverlay()` 点完 `.close-btn` 后，把仍处于 `v-leave` 的节点 `remove()` 掉，日志会打 `overlay cleanup: removed N stuck node(s)`。
3. Escape 兜底改成**在推荐帧自己的 document 里派发**——顶层 `Input.dispatchKeyEvent` 的 Escape 到不了这个 iframe。

### 3. 固定等待不够

旧代码 `sleep(9000)` 后一次性取帧和偏移，赶不上这个页面 20 秒级的重挂节奏 → 见上文「一.2」的就绪轮询。

### 4. 后台任务超时被搬家

跑太久的命令会被移到后台继续跑（600s 后），看起来像"卡住"。处置：`job_list` 看有没有还在跑的 job，需要的话 `job_kill`，再重启任务。

---

## 三、点空（"模拟点击总是点歪"）

这是本项目花时间最多的问题，根因有三层：

### 1. 坐标是猜的，而且猜错了

| 元素 | 旧坐标 | 实测真实位置 | 偏差 |
|---|---|---|---|
| 收藏按钮 | `(clientWidth-360, 95)` = (677,95) → 帧内 (509,55) | 帧内 `(553,30)` + iframe 偏移 (168,40) → 约 `x721..792, y70..126` | 横向偏左 44px（落到工具条左侧空白，纵向虽在工具条高度内但不在按钮上） |
| 浮层关闭 X | `(clientWidth-126, 57)` = (911,57) → 帧内 (743,17) | 帧内 `(842,6)` + 偏移 → 约 `(1010,46)` | 横向偏约 99px、纵向偏 11px |

窗口宽度一变，偏差还会变。**结论：不要用减固定像素的魔法坐标。**

### 2. 控件不在以为的地方

- 浮层 `web/frame/c-resume/` 只是画布容器：`<div id="resume"><canvas id="resume"></canvas></div>`，`innerText` 为空，**点它的 shadow DOM 什么也点不到**（旧文档说"在闭合 shadow DOM 里只能坐标点击"是错的）。
- 真正可点的控件都在**推荐 iframe**（`https://www.zhipin.com/web/frame/recommend/?...`）里：
  - 收藏：`div.like-icon-and-text`（内层 `div.btn-text` 文案「收藏」/「已收藏」）
  - 关闭：`div.close-btn`
  - 工具条容器：`.communication.icon-coop-forward.shareReport` / `.btns`（收藏/转发/举报/不合适），其下还有「打招呼」按钮 —— **必须有 allowlist，绝不点它**。

### 3. 合成点击的可信度

- `element.click()`（JS 派发）足以打开卡片浮层、足以触发收藏，**不需要 isTrusted**。本机实测：`document.querySelector('.row.name-wrap').click()` 稳定开卡；同一时刻按坐标点 `(362,138)` 反而打不开。
- 需要真实鼠标事件时才用 `Input.dispatchMouseEvent`，并且坐标必须是「帧内 `getBoundingClientRect()` + 顶层 iframe 偏移」算出来的，不是猜的。
- 校验以**控件文本变化**为准（`收藏` → `已收藏`），toast 只作补充——toast 有假阴性/假阳性（旧实现就出现过"报了 fav 实际没进去"和"没报但进去了"两种情况）。

---

## 四、审核闸门卡住

- `exit 42` = 有未结批的 batch。必须先写 `review_ok_N.json`（`digest` 必须与 `review_batch_N.json` 一致，`approved_card_ids ∪ rejected_card_ids` 覆盖全部候选且不重叠），否则下次启动直接拒绝。
- 被拒的候选如果还记在 `known_fav.json` 里，会报 `REJECTED_STILL_FAVORITED` —— 要么 `--rollback "真实姓名"` 走闭环，要么确认它其实从未收藏成功（历史 bug 的假记录）后手工纠正记账。
- 历史教训：旧版坐标点击写出过两条**假收藏记录**（日志报 `fav`，收藏列表里没有）。修好元素点击后不会再有；发现历史假记录时按上面第二条纠正，并在台账里注明。

---

## 五、为什么不用扩展桥做收藏

排查过两条桥，都不能替代原生 CDP 完成"收藏"这一步：

| 方案 | 能做什么 | 卡在哪 |
|---|---|---|
| BrowserSkill 0.3.3（bsk daemon，`ws://127.0.0.1:52800`） | `evaluate` 可读页面、可截图 | 用 `chrome.debugger` 长驱动 → 触发上面的反爬白屏；且要先 `bsk tab borrow` 才能碰用户标签 |
| DSH 浏览器助手（`~/.dsh/browser-extension`，工具级 15 个 `browser_*`） | `snapshot`/`get_text`/`scroll` 读整页候选人文本（实测一次读 12 人） | 点击只有 snapshot 序号或 CSS selector，**没有视口坐标、没有任意 JS 求值**；而卡片和「收藏」既不是 `<button>` 也不是 `<a[href]>`，snapshot 里只编号出「打招呼」按钮 → 想点收藏就会点到打招呼 |

所以：**收藏必须走独立调试实例 + 原生 CDP**；扩展桥只适合「只读筛人」（读候选人 → 判定 → 出名单，不点收藏）。

---

## 六、Windows 平台专属结论

1. **Chrome 136+ 不允许在默认 user-data-dir 上开调试端口**。实测三条路都不通：直接指定默认目录、目录 junction、`subst` 盘符映射——Chrome 会把路径解析回默认目录，端口不监听。必须用全新的 `--user-data-dir`（本机 `C:\Users\<you>\.boss-prof`），**并且在这个实例里登录一次**。
2. **Cookie 搬不过去**：源 profile 的 zhipin cookie 全部是 `v20` 前缀（App-Bound Encryption）。复制 `Local State` + `Cookies` + `Preferences` 到新 profile 启动后，实测 10 条 cookie **全被 Chrome 删掉**（解不开的 v20 会被清除）。macOS 的 cookie 密钥在钥匙串、同用户可复用，所以上游 README 里"复制 Default 目录"的流程在 macOS 成立、在 Windows 不成立。
3. 非管理员账号改不了 `HKLM\SOFTWARE\Policies\Google\Chrome`（`HKCU` 那个键访问被拒），所以没法用企业策略放开默认 profile 调试。
