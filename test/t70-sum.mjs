// /sum 上下文压缩回归：手动命令 / 请求旁路 / 摘要交接 / 自动触发 / 估算口径
import { makeEnv, loadBundle } from './harness.mjs'

var PASS = 0, FAIL = 0
function ck(id, name, cond, extra) {
  if (cond) { PASS++; console.log('  PASS ' + id + ' ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { FAIL++; console.log('  FAIL ' + id + ' ' + name + (extra ? '  [' + extra + ']' : '')) }
}
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

// ---- 简易 sessionStorage（harness 只给了 localStorage）----
var SESS_MAP = null
function installSessionStorage() {
  if (SESS_MAP) { return SESS_MAP }
  var map = SESS_MAP = Object.create(null)
  globalThis.sessionStorage = {
    getItem: function (k) { return k in map ? map[k] : null },
    setItem: function (k, v) { map[k] = String(v) },
    removeItem: function (k) { delete map[k] },
    get length() { return Object.keys(map).length },
    key: function (i) { return Object.keys(map)[i] || null }
  }
  return map
}

// ---- 假 XHR：回答内容可按 mode 切换 ----
function installFakeXhr() {
  var log = []
  var css = globalThis.__SSE_MODE || 'normal'
  function FakeXhr() {
    this.readyState = 0; this.status = 0; this.statusText = ''
    this.responseText = ''; this.responseType = ''
    this._listeners = {}; this._headers = {}
  }
  FakeXhr.prototype.addEventListener = function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn) }
  FakeXhr.prototype.removeEventListener = function () {}
  FakeXhr.prototype._fire = function (t) {
    var a = (this._listeners[t] || []).slice()
    for (var i = 0; i < a.length; i++) { try { a[i].call(this, { type: t }) } catch (e) {} }
  }
  FakeXhr.prototype.open = function (m, u, async) {
    this._method = m; this._url = u; this._async = (async === undefined) ? true : !!async
    this.readyState = 1
  }
  FakeXhr.prototype.setRequestHeader = function (k, v) { this._headers[String(k).toLowerCase()] = v }
  FakeXhr.prototype.send = function (body) {
    var self = this
    log.push({ url: self._url, body: body })
    var mode = globalThis.__SSE_MODE || 'normal'
    var answer = '回答内容'
    if (mode === 'summary') answer = '这是整段对话的摘要：用户在调试 DeepSeek 网页记忆脚本，讨论了检索、注入与上下文压缩三件事。'
    else if (mode === 'custom') answer = String(globalThis.__SSE_TEXT || '回答内容')
    var SSE = 'data: {"v":{"response":{"message_id":7,"status":"WIP","fragments":[{"id":1,"type":"RESPONSE","content":"' + answer + '"}]}}}\n' +
              'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n'
    setTimeout(function () {
      self.status = 200; self.statusText = 'OK'
      self.responseText = SSE
      self.readyState = 4
      self._fire('readystatechange'); self._fire('load'); self._fire('loadend')
    }, 5)
  }
  FakeXhr.prototype.abort = function () { this.readyState = 0; this._fire('abort'); this._fire('loadend') }
  globalThis.XMLHttpRequest = FakeXhr
  return log
}

function override(extraCfg) {
  globalThis.__DSMEM_PROTOCOL_OVERRIDE = {
    endpointPath: '/api/v0/chat/completion',
    method: 'POST',
    retryBranch: 'B',
    fields: { userText: 'prompt', sessionId: 'chat_session_id', parentMessageId: 'parent_message_id' }
  }
  if (extraCfg) globalThis.__DSMEM_CONFIG_OVERRIDE = extraCfg
}

function makeTextarea(value) {
  var el = {
    tagName: 'TEXTAREA', value: value == null ? '' : value, isContentEditable: false,
    dispatchEvent: function () { return true },
    focus: function () {},
    closest: function () { return null }
  }
  return el
}

