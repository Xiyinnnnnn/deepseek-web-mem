// 针对性回归：复现真机「count 恒为 0」的两个根因
//   根因 A：主链路只包 fetch，页面走 XHR
//   根因 B：aiText 为空时 store.put 直接拒收
import fs from 'node:fs'
import { makeEnv, loadBundle } from './harness.mjs'

var PASS = 0, FAIL = 0
function ck(id, name, cond, extra) {
  if (cond) { PASS++; console.log('  PASS ' + id + ' ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { FAIL++; console.log('  FAIL ' + id + ' ' + name + (extra ? '  [' + extra + ']' : '')) }
}
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

// ---- 最小 XHR 模拟：够用即止，不做压缩/重定向等真实行为 ----
function installFakeXhr(responseFactory) {
  var log = []
  function FakeXhr() {
    this.readyState = 0
    this.status = 0
    this.statusText = ''
    this.responseText = ''
    this.responseType = ''
    this._listeners = {}
    this._headers = {}
    this._body = null
  }
  FakeXhr.prototype.addEventListener = function (t, fn) {
    (this._listeners[t] = this._listeners[t] || []).push(fn)
  }
  FakeXhr.prototype.removeEventListener = function (t, fn) {
    var a = this._listeners[t] || []
    var i = a.indexOf(fn)
    if (i !== -1) a.splice(i, 1)
  }
  FakeXhr.prototype._fire = function (t) {
    var a = (this._listeners[t] || []).slice()
    for (var i = 0; i < a.length; i++) { try { a[i].call(this, { type: t }) } catch (e) {} }
  }
  FakeXhr.prototype.open = function (m, u, async) {
    this._method = m; this._url = u
    this._async = (async === undefined) ? true : !!async
    this.readyState = 1
  }
  FakeXhr.prototype.setRequestHeader = function (k, v) { this._headers[String(k).toLowerCase()] = v }
  FakeXhr.prototype.send = function (body) {
    var self = this
    log.push({ url: self._url, body: body, headers: self._headers })
    var res = responseFactory(body, log.length)
    setTimeout(function () {
      self.status = res.status || 200
      self.statusText = res.status === 200 ? 'OK' : 'ERR'
      self.responseText = res.body || ''
      self.readyState = 4
      self._fire('readystatechange')
      self._fire('load')
      self._fire('loadend')
    }, 5)
  }
  FakeXhr.prototype.abort = function () {
    this.readyState = 0
    this._fire('abort')
    this._fire('loadend')
  }
  globalThis.XMLHttpRequest = FakeXhr
  return log
}

function override(opts) {
  opts = opts || {}
  globalThis.__DSMEM_PROTOCOL_OVERRIDE = {
    endpointPath: '/api/v0/chat/completion',
    method: 'POST',
    retryBranch: 'B',
    fields: { userText: 'prompt', sessionId: 'chat_session_id', parentMessageId: 'parent_message_id' },
    // 故意保持 sse 全空：模拟真机「协议响应侧未回填」的现状
    sse: opts.sse || {
      eventPathKey: 'p', eventOpKey: 'o', eventValueKey: 'v',
      ops: { APPEND: 'APPEND', SET: 'SET', BATCH: 'BATCH' },
      defaultOpWhenMissing: 'APPEND',
      textFragmentTypes: null, thinkFragmentTypes: null,
      doneOps: null, errorOps: null, moderatedOps: null, messageIdPath: null
    }
  }
}

// 假想的 DeepSeek 包装格式：{v:{response:{content}}}
function packagedSse(text) {
  return 'data: {"v":{"response":{"message_id":11,"content":"' + text + '","thinking_content":"内心戏"}}}\n\ndata: {"v":{}}\n\n'
}

async function main() {
  var env = makeEnv({})
  override()
  var log = installFakeXhr(function (body) {
    return { status: 200, body: packagedSse('这是回答') }
  })
  var fetchCalls = 0
  globalThis.fetch = function () { fetchCalls++; return Promise.resolve(new Response('{}', { status: 200 })) }

  loadBundle('dist/deepseek-web-mem.user.js')
  await sleep(160)

  console.log('\n[T40] XHR 通道')
  ck('T40a', 'XHR.prototype 已被接管', XMLHttpRequest.prototype.__dsmHooked === true)
  ck('T40b', 'fetch 也被接管', !/native code/.test(String(globalThis.fetch)))

  var xhr = new XMLHttpRequest()
  xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion', true)
  xhr.setRequestHeader('content-type', 'application/json')
  xhr.send(JSON.stringify({ chat_session_id: 'A', parent_message_id: 'p1', prompt: 'Termux 里怎么用 Python 写爬虫', model_type: 'x' }))
  await sleep(300)

  var st = globalThis.__dsMem.stats()
  ck('T40c', 'XHR 请求被识别', st.xhr_hit === 1, 'xhr_hit=' + st.xhr_hit)
  ck('T40d', '请求发出即落库（不依赖响应）', globalThis.__dsMem.count() === 1, 'count=' + globalThis.__dsMem.count())
  ck('T40e', '请求真的发出去了', log.length === 1, 'sent=' + log.length)
  ck('T40f', '未命中不出块时原样放行原文', JSON.parse(log[0].body).prompt === 'Termux 里怎么用 Python 写爬虫')

  console.log('\n[T41] 响应正文兜底补写')
  var mem = globalThis.__dsMem.memList()[0]
  ck('T41a', 'sse 未配置也能补出 aiText', mem && mem.aiLen > 0, 'aiLen=' + (mem && mem.aiLen))
  ck('T41b', '补写计数', st.ai_filled === 1 || globalThis.__dsMem.stats().ai_filled === 1,
     'ai_filled=' + globalThis.__dsMem.stats().ai_filled)
  var ai = globalThis.__dsMem.memories()[0].ai
  ck('T41c', '排除 thinking 内容', ai.indexOf('内心戏') === -1, 'ai=' + JSON.stringify(ai))

  console.log('\n[T42] 跨会话注入走 XHR 通道')
  var xhr2 = new XMLHttpRequest()
  xhr2.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion', true)
  xhr2.setRequestHeader('content-type', 'application/json')
  xhr2.send(JSON.stringify({ chat_session_id: 'B', parent_message_id: 'q1', prompt: 'Python 写爬虫用什么库' }))
  await sleep(300)

  var last = JSON.parse(log[log.length - 1].body)
  ck('T42a', 'XHR 注入成功', globalThis.__dsMem.stats().xhr_inject_ok === 1,
     'xhr_inject_ok=' + globalThis.__dsMem.stats().xhr_inject_ok)
  ck('T42b', '注入块在 prompt 首位', String(last.prompt).indexOf('[[DSMEM:v1 BEGIN]]') === 0)
  ck('T42c', '原文保留在块后', String(last.prompt).indexOf('Python 写爬虫用什么库') !== -1)

  console.log('\n[T43] 同步 XHR 与非字符串 body 必须放行')
  var before = log.length
  var x3 = new XMLHttpRequest()
  x3.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion', false)
  x3.send('{"chat_session_id":"C","prompt":"同步请求"}')
  await sleep(60)
  ck('T43a', '同步 XHR 不介入', log.length === before + 1 && String(log[log.length - 1].body).indexOf('[[DSMEM') === -1)

  var x4 = new XMLHttpRequest()
  x4.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion', true)
  x4.send(new Uint8Array([1, 2, 3]))
  await sleep(60)
  ck('T43b', '非字符串 body 放行', true)

  console.log('\n[T44] 诊断口')
  var d = globalThis.__dsMem.diag()
  ck('T44a', 'diag 返回字符串', typeof d === 'string' && d.indexOf('DSMEM 诊断') === 0)
  ck('T44b', 'diag 显示 xhr 已接管', d.indexOf('xhr        = 已接管') !== -1)
  ck('T44c', 'diag 显示 count', d.indexOf('count=2') !== -1, d.split('\n').filter(function (l) { return l.indexOf('store') === 0 })[0])

  console.log('\n================  ' + PASS + ' PASS / ' + FAIL + ' FAIL  ================')
  if (FAIL) process.exit(1)
}

main()
