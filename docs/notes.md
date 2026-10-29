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
- `/mem clear` 需 30 秒内二次确认；`/mem` 指令用 400 响应中断页面请求，真机表现待阶段 1 验证。
