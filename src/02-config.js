// 全部工程参数集中在此，写死；要改就改这个文件再重新打包。
// 数值来自设计文档 V3 的初始值，标注【实测待调】的必须在真机上校准。

export var CONFIG = {
  // ---- 发送路径硬时限（第五章原则六）----
  RETRIEVE_TIMEOUT_MS: 400,          // 检索 + 构建注入块总时限
  INIT_RETRY_LIMIT: 1,               // 初始化失败不自动重试

  // ---- 查询预处理（8.2）----
  QUERY_MAX_CHARS: 200,
  MIN_QUERY_TOKENS: 2,
  CANDIDATE_LIMIT: 10,
  TOP_K: 3,

  // ---- 注入预算（8.1 / 8.4）----
  MAX_MEMORY_CHARS: 1800,
  PER_ITEM_CHARS: 600,
  PER_ITEM_QUESTION_CHARS: 150,

  // ---- 相关性（8.3，已按 3.1.18 实测修正，见 KNOWLEDGE.md）----
  ORAMA_THRESHOLD: 1,                // 1 = 命中任一词即返回，宽召回，后面自己裁
  COVERAGE_MIN: 0.34,                // 自行计算的查询词覆盖率下限【实测待调】
  SCORE_RATIO_MIN: 0.5,              // 候选得分不得低于 top1 的该比例
  ECHO_PENALTY: 0.8,                 // injected 记忆的得分系数

  // ---- 索引字段（7.2）----
  AI_INDEX_CHARS: 300,

  // ---- 存储（6.2）----
  MAX_TOTAL_CHARS: 500000,           // 文档初始 1000000，实测按 UTF-16 折算后下调
  MAX_ENTRIES: 2000,
  MAX_USER_TEXT_CHARS: 2000,
  MAX_AI_TEXT_CHARS: 4000,
  EVICT_RATIO: 0.1,                  // 配额失败时淘汰比例
  INJECTED_SESSIONS_KEEP: 30,

  // ---- 索引生命周期（7.6）----
  INDEX_CHUNK_SIZE: 50,
  INDEX_REBUILD_DELAY_MS: 1500,      // stale 后空闲重建的延迟

  // ---- 熔断与告警（5.4 / 13.2）----
  BREAKER_LIMIT: 3,
  PARSE_FAIL_ALERT: 5,
  INJECT_REJECT_ALERT: 3,
  TOAST_MS: 3200,
  INJECT_TOAST: true,               // 每次注入成功后短提示一次，便于肉眼确认

  // ---- 输入框快捷指令（13.3 重做：命令在输入框就被吃掉，不产生请求）----
  CMD_PREFIX: '/mem',
  CMD_KEYS: ['on', 'off', 'clear', 'sum'],

  // ---- /sum 上下文压缩（手动 + 超阈值自动）----
  // 做法：hook 输入框发一条 [总结所有] 的 user 消息 → 端点回摘要 → 摘要原样开一个新对话继续。
  SUM_ENABLE: true,
  SUM_PROMPT: '[总结所有]',
  SUM_AUTO: true,                    // 超阈值自动触发（手动 /sum 不受此开关影响）
  SUM_TRIGGER_TOKENS: 700000,        // 用户指定：约 70 万 token 触发；按需要下调即可
  SUM_TOKEN_CJK: 0.6,                // 1 个中文字符 ≈ 0.6 token
  SUM_TOKEN_OTHER: 0.3,              // 1 个英文字符 ≈ 0.3 token
  SUM_COOLDOWN_MS: 60000,            // 两次自动压缩的最短间隔，防抖
  SUM_MIN_TEXT_CHARS: 20,            // 摘要短于此长度视为失败，不开新对话
  SUM_HANDOFF_CHARS: 20000,          // 交给新对话的摘要上限，超出截断
  SUM_ARM_MS: 30000,                 // 发出 [总结所有] 后，认定「这条是本脚本发的」的时间窗
  SUM_PENDING_TTL_MS: 600000,        // 新会话交接单的保质期，过期丢弃
  SUM_INPUT_WAIT_MS: 20000,          // 新会话里等输入框出现的最长时间
  SUM_AUTO_DELAY_MS: 800,            // 自动触发时给页面留的渲染时间
  SUM_NEW_CHAT_URL: 'https://chat.deepseek.com/',

  // ---- 存储键（6.2）----
  KEY_PREFIX: 'ds_mem_e_',
  KEY_META: 'ds_mem_meta_v1',
  KEY_INJECTED: 'ds_mem_inj_v1',
  KEY_STATS: 'ds_mem_stats_v1',
  KEY_SESS_OFF: 'ds_mem_sessoff_v1',
  KEY_GLOBAL_OFF: 'ds_mem_global_off_v1',   // 总开关：/mem off 写这里
  KEY_SUM_PENDING: 'ds_mem_sum_pending_v1', // /sum 摘要 → 新对话的交接单

  MEMORY_BLOCK_BEGIN: '[[DSMEM:v1 BEGIN]]',
  MEMORY_BLOCK_END: '[[DSMEM:v1 END]]',
  SCHEMA_VERSION: 2
};

