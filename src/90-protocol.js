// 协议适配层（第四章）。配置驱动：PROTOCOL 里没确认的字段一律返回 null（放行），不猜测。
import { PROTOCOL, CONFIG } from './02-config.js'
import { stats } from './01-stats.js'
import { stripMemoryBlocks } from './30-block.js'
import { composeInjectedText } from './30-block.js'

function urlOf(input) {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object' && typeof input.url === 'string') return input.url
  return null
}

function baseHref() {
  try {
    if (typeof location !== 'undefined' && location && location.href) return location.href
  } catch (e) {}
  return 'https://chat.deepseek.com/'
}

function pathOf(url) {
  try {
    var u = new URL(url, baseHref())
    return u.pathname + (u.search || '')
  } catch (e) { return null }
}

function hostOf(url) {
  try {
    var u = new URL(url, baseHref())
    return u.hostname
  } catch (e) { return null }
}

export function isTargetRequest(input, init) {
  var url = urlOf(input)
  if (!url) return false
  if (hostOf(url) !== PROTOCOL.host) return false
  if (PROTOCOL.endpointPath === null) return false          // 协议未确认：一律放行（4.2）
  var p = pathOf(url)
  var matched = p && p.indexOf(PROTOCOL.endpointPath) !== -1
  if (!matched && PROTOCOL.altPaths) {
    for (var i = 0; i < PROTOCOL.altPaths.length; i++) {
      if (p && p.indexOf(PROTOCOL.altPaths[i]) !== -1) { matched = true; break }
    }
  }
  if (!matched) return false
  var method = (init && init.method) || (typeof input === 'object' && input.method) || 'GET'
  if (String(method).toUpperCase() !== PROTOCOL.method) return false
  return true
}

// 4.5：MVP 只支持 fetch(url, init) 且 init.body 为字符串。其余形式放行并计数。
export function isSupportedForm(input, init) {
  if (typeof input !== 'string') { stats.inc('skip_unsupported_form'); return false }
  if (!init || typeof init.body !== 'string') { stats.inc('skip_unsupported_form'); return false }
  var ct = ''
  try {
    if (init.headers) {
      if (typeof init.headers.forEach === 'function') init.headers.forEach(function (v, k) { if (k.toLowerCase() === 'content-type') ct = v })
      else for (var k in init.headers) if (k.toLowerCase() === 'content-type') ct = init.headers[k]
    }
  } catch (e) {}
  if (ct && ct.indexOf('json') === -1) { stats.inc('skip_unsupported_form'); return false }
  return true
}

function pick(obj, path) {
  var node = obj
  var parts = String(path).split('.')
  for (var i = 0; i < parts.length && node != null; i++) node = node[parts[i]]
  return node
}

function lastUserMessage(obj) {
  var arr = pick(obj, PROTOCOL.messagesPath)
  if (!Array.isArray(arr)) return null
  for (var i = arr.length - 1; i >= 0; i--) {
    var m = arr[i]
    if (m && m.role === PROTOCOL.lastMessageRole && typeof m.content === 'string') return m
  }
  return null
}

function extractUserText(obj) {
  if (PROTOCOL.messagesPath) {
    var msg = lastUserMessage(obj)
    return msg ? msg.content : null
  }
  if (PROTOCOL.fields.userText) {
    var v = pick(obj, PROTOCOL.fields.userText)
    return typeof v === 'string' ? v : null
  }
  return null
}

