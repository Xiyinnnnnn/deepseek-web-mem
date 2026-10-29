// 模块 G：/sum 上下文压缩（手动命令 + 超阈值自动）
//
// 需求原话：hook 用户输入，发一条 [总结所有] 的 user 消息，把端点返回的摘要直接开一个新对话。
// 实现取舍：不自己造请求（不抄 Authorization / 不猜 PoW），而是**把输入框写成 [总结所有] 再让页面自己发**，
// 这样鉴权、PoW、请求头全部由页面生成，成功率与正常聊天一致。
//
// 全流程：
//   1. begin()  写输入框 = [总结所有]，标记「本脚本发的」时间窗，触发页面发送
//   2. 99-main 在网络层认出这条请求 → 原样放行、不落库、不注入，只旁观响应
//   3. finish(text) 拿到摘要 → 存交接单 → 跳新对话（整页重载）
//   4. resume() 新页面 boot 时读交接单 → 等输入框 → 写入摘要 → 触发发送
//
// 任何一步失败都只影响压缩，不影响正常聊天：全部 try/catch，失败给 toast。
import { CONFIG } from './02-config.js'
import { stats } from './01-stats.js'
import { toast } from './80-context.js'
import { findInput, writeValue, submitInput, waitForInput } from './85-input-command.js'

// sessionStorage 优先（每个标签页一份，刷新即失效最符合「交接单」语义），
// Via 等环境可能没有，退回 localStorage；都没有就只在本页内存里兜着。
function bag() {
  try { if (typeof sessionStorage !== 'undefined' && sessionStorage) return sessionStorage } catch (e) {}
  try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage } catch (e) {}
  return null
}

function readPending() {
  try {
    var b = bag()
    var raw = b ? b.getItem(CONFIG.KEY_SUM_PENDING) : null
    if (!raw) return null
    var p = JSON.parse(raw)
    return p && p.text ? p : null
  } catch (e) { return null }
}

function writePending(text, from) {
  try {
    var b = bag()
    if (!b) return false
    b.setItem(CONFIG.KEY_SUM_PENDING, JSON.stringify({ text: text, at: Date.now(), from: from || '' }))
    return true
  } catch (e) { return false }
}

function dropPending() {
  try {
    var b = bag()
    if (b) b.removeItem(CONFIG.KEY_SUM_PENDING)
  } catch (e) {}
}