function pressEnter(el) {
  var ev = {
    key: 'Enter', keyCode: 13, target: el, isComposing: false,
    prevented: 0, stopped: 0,
    preventDefault: function () { ev.prevented++ },
    stopPropagation: function () { ev.stopped++ },
    stopImmediatePropagation: function () { ev.stopped++ }
  }
  var hs = (globalThis.document.__byType || {})['keydown'] || []
  for (var i = 0; i < hs.length; i++) hs[i](ev)
  return ev
}

function xhrSend(body) {
  var x = new globalThis.XMLHttpRequest()
  var done = { fired: 0, status: -1 }
  x.onloadend = function () { done.fired++; done.status = x.status }
  x.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion', true)
  x.setRequestHeader('content-type', 'application/json')
  x.send(JSON.stringify(body))
  return { xhr: x, done: done }
}

function msg(text, sess, parent) {
  return { prompt: text, chat_session_id: sess || 'sess-sum', parent_message_id: parent || null }
}

var env, netlog, ds

async function boot(kv, cfg, activeEl) {
  if (kv) env = makeEnv({ kv: kv })
  else env = makeEnv({})
  if (activeEl) globalThis.document.activeElement = activeEl
  delete globalThis.__ds_memory_rag_loaded
  delete globalThis.__dsMem
  globalThis.__DSMEM_DEV = true
  override(cfg)
  netlog = installFakeXhr()
  installSessionStorage()
  loadBundle('dist/deepseek-web-mem.user.js')
  ds = globalThis.__dsMem
  await sleep(120)
  return env
}

