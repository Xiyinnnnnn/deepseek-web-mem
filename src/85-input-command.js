// 模块 F2：输入框快捷指令（13.3 重做）
//
// 真机问题：旧实现把 /mem 交给「网络层 400 中断」，可页面实际走 XHR，
// 而 XHR 分支当时对命令只 toast 一句就 XS.apply 放行 → 命令原封不动发给了 API。
//
// 现在改在输入框上截：document 捕获阶段（比页面自己的 React 根容器更早）
// 拦 Enter / 点发送键 / form submit，命中就地 preventDefault + 清空输入框 +
// 执行命令，请求根本不会产生。只有这三条：/mem on、/mem off、/mem clear。
import { toast } from './80-context.js'

var CMD_RE = /^\/mem(?:\s+([A-Za-z]+))?\s*$/
var HELP = '记忆：可用指令 /mem on、/mem off、/mem clear'
var installed = false

// 纯解析：/mem on|off|clear。裸 /mem 返回 {sub:''}（提示用法），
// 其它 /mem 开头的一律返回 {sub:原词, unknown:true}，照样拦下不发网络。
export function parseCommand(text) {
  var s = String(text == null ? '' : text).trim()
  if (!s || s.charAt(0) !== '/') return null
  var m = CMD_RE.exec(s)
  if (m) return { sub: (m[1] || '').toLowerCase(), unknown: false }
  if (/^\/mem(\s|$)/i.test(s)) {
    return { sub: (s.split(/\s+/)[1] || '').toLowerCase(), unknown: true }
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

function fire(el, type) {
  try {
    if (typeof Event !== 'function' || !el.dispatchEvent) return
    el.dispatchEvent(new Event(type, { bubbles: true }))
  } catch (e) {}
}

// 清空输入框必须走原生 setter + input 事件：
// 直接 el.value='' 不会更新 React 内部 state，下次渲染会把旧命令写回来。
function clearValue(el) {
  var t = tagOf(el)
  try {
    if (t === 'TEXTAREA' || t === 'INPUT') {
      var proto = null
      try {
        if (t === 'TEXTAREA' && window.HTMLTextAreaElement) proto = window.HTMLTextAreaElement.prototype
        if (t === 'INPUT' && window.HTMLInputElement) proto = window.HTMLInputElement.prototype
      } catch (e) {}
      var desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null
      if (desc && desc.set) desc.set.call(el, '')
      else el.value = ''
      fire(el, 'input')
      return
    }
    try {
      el.focus()
      var sel = window.getSelection && window.getSelection()
      if (sel && document.createRange) {
        var r = document.createRange()
        r.selectNodeContents(el)
        sel.removeAllRanges(); sel.addRange(r)
        if (document.execCommand) document.execCommand('delete')
      }
    } catch (e) {}
    if (String(el.textContent || '').trim()) el.textContent = ''
    fire(el, 'input')
  } catch (e) {}
}

function apply(ctx, el, cmd) {
  clearValue(el)                       // 先清空，页面即使后面还想发也是空的
  var msg = ''
  try { msg = ctx.run(cmd.sub) } catch (e) { msg = '记忆：指令执行失败（' + String(e).slice(0, 40) + '）' }
  try { if (typeof msg === 'string' && msg) toast(msg) } catch (e) {}
  try { console.log('[DSMEM]', msg) } catch (e) {}
}

function sendLikeBtn(target) {
  try { return target && target.closest ? target.closest('button, [role="button"], [type="submit"]') : null }
  catch (e) { return null }
}

function btnLabel(btn) {
  try {
    var a = (btn.getAttribute && (btn.getAttribute('aria-label') || btn.getAttribute('title'))) || ''
    return String(a) + ' ' + String(btn.textContent || '')
  } catch (e) { return '' }
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

// opts.run(sub) → 一句提示文案。同一页面只装一次。
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
