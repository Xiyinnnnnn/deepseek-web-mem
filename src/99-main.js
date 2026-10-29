// 模块 A：运行时初始化 + fetch 拦截（5.2 / 5.3 / 5.4 / 3.4）
import { CONFIG, PROTOCOL } from './02-config.js'
import { detect, capabilities } from './00-preflight.js'
import { stats } from './01-stats.js'
import { mode as tokenizerMode } from './10-tokenizer.js'
import { createStore, makeLocalBackend, makeMemoryBackend } from './20-store.js'
import { createIndexLayer } from './60-index.js'
import { planInjection, withTimeout } from './70-retrieve.js'
import { createRequestContext, finalizeOnce, createBreaker, createInjectedRegistry, createSessionSwitch, toast } from './80-context.js'
import { isTargetRequest, isSupportedForm, parseRequest, buildModifiedInit, buildModifiedBody, commandResponse, fakeXhrDone } from './90-protocol.js'
import { parseCommand, installInputCommand, HELP } from './85-input-command.js'
import { createCompressor } from './95-summarize.js'
import { tokensOfCounts } from './15-token-est.js'
import { createSseParser } from './40-sse.js'
import { createMachine, STATUS } from './50-machine.js'
import { extractFromRawText } from './45-fallback.js'
import { probeRequest, probeText, probePanel, showText, installHooks, channels, markInjectTime, injectedAt } from './05-probe.js'

