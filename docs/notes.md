# via-dsmem · Via + DeepSeek 本地 RAG 记忆系统

按《Via + DeepSeek 本地 RAG 记忆系统 · Orama 版设计文档 V3》实现的用户脚本工程。
当前状态：**阶段 1/2a 完成并通过离线验收；阶段 0（协议抓包）未完成，协议字段留空，脚本对目标请求全部放行。**

| 项 | 值 |
|---|---|
| 产物 | `dist/via-dsmem.user.js`（单文件 IIFE，约 100 KB） |
| 依赖 | `@orama/orama` 3.1.18（锁定）、`esbuild`（仅构建期） |
| 源码 | `src/` 15 模块约 2100 行；测试 `test/` 6 个 |
| 离线验收 | 55 PASS / 0 FAIL（all 24 + t40-xhr 17 + t50-machine 14） |

## 快捷指令（输入框直接发，不进网络）

在对话框里输入下面三条之一，按发送（Enter 或点发送键）即可。命令在输入框层就被截住，
**不会产生任何网络请求**，执行完弹一条 toast 并清空输入框。

| 输入 | 作用 |
|---|---|
| `/mem on` | 开启记忆：恢复记录 + 注入 |
| `/mem off` | 关闭记忆：不记录、不注入（总开关，重启/刷新仍生效） |
| `/mem clear` | 清空全部记忆与响应样本（一次到位，无二次确认） |

实现要点：`src/85-input-command.js` 在 document 捕获阶段拦 `keydown Enter` / 发送键 `click` / `form submit`
（比页面 React 根容器更早），命中就地 `preventDefault + stopImmediatePropagation`，
再用原生 setter 清空输入框（否则 React state 不回写）。
网络层仍保留兜底：万一命令漏过输入框（改版、语音发送），XHR 分支直接不调用原始 `send`，
本地伪造一次 400 完成事件，命令依然不出网。

开发者调试口 `__dsMem` 默认**不再挂载**，需要时在页面先置 `window.__DSMEM_DEV = true`
或地址栏加 `#dsmem-dev`（测试 harness 会自动打开）。

## 目录

| 路径 | 内容 |
|---|---|
| `src/02-config.js` | 全部工程参数 + `PROTOCOL` 协议配置（**唯一需要改的文件**） |
| `src/99-main.js` | fetch 拦截、注入回退、SSE 观察、`/mem` 指令 |
| `src/20-store.js` | 记忆存储（一条一 key、预算淘汰、配额回滚） |
| `src/60-index.js` | Orama 索引（分片建库、增量更新、stale 重建） |
| `src/70-retrieve.js` | 检索、过滤、覆盖率裁剪、注入块计划 |
| `src/90-protocol.js` | 协议适配（配置驱动，未确认字段返回 null 即放行） |
| `src/05-probe.js` | 阶段 0 抓包探针（只记结构，不记正文） |
| `test/all.mjs` | 离线验收：T01/T02/T08/T11/T12/T15/T17/T23/T24/T25/T28/T33/T36/T38 |
| `test/harness.mjs` | 最小浏览器环境（window/localStorage/document/Response 切片） |
| `test/_diag.mjs` | 诊断：跑 6 轮看索引状态与计数器 |

## 命令

依赖已装在工程内 `node_modules`（16 MB），不需要联网重装。

```sh
sh build.sh          # 打包 → dist/via-dsmem.user.js
node test/all.mjs    # 离线验收（24 项）
node test/t05-no-segmenter.mjs   # 无 Intl.Segmenter 环境冒烟
```

## 阶段 0：抓包怎么用这个工程

1. 改 `src/02-config.js`：`PROTOCOL.discovery = true`，`sh build.sh`。
2. 把 `dist/via-dsmem.user.js` 装进 Via，打开 `chat.deepseek.com`，正常发一条消息。
3. 结构会打到控制台（`[DSMEM-PROBE]`）并经 toast 提示条数；也可在地址栏书签执行 `javascript:__dsMem.probe()` 取文本。
4. 把报告填进 `PROTOCOL`：`endpointPath` / `fields.userText` / `fields.sessionId` / `fields.parentMessageId` / `sse.*` / `retryBranch`。
5. `discovery = false` 重新打包，进入阶段 2b。

探针只记录键名、类型、长度、是否含中文；Authorization / PoW / Cookie 类请求头打码，正文内容一律不记录。

## 与设计文档 V3 的实测偏差（重要）