async function main() {
  console.log('\n[1] /sum 手动命令：输入框就地吃掉，写成 [总结所有]，不发网络')
  var ta = makeTextarea('/sum')
  await boot(null, null, ta)
  ck('T70', 'dev 入口可用', !!ds)
  var ev = pressEnter(ta)
  await sleep(30)
  ck('T71', '/sum 的 Enter 被拦下', ev.prevented > 0 && ev.stopped > 0)
  ck('T72', '输入框被改写成 [总结所有]', ta.value === '[总结所有]', 'value=' + ta.value)
  ck('T73', '/sum 本身不产生网络请求', netlog.length === 0, 'net=' + netlog.length)
  ck('T74', '统计到一次手动触发', ds.stats().sum_manual === 1, 'sum_manual=' + ds.stats().sum_manual)
  ck('T75', 'toast 说明已发出', /已发出/.test(env.toasts[env.toasts.length - 1] || ''), env.toasts[env.toasts.length - 1])

  console.log('\n[2] 压缩请求旁路：原样发出、不落库、只取摘要')
  globalThis.__SSE_MODE = 'summary'
  var before = ds.count()
  var r2 = xhrSend(msg('[总结所有]'))
  await sleep(200)
  ck('T76', '压缩请求照常发到端点', netlog.length === 1, 'net=' + netlog.length)
  ck('T77', '识别为压缩请求', ds.stats().sum_request === 1, 'sum_request=' + ds.stats().sum_request)
  var convo = ds.memList().filter(function (r) { return String(r.sessionId) === 'sess-sum' })
  ck('T78', '压缩请求不当作对话记录落库', convo.length === 0, 'sess-sum=' + convo.length)
  ck('T78b', '摘要本身进了记忆库（可被后续检索）', ds.count() === before + 1, 'count=' + ds.count() + ' saved=' + ds.stats().sum_saved)
  ck('T79', '摘要已捕获', ds.stats().sum_done === 1, 'sum_done=' + ds.stats().sum_done)
  var pend = JSON.parse(globalThis.sessionStorage.getItem('ds_mem_sum_pending_v1') || 'null')
  ck('T80', '交接单写入 sessionStorage', !!(pend && pend.text && pend.text.length > 20), pend ? 'len=' + pend.text.length : 'null')
  ck('T81', 'toast 提示正在开新对话', /新开对话|新对话/.test(env.toasts[env.toasts.length - 1] || ''), env.toasts[env.toasts.length - 1])

  console.log('\n[3] 新会话落地：交接单里的摘要被写成新对话第一条')
  var ta2 = makeTextarea('')
  var pendText = pend.text
  await boot(env.kv, null, ta2)
  await sleep(700)
  ck('T82', '等输入框后自动填入摘要', ta2.value === pendText, 'len=' + ta2.value.length)
  ck('T83', '交接单用后即删（避免重复发）', !globalThis.sessionStorage.getItem('ds_mem_sum_pending_v1'))
  ck('T84', '统计到一次落地', ds.stats().sum_resume === 1, 'sum_resume=' + ds.stats().sum_resume)

  console.log('\n[4] 估算口径：1 中文字符 0.6 token，1 英文字符 0.3 token')
  var ta3 = makeTextarea('')
  await boot(null, { SUM_TRIGGER_TOKENS: 1e12 }, ta3)   // 先关掉自动触发，单独看数字
  globalThis.__SSE_MODE = 'normal'
  var zh = new Array(101).join('中')      // 100 个中文字符
  var en = new Array(101).join('a')       // 100 个英文字符
  globalThis.__SSE_MODE = 'custom'
  globalThis.__SSE_TEXT = en
  xhrSend(msg(zh, 'sess-est', 'e1'))
  await sleep(150)
  var est = ds.estimate()
  ck('T85', '中文 100 字 + 英文 100 字 ≈ 90 token', Math.abs(est - 90) < 1, 'est=' + est)

  console.log('\n[5] 超阈值自动触发')
  var ta4 = makeTextarea('')
  await boot(null, { SUM_TRIGGER_TOKENS: 50, SUM_AUTO_DELAY_MS: 50, SUM_COOLDOWN_MS: 0 }, ta4)
  globalThis.__SSE_MODE = 'normal'
  globalThis.__SSE_TEXT = null
  xhrSend(msg(new Array(101).join('中'), 'sess-auto', 'a1'))
  await sleep(900)
  ck('T86', '达到阈值自动发 [总结所有]', ta4.value === '[总结所有]', 'value=' + ta4.value)
  ck('T87', '统计到自动触发', ds.stats().sum_auto === 1, 'sum_auto=' + ds.stats().sum_auto)
  ck('T88', '自动触发也有提示', env.toasts.some(function (t) { return /自动压缩/.test(t) }), env.toasts.join(' | ').slice(0, 80))

  console.log('\n[6] 时间窗外的 [总结所有] 不认作压缩请求')
  var ta5 = makeTextarea('')
  await boot(null, { SUM_TRIGGER_TOKENS: 1e12 }, ta5)
  globalThis.__SSE_MODE = 'normal'
  xhrSend(msg('[总结所有]', 'sess-plain', 'p1'))
  await sleep(200)
  ck('T89', '不武装时不进压缩分支', ds.stats().sum_request === 0 && ds.stats().sum_done === 0,
     'req=' + ds.stats().sum_request + ' done=' + ds.stats().sum_done)
  ck('T90', '这条当成普通消息落库', ds.count() === 1, 'count=' + ds.count())
  ck('T91', '记为 stray', ds.stats().sum_stray === 1, 'sum_stray=' + ds.stats().sum_stray)

  console.log('\n[7] /sum 带参数只回用法，不触发压缩')
  var ta6 = makeTextarea('/sum now')
  await boot(null, null, ta6)
  pressEnter(ta6)
  await sleep(30)
  ck('T92', '带参数不触发压缩', ds.stats().sum_manual === 0)
  ck('T93', '/sum 用法提示', /可用指令/.test(env.toasts[env.toasts.length - 1] || ''), env.toasts[env.toasts.length - 1])
  ck('T94', '输入框已清空', ta6.value === '', 'value=' + ta6.value)

  console.log('\n================  ' + PASS + ' PASS / ' + FAIL + ' FAIL  ================')
  process.exit(FAIL ? 1 : 0)
}

main().catch(function (e) { console.error('HARNESS ERROR', e); process.exit(2) })