export function parseRequest(input, init) {
  if (!PROTOCOL.endpointPath || !PROTOCOL.fields.sessionId) { stats.inc('skip_parse'); return null }
  if (!PROTOCOL.messagesPath && !PROTOCOL.fields.userText) { stats.inc('skip_parse'); return null }

  var body = init && init.body
  if (typeof body !== 'string') { stats.inc('skip_unsupported_form'); return null }

  var obj
  try { obj = JSON.parse(body) } catch (e) { stats.inc('skip_parse'); return null }
  if (!obj || typeof obj !== 'object') { stats.inc('skip_parse'); return null }

  var rawText = extractUserText(obj)
  if (typeof rawText !== 'string') { stats.inc('skip_parse'); return null }

  // 4.3 第 1 条：先剥离历史记忆块，得到原始输入
  var userText = stripMemoryBlocks(rawText)
  if (!userText) { stats.inc('skip_parse'); return null }

  var sessionId = pick(obj, PROTOCOL.fields.sessionId)
  if ((sessionId == null || sessionId === '') && PROTOCOL.sessionIdFallback) {
    sessionId = pick(obj, PROTOCOL.sessionIdFallback)
  }
  if (sessionId == null || sessionId === '') { stats.inc('skip_no_session'); return null }
  sessionId = String(sessionId)

  var parentMessageId = null
  if (PROTOCOL.fields.parentMessageId) {
    var pid = pick(obj, PROTOCOL.fields.parentMessageId)
    // 实测：DeepSeek 新会话首条发的是字符串 "null"，不是 JS null。
    // 不归一化会让所有新会话的父消息 id 都等于 "null"，去重键全撞在一起。
    if (pid != null && pid !== '' && String(pid) !== 'null') parentMessageId = String(pid)
  }

  // 命令只在输入框层就该被吃掉；这里的匹配是网络层兜底（改版 / 语音发送漏过来的情况）
  var command = null
  if (/^\/(mem|sum)(\s|$)/.test(userText)) command = userText.trim()

  return {
    sessionId: sessionId,
    parentMessageId: parentMessageId,
    userText: userText,
    rawUserTextHadBlock: rawText !== userText,
    command: command
  }
}

// 4.4：只改用户输入字段；其余字段、请求头、signal 原样保留
export function buildModifiedInit(init, block, info) {
  if (!init || typeof init.body !== 'string') return null
  if (!block) return null

  var obj
  try { obj = JSON.parse(init.body) } catch (e) { return null }

  var injectedText = composeInjectedText(block, info.userText)

  if (PROTOCOL.messagesPath) {
    var msg = lastUserMessage(obj)
    if (!msg) return null
    msg.content = injectedText
  } else if (PROTOCOL.fields.userText) {
    var segs = String(PROTOCOL.fields.userText).split('.')
    var node = obj
    for (var i = 0; i < segs.length - 1; i++) {
      node = node[segs[i]]
      if (!node || typeof node !== 'object') return null
    }
    node[segs[segs.length - 1]] = injectedText
  } else {
    return null
  }

  var out
  try {
    out = {}
    for (var k in init) out[k] = init[k]
    out.body = JSON.stringify(obj)     // Content-Length 由浏览器处理，不手写
  } catch (e) { return null }
  return out
}

// XHR 通道用：只产出新的 body 字符串（headers 由页面自己 setRequestHeader，不动）
export function buildModifiedBody(bodyStr, method, block, info) {
  if (typeof bodyStr !== 'string' || !block) return null
  var fake = { method: method || 'POST', body: bodyStr }
  var out = buildModifiedInit(fake, block, info)
  if (!out || typeof out.body !== 'string') return null
  return out.body
}

// 13.3 管理指令的本地响应：构造一个让页面当作请求失败的响应
export function commandResponse(payload) {
  try {
    if (typeof Response === 'function') {
      return Promise.resolve(new Response(JSON.stringify(payload), {
        status: 400,
        statusText: 'DSMEM Command Handled Locally',
        headers: { 'content-type': 'application/json' }
      }))
    }
  } catch (e) {}
  return Promise.reject(new Error('DSMEM_COMMAND_LOCAL'))
}

// XHR 通道的命令兜底：不联网，但要让页面以为请求已经失败返回，
// 否则页面停在 loading 态一直转圈。readyState/status 用自有属性覆盖原型 getter。
export function fakeXhrDone(xhr, status, text) {
  if (!xhr) return false
  var body = String(text == null ? '' : text)
  function def(k, v) {
    try { Object.defineProperty(xhr, k, { configurable: true, get: function () { return v } }) } catch (e) {}
  }
  def('readyState', 4)
  def('status', status || 400)
  def('statusText', 'DSMEM Command Handled Locally')
  def('responseURL', '')
  var rt = 'text'
  try { rt = xhr.responseType || 'text' } catch (e) {}
  if (rt === 'json') {
    var parsed = null
    try { parsed = JSON.parse(body) } catch (e) {}
    def('response', parsed)
    def('responseText', body)
  } else if (rt === '' || rt === 'text') {
    def('response', body)
    def('responseText', body)
  }
  function fire(type) {
    try { if (typeof xhr['on' + type] === 'function') xhr['on' + type]({ type: type, target: xhr, currentTarget: xhr }) } catch (e) {}
    try { if (typeof Event === 'function' && xhr.dispatchEvent) xhr.dispatchEvent(new Event(type)) } catch (e) {}
  }
  fire('readystatechange')
  fire('load')       // XHR 的 load 在非 2xx 完成时同样触发
  fire('loadend')
  return true
}