| # | 文档原文 | 实测结论（Orama 3.1.18 / node 26） | 本工程处置 |
|---|---|---|---|
| 1 | 8.3「`threshold` 取 0–1 之间要求命中一定比例的查询词」 | 否。`threshold` 是**结果集按条数插值裁剪**：0=命中全部词，1=命中任一词，中间值按 `lastTokenWithAllKeywords + ceil(t*(all-that))` 切条。实测 threshold 0 / 0.5 / 1 对同一查询返回完全相同的 2 条 | 用 `threshold=1` 宽召回，再自算 **token 覆盖率**（`COVERAGE_MIN`）与相对分裁剪 |
| 2 | 3.3「mandarin 模块顶层创建 Intl.Segmenter，无该 API 时整包失效」 | 证实。`dist/esm/mandarin.js` 第 6 行 `const segmenter = new Intl.Segmenter(...)` 在模块顶层 | 自实现 tokenizer，segmenter 惰性创建；T05 实测无 Segmenter 仍能加载并注册拦截器 |
| 3 | 7.3「自定义 tokenizer 需补齐锁定版本要求的字段」 | 需 8 个：`language` `tokenize` `stemmerSkipProperties` `tokenizeSkipProperties` `stopWords` `allowDuplicates` `normalizeToken`（来自 `@orama/orama/internals`） `normalizationCache` | `src/10-tokenizer.js` 按此契约实现 |
| 4 | 11.2「重新生成覆盖旧记录」 | 覆盖写入会用同 id 二次 `insert`，Orama 抛重复 id → 索引转 stale → 检索永久停用 | `addRecord` 先删后插；`markStale` 后 1.5 s 空闲重建 |
| 5 | 6.2「`MAX_TOTAL_CHARS` 取 1000000」 | Chrome/WebView localStorage 按 UTF-16 计，5 MB 约合 2.5 M 字符；站点自身也占用 | 下调到 500000（约占配额 20%），真机实测后再调 |

## 真机验收（阶段 1，本工程无法代做）

| 项 | 判据 |
|---|---|
| 脚本执行时机 | 页面发出首个 completion 请求前拦截器已注册 |
| fetch 共享 | `window.fetch` 即页面实际使用的 fetch |
| `Response.clone()` | 流式响应可克隆；用户取消时两支独立结束 |
| localStorage | 持久化范围与配额；单次写入耗时 < 30 ms |
| 分片建库 | 2000 条规模不阻塞输入；记录耗时 |

## v1.1 修复：真机 `count()` 恒为 0（2026-10-29）

三处根因，全部有代码证据，不是猜测：

| # | 根因 | 证据 | 处置 |
|---|---|---|---|
| A | **主链路只包 `window.fetch`，而页面实际走 XHR** | `src/99-main.js` 全文仅 `window.fetch=`；`src/05-probe.js` 的 XHR 钩子只记录后 `XS.apply` 放行 | 新增 `installXhr()`：包 `open/send/setRequestHeader`，主链路与 fetch 共用同一套 `planAndBuild` |
| B | **`store.put` 要求 `aiText` 非空**，而 `PROTOCOL.sse` 全 null 时正文永远提取不到 → 永远 `reason:'empty'` | `src/20-store.js` `if (!u.text \|\| !a.text) return {ok:false,reason:'empty'}` | 落库前移到「请求发出时」，只要求 `userText` 非空；响应回来用 `putAi()` 补写 |
| C | `__dsMem.stats()` 在 Via 控制台显示 `null` | Via 不渲染对象 | 新增 `__dsMem.diag()` 返回纯文本；`stats()` 契约不变 |

### 配套改动

| 项 | 说明 |
|---|---|
| `src/45-fallback.js`（新增） | 不依赖 `PROTOCOL.sse` 的正文兜底提取器。按结构嗅探 `content`/`text` 字段，排除 `thinking`/`reasoning`/`search`。实测三种格式：路径拼接式、`{v:{response:{content}}}` 包装式、thinking 干扰式 |
| 落库时机 | 请求发出即落 `userText`（`saved_pending`）；响应回来补 `aiText`（`ai_filled`） |
| 回滚 | 用户取消生成 / 审核撤回 → 撤回预落记录并递减 `saved`，维持原「不入库」语义 |
| 补丁重打 | 原实现只在 `discovery` 时重打，正常版单次打补丁被页面覆盖后整条链路静默失效。改为一律重打 20 次 × 400 ms |
| 探针版隔离 | `discovery=true` 时 fetch/XHR 均不注入、不落库（原实现仍会注入） |

### 新增诊断口

