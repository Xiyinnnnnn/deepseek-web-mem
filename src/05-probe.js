// 阶段 0 抓包探针：只记录「结构」，不记录任何对话正文。
// 产物用于填 PROTOCOL 配置，然后关掉 discovery。
import { PROTOCOL } from './02-config.js'
import { toast } from './80-context.js'

var hits = []

function shape(v, depth) {
  depth = depth || 0
  if (depth > 4) return '…'
  if (v === null) return 'null'
  if (Array.isArray(v)) {
    return { '@array': v.length, sample: v.length ? shape(v[0], depth + 1) : null }
  }
  var t = typeof v
  if (t === 'string') {
    // 只给长度与是否含中文，绝不给内容
    return { '@string': v.length, cjk: /[\u4e00-\u9fff]/.test(v) }
  }
  if (t === 'number' || t === 'boolean') return t
  if (t === 'object') {
    var o = {}
    for (var k in v) o[k] = shape(v[k], depth + 1)
    return o
  }
  return t
}

var KEY_PROBE = 'ds_mem_probe_v1'

function persist() {
  try { localStorage.setItem(KEY_PROBE, JSON.stringify(hits.slice(-40))) } catch (e) {}
}

export function loadProbeHits() {
  try {
    var raw = JSON.parse(localStorage.getItem(KEY_PROBE) || 'null')
    if (Array.isArray(raw)) hits = raw
  } catch (e) {}
  return hits
}

export function probeRequest(url, init, rawInput) {
  if (!PROTOCOL.discovery) return
  var isReq = !!(rawInput && typeof rawInput === 'object' && typeof rawInput.url === 'string')
  var method = String((init && init.method) || (isReq && rawInput.method) || 'GET').toUpperCase()
  if (method !== 'POST' && !isReq) return
  if (!isReq && (!init || typeof init.body !== 'string')) return
  try {
    var rec = {
      path: (function () { try { return new URL(url, 'https://' + PROTOCOL.host).pathname } catch (e) { return url } })(),
      method: (init && init.method) || 'GET',
      headers: [],
      bodyShape: null
    }
    try {
      if (init && init.headers) {
        if (typeof init.headers.forEach === 'function') init.headers.forEach(function (v, k) { rec.headers.push(k + (k.toLowerCase() === 'authorization' || /pow|token|cookie/i.test(k) ? ': <hidden>' : ': <' + String(v).length + 'ch>')) })
        else for (var k in init.headers) rec.headers.push(k + (/authorization|pow|token|cookie/i.test(k) ? ': <hidden>' : ': <' + String(init.headers[k]).length + 'ch>'))
      }
    } catch (e) {}
    if (isReq) {
      rec.form = 'Request'
      rec.bodyShape = '[Request 对象，body 需异步读取]'
    } else if (init && typeof init.body === 'string' && init.body.length < 200000) {
      try { rec.bodyShape = shape(JSON.parse(init.body)) } catch (e) { rec.bodyShape = 'not-json' }
    } else if (init && init.body) {
      rec.bodyShape = String(Object.prototype.toString.call(init.body))
    }
    channels.fetch++
    hits.push(rec)
    if (hits.length > 40) hits.shift()
    persist()
    try { console.log('[DSMEM-PROBE]', JSON.stringify(rec)) } catch (e) {}
    firstHitToast()
  } catch (e) {}
}

export function probeReport() {
  return hits.slice()
}

// ---- 三路挂钩：页面可能不用 window.fetch，必须同时盯 XHR / EventSource ----
export var channels = { fetch: 0, xhr: 0, es: 0, wsNew: 0, wsSend: 0, lastError: '' }

function shapeBody(body) {
  if (typeof body === 'string') {
    if (body.length > 200000) return { '@string': body.length, note: 'too-large' }
    try { return shape(JSON.parse(body)) } catch (e) { return { '@string': body.length, note: 'not-json' } }
  }
  if (body == null) return null
  return String(Object.prototype.toString.call(body))
}

