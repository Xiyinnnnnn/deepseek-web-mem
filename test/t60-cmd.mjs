// /mem 快捷指令回归：命令必须在输入框层被吃掉，绝不能进网络
import { makeEnv, loadBundle } from './harness.mjs'

var PASS = 0, FAIL = 0
function ck(id, name, cond, extra) {
  if (cond) { PASS++; console.log('  PASS ' + id + ' ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { FAIL++; console.log('  FAIL ' + id + ' ' + name + (extra ? '  [' + extra + ']' : '')) }
}
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

function installFakeXhr() {
  var log = []
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
    this._method = m; this._url = u
    this._async = (async === undefined) ? true : !!async
    this.readyState = 1
  }
  FakeXhr.prototype.setRequestHeader = function (k, v) { this._headers[String(k).toLowerCase()] = v }
  // 真实 SSE 形态（与真机报文一致）：空响应会被状态机判成取消 → 回滚，
  // 所以这里必须给一条正常完成的事件流，否则测的是「取消不落库」而不是指令
  var SSE = 'data: {"v":{"response":{"message_id":7,"status":"WIP","fragments":[{"id":1,"type":"RESPONSE","content":"回答内容"}]}}}\n' +
            'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n'
  FakeXhr.prototype.send = function (body) {
    var self = this
    log.push({ url: self._url, body: body })
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

function override() {
  globalThis.__DSMEM_PROTOCOL_OVERRIDE = {
    endpointPath: '/api/v0/chat/completion',
    method: 'POST',
    retryBranch: 'B',
    fields: { userText: 'prompt', sessionId: 'chat_session_id', parentMessageId: 'parent_message_id' }
  }
}

// 最小输入框
function makeTextarea(value) {
  return {
    tagName: 'TEXTAREA', value: value, isContentEditable: false,
    dispatchEvent: function () { return true },
    focus: function () {},
    closest: function () { return null }
  }
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
  ck('T60a', 'keydown 监听已注册（捕获阶段）', hs.length > 0, 'n=' + hs.length)
  for (var i = 0; i < hs.length; i++) hs[i](ev)
  return ev
}

function xhrSend(body) {
  var x = new globalThis.XMLHttpRequest()
  var done = { status: -1, fired: 0 }
  x.onloadend = function () { done.fired++; done.status = x.status }
  x.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion', true)
  x.setRequestHeader('content-type', 'application/json')
  x.send(typeof body === 'string' ? body : JSON.stringify(body))
  return { xhr: x, done: done }
}

function msg(text) {
  return { prompt: text, chat_session_id: 'sess-t60', parent_message_id: null }
}

var env = makeEnv({})
override()
var netlog = installFakeXhr()
loadBundle('dist/deepseek-web-mem.user.js')
var ds = globalThis.__dsMem

async function main() {
  ck('T60', 'dev 入口在 __DSMEM_DEV 下可用', !!ds)

  console.log('\n[1] /mem off：Enter 就地截住，不发网络')
  var ta = makeTextarea('/mem off')
  globalThis.document.activeElement = ta
  var ev = pressEnter(ta)
  await sleep(20)
  ck('T61', 'Enter 被 preventDefault', ev.prevented > 0)
  ck('T62', '事件被停传播（页面收不到）', ev.stopped > 0)
  ck('T63', '输入框已清空', ta.value === '')
  ck('T64', '没有产生任何网络请求', netlog.length === 0, 'net=' + netlog.length)
  ck('T65', 'toast 提示已关闭', /关闭/.test(env.toasts[env.toasts.length - 1] || ''), env.toasts[env.toasts.length - 1])

  console.log('\n[2] 关闭后正常提问：原样放行，不记录')
  var r2 = xhrSend(msg('普通问题一'))
  await sleep(40)
  ck('T66', '请求照常发出', netlog.length === 1, 'net=' + netlog.length)
  ck('T67', '关闭态不落库', ds.count() === 0, 'count=' + ds.count())

  console.log('\n[3] /mem on：恢复记录')
  var ta2 = makeTextarea('/mem on')
  globalThis.document.activeElement = ta2
  pressEnter(ta2)
  await sleep(20)
  ck('T68', 'toast 提示已开启', /开启/.test(env.toasts[env.toasts.length - 1] || ''), env.toasts[env.toasts.length - 1])
  ck('T69', '/mem on 本身不发网络', netlog.length === 1, 'net=' + netlog.length)
  var r3 = xhrSend(msg('普通问题二'))
  await sleep(80)
  ck('T70', '开启后重新落库', ds.count() === 1, 'count=' + ds.count())

  console.log('\n[4] /mem clear：一次到位')
  var ta3 = makeTextarea('/mem clear')
  globalThis.document.activeElement = ta3
  pressEnter(ta3)
  await sleep(30)
  ck('T71', 'toast 提示已清空', /清空/.test(env.toasts[env.toasts.length - 1] || ''), env.toasts[env.toasts.length - 1])
  ck('T72', '记忆已归零', ds.count() === 0, 'count=' + ds.count())
  ck('T73', '命令自身不发网络', netlog.length === 2, 'net=' + netlog.length)

  console.log('\n[5] 网络层兜底：命令漏过输入框也不外发')
  var before = netlog.length
  var r5 = xhrSend(msg('/mem clear'))
  await sleep(40)
  ck('T74', '命令未进网络', netlog.length === before, 'net=' + netlog.length + ' before=' + before)
  ck('T75', '本地伪造了完成事件（页面不会一直转圈）', r5.done.fired > 0 && r5.done.status === 400,
     'fired=' + r5.done.fired + ' status=' + r5.done.status)

  console.log('\n[6] 大小写与用法提示')
  var ta4 = makeTextarea('/MEM OFF')
  globalThis.document.activeElement = ta4
  pressEnter(ta4)
  await sleep(20)
  ck('T76', '大小写不敏感', /关闭/.test(env.toasts[env.toasts.length - 1] || ''), env.toasts[env.toasts.length - 1])
  var n6 = netlog.length
  var ta5 = makeTextarea('/mem 你好')
  globalThis.document.activeElement = ta5
  pressEnter(ta5)
  await sleep(20)
  ck('T77', '/mem 其它子命令不发网络', netlog.length === n6)
  ck('T78', '返回用法提示', /可用指令/.test(env.toasts[env.toasts.length - 1] || ''), env.toasts[env.toasts.length - 1])

  console.log('\n[7] 普通输入不受影响')
  var ta6 = makeTextarea('帮我看看这段代码')
  globalThis.document.activeElement = ta6
  var ev6 = pressEnter(ta6)
  await sleep(10)
  ck('T79', '非命令 Enter 不拦', ev6.prevented === 0 && ta6.value === '帮我看看这段代码')

  console.log('\n[8] 开发者入口默认不挂载')
  delete globalThis.__dsMem
  globalThis.__DSMEM_DEV = false
  globalThis.__ds_memory_rag_loaded = false
  loadBundle('dist/deepseek-web-mem.user.js')
  ck('T80', '未开启 DEV 时页面没有 __dsMem', typeof globalThis.__dsMem === 'undefined')

  console.log('\n================  ' + PASS + ' PASS / ' + FAIL + ' FAIL  ================')
  if (FAIL) process.exit(1)
}

main().catch(function (e) { console.error(e); process.exit(1) })
