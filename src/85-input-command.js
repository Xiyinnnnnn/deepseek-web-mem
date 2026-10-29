// 模块 F2：输入框快捷指令（13.3 重做 + /sum）
//
// 真机问题：旧实现把 /mem 交给「网络层 400 中断」，可页面实际走 XHR，
// 而 XHR 分支当时对命令只 toast 一句就 XS.apply 放行 → 命令原封不动发给了 API。
//
// 现在改在输入框上截：document 捕获阶段（比页面自己的 React 根容器更早）
// 拦 Enter / 点发送键 / form submit，命中就地 preventDefault + 清空输入框 +
// 执行命令，请求根本不会产生。命令只有四条：/mem on、/mem off、/mem clear、/sum。
//
// /sum 特殊一点：它执行完会自己往输入框里写 [总结所有] 再发出去（由 95-summarize 负责），
// 所以这里额外导出「写值 / 发送 / 等输入框」三个工具，供压缩流程复用。
import { toast } from './80-context.js'

var CMD_RE = /^\/(mem|sum)(?:\s+([A-Za-z]+))?\s*$/i
var CMD_HEAD_RE = /^\/(mem|sum)(\s|$)/i
export var HELP = '记忆：可用指令 /mem on、/mem off、/mem clear、/sum（压缩上下文）'
var installed = false

// 纯解析：/mem on|off|clear 与 /sum。裸 /mem、/sum 带参数返回 {sub:''/原词}（提示用法），
// 其它 /mem、/sum 开头的一律返回 {unknown:true}，照样拦下不发网络。
export function parseCommand(text) {
  var s = String(text == null ? '' : text).trim()
  if (!s || s.charAt(0) !== '/') return null
  var m = CMD_RE.exec(s)
  if (m) return { cmd: (m[1] || '').toLowerCase(), sub: (m[2] || '').toLowerCase(), unknown: false }
  if (CMD_HEAD_RE.test(s)) {
    return { cmd: (s.split(/\s+/)[0] || '').slice(1).toLowerCase(), sub: (s.split(/\s+/)[1] || '').toLowerCase(), unknown: true }
  }
  return null
}

function tagOf(el) { return el && el.tagName ? String(el.tagName).toUpperCase() : '' }

export function isInputEl(el) {
  if (!el || typeof el !== 'object') return false
  var t = tagOf(el)
  if (t === 'TEXTAREA' || t === 'INPUT') return true
  return el.isContentEditable === true
}

function readValue(el) {
  if (!el) return ''
  var t = tagOf(el)
  if (t === 'TEXTAREA' || t === 'INPUT') return String(el.value == null ? '' : el.value)
  return String(el.innerText != null ? el.innerText : (el.textContent || ''))
}

// 供压缩模块回读校验：写完值后要确认 React 没把输入框冲回空串
export function readInputValue(el) { return readValue(el) }

function fire(el, type) {
  try {
    if (typeof Event !== 'function' || !el.dispatchEvent) return
    el.dispatchEvent(new Event(type, { bubbles: true }))
  } catch (e) {}
}

// 写输入框必须走原生 setter + input 事件：
// 直接 el.value = 'x' 不会更新 React 内部 state，下次渲染会把旧值写回来。
// /sum 往输入框里塞 [总结所有] 也走这条路径，否则点发送时页面发的是空串。
export function writeValue(el, text) {
  var s = String(text == null ? '' : text)
  var t = tagOf(el)
  try {
    if (t === 'TEXTAREA' || t === 'INPUT') {
      var proto = null
      try {
        if (t === 'TEXTAREA' && window.HTMLTextAreaElement) proto = window.HTMLTextAreaElement.prototype
        if (t === 'INPUT' && window.HTMLInputElement) proto = window.HTMLInputElement.prototype
      } catch (e) {}
      var desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null
      if (desc && desc.set) desc.set.call(el, s)
      else el.value = s
      fire(el, 'input')
      return true
    }
    try { if (el.focus) el.focus() } catch (e) {}
    el.textContent = s
    fire(el, 'input')
    return true
  } catch (e) { return false }
}

function clearValue(el) { return writeValue(el, '') }

// 当前输入框：优先 activeElement，其次全页最后一个可编辑元素
export function findInput() {
  try {
    if (typeof document === 'undefined') return null
    if (isInputEl(document.activeElement)) return document.activeElement
  } catch (e) {}
  try {
    if (!document.querySelectorAll) return null
    var list = document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')
    for (var i = list.length - 1; i >= 0; i--) if (isInputEl(list[i])) return list[i]
  } catch (e) {}
  return null
}

function btnLabel(btn) {
  try {
    var a = (btn.getAttribute && (btn.getAttribute('aria-label') || btn.getAttribute('title'))) || ''
    return String(a) + ' ' + String(btn.textContent || '')
  } catch (e) { return '' }
}

// 发送键兜底：DeepSeek 的发送键是纯图标按钮（无文字、无 aria-label）
export function findSendButton() {
  var list = []
  try { list = document.querySelectorAll('button, [role="button"], [type="submit"]') || [] } catch (e) { return null }
  for (var i = list.length - 1; i >= 0; i--) {
    var b = list[i]
    if (!b || b.disabled) continue
    var label = btnLabel(b).trim()
    if (/发送|send/i.test(label) || label === '') return b
  }
  return null
}