// 协议配置：阶段 0 抓包结论写在这里。未确认项一律留 null，
// 解析器遇到 null 必须返回 null（放行），不得猜测。
// 【阶段 0 待填】抓包日期、接口路径、字段名、事件类型、完成标志、审核撤回事件。
export var PROTOCOL = {
  discovery: false,               // 阶段 0：只记录请求结构，不修改、不注入、不落库
  capturedAt: '2026-10-29',        // 真机 Via + DeepSeek 网页
  host: 'chat.deepseek.com',
  // 来源：Greasy Fork 583027 (v2.1.0) 与 576012 (v1.2) 源码互证，2026-10-29 抓取。
  // 二者均在 chat.deepseek.com 上工作，API_PATTERNS 含 '/api/v0/chat/completion'，
  // 请求体含 prompt / chat_session_id / parent_message_id，新会话首条 parent_message_id 为 null。
  // 仍属第三方推断，未在本机真机流量核对；字段不匹配时 parseRequest 返回 null 自动放行。
  endpointPath: '/api/v0/chat/completion',
  altPaths: ['/chat/completions', '/v1/chat/completions'],
  method: 'POST',
  contentType: 'application/json',
  fields: {
    userText: 'prompt',
    sessionId: 'chat_session_id',
    parentMessageId: 'parent_message_id'
  },
  sessionIdFallback: 'session_id',  // 社区源码里的兜底字段名
  // 请求体是 messages 数组时的取值规则
  messagesPath: null,               // 例 'messages'
  lastMessageRole: 'user',
  powHeader: null,                  // 例 'x-ds-pow-response'
  // 响应侧：2026-10-29 真机报文实测回填
  // 实测形态见 src/50-machine.js 顶部注释。三个必须记住的点：
  //  1. 不用空行分隔事件，每个 data: 行就是一条独立事件
  //  2. `fragments/-1` 是动态下标，同一 path 在不同时刻指向不同片段
  //  3. 正文与 THINK/TOOL_SEARCH 靠 fragment.type 区分，不靠 path
  sse: {
    eventPathKey: 'p',
    eventOpKey: 'o',
    eventValueKey: 'v',
    ops: { APPEND: 'APPEND', SET: 'SET', BATCH: 'BATCH' },
    defaultOpWhenMissing: 'APPEND',
    textFragmentTypes: null,                              // 由 type 黑名单判定
    thinkFragmentTypes: ['THINK', 'THINKING', 'REASONING'],
    toolFragmentTypes: ['TOOL_SEARCH', 'TOOL_OPEN', 'TOOL_RESULT', 'SEARCH', 'SEARCH_RESULT'],
    snapshotPath: 'v.response',                           // 整条消息快照的位置
    fragmentsPath: 'response/fragments',                  // 片段数组
    lastIndexToken: '-1',                                 // 动态下标
    doneOps: null,                                        // 完成靠 status 字段，不靠 o
    errorOps: null,
    messageIdPath: 'response/message_id',
    moderatedOps: null
  },
  // 5.4 分支选择：'A' 可补发 / 'B' 一次性校验头
  retryBranch: 'B'
};

export var RETRY_ORIGINAL_ON_REJECT = PROTOCOL.retryBranch === 'A';