| 调用 | 返回 |
|---|---|
| `__dsMem.diag()` | 纯文本：store/index/fetch 接管状态/XHR 接管状态/非零计数/最近 prompt/响应样本 |
| `__dsMem.tap()` | 最近一次响应原文（≤6000 字符），用于回填 `PROTOCOL.sse` |
| `__dsMem.tapPanel()` | 把样本铺成全屏可复制浮层 |
| `__dsMem.clearTap()` | 清除样本 |
| `__dsMem.statsText()` | 统计 JSON 字符串（`stats()` 仍返回对象） |

### 验收

| 套件 | 结果 |
|---|---|
| `node test/all.mjs` | 24 PASS / 0 FAIL |
| `node test/t40-xhr.mjs`（新增） | 17 PASS / 0 FAIL |
| `node test/t05-no-segmenter.mjs` | PASS |

产物：`via-dsmem.user.js` md5 `33d19af6`，`via-dsmem-probe.user.js` md5 `129023364`。

## v1.2 修复：响应侧协议定型（2026-10-29 真机报文）

拿到真机响应报文后，发现三个必须一起改的问题。

| # | 问题 | 后果 |
|---|---|---|
| D | **DeepSeek 不用空行分隔 SSE 事件**，每个 `data:` 行就是一条独立事件 | 按标准 SSE 把连续 data 行拼成一条再 `JSON.parse` → 几十条事件合成一行、全部解析失败、**正文一个都拿不到** |
| E | **`fragments/-1` 是动态下标** | 同一个 path 字符串在不同时刻指向 THINK 片段或正文片段。拿 path 当 buffer key，思考过程和正文必然混在一起 |
| F | **正文与思考靠 `fragment.type` 区分，不靠 path** | `THINK` / `TOOL_SEARCH` 的内容也走 `.../content`，只看 path 分不出来 → 记忆里存的是思考碎片 |

### 处置

| 文件 | 改动 |
|---|---|
| `src/40-sse.js` | `push()` 接受字符串（XHR 与非流式两条路径传的都是字符串，丢给 `TextDecoder` 会抛 `ERR_INVALID_ARG_TYPE` 并被上层吞掉）；`flushEvent()` 先判断「拼起来还算不算 JSON」，不是 JSON 就逐行独立成事件 |
| `src/50-machine.js` | 整文件重写。维护 `fragments` 索引表，把 `-1` 在求值时解析成具体片段，按 `type` 分流到正文 / 思考 / 工具三个桶 |
| `src/02-config.js` | `PROTOCOL.sse` 回填实测值，`capturedAt` 置 `2026-10-29` |
| `src/45-fallback.js` | 兜底嗅探也认 `type`，遇到 `THINK` / `TOOL_*` 整段跳过 |

### 实测结论（顺带结掉的那个未知）

**`x-hif-leim` / `x-hif-dliq` 两枚签名头不绑定请求体。** 注入后 `inject_ok=1`、请求正常返回，记忆块拼进 `prompt` 服务端照常接受。`retryBranch` 保持 `'B'`，熔断仅作保险。

### 测试

| 套件 | 结果 |
|---|---|
| `test/all.mjs` | 24 PASS / 0 FAIL（已改用真机报文形态） |
| `test/t40-xhr.mjs` | 17 PASS / 0 FAIL |
| `test/t50-machine.mjs`（新增） | 14 PASS / 0 FAIL，**全部用真机原始报文** |
| `test/t05-no-segmenter.mjs` | PASS |

合计 **55 项**。产物 md5 `a8126925`。

## 设计变更声明

**「落库」语义由「回答生成完成才记一条」改为「用户发出即记一条，回答后到补写」。**

原因：响应侧协议未回填时 `aiText` 恒为空，按原语义一条都存不下来，整个系统不可验证。`userText` 是检索的主力字段（索引 boost 2:1），单独存在也能召回。用户取消生成与审核撤回仍按原设计不入库。

## 已知限制

- 协议未抓包，`PROTOCOL.endpointPath` 为 null 时脚本对目标请求全部放行，只注册拦截器不做事（设计如此）。
- 仅支持 `fetch(url, init)` 且 `body` 为字符串；Request 对象、FormData、二进制全部放行并计数 `skip_unsupported_form`。
- 无 `Intl.Segmenter` 时降级二元组分词，单字中文查询召回有限，阈值需另行校准。
- `/sum` 依赖「新对话页 = `https://chat.deepseek.com/`」这一前提；站点改版后改 `SUM_NEW_CHAT_URL` 即可。
- `/sum` 的自动触发频率取决于脚本观察到多少轮次，历史会话说到底只能靠服务端上下文，本地估算只是下界。