function makeEnterEvent() {
  try {
    if (typeof KeyboardEvent === 'function') {
      var ev = new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
      })
      try { Object.defineProperty(ev, 'keyCode', { get: function () { return 13 } }) } catch (e) {}
      try { Object.defineProperty(ev, 'which', { get: function () { return 13 } }) } catch (e) {}
      return ev
    }
  } catch (e) {}
  try {
    if (typeof Event === 'function') {
      var ev2 = new Event('keydown', { bubbles: true, cancelable: true })
      try { Object.defineProperty(ev2, 'keyCode', { get: function () { return 13 } }) } catch (e) {}
      try { Object.defineProperty(ev2, 'key', { get: function () { return 'Enter' } }) } catch (e) {}
      return ev2
    }
  } catch (e) {}
  return null
}

// 提交当前输入框：先发 Enter（页面正常就是 Enter 发送），
// 250ms 后输入框还有内容 → 再点发送键；仍没消费就回调 onFail（提示用户手动发）。
// 注意：我们自己的捕获层也会收到这个合成 Enter，但 [总结所有] 不是命令，不会被拦。
export function submitInput(el, onFail) {
  if (!el) return false
  try { if (el.focus) el.focus() } catch (e) {}
  try {
    var ev = makeEnterEvent()
    if (ev && el.dispatchEvent) el.dispatchEvent(ev)
  } catch (e) {}
  setTimeout(function () {
    if (!readValue(el)) return
    var btn = findSendButton()
    if (btn) { try { btn.click() } catch (e) {} }
    setTimeout(function () {
      if (!readValue(el)) return
      if (onFail) { try { onFail() } catch (e) {} }
    }, 500)
  }, 250)
  return true
}

// 等输入框出现（新会话是整页重载后异步渲染的）
export function waitForInput(cb, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 20000)
  function tick() {
    var el = findInput()
    if (el) { try { cb(el) } catch (e) {} ; return }
    if (Date.now() > deadline) { try { cb(null) } catch (e) {} ; return }
    setTimeout(tick, 300)
  }
  setTimeout(tick, 300)
}

function apply(ctx, el, cmd) {
  clearValue(el)                       // 先清空，页面即使后面还想发也是空的
  var msg = ''
  try { msg = ctx.run(cmd) } catch (e) { msg = '记忆：指令执行失败（' + String(e).slice(0, 40) + '）' }
  try { if (typeof msg === 'string' && msg) toast(msg) } catch (e) {}
  try { console.log('[DSMEM]', msg) } catch (e) {}
}

function sendLikeBtn(target) {
  try { return target && target.closest ? target.closest('button, [role="button"], [type="submit"]') : null }
  catch (e) { return null }
}

// 找出当前装着命令的输入框：优先 activeElement，其次全页扫
function findCommand(doc) {
  try {
    var ae = doc.activeElement
    if (isInputEl(ae)) {
      var c0 = parseCommand(readValue(ae))
      if (c0) return { el: ae, cmd: c0 }
    }
  } catch (e) {}
  try {
    if (!doc.querySelectorAll) return null
    var list = doc.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')
    for (var i = 0; i < list.length; i++) {
      var c = parseCommand(readValue(list[i]))
      if (c) return { el: list[i], cmd: c }
    }
  } catch (e) {}
  return null
}

function stop(ev) {
  try { if (ev.preventDefault) ev.preventDefault() } catch (e) {}
  try { if (ev.stopPropagation) ev.stopPropagation() } catch (e) {}
  try { if (ev.stopImmediatePropagation) ev.stopImmediatePropagation() } catch (e) {}
}

function onKeyDown(ev, ctx) {
  try {
    if (!ev) return
    if (ev.isComposing || ev.keyCode === 229) return           // 输入法组字中，不算提交
    var isEnter = ev.key === 'Enter' || ev.keyCode === 13 || ev.which === 13
    if (!isEnter) return
    if (ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return
    var el = ev.target
    if (!isInputEl(el)) return
    var cmd = parseCommand(readValue(el))
    if (!cmd) return
    stop(ev)
    apply(ctx, el, cmd)
  } catch (e) {}
}

function onClick(ev, ctx) {
  try {
    var hit = findCommand(document)
    if (!hit) return
    var btn = sendLikeBtn(ev.target)
    if (!btn) return
    var label = btnLabel(btn).trim()
    // 发送键在 DeepSeek 是纯图标按钮：无文字、无 aria-label
    if (!(/发送|send/i.test(label) || label === '')) return
    stop(ev)
    apply(ctx, hit.el, hit.cmd)
  } catch (e) {}
}

function onSubmit(ev, ctx) {
  try {
    var hit = findCommand(document)
    if (!hit) return
    stop(ev)
    apply(ctx, hit.el, hit.cmd)
  } catch (e) {}
}

// opts.run(cmd) → 一句提示文案；cmd = {cmd:'mem'|'sum', sub:'on'|'off'|'clear'|'sum'|..., unknown}
export function installInputCommand(opts) {
  var ctx = { run: (opts && opts.run) || function () { return HELP } }
  if (installed) return ctx
  installed = true
  try {
    if (typeof document === 'undefined' || !document.addEventListener) return ctx
    document.addEventListener('keydown', function (ev) { onKeyDown(ev, ctx) }, true)
    document.addEventListener('click', function (ev) { onClick(ev, ctx) }, true)
    document.addEventListener('submit', function (ev) { onSubmit(ev, ctx) }, true)
  } catch (e) {}
  return ctx
}
