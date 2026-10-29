# deepseek-web-mem

DeepSeek 网页版的**本地记忆**。历史对话存在你自己浏览器里，新提问时按相关度挑几条塞回 prompt。
不调 Embedding、不联网检索、不要 API Key，记忆不出本机。聊久了用 `/sum` 一键压缩成摘要，直接开新对话接着聊。

[![安装](https://img.shields.io/badge/一键安装-用户脚本-2f6f4f?style=for-the-badge)](https://raw.githubusercontent.com/Xiyinnnnnn/deepseek-web-mem/main/dist/deepseek-web-mem.user.js)
[![Tampermonkey](https://img.shields.io/badge/需要-Tampermonkey/Via-4a4a4a?style=for-the-badge)](https://www.tampermonkey.net/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

## 安装

| 步 | 动作 |
|---|---|
| 1 | 装一个用户脚本管理器：桌面端和手机浏览器用 [Tampermonkey](https://www.tampermonkey.net/)，Via 用自带的「脚本」功能 |
| 2 | 点上面的**一键安装**按钮，管理器弹出脚本页 → 点「安装」 |
| 3 | 打开 <https://chat.deepseek.com> 正常聊天，记忆自动开始工作 |

装好后第一次提问会看到一条 toast 提示，之后注入成功也会短提示一次（可在配置里关掉）。

## 快捷命令

在对话框里直接输入，按发送。命令**不会发到 API**：就地拦截、执行、弹 toast、清空输入框。

| 命令 | 作用 |
|---|---|
| `/mem on` | 开启记忆（记录 + 注入） |
| `/mem off` | 关闭记忆（不记录、不注入），刷新/重启后仍生效 |
| `/mem clear` | 清空全部记忆与响应样本 |
| `/sum` | **压缩上下文**：发一条 `[总结所有]` 让模型把这段对话压成摘要，摘要直接开一个新对话接着聊 |

上下文估算（中文 0.6 token/字、英文 0.3 token/字）累计到 **70 万 token** 时会自动做一次同样的压缩，
不需要手动输入。压缩请求本身不会被记成记忆；摘要有价值，会作为一条记忆入库（`dsmem_summary`）。

## 业务逻辑

| 环节 | 做法 |
|---|---|
| 拦截 | 同时接管 `window.fetch` 与 `XMLHttpRequest`（实测页面走 XHR，只包 fetch 会全盘不命中）；400ms 重打补丁防页面覆盖 |
| 落库 | 请求发出瞬间先存用户提问，回答流结束后补写正文；取消生成 / 内容撤回则回滚该条 |
| 检索 | 中文词级分词 → BM25 召回 → 覆盖率与得分双重裁剪 → top 3 |
| 注入 | 命中记忆拼成 `[[DSMEM:v1 BEGIN]] … [[DSMEM:v1 END]]` 块，写回**同一请求体**的 prompt 字段，其余字段与请求头原样不动 |
| 降级 | 凡是拿不准的情况一律放行原文：协议字段为 null、解析失败、检索超时（400ms）、注入被服务端拒 3 次即熔断停注入 |
| 压缩（手动 `/sum`） | 把输入框原地改写成 `[总结所有]`，**让页面自己发**这条请求（鉴权/PoW 全由页面处理）；响应侧只旁听取正文 → 摘要存进 `sessionStorage` 交接单 → 整页跳到新对话首页 → 新页面 boot 时把摘要写进输入框发出，交接单随即删除 |
| 压缩（自动） | 每轮回答结束后按当前会话累计字符估算 token（中文 0.6/字、英文 0.3/字），达到 `SUM_TRIGGER_TOKENS`（默认 70 万）就自动做一次上面那套压缩；60 秒冷却 + 压缩轮自身不计入估算，所以不会连环触发 |

## 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 检索 | Orama 3.1.18（BM25，无向量） | 打包后 ~130 KB 纯 JS；无 Embedding 即无网络、无 key、无隐私出口 |
| 中文分词 | `Intl.Segmenter`（`zh-CN` word 粒度） | WebView 自带；缺失时自动退回二元组 |
| 存储 | `localStorage` 单条一 key + 目录元数据 | 避免整表重写；配额不足按 10% 淘汰最旧；可检索字段只留 userText 与正文前 300 字 |
| 打包 | esbuild → 单文件 IIFE，`target=es2017` | 用户脚本必须单文件；ES2017 覆盖 Android System WebView |
| 协议 | 配置对象 `PROTOCOL`，未确认字段一律 `null` | 页面协议会变；`null` 走放行不猜，改配置不动逻辑 |
| 依赖 | 运行时零依赖、零外部请求 | 除 chat.deepseek.com 自身流量外不产生任何网络出口 |

## 开发

```bash
sh build.sh                    # 打包 → dist/deepseek-web-mem.user.js
node test/all.mjs              # 离线回归（24 项）
node test/t40-xhr.mjs          # XHR 通道（17 项）
node test/t60-cmd.mjs          # /mem、/sum 快捷命令（27 项）
node test/t50-machine.mjs       # 响应状态机（14 项）
node test/t70-sum.mjs           # /sum 压缩全流程（26 项）
```

| 目录 | 内容 |
|---|---|
| `src/` | 分包源码：能力检测 / 统计 / 配置 / 探针 / 分词 / 存储 / 记忆块 / SSE 解析 / 状态机 / 索引 / 检索 / 上下文 / 指令拦截 / 主装配 |
| `dist/` | 构建产物与 UserScript 元数据头 |
| `test/` | node 端模拟浏览器环境的回归套件 |
| `docs/notes.md` | 与设计文档的实测偏差、真机踩坑记录 |

## 已知限制

| 项 | 现状 |
|---|---|
| 只适配 `chat.deepseek.com` 的网页版对话接口 | 页面大改版可能中断；失败时一律放行，不会弄坏聊天 |
| 记忆上限 | 2000 条 / 约 50 万字符（`localStorage` 按 UTF-16 折算） |
| 换浏览器或清站点数据 | 记忆不跨设备、不跨浏览器，也无导出备份 |
| 上下文估算是字符折算 | 拿不到服务端 tokenizer，按中文 0.6 / 英文 0.3 粗算，且只统计脚本观察到的轮次；阈值 70 万 token 是保守值，可在 `02-config.js` 的 `SUM_TRIGGER_TOKENS` 改 |
| 压缩依赖新对话首页 | 压缩后跳到 `https://chat.deepseek.com/`（新对话页）再灌摘要；若站点改版导致新会话地址变化，改 `SUM_NEW_CHAT_URL` 即可 |

## 许可

[MIT](LICENSE)
