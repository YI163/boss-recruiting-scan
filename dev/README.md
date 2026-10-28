# dev —— 排查用的探针脚本

这些脚本不是 skill 的一部分，是我在定位「收藏点空 / 浮层关不掉 / 页面反复重载」时写的一次性探针，保留下来是为了让排查过程可复现。

- 连接方式与 skill 一致：先起带 --remote-debugging-port=9333 的 Chrome，再直接 
ode dev/xxx.mjs。
- 原始版本里的绝对路径已脱敏为 C:\Users\<you>\boss-work，**运行前请改成你自己的路径**。
- 按用途分：
  - probe-*.mjs：DOM/浮层/帧树/点击命中取证（probe-dialog、probe-leave 定位到 Vue 卡在 -leave；probe-hit 做落点命中测试；probe-close* 找关闭按钮）
  - av-*.mjs：单步收藏流程验证（开卡 → 读控件 → 点击 → 自证）
  - check-favs.mjs：去 /web/chat/interaction?status=9 核对真实收藏列表
  - dump-cards.mjs / inspect-page.mjs：抓卡片文本、看页面结构
  - judge-pt-java.py：一个改好的自定义判定器示例（深圳·兼职·Java 后端）
  - wd3080.mjs：把扩展写死的 127.0.0.1:3080 转发到 DSH 的 7775 桥（只读方案 B 用）
  - sk-eval.ps1：PowerShell 5.1 下给 sk evaluate 传长 JS 的包装（绕开引号被吃）

这些脚本会真实操作页面（点击、导航），跑之前确认当前标签是测试实例，不要在你的日常工作窗口里跑。