## 新增：`/sum` 上下文压缩（随 1.0 发布）

### 需求

1. 一个手动命令 `/sum`，其余全部自动。
2. 按字符粗估上下文规模（中文 0.6 token/字、英文 0.3 token/字），约 70 万 token 自动触发。
3. 触发方式 = hook 用户输入，发一条 `[总结所有]` 的 user 消息；端点返回的摘要**直接开一个新对话**继续。

### 关键取舍：不自己造请求

自己发一条压缩请求意味着要复刻页面的 `Authorization`、PoW 头（`x-ds-pow-response` 一类）与
请求体签名。这些东西是页面每次现算的，抄一份存着必然过期，写错了还会污染正常聊天。

所以改为**把输入框原地改写成 `[总结所有]`，让页面自己发**：

| 步 | 动作 | 实现位置 |
|---|---|---|
| 1 | 原生 setter 写值 + `input` 事件（否则 React state 不回写，点发送发的是空串） | `85-input-command.js` `writeValue` |
| 2 | 先补一个 `keydown Enter`（页面正常就是 Enter 发送），250ms 后输入框仍有内容 → 点发送键，再 500ms 还有 → toast 提示手动发 | `submitInput` |
| 3 | 网络层认出这条请求（`prompt === '[总结所有]'` 且落在 `SUM_ARM_MS` 时间窗内）→ 不注入、不落库，原样 `send`，只旁听响应 | `99-main.js` 两个通道各一处 |
| 4 | 响应正文到手 → 存 `sessionStorage` 交接单 → `location.href` 跳新对话首页 | `95-summarize.js` `finish` |
| 5 | 新页面 boot → 读交接单 → 等输入框（300ms 轮询，最多 20s）→ 写摘要 → 触发发送 → 删交接单 | `95-summarize.js` `resume` |

时间窗 `SUM_ARM_MS = 30s` 是必要的：`[总结所有]` 是普通文本，用户完全可以自己发这句话。
没有时间窗就会出现「用户自己想总结一下」被脚本当成交接动作的情况。窗口外命中记 `sum_stray` 并当普通消息落库。

### 上下文估算是下界

`store.sessionCounts(sessionId)` 只累加**脚本观察到的**轮次，且单条 `aiText` 落库时截断到 4000 字符，
所以算出来的是下界。真机上这个下界越大，估算越保守——阈值 70 万 token 属于用户指定值，
实际对话上下文远小于此，想让它起作用就把 `SUM_TRIGGER_TOKENS` 往下调。

估算按索引项里的 `cjk` / `other` 计数直接折算，不读 `localStorage` 正文：每轮结束都要算一次，
扫一遍全部条目在真机上会卡。

### 落地保护

| 风险 | 处置 |
|---|---|
| 压缩完成后用户又打开旧会话，交接单把摘要灌进旧对话 | `resume()` 先看地址栏：还是 `/a/chat/s/<id>` 就跳过（`resume-skip-old-chat`），交接单留着 |
| 摘要为空 / 被取消生成 | 短于 `SUM_MIN_TEXT_CHARS` 视为失败，只 toast，不跳转、不动原对话 |
| 新对话输入框迟迟不出现 | 20s 超时后提示「摘要已保留」，交接单不删，下次打开还能续 |
| 交接单保质期 | `SUM_PENDING_TTL_MS = 10 分钟`，过期丢弃，避免几天后突然冒出一条摘要 |
| `sessionStorage` 不可用（部分 WebView） | 退回 `localStorage`；都没有就只在本页内存里，压缩退化为「不跨页」 |

### 自我压缩导致的死循环

压缩请求走 `isSummaryRequest` 分支后直接 `return`，既不过 `saveUser` 也不走 `finalizeOnce`，
所以不会触发 `maybeAuto`；`SUM_COOLDOWN_MS` 再兜一层。摘要本身另存 `sessionId='dsmem_summary'`，
与当前会话无关，不会推高当前会话的估算值。

### 测试

`test/t70-sum.mjs` 26 项：命令拦截至不出网、输入框被改写、请求旁路不落库、摘要捕获与交接单、
新页面落地、估算口径（100 中文 + 100 英文 = 90 token）、超阈值自动触发、
时间窗外的 `[总结所有]` 记 `sum_stray`、`/sum` 带参数只回用法。

合计 **108 项**（24 + 17 + 27 + 14 + 26）。
