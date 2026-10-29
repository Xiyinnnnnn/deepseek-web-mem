// 轮次管理（第十章）+ 熔断（5.4）+ 可见提示（13.2）+ 管理指令（13.3）
import { CONFIG } from './02-config.js'
import { stats } from './01-stats.js'

// ---- 10.1 独立请求上下文：绝不用全局变量配对 ----
export function createRequestContext(info) {
  return {
    requestId: 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
    sessionId: info.sessionId,
    parentMessageId: info.parentMessageId == null ? null : info.parentMessageId,
    originalUserText: info.userText,     // 已剥离记忆块
    createdAt: Date.now(),
    injectedIds: [],
    status: 'PENDING',
    finalized: false
  }
}

// ---- 10.3 防重复落库 ----
export function finalizeOnce(ctx, fn) {
  if (!ctx || ctx.finalized) return false
  ctx.finalized = true
  try { fn() } catch (e) {}
  return true
}

// ---- 5.4 熔断器 ----
export function createBreaker(onTrip) {
  var fails = 0
  var tripped = false
  return {
    allow: function () { return !tripped },
    success: function () { fails = 0 },
    fail: function () {
      fails++
      if (!tripped && fails >= CONFIG.BREAKER_LIMIT) {
        tripped = true
        stats.inc('breaker_tripped')
        stats.save()
        if (onTrip) { try { onTrip() } catch (e) {} }
      }
    },
    isTripped: function () { return tripped },
    fails: function () { return fails }
  }
}

// ---- 10.5 会话级已注入记录（持久化，最近 N 个会话）----
export function createInjectedRegistry() {
  var map = Object.create(null)
  var order = []

  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(CONFIG.KEY_INJECTED) || 'null')
      if (raw && raw.sessions && Array.isArray(raw.order)) {
        map = raw.sessions
        order = raw.order
      }
    } catch (e) {}
  }
  function save() {
    try {
      localStorage.setItem(CONFIG.KEY_INJECTED, JSON.stringify({ sessions: map, order: order }))
    } catch (e) {}
  }
  function touch(sessionId) {
    var pos = order.indexOf(sessionId)
    if (pos !== -1) order.splice(pos, 1)
    order.push(sessionId)
    while (order.length > CONFIG.INJECTED_SESSIONS_KEEP) {
      var drop = order.shift()
      delete map[drop]
    }
  }
  return {
    load: load,
    idsFor: function (sessionId) {
      map[sessionId] = map[sessionId] || {}
      return map[sessionId]
    },
    add: function (sessionId, ids) {
      if (!ids || !ids.length) return
      var set = map[sessionId] || (map[sessionId] = {})
      for (var i = 0; i < ids.length; i++) set[ids[i]] = true
      touch(sessionId)
      save()
    },
    clearAll: function () { map = Object.create(null); order = []; save() }
  }
}

// ---- 8.5 第 4 点 / 13.3：记忆开关（全局总开关 + 会话级）----
// 真机改版：/mem off 变成总开关——不记录也不注入。会话级 off 保留只为兼容旧数据。
export function createSessionSwitch() {
  var off = Object.create(null)
  var globalOff = false
  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(CONFIG.KEY_SESS_OFF) || 'null')
      if (raw && typeof raw === 'object') off = raw
    } catch (e) {}
    try { globalOff = localStorage.getItem(CONFIG.KEY_GLOBAL_OFF) === '1' } catch (e) {}
  }
  function save() {
    try { localStorage.setItem(CONFIG.KEY_SESS_OFF, JSON.stringify(off)) } catch (e) {}
  }
  function saveGlobal() {
    try {
      if (globalOff) localStorage.setItem(CONFIG.KEY_GLOBAL_OFF, '1')
      else localStorage.removeItem(CONFIG.KEY_GLOBAL_OFF)
    } catch (e) {}
  }
  return {
    load: load,
    isOff: function (s) { return globalOff || !!off[s] },
    setOff: function (s, v) { if (v) off[s] = 1; else delete off[s]; save() },
    isGlobalOff: function () { return globalOff },
    setGlobalOff: function (v) { globalOff = !!v; saveGlobal() },
    clearAll: function () { off = Object.create(null); save() }
  }
}

// ---- 13.2 可见提示：固定定位、自动消失、不拦点击、同原因每页一次 ----
var shownOnce = Object.create(null)

export function toast(message, onceKey) {
  if (onceKey) {
    if (shownOnce[onceKey]) return
    shownOnce[onceKey] = true
  }
  try {
    if (typeof document === 'undefined' || !document.body) return
    var el = document.createElement('div')
    el.setAttribute('data-ds-mem-toast', '1')
    el.textContent = String(message)
    el.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'left:50%', 'bottom:96px',
      'transform:translateX(-50%)', 'max-width:78vw', 'padding:8px 14px',
      'border-radius:10px', 'background:rgba(20,20,20,.88)', 'color:#fff',
      'font-size:13px', 'line-height:1.4', 'pointer-events:none',
      'box-shadow:0 2px 12px rgba(0,0,0,.35)', 'opacity:0',
      'transition:opacity .18s ease'
    ].join(';')
    document.body.appendChild(el)
    requestAnimationFrame(function () { el.style.opacity = '1' })
    setTimeout(function () {
      el.style.opacity = '0'
      setTimeout(function () { try { el.remove() } catch (e) {} }, 220)
    }, CONFIG.TOAST_MS)
  } catch (e) { /* 提示失败绝不影响聊天 */ }
}