export function createCompressor(deps) {
  var d = deps || {}
  var busy = false            // 自己发出去的那条 [总结所有] 还没回来
  var armedUntil = 0          // 时间窗：这条 [总结所有] 认作本脚本发的
  var lastTriggerAt = 0       // 自动触发节流
  var lastStatus = ''

  function note(s) {
    lastStatus = s
    try { console.log('[DSMEM] sum:', s) } catch (e) {}
  }

  // ---- 判定：这条请求是不是我们发的压缩请求 ----
  function isSummaryRequest(info) {
    try {
      if (!CONFIG.SUM_ENABLE) return false
      if (!info) return false
      if (String(info.userText || '').trim() !== CONFIG.SUM_PROMPT) return false
      if (Date.now() > armedUntil) { stats.inc('sum_stray'); return false }
      return true
    } catch (e) { return false }
  }

  // ---- 触发：写入 [总结所有] 并让页面自己发出去 ----
  function begin(reason) {
    if (!CONFIG.SUM_ENABLE) return '压缩：功能未启用（SUM_ENABLE=false）'
    if (busy) return '压缩：上一条还没回来，稍等'
    var el = findInput()
    if (!el) return '压缩：没找到输入框，请手动发 ' + CONFIG.SUM_PROMPT
    busy = true
    armedUntil = Date.now() + CONFIG.SUM_ARM_MS
    if (!writeValue(el, CONFIG.SUM_PROMPT)) {
      busy = false
      armedUntil = 0
      stats.inc('sum_fail')
      return '压缩：写入输入框失败'
    }
    submitInput(el, function () {
      // 页面没自动发出去：保留时间窗，用户手动点发送也能收尾
      note('submit-fallback')
      toast('压缩：没自动发出，请手动点发送 ' + CONFIG.SUM_PROMPT)
    })
    // 看门狗：时间窗过了还没抓到请求，就把状态复位，避免永久卡 busy
    setTimeout(function () {
      if (busy && Date.now() >= armedUntil) {
        busy = false
        armedUntil = 0
        note('armed-timeout')
      }
    }, CONFIG.SUM_ARM_MS + 2000)
    stats.inc(reason === 'auto' ? 'sum_auto' : 'sum_manual')
    note(reason)
    return '压缩：已发出 ' + CONFIG.SUM_PROMPT + '，摘要回来会自动开新对话'
  }

  function manual() { return begin('manual') }

  // ---- 超阈值自动触发：每轮响应结束后调一次，自带节流 ----
  function maybeAuto() {
    try {
      if (!CONFIG.SUM_ENABLE || !CONFIG.SUM_AUTO) return false
      if (busy) return false
      var now = Date.now()
      if (now - lastTriggerAt < CONFIG.SUM_COOLDOWN_MS) return false
      var est = 0
      try { est = d.contextTokens ? d.contextTokens() : 0 } catch (e) { est = 0 }
      if (!(est >= CONFIG.SUM_TRIGGER_TOKENS)) return false
      lastTriggerAt = now
      toast('上下文约 ' + (est >= 1000 ? Math.round(est / 1000) + 'K' : Math.round(est)) + ' token，自动压缩…')
      setTimeout(function () { begin('auto') }, CONFIG.SUM_AUTO_DELAY_MS)
      return true
    } catch (e) { return false }
  }

  // ---- 收尾：拿到摘要 → 存交接单 → 开新对话 ----
  function finish(text) {
    if (!busy) return false
    busy = false
    armedUntil = 0
    var t = String(text || '').trim()
    if (t.length < CONFIG.SUM_MIN_TEXT_CHARS) {
      stats.inc('sum_fail')
      note('empty')
      toast('压缩：摘要为空，已放弃（原对话不受影响）')
      return false
    }
    if (t.length > CONFIG.SUM_HANDOFF_CHARS) t = t.slice(0, CONFIG.SUM_HANDOFF_CHARS)
    var from = ''
    try { from = d.currentSession ? String(d.currentSession() || '') : '' } catch (e) {}
    writePending(t, from)
    try { if (d.onSummary) d.onSummary(t, from) } catch (e) {}
    stats.inc('sum_done')
    note('done len=' + t.length)
    toast('压缩完成：摘要 ' + t.length + ' 字，正在新开对话…')
    setTimeout(openNewChat, 600)
    return true
  }

  function openNewChat() {
    try {
      if (typeof location === 'undefined' || !location) return
      // 整页重载到新对话首页：boot() 里 resume() 会把摘要灌进去当第一条
      location.href = CONFIG.SUM_NEW_CHAT_URL
    } catch (e) { note('nav-fail') }
  }

  // 只有「新对话页」才灌摘要：地址栏还是 /a/chat/s/<id> 说明用户开的是旧会话，
  // 此时灌进去等于污染旧对话，宁可把交接单留着等下一次跳到新对话。
  function onFreshChatPage() {
    try {
      var path = String((location && location.pathname) || '/')
      return !/\/a\/chat\/s\//.test(path)
    } catch (e) { return true }
  }

  // ---- 新会话落地：把摘要写成新对话的第一条 user 消息 ----
  function resume() {
    var pend = readPending()
    if (!pend) return false
    if (Date.now() - (pend.at || 0) > CONFIG.SUM_PENDING_TTL_MS) { dropPending(); return false }
    if (!onFreshChatPage()) { note('resume-skip-old-chat'); return false }
    note('resume-wait')
    waitForInput(function (el) {
      if (!el) {
        // 不删交接单：下次打开页面还能继续
        toast('压缩：新对话输入框没出现，摘要已保留')
        return
      }
      if (!writeValue(el, pend.text)) {
        toast('压缩：摘要写入输入框失败')
        return
      }
      submitInput(el, function () {
        toast('压缩：摘要已填入，请手动点发送')
      })
      stats.inc('sum_resume')
      note('resume-sent')
      // 立刻删交接单：避免刷新一次重发一次；失败也宁可丢，也不重复发一堆摘要
      dropPending()
      toast('记忆：已把上一段对话的摘要发到新对话')
    }, CONFIG.SUM_INPUT_WAIT_MS)
    return true
  }

  return {
    isSummaryRequest: isSummaryRequest,
    begin: begin,
    manual: manual,
    maybeAuto: maybeAuto,
    finish: finish,
    resume: resume,
    status: function () {
      return '压缩：' + (busy ? '进行中' : '空闲') +
        '；自动=' + (CONFIG.SUM_AUTO ? '开' : '关') +
        '；阈值=' + Math.round(CONFIG.SUM_TRIGGER_TOKENS / 1000) + 'K token' +
        (lastStatus ? '；最近=' + lastStatus : '')
    }
  }
}