// 决定性诊断：注入发生在页面生命周期的哪个时刻
export var injectedAt = { readyState: '', sinceOriginMs: -1, patched: 0 }

export function markInjectTime() {
  try {
    injectedAt.readyState = String(document.readyState)
    injectedAt.sinceOriginMs = Math.round(typeof performance !== 'undefined' ? performance.now() : -1)
  } catch (e) {}
}

var hooksDone = false
export function installHooks() {
  if (!PROTOCOL.discovery) return
  if (hooksDone) return
  hooksDone = true

  var XO = XMLHttpRequest.prototype.open
  var XS = XMLHttpRequest.prototype.send
  var XSH = XMLHttpRequest.prototype.setRequestHeader
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__dsm = m; this.__dsu = u; this.__dsh = []
    return XO.apply(this, arguments)
  }
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (this.__dsh) this.__dsh.push(k + (/authorization|pow|token|cookie/i.test(k) ? ': <hidden>' : ': <' + String(v).length + 'ch>')) } catch (e) {}
    return XSH.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function (body) {
    var self = this
    try {
      var rec = {
        via: 'XHR',
        path: (function () { try { return new URL(String(self.__dsu), 'https://' + PROTOCOL.host).pathname } catch (e) { return String(self.__dsu) } })(),
        method: self.__dsm || 'GET',
        headers: self.__dsh || [],
        bodyShape: shapeBody(body)
      }
      if (String(rec.path).indexOf('/api/') === -1) return XS.apply(this, arguments)  // 丢掉 /list /query /profile/list 埋点噪声
      channels.xhr++
      hits.push(rec); if (hits.length > 40) hits.shift(); persist()
      try { console.log('[DSMEM-PROBE]', JSON.stringify(rec)) } catch (e) {}
      firstHitToast()
    } catch (e) { channels.lastError = 'xhr:' + e }
    return XS.apply(this, arguments)
  }

  try {
    var OE = window.EventSource
    if (typeof OE === 'function') {
      window.EventSource = new Proxy(OE, {
        construct: function (target, args) {
          try {
            channels.es++
            var rec = {
              via: 'EventSource',
              path: (function () { try { return new URL(String(args[0]), 'https://' + PROTOCOL.host).pathname } catch (e) { return String(args[0]) } })(),
              method: 'GET', headers: [], bodyShape: null
            }
            hits.push(rec); if (hits.length > 40) hits.shift(); persist()
            try { console.log('[DSMEM-PROBE]', JSON.stringify(rec)) } catch (e) {}
            firstHitToast()
          } catch (e) { channels.lastError = 'es:' + e }
          return new target(...args)
        }
      })
    }
  } catch (e) { channels.lastError = 'es-install:' + e }

  try {
    var OW = window.WebSocket
    if (typeof OW === 'function') {
      window.WebSocket = new Proxy(OW, {
        construct: function (target, args) {
          try {
            channels.wsNew++
            var rec = { via: 'WebSocket.new', path: String(args[0]).slice(0, 120), method: 'WS', headers: [], bodyShape: null }
            hits.push(rec); if (hits.length > 40) hits.shift(); persist()
          } catch (e) {}
          return new target(...args)
        }
      })
      // 关键：页面可能在本脚本注入前就建好了长连接，构造函数包装对它无效；
      // 包 prototype.send 才能覆盖已存在的实例。
      var WSP = OW.prototype
      var OWS = WSP.send
      WSP.send = function (data) {
        try {
          channels.wsSend++
          var rec = {
            via: 'WS.send',
            path: String(this.url || '').slice(0, 120),
            method: 'WS',
            headers: [],
            bodyShape: shapeBody(data)
          }
          hits.push(rec); if (hits.length > 40) hits.shift(); persist()
          try { console.log('[DSMEM-PROBE]', JSON.stringify(rec)) } catch (e) {}
          firstHitToast()
        } catch (e) { channels.lastError = 'ws:' + e }
        return OWS.apply(this, arguments)
      }
    }
  } catch (e) { channels.lastError = 'ws-install:' + e }
}