function boot() {
  if (window.__ds_memory_rag_loaded) return
  window.__ds_memory_rag_loaded = true

  // 允许运行时覆盖协议配置：阶段 0 抓包结论可以先用书签注入，改完再写回源码
  try {
    if (window.__DSMEM_PROTOCOL_OVERRIDE) {
      var ov = window.__DSMEM_PROTOCOL_OVERRIDE
      for (var ok in ov) PROTOCOL[ok] = ov[ok]
    }
    if (window.__DSMEM_CONFIG_OVERRIDE) {
      var oc = window.__DSMEM_CONFIG_OVERRIDE
      for (var ck in oc) CONFIG[ck] = oc[ck]
    }
  } catch (e) {}

  try { markInjectTime(); installHooks() } catch (e) {}
  // 社区实证：页面会在初始化后重新赋值传输对象，单次打补丁会被覆盖。
  // 按 400ms 重打，最多 15 次（6 秒），幂等。
  // 补丁会被页面覆盖，必须重打。原实现只在 discovery 时重打，
  // 正常版因此单次打补丁被覆盖后整条链路静默失效。
  try {
    var repatch = setInterval(function () {
      try { installXhr(); injectedAt.patched++ } catch (e) {}
      if (injectedAt.patched > 20) clearInterval(repatch)
    }, 400)
  } catch (e) {}

  var originalFetch = window.fetch
  var store = null
  var index = null
  var injected = createInjectedRegistry()
  var sessionSwitch = createSessionSwitch()
  var skipNextInjection = false
  var lastInjection = null      // 最近一次注入的完整文本，仅存在于内存
  // 页面显示的是用户原文，服务端收到的是带记忆块的文本（设计文档 8.5 第 5 点）。
  // 因此「是否真的注入了」只能靠这份记录自证。
  var lastSent = { prompt: '', injected: false, ids: [], at: 0 }
  var lastInfo = null           // 最近一次目标请求的会话信息，/sum 估算上下文要用

  var breaker = createBreaker(function () {
    toast('记忆：注入被拒，本页面已暂停注入', 'breaker')
  })

  detect()
  try { stats.load() } catch (e) {}
  try { injected.load() } catch (e) {}
  try { sessionSwitch.load() } catch (e) {}

  // ---- 3.4 第 2 步：拦截器先注册，此时全部放行 ----
  window.fetch = function (input, init) {
    try {
      // 探针独立于目标识别：协议填好后 isTargetRequest 恒真，探针仍要能记录
      try { probeRequest(typeof input === 'string' ? input : (input && input.url), init, input) } catch (e) {}
      if (!isTargetRequest(input, init)) {
        return originalFetch.apply(this, arguments)
      }
      return processFetch(this, input, init)
    } catch (e) {
      // 同步异常一律回退原始请求：宁可不知道，也不能弄坏页面
      try { stats.set('lastOuterErr', String(e && e.message ? e.message : e).slice(0, 90)) } catch (e2) {}
      return originalFetch.apply(this, arguments)
    }
  }

  // ---- 3.4 第 3 步：异步初始化，每步独立 try/catch ----
  function initStorage() {
    try {
      if (capabilities.localStorage) {
        store = createStore(makeLocalBackend())
        store.init()
      } else {
        store = createStore(makeMemoryBackend())
        store.init()
        toast('记忆：存储不可用，本次浏览不保存记忆', 'no-storage')
        stats.inc('save_fail')
      }
    } catch (e) {
      try {
        store = createStore(makeMemoryBackend())
        store.init()
      } catch (e2) { store = null }
    }
  }

  function initIndex() {
    if (!store) return
    try {
      index = createIndexLayer(store)
      index.build().then(function (ok) {
        if (!ok) toast('记忆：检索不可用，聊天不受影响', 'index-fail')
      })
    } catch (e) {
      index = null
    }
  }

  // store 初始化改为同步：真机第一条请求可能早于 setTimeout(0)，
  // 异步会导致首条记忆落不进去（实测 saved=3 而 saved_pending=2 就是这个差）
  try { initStorage() } catch (e) {}
  setTimeout(initIndex, 0)
  try { installXhr() } catch (e) {}

  // ---- /sum 上下文压缩：手动 /sum + 超阈值自动 ----
  // 唯一需要准备的东西是「当前会话已经有多大」，所以把 store 的会话统计和会话 id 交给它。
  var compressor = createCompressor({
    contextTokens: contextTokens,
    currentSession: currentSession,
    // 摘要本身也进记忆库：新对话里再聊到相关话题时，这段摘要能被检索回来
    onSummary: function (text, from) {
      try {
        if (!store) return
        var r = store.put({
          sessionId: 'dsmem_summary',
          parentMessageId: null,
          userText: String(text || '').slice(0, 1900),
          aiText: '',
          injected: false,
          injectedIds: []
        })
        if (r && r.ok) {
          stats.inc('sum_saved')
          if (index) { var rec = store.get(r.id); if (rec) index.addRecord(rec) }
        }
      } catch (e) {}
    }
  })
  try { compressor.resume() } catch (e) {}
  // SPA 内跳到新对话不重载页面，靠路由监听补一次落地机会
  try { compressor.watchRoute() } catch (e) {}

  // 输入框快捷指令：命令在这里就被吃掉，根本不会产生请求
  try { installInputCommand({ run: runCommandText }) } catch (e) {}

  // ---- 当前会话 id：优先最近一次请求，其次地址栏 /a/chat/s/<id> ----
  function currentSession() {
    try { if (lastInfo && lastInfo.sessionId) return String(lastInfo.sessionId) } catch (e) {}
    try {
      var m = /\/a\/chat\/s\/([A-Za-z0-9_-]+)/.exec(String((location && location.pathname) || ''))
      if (m) return m[1]
    } catch (e) {}
    return ''
  }

  // ---- 上下文规模：本会话已落库的 user+ai 文本，按中英字符折算 ----
  // 口径来自需求：1 个中文字符 ≈ 0.6 token，1 个英文字符 ≈ 0.3 token。
  function contextTokens() {
    if (!store) return 0
    var sid = currentSession()
    if (!sid) return 0
    return tokensOfCounts(store.sessionCounts(sid))
  }

  // ---- 5.3 保持原始响应语义 ----
  function recordSent(init, modifiedInit, ids) {
    try {
      var raw = (modifiedInit || init || {}).body
      var obj = typeof raw === 'string' ? JSON.parse(raw) : null
      lastSent.prompt = obj && typeof obj.prompt === 'string' ? obj.prompt : ''
      lastSent.injected = !!modifiedInit
      lastSent.ids = ids || []
      lastSent.at = Date.now()
    } catch (e) {}
  }

  // ---- 传输无关的上半段：落库 userText + 决定要不要注入 ----
  // 落库前移的理由（实测）：响应侧协议未确认时 aiText 永远提取不到，
  // 若等响应回来才落库，count 会永远为 0。userText 才是检索的主力字段，必须先留下。
  function saveUser(ctx) {
    if (!store || !ctx) return null
    try {
      var r = store.put({
        sessionId: ctx.sessionId,
        parentMessageId: ctx.parentMessageId,
        userText: ctx.originalUserText,
        aiText: '',
        injected: false,
        injectedIds: []
      })
      if (r && r.ok) {
        ctx.savedId = r.id
        stats.inc('saved_pending')
        if (index) {
          var rec = store.get(r.id)
          if (rec) index.addRecord(rec)
        }
      }
      return r
    } catch (e) { return null }
  }

  // 返回 Promise<{ body: 新 body 或 null, ctx }>，任何失败都解析为 body=null（放行原文）
  function planAndBuild(info, bodyStr, method) {
    var ctx = createRequestContext(info)
    if (!isInjectionAllowed(info)) return Promise.resolve({ body: null, ctx: ctx })
    var deps = { index: index, store: store, injected: injected }
    return withTimeout(planInjection(deps, info), CONFIG.RETRIEVE_TIMEOUT_MS, function () {
      stats.inc('retrieve_timeout')
    }).then(function (plan) {
      if (!plan || !plan.block) {
        if (plan === null) stats.inc('retrieve_none')
        return { body: null, ctx: ctx }
      }
      var mod = null
      try { mod = buildModifiedBody(bodyStr, method || 'POST', plan.block, info) } catch (e) { mod = null }
      if (!mod) return { body: null, ctx: ctx }
      ctx.injectedIds = plan.ids.slice()
      ctx.pendingText = mod
      return { body: mod, ctx: ctx }
    }, function () {
      stats.inc('retrieve_error')
      return { body: null, ctx: ctx }
    })
  }

  function injectSuccess(ctx) {
    breaker.success()
    stats.inc('inject_ok')
    try { injected.add(ctx.sessionId, ctx.injectedIds) } catch (e) {}
    lastInjection = {
      at: new Date().toISOString(),
      count: ctx.injectedIds.length,
      ids: ctx.injectedIds.slice(),
      text: ctx.pendingText || ''
    }
    if (CONFIG.INJECT_TOAST) toast('记忆：本次请求已注入 ' + ctx.injectedIds.length + ' 条历史记忆')
    stats.save()
  }

  // 响应原文样本：PROTOCOL.sse 尚未回填时，这是唯一的回填依据
  var lastTap = ''
  try { lastTap = localStorage.getItem('ds_mem_tap_v1') || '' } catch (e) {}

  function saveTap(rawText) {
    try {
      var sample = String(rawText || '')
      if (sample.length > 6000) sample = sample.slice(0, 6000)
      if (!sample) return
      lastTap = sample
      stats.inc('tap_saved')
      try { localStorage.setItem('ds_mem_tap_v1', sample) } catch (e) {}
    } catch (e) {}
  }

  // ---- 8.5 / 5.4 是否允许注入 ----
  function isInjectionAllowed(info) {
    if (!store || !index) return false
    if (breaker.isTripped()) return false
    if (skipNextInjection) { skipNextInjection = false; return false }
    if (sessionSwitch.isOff(info.sessionId)) return false
    if (!index.isReady()) return false           // T22：构建中直接放行，不排队
    return true
  }

  // ---- 5.2 请求处理（fetch 通道）----
  function processFetch(receiver, input, init) {
    // 阶段 0：只记录结构，不注入、不落库（探针版）
    if (PROTOCOL.discovery) return originalFetch.call(receiver, input, init)
    var info = null
    try { info = parseRequest(input, init) } catch (e) { info = null }

    if (!info) {
      stats.inc('skip_parse')
      return originalFetch.call(receiver, input, init)
    }
    if (info.command) {
      // 命令一律不发网络（页面走 fetch 时才会到这儿，正常情况输入框层已吃掉）
      stats.inc('cmd_blocked_fetch')
      runCommandLocal(info.command)
      return commandResponse({ code: 0, msg: 'DSMEM command handled locally' })
    }
    lastInfo = info

    // /sum 压缩请求：不注入、不落库，原样发出，只旁听响应拿摘要
    if (compressor.isSummaryRequest(info)) {
      stats.inc('sum_request')
      var sctx = createRequestContext(info)
      sctx.isSummary = true
      var sumRes = originalFetch.call(receiver, input, init)
      try {
        sumRes.then(function (res) { try { observeFetch(res, sctx) } catch (e) {} },
                    function () { try { compressor.finish('') } catch (e) {} })
      } catch (e) {}
      return sumRes
    }
    if (sessionSwitch.isGlobalOff()) {          // /mem off：原样放行，不记录也不注入
      stats.inc('off_pass')
      return originalFetch.call(receiver, input, init)
    }

    var early = createRequestContext(info)
    saveUser(early)                     // 先落 userText：这一步与响应完全无关

    var method = (init && init.method) || 'POST'
    return planAndBuild(info, init.body, method).then(function (r) {
      var ctx = r.ctx || early
      if (!ctx.savedId) ctx.savedId = early.savedId
      recordSent(init, r.body ? { body: r.body } : null, ctx.injectedIds)

      var reqInit = init
      if (r.body) {
        reqInit = {}
        for (var k in init) reqInit[k] = init[k]
        reqInit.body = r.body
      }
      return originalFetch.call(receiver, input, reqInit).then(function (res) {
        try { observeFetch(res, ctx) } catch (e) {}
        if (r.body) {
          if (res && res.ok) { injectSuccess(ctx); return res }
          stats.inc('inject_rejected')
          breaker.fail()
          if (PROTOCOL.retryBranch === 'A') {
            try { if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(function () {}) } catch (e) {}
            ctx.injectedIds = []
            return originalFetch.call(receiver, input, init).then(function (res2) {
              try { observeFetch(res2, ctx) } catch (e) {}
              return res2
            })
          }
          skipNextInjection = true
          ctx.injectedIds = []
        }
        return res
      }, function (err) {
        if (r.body) { stats.inc('inject_rejected'); breaker.fail(); skipNextInjection = true }
        throw err
      })
    }, function () {
      return originalFetch.call(receiver, input, init)
    })
  }

  // ---- 5.2 请求处理（XHR 通道）----
  // 真机实测：DeepSeek 网页走的是 XMLHttpRequest，不是 fetch。
  // 只包 window.fetch 的版本永远不命中，这就是「count 恒为 0」的直接原因。
  function installXhr() {
    try {
      if (PROTOCOL.discovery) return false
      if (typeof XMLHttpRequest === 'undefined' || !XMLHttpRequest.prototype) return false
      var P = XMLHttpRequest.prototype
      if (P.__dsmHooked) return true

      var XO = P.open, XS = P.send, XH = P.setRequestHeader

      P.open = function (method, url, async) {
        try {
          this.__dsmMethod = method
          this.__dsmUrl = url
          this.__dsmAsync = (async === undefined) ? true : !!async
          this.__dsmHeaders = {}
          this.__dsmMine = true
        } catch (e) {}
        return XO.apply(this, arguments)
      }

      P.setRequestHeader = function (k, v) {
        try { if (this.__dsmHeaders) this.__dsmHeaders[String(k).toLowerCase()] = String(v) } catch (e) {}
        return XH.apply(this, arguments)
      }

      P.send = function (body) {
        var self = this
        try {
          if (!self.__dsmMine) return XS.apply(this, arguments)
          if (self.__dsmAsync === false) return XS.apply(this, arguments)     // 同步 XHR 不介入
          if (typeof body !== 'string') return XS.apply(this, arguments)

          var init = { method: self.__dsmMethod, body: body, headers: self.__dsmHeaders }
          if (!isTargetRequest(self.__dsmUrl, init)) return XS.apply(this, arguments)

          stats.inc('xhr_hit')
          var info = null
          try { info = parseRequest(self.__dsmUrl, init) } catch (e) { info = null }
          if (!info) { stats.inc('skip_parse'); return XS.apply(this, arguments) }

          if (info.command) {
            // 真机根因就在这里：旧代码 `XS.apply(this, arguments)` 把命令原样发给了 API。
            // 现在绝不外发，本地执行 + 伪造一次 400 完成事件，免得页面一直转圈。
            stats.inc('cmd_blocked_xhr')
            runCommandLocal(info.command)
            fakeXhrDone(self, 400, JSON.stringify({ code: 1, msg: 'handled locally' }))
            return
          }
          // /sum 压缩请求：不注入、不落库，原样发出，响应侧交给 finish 取摘要
          if (compressor.isSummaryRequest(info)) {
            stats.inc('sum_request')
            lastInfo = info
            var sctx = createRequestContext(info)
            sctx.isSummary = true
            observeXhr(self, sctx)
            return XS.call(self, body)
          }
          lastInfo = info

          if (sessionSwitch.isGlobalOff()) { stats.inc('off_pass'); return XS.apply(this, arguments) }

          var early = createRequestContext(info)
          saveUser(early)
          observeXhr(self, early)

          planAndBuild(info, body, self.__dsmMethod).then(function (r) {
            var ctx = r.ctx || early
            if (!ctx.savedId) ctx.savedId = early.savedId
            if (ctx.injectedIds.length) { early.injectedIds = ctx.injectedIds; early.pendingText = ctx.pendingText }
            // 页面可能在这几毫秒内 abort 掉，此时再 send 会抛 InvalidStateError
            if (self.readyState !== 1) { stats.inc('xhr_aborted_before_send'); return }
            recordSent(init, r.body ? { body: r.body } : null, ctx.injectedIds)
            if (r.body) {
              try {
                XS.call(self, r.body)
                stats.inc('xhr_inject_ok')
                injectSuccess(ctx)
                return
              } catch (e) {
                stats.set('lastXhrError', 'inject-send:' + String(e).slice(0, 60))
              }
            }
            try { XS.call(self, body) } catch (e2) {
              stats.set('lastXhrError', 'send:' + String(e2).slice(0, 60))
            }
          }, function () {
            if (self.readyState !== 1) return
            try { XS.call(self, body) } catch (e) {}
          })
          return
        } catch (e) {
          try { stats.set('lastXhrError', String(e).slice(0, 80)) } catch (e2) {}
          return XS.apply(this, arguments)
        }
      }

      P.__dsmHooked = true
      return true
    } catch (e) {
      try { stats.set('lastXhrError', 'install:' + String(e).slice(0, 60)) } catch (e2) {}
      return false
    }
  }

  // ---- 5.3 保持原始响应语义：克隆副本独立读完，任何异常不影响页面 ----
  function observeFetch(res, ctx) {
    if (!res || !capabilities.clone) return
    var copy
    try { copy = res.clone() } catch (e) { return }

    var machine = createMachine()
    var parser = createSseParser(function (ev) { machine.feed(ev) })
    var whole = ''                      // 累积原文，供兜底提取与样本留存

    if (!copy.body || typeof copy.body.getReader !== 'function') {
      copy.text().then(function (txt) {
        whole = txt
        parser.push(txt)
        parser.end()
        finish(machine, ctx, whole)
      }, function () { machine.markFailed(); finish(machine, ctx, '') })
      return
    }

    var reader = copy.body.getReader()
    function pump() {
      reader.read().then(function (r) {
        if (r.done) { parser.end(); finish(machine, ctx, whole); return }
        try { whole += typeof r.value === 'string' ? r.value : new TextDecoder('utf-8').decode(r.value, { stream: true }) } catch (e) {}
        parser.push(r.value)
        pump()
      }, function (err) {
        var name = (err && err.name) || ''
        if (/abort/i.test(name)) machine.markCancelled()
        else machine.markFailed()
        finish(machine, ctx, whole)
      })
    }
    pump()
  }

  function observeXhr(xhr, ctx) {
    var machine = createMachine()
    var parser = createSseParser(function (ev) { machine.feed(ev) })
    var done = false

    function readRaw() {
      var raw = ''
      try { raw = xhr.responseText || '' } catch (e) { raw = '' }
      if (!raw) {
        try {
          var rt = xhr.responseType
          if (rt === 'json' && xhr.response) raw = JSON.stringify(xhr.response)
          else if (rt === 'arraybuffer' && xhr.response && typeof TextDecoder !== 'undefined') raw = new TextDecoder('utf-8').decode(xhr.response)
        } catch (e) {}
      }
      return raw
    }

    function settle(kind) {
      if (done) return
      done = true
      var raw = readRaw()
      if (raw) { try { parser.push(raw); parser.end() } catch (e) {} }
      else if (kind === 'abort') machine.markCancelled()
      else machine.markFailed()
      finish(machine, ctx, raw)
    }

    try {
      xhr.addEventListener('loadend', function () { settle('load') })
      xhr.addEventListener('abort', function () { settle('abort') })
      xhr.addEventListener('error', function () { settle('error') })
      xhr.addEventListener('timeout', function () { settle('abort') })
    } catch (e) {}
  }

  // 取消生成 / 审核撤回：把发送时预落的 userText 撤回，维持「不入库」的原语义。
  // 与「正文提取失败」区别对待：后者是真机常态（响应协议还没回填），必须保留 userText。
  function rollbackPending(ctx) {
    if (!store || !ctx || !ctx.savedId) return
    try {
      store.remove(ctx.savedId)
      if (index) index.dropRecord(ctx.savedId)
      // 口径对齐：预落库时 saved 已 +1，撤回要减回去，否则统计与条目数会长期背离
      stats.inc('saved', -1)
      stats.inc('saved_pending', -1)
      stats.inc('rollback')
      ctx.savedId = null
    } catch (e) {}
  }

  function finish(machine, ctx, rawText) {
    // 无条件留样本：提取成功时更该留，否则永远拿不到真实响应结构去回填 PROTOCOL.sse
    if (rawText && rawText.length > 20) saveTap(rawText)
    var result = machine.result()

    // /sum 压缩请求：只把正文交给压缩模块，既不入库也不参与注入统计
    if (ctx && ctx.isSummary) {
      var dead = (result.status === STATUS.CANCELLED || result.status === STATUS.FAILED)
      var sumText = dead ? '' : String(result.text || '').trim()
      if (!sumText && !dead && rawText) {
        try { sumText = String(extractFromRawText(rawText) || '').trim() } catch (e) {}
      }
      try { compressor.finish(sumText) } catch (e) {}
      return
    }

    if (result.status === STATUS.CANCELLED || result.status === STATUS.FAILED) {
      // 审核撤回时正文可能已部分到达，同样不保留
      rollbackPending(ctx)
      if (result.status === STATUS.FAILED) stats.inc('extract_fail_run')
      if (result.status === STATUS.FAILED) maybeProtocolAlert()
      return
    }
    var text = String(result.text || '').trim()

    // 配置驱动失败时走结构嗅探兜底（PROTOCOL.sse 尚未回填的常态）
    if (!text && rawText) {
      try { text = String(extractFromRawText(rawText) || '').trim() } catch (e) {}
    }
    if (!text) {
      stats.inc('extract_fail_run')
      if (result.status === STATUS.FAILED) maybeProtocolAlert()
      return                                  // userText 已落库，这里只丢正文
    }
    stats.resetRun()

    finalizeOnce(ctx, function () {
      if (!store) return
      if (ctx.savedId) {
        var r = store.putAi(ctx.savedId, text)
        if (!(r && r.ok)) stats.set('lastAiErr', String(r && r.reason))
        if (r && r.ok && index && r.rec) index.addRecord(r.rec)
        return
      }
      var r2 = store.put({
        sessionId: ctx.sessionId,
        parentMessageId: ctx.parentMessageId || result.messageId || null,
        userText: ctx.originalUserText,
        aiText: text,
        injected: ctx.injectedIds.length > 0,
        injectedIds: ctx.injectedIds
      })
      if (r2 && r2.ok && index) {
        var rec = store.get(r2.id)
        if (rec) index.addRecord(rec)
        if (r2.evicted && r2.evicted.length) {
          for (var i = 0; i < r2.evicted.length; i++) index.dropRecord(r2.evicted[i])
        }
      }
    })

    // 每轮结束后按会话规模判定一次：达到阈值就自动发 [总结所有]（自带冷却，不会连环触发）
    try { compressor.maybeAuto() } catch (e) {}
  }

  function maybeProtocolAlert() {
    if (stats.get('extract_fail_run') >= CONFIG.PARSE_FAIL_ALERT) {
      toast('记忆：协议疑似变化，已暂停记录', 'protocol')
    }
  }

  // ---- 13.3 管理指令：/mem on|off|clear 与 /sum ----
  // cmd = { cmd:'mem'|'sum', sub:'on'|'off'|'clear'|'', unknown:bool }；也接受纯字符串子命令。
  // 返回一句文案；不弹提示、不发网络、不落库。提示由调用方决定。
  function applyCommand(cmd) {
    var c = (cmd && typeof cmd === 'object') ? cmd : { cmd: 'mem', sub: cmd, unknown: false }
    var t = String(c.sub || '').toLowerCase().trim()
    var name = String(c.cmd || 'mem').toLowerCase()

    if (name === 'sum') {
      if (t) return HELP                    // /sum 只有裸命令，带参数按用法提示处理
      return compressor.manual()
    }
    if (c.unknown && t) return HELP          // /mem 后面跟了看不懂的词

    if (t === 'on') {
      sessionSwitch.clearAll()
      sessionSwitch.setGlobalOff(false)
      try { stats.save() } catch (e) {}
      return '记忆：已开启（记录 + 注入）'
    }
    if (t === 'off') {
      sessionSwitch.setGlobalOff(true)
      return '记忆：已关闭（不记录、不注入）'
    }
    if (t === 'clear') {
      var n = store ? store.count() : 0
      try { if (store) store.clearAll() } catch (e) {}
      try { injected.clearAll() } catch (e) {}
      lastTap = ''
      try { localStorage.removeItem('ds_mem_tap_v1') } catch (e) {}
      try { if (index && index.rebuild) index.rebuild() } catch (e) {}
      stats.inc('mem_cleared')
      return '记忆：已清空 ' + n + ' 条'
    }
    return HELP
  }

  // 输入框入口传 {cmd,sub}；网络兜底传整条命令文本
  function runCommandText(raw) {
    if (raw && typeof raw === 'object') return applyCommand(raw)
    var t = String(raw == null ? '' : raw).trim()
    var c = null
    if (t.charAt(0) === '/') { try { c = parseCommand(t) } catch (e) {} }
    if (!c) c = { cmd: 'mem', sub: t, unknown: false }
    return applyCommand(c)
  }

  // 网络层兜底：输入框没抓到（改版 / 语音发送 / 别的键盘）时，执行 + 提示
  function runCommandLocal(raw) {
    var m = ''
    try { m = runCommandText(raw) } catch (e) { m = '记忆：指令执行失败' }
    try { toast(m) } catch (e) {}
    try { console.log('[DSMEM]', m) } catch (e) {}
    return m
  }

  function statusText() {
    var n = store ? store.count() : 0
    var chars = store ? store.chars() : 0
    return '记忆：' + n + ' 条 / 约 ' + chars + ' 字；开关=' + (sessionSwitch.isGlobalOff() ? '关' : '开') +
      '；分词=' + tokenizerMode() + '；索引=' + (index ? index.state() : 'n/a') +
      '；注入 ' + stats.get('inject_ok') + '/' + stats.get('inject_rejected')
  }

  function forgetLast() {
    var ids = store ? store.ids() : []
    if (!ids.length) return '记忆：没有可删除的记录'
    var last = ids[ids.length - 1]
    store.remove(last)
    if (index) index.dropRecord(last)
    return '记忆：已删除最近一条，剩余 ' + store.count() + ' 条'
  }

  // 13.3 开发者入口：默认不挂载。命令入口只走输入框。
  // 需要调试时在加载脚本前置 window.__DSMEM_DEV = true，或地址栏加 #dsmem-dev。
  try {
    var devOn = false
    try {
      devOn = !!window.__DSMEM_DEV || /dsmem[-_]dev/.test(String((window.location && window.location.hash) || ''))
    } catch (e) {}
    if (devOn) window.__dsMem = {
      status: function () { var m = statusText(); toast(m); return m },
      forget: function () { var m = forgetLast(); toast(m); return m },
      clear: function () { var m = applyCommand('clear'); toast(m); return m },
      // 契约保持：返回对象，测试与脚本内部依赖这个形状。
      // Via 控制台不渲染对象（显示成 null），要看人话请用 __dsMem.diag()。
      stats: function () { return stats.snapshot() },
      statsText: function () { return JSON.stringify(stats.snapshot()) },
      diag: function () {
        var st = stats.snapshot()
        var L = []
        L.push('DSMEM 诊断 ' + new Date().toLocaleString())
        L.push('')
        L.push('store      = ' + (store ? store.kind() : 'null') +
               '  count=' + (store ? store.count() : -1) +
               '  chars=' + (store ? store.chars() : -1))
        L.push('index      = ' + (index ? index.state() : 'null'))
        L.push('tokenizer  = ' + tokenizerMode())
        L.push('context    = 约 ' + Math.round(contextTokens() / 1000) + 'K token（会话 ' + (currentSession() || '-') + '）')
        L.push('compressor = ' + compressor.status())
        L.push('fetch      = ' + (/native code/.test(String(window.fetch)) ? '原生(未接管)' : '已接管'))
        L.push('xhr        = ' + (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype.__dsmHooked ? '已接管' : '未接管'))
        L.push('存储可用   = ' + (capabilities.localStorage ? 'localStorage' : '内存(不持久)'))
        L.push('')
        L.push('--- 通道命中 ---')
        L.push('channels   = ' + JSON.stringify(channels))
        L.push('')
        L.push('--- 计数（非 0 才列出）---')
        var zero = []
        for (var k in st) {
          if (k === 'v' || k === 'lastSavedAt' || k === 'tokenizerMode') continue
          if (st[k]) L.push('  ' + k + ' = ' + st[k])
          else zero.push(k)
        }
        L.push('  (为 0: ' + zero.length + ' 项)')
        if (st.lastSavedAt) L.push('最近落库 = ' + new Date(st.lastSavedAt).toLocaleString())
        if (st.lastXhrError) L.push('XHR 异常 = ' + st.lastXhrError)
        L.push('')
        L.push('--- 最近一次发给服务端的 prompt ---')
        if (!lastSent.at) L.push('（还没有发出过请求）')
        else L.push('注入=' + (lastSent.injected ? '是' : '否') + '  ids=' + (lastSent.ids.join(',') || '-') +
                    '  长度=' + String(lastSent.prompt || '').length)
        L.push('')
        L.push('--- 响应样本 ---')
        L.push(lastTap ? lastTap.length + ' 字符（用 __dsMem.tap() 取）' : '无（还没有抓到响应原文）')
        return L.join('\n')
      },
      tap: function () {
        if (!lastTap) return '（还没有抓到响应原文：先在新会话里发一条消息）'
        return lastTap
      },
      tapPanel: function () { return showText('DSMEM 响应样本', lastTap || '（空）') },
      // 一步清空：协议改写后旧记录里的 aiText 可能是脏的（思考碎片），必须能整批丢掉
      wipe: function () {
        if (!store) return 'store 未初始化'
        var n = store.count()
        try { store.clearAll() } catch (e) {}
        try { injected.clearAll() } catch (e) {}
        try { localStorage.removeItem('ds_mem_tap_v1') } catch (e) {}
        lastTap = ''
        try { stats.save() } catch (e) {}
        if (index) { try { index.rebuild() } catch (e) {} }
        return '已清空 ' + n + ' 条记忆与响应样本'
      },
      clearTap: function () { try { localStorage.removeItem('ds_mem_tap_v1') } catch (e) {} lastTap = ''; return 'ok' },
      indexState: function () { return index ? index.state() : 'n/a' },
      count: function () { return store ? store.count() : 0 },
      lastInjection: function () { return lastInjection },
      memories: function () {
        if (!store) return []
        return store.all().map(function (r) {
          return {
            id: r.id,
            session: String(r.sessionId).slice(0, 8),
            user: String(r.userText),
            ai: String(r.aiText).slice(0, 80),
            injected: !!r.injected,
            at: new Date(r.timestamp).toLocaleString()
          }
        })
      },
      panel: function (text) {
        try {
          var old = document.querySelector('[data-dsmem-panel]'); if (old) old.remove()
          var w = document.createElement('div')
          w.setAttribute('data-dsmem-panel', '1')
          w.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.86);padding:14px;box-sizing:border-box;display:flex;flex-direction:column;gap:8px'
          var bar = document.createElement('div')
          bar.style.cssText = 'display:flex;gap:10px;color:#fff;font-size:14px;align-items:center'
          bar.textContent = 'DSMEM 输出（长按全选复制）'
          var btn = document.createElement('button')
          btn.textContent = '关闭'
          btn.style.cssText = 'margin-left:auto;padding:6px 12px;border-radius:8px;border:0;background:#444;color:#fff;font-size:14px'
          btn.onclick = function () { w.remove() }
          bar.appendChild(btn)
          var ta = document.createElement('textarea')
          ta.value = String(text)
          ta.style.cssText = 'flex:1;width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;line-height:1.45;background:#111;color:#e6e6e6;border:1px solid #333;border-radius:10px;padding:10px;resize:none'
          w.appendChild(bar); w.appendChild(ta); document.body.appendChild(w)
          try { ta.focus(); ta.select() } catch (e) {}
        } catch (e) {}
        return text
      },
      lastSent: function () { return lastSent },
      // /sum 相关：手动压缩、当前上下文估算、压缩状态
      sum: function () { var m = compressor.manual(); return m },
      estimate: function () { return contextTokens() },
      sumStatus: function () { return compressor.status() },
      memList: function () {
        if (!store) return []
        return store.all().map(function (r) {
          return {
            id: r.id,
            sessionId: r.sessionId,
            userText: r.userText,
            injected: r.injected,
            aiLen: (r.aiText || '').length,
            ai: String(r.aiText || '').slice(0, 60)
          }
        })
      },
      // 不发送，只算「现在问这句话会注入什么」
      preview: function (q) {
        if (!store || !index) return Promise.resolve('记忆未初始化')
        var deps = { index: index, store: store, injected: injected }
        return planInjection(deps, { sessionId: '__preview__', userText: String(q || '') })
          .then(function (p) { return p ? p.block : '（没有命中任何记忆）' })
          .catch(function (e) { return '检索异常：' + e })
      },
      ragPanel: function () {
        var L = []
        L.push('记忆条数=' + (store ? store.count() : 0) + '  字符=' + (store ? store.chars() : 0) +
               '  索引=' + (index ? index.state() : 'n/a') + '  分词=' + tokenizerMode())
        var st = stats.snapshot()
        L.push('saved=' + st.saved + '  inject_ok=' + st.inject_ok + '  inject_rejected=' + st.inject_rejected +
               '  breaker=' + st.breaker_tripped + '  retrieve_timeout=' + st.retrieve_timeout)
        L.push('')
        L.push('===== 最近一次实际发给服务端的 prompt =====')
        if (!lastSent.at) L.push('（还没有发出过请求）')
        else {
          L.push('时间=' + new Date(lastSent.at).toLocaleTimeString() + '   注入=' + (lastSent.injected ? '是' : '否') +
                 '   ids=' + (lastSent.ids.join(',') || '-'))
          L.push(lastSent.prompt.slice(0, 900))
        }
        L.push('')
        L.push('===== 记忆列表（最近 10 条）=====')
        var all = store ? store.all() : []
        for (var i = Math.max(0, all.length - 10); i < all.length; i++) {
          var r = all[i]
          L.push('[' + i + '] sess=' + String(r.sessionId).slice(0, 6) + ' inj=' + (r.injected ? 'Y' : 'N') +
                 ' 问:' + String(r.userText).slice(0, 26).replace(/\n/g, ' '))
        }
        if (!all.length) L.push('（空）')
        return showText('DSMEM 记忆诊断', L.join('\n'))
      },
      tokenizerMode: function () { return tokenizerMode() },
      probe: function () { return probeText() },
      probePanel: function () { return probePanel() },
      channels: function () { return channels },
      injectedAt: function () { return injectedAt },
      rebuild: function () { return index ? index.rebuild() : null },
      config: CONFIG,
      protocol: PROTOCOL
    };
  } catch (e) {}
}

boot()