var toasted = false
function firstHitToast() {
  if (toasted) return
  toasted = true
  toast('记忆探针：已抓到请求（报告见 __DSMEM_DEV 模式下的 __dsMem.probePanel()）')
}

export function showText(title, text) {
  try {
    if (typeof document === 'undefined' || !document.body) return text
    var old = document.querySelector('[data-dsmem-panel]')
    if (old) { old.remove(); return text }
    var wrap = document.createElement('div')
    wrap.setAttribute('data-dsmem-panel', '1')
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.88);padding:12px;box-sizing:border-box;display:flex;flex-direction:column;gap:8px'
    var bar = document.createElement('div')
    bar.style.cssText = 'display:flex;gap:10px;color:#fff;font-size:13px;align-items:center;font-family:monospace'
    bar.textContent = String(title || '')
    var close = document.createElement('button')
    close.textContent = '关闭'
    close.style.cssText = 'margin-left:auto;padding:6px 12px;border-radius:8px;border:0;background:#444;color:#fff;font-size:14px'
    close.onclick = function () { wrap.remove() }
    bar.appendChild(close)
    var ta = document.createElement('textarea')
    ta.value = String(text == null ? '' : text)
    ta.style.cssText = 'flex:1;width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;line-height:1.45;background:#0f0f0f;color:#e8e8e8;border:1px solid #333;border-radius:10px;padding:10px;resize:none'
    wrap.appendChild(bar); wrap.appendChild(ta)
    document.body.appendChild(wrap)
    try { ta.focus(); ta.select() } catch (e) {}
    return text
  } catch (e) { return text }
}

export function probePanel() {
  try {
    if (typeof document === 'undefined' || !document.body) return null
    var old = document.querySelector('[data-dsmem-panel]')
    if (old) { old.remove(); return null }
    var wrap = document.createElement('div')
    wrap.setAttribute('data-dsmem-panel', '1')
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.86);padding:14px;box-sizing:border-box;display:flex;flex-direction:column;gap:8px'
    var bar = document.createElement('div')
    bar.style.cssText = 'display:flex;gap:10px;color:#fff;font-size:14px;align-items:center'
    bar.textContent = 'f=' + channels.fetch + ' xhr=' + channels.xhr + ' es=' + channels.es + ' ws=' + channels.ws +
      ' wsN=' + channels.wsNew + ' wsS=' + channels.wsSend +
      ' | 注入@' + injectedAt.sinceOriginMs + 'ms rs=' + injectedAt.readyState + ' 补丁' + injectedAt.patched
    var close = document.createElement('button')
    close.textContent = '关闭'
    close.style.cssText = 'margin-left:auto;padding:6px 12px;border-radius:8px;border:0;background:#444;color:#fff;font-size:14px'
    close.onclick = function () { wrap.remove() }
    bar.appendChild(close)
    var ta = document.createElement('textarea')
    ta.value = probeText() || '暂无记录：先正常发一条消息'
    ta.style.cssText = 'flex:1;width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;line-height:1.45;background:#111;color:#e6e6e6;border:1px solid #333;border-radius:10px;padding:10px;resize:none'
    wrap.appendChild(bar)
    wrap.appendChild(ta)
    document.body.appendChild(wrap)
    try { ta.focus(); ta.select() } catch (e) {}
    return probeText()
  } catch (e) { return null }
}

export function probeText() {
  var lines = []
  for (var i = 0; i < hits.length; i++) {
    lines.push('#' + (i + 1) + ' [' + (hits[i].via || 'fetch') + '] ' + hits[i].method + ' ' + hits[i].path)
    if (hits[i].headers.length) lines.push('  headers: ' + hits[i].headers.join(' | '))
    lines.push('  body: ' + JSON.stringify(hits[i].bodyShape))
  }
  return lines.join('\n')
}
