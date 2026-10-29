// DeepSeek SSE 协议状态机（2026-10-29 真机报文实测回填）。
//
// 实测形态：
//   event: ready
//   data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}
//   event: update_session
//   data: {"updated_at":1793248845.832685}
//   data: {"v":{"response":{...整条消息快照，含 fragments 数组...}}}   ← 无 p 无 o
//   data: {"p":"response/conversation_mode","v":"DEEP_SEARCH"}
//   data: {"p":"response/fragments/-1/content","o":"APPEND","v":"想知道"}
//   data: {"v":"如何"}                                               ← 裸增量，沿用上一个 path
//   data: {"p":"response","o":"BATCH","v":[{"p":"fragments","o":"APPEND","v":[{...}]}]}
//   data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":0.729}
//   data: {"p":"response/fragments/-1/results","o":"SET","v":[...]}
//
// 致命细节：`fragments/-1` 是「数组最后一个」的动态下标。
// 同一个 path 字符串在 THINK 片段和正文片段上指向不同对象，
// 所以绝不能拿 path 字符串当累积 buffer 的 key，必须先把 -1 解析成具体 fragment 的 id。
// 片段有 type：THINK / TOOL_SEARCH 属于过程，只有正文才进记忆。

import { PROTOCOL } from './02-config.js'

export var STATUS = {
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  INCOMPLETE: 'INCOMPLETE'
}

// 过程类片段：内容不进记忆。用黑名单而不是白名单，
// 因为正文 type 的值还可能变（见 knownTypes，诊断口会把它暴露出来）
var NON_TEXT_TYPES = {
  THINK: 1, THINKING: 1,
  TOOL_SEARCH: 1, TOOL_OPEN: 1, TOOL_RESULT: 1, TOOL: 1,
  SEARCH: 1, SEARCH_RESULT: 1,
  REASONING: 1
}

function isTextType(type) {
  if (!type) return false
  return !NON_TEXT_TYPES[String(type).toUpperCase()]
}

function parts(p) {
  return String(p == null ? '' : p).split('/').filter(function (x) { return x !== '' })
}

function joinPath(base, child) {
  if (!child) return base
  if (!base) return child
  // 子路径是相对父路径的（BATCH 内部即如此）
  return base + '/' + child
}

export function createMachine() {
  var status = STATUS.PENDING
  var fragments = []            // [{ id, type }]，顺序即 fragments 数组顺序
  var textBuf = ''              // 正文
  var thinkBuf = ''             // 思考内容，只用于诊断，绝不入记忆
  var otherBuf = ''             // 其他过程类片段（搜索等）
  var messageId = null
  var currentPath = null        // 裸增量要沿用上一个 path
  var sawText = false
  var finished = false
  var seenTypes = null

  function noteType(t) {
    if (!t) return
    if (!seenTypes) seenTypes = Object.create(null)
    seenTypes[String(t).toUpperCase()] = (seenTypes[String(t).toUpperCase()] || 0) + 1
  }

  function bucketOf(frag) {
    if (!frag) return 'other'
    var t = String(frag.type || '').toUpperCase()
    if (!t) return 'text'                 // 类型未知时按正文处理，宁可多存不可漏存
    if (t === 'THINK' || t === 'THINKING' || t === 'REASONING') return 'think'
    if (isTextType(t)) return 'text'
    return 'other'
  }

  function appendTo(frag, op, value) {
    var b = bucketOf(frag)
    var s = String(value == null ? '' : value)
    if (b === 'think') { thinkBuf = (op === 'SET') ? s : thinkBuf + s; return }
    if (b === 'other') { otherBuf = (op === 'SET') ? s : otherBuf + s; return }
    textBuf = (op === 'SET') ? s : textBuf + s
    if (s) sawText = true
  }

  function fragmentsOf(root) {
    if (!root || typeof root !== 'object') return null
    return Array.isArray(root.fragments) ? root.fragments : null
  }

  // 整条消息快照：{v:{response:{...}}}。用来重建 fragments 索引与当前正文
  function syncResponse(r) {
    if (!r || typeof r !== 'object') return
    if (typeof r.message_id === 'string' || typeof r.message_id === 'number') messageId = r.message_id
    if (typeof r.status === 'string') {
      var s = String(r.status).toUpperCase()
      if (s === 'FINISHED' || s === 'COMPLETED') { finished = true; status = STATUS.COMPLETED }
      else if (s === 'FAILED' || s === 'ERROR') status = STATUS.FAILED
      else if (s === 'CONTENT_FILTER' || s === 'MODERATION') status = STATUS.FAILED
    }
    var fs = fragmentsOf(r)
    if (fs) {
      fragments = []
      for (var i = 0; i < fs.length; i++) {
        var f = fs[i] || {}
        fragments.push({ id: f.id, type: f.type })
        noteType(f.type)
        if (typeof f.content === 'string' && f.content) appendTo(fragments[i], 'SET', f.content)
      }
    }
  }

  function pushFragments(list) {
    if (!Array.isArray(list)) list = (list && typeof list === 'object') ? [list] : []
    for (var i = 0; i < list.length; i++) {
      var f = list[i]
      if (!f || typeof f !== 'object') continue
      fragments.push({ id: f.id, type: f.type })
      noteType(f.type)
      if (typeof f.content === 'string' && f.content) {
        appendTo(fragments[fragments.length - 1], 'APPEND', f.content)
      }
    }
    // 新建片段后，紧随其后的裸增量（无 p）应接到这个片段上
    if (list.length && fragments.length) currentPath = 'response/fragments/-1/content'
  }

  function resolveFragment(idxStr) {
    if (idxStr === undefined || idxStr === null || idxStr === '') return null
    var idx
    if (String(idxStr) === '-1') idx = fragments.length - 1
    else idx = parseInt(idxStr, 10)
    if (!(idx >= 0) || idx >= fragments.length) return null
    return fragments[idx]
  }

  function applyPatch(path, op, value) {
    var ps = parts(path)
    if (!ps.length || ps[0] !== 'response') return
    var O = String(op || 'APPEND').toUpperCase()

    if (ps[1] === 'fragments') {
      if (ps.length === 2) { pushFragments(value); return }
      var frag = resolveFragment(ps[2])
      var rest = ps.slice(3).join('/')
      if (!frag) {
        // -1 还没对应片段（快照没到）：先按正文兜底收下，避免丢字
        if (rest === 'content') { textBuf += String(value == null ? '' : value); sawText = true }
        return
      }
      if (rest === 'content' || rest === 'text') { appendTo(frag, O, value); return }
      if (rest === 'status') {
        var sv = String(value == null ? '' : value).toUpperCase()
        if ((sv === 'FINISHED' || sv === 'COMPLETED') && bucketOf(frag) === 'text') {
          finished = true
          status = STATUS.COMPLETED
        } else if (sv === 'FAILED' || sv === 'ERROR' || sv === 'CONTENT_FILTER' || sv === 'MODERATION') {
          status = STATUS.FAILED
        }
        return
      }
      return                                   // 其余 fragment 字段（results/queries/elapsed_secs）忽略
    }

    if (ps[1] === 'status') {
      var rs = String(value == null ? '' : value).toUpperCase()
      if (rs === 'FINISHED' || rs === 'COMPLETED') { finished = true; status = STATUS.COMPLETED }
      else if (rs === 'FAILED' || rs === 'ERROR') status = STATUS.FAILED
      return
    }
    if (ps[1] === 'message_id') { messageId = value; return }
    // response 其它字段不关心
  }

  function feed(ev) {
    if (!ev) return
    if (ev.event === 'error') { status = STATUS.FAILED; return }
    var raw = ev.data
    if (raw == null) return
    if (raw === '[DONE]') { finished = true; if (status === STATUS.PENDING) status = STATUS.COMPLETED; return }
    raw = String(raw).trim()
    if (!raw) return

    var obj
    try { obj = JSON.parse(raw) } catch (e) { return }    // 非 JSON 事件忽略，不猜
    if (!obj || typeof obj !== 'object') return

    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) applyPatch(obj[i] && obj[i].p, obj[i] && obj[i].o, obj[i] && obj[i].v)
      return
    }

    // 1) 整体快照：{"v":{"response":{...}}}
    if (obj.v && typeof obj.v === 'object' && obj.v.response && typeof obj.v.response === 'object') {
      syncResponse(obj.v.response)
      return
    }

    var p = obj.p
    var o = obj.o
    var v = obj.v

    // 2) 显式 path
    if (typeof p === 'string' && p) {
      if (O_isBatch(o)) {
        currentPath = p
        var arr = Array.isArray(v) ? v : []
        for (var j = 0; j < arr.length; j++) {
          var it = arr[j] || {}
          applyPatch(joinPath(p, it.p), it.o || 'APPEND', it.v)
        }
        return
      }
      applyPatch(p, o || PROTOCOL.sse.defaultOpWhenMissing || 'APPEND', v)
      currentPath = p
      return
    }

    // 3) 裸增量：没有 path，沿用上一个 path
    if (typeof v === 'string' && v) {
      var cp = currentPath
      if (cp && (cp.slice(-8) === '/content' || cp.slice(-5) === '/text')) {
        applyPatch(cp, o || 'APPEND', v)
      } else if (!cp) {
        textBuf += v
        sawText = true
      }
      return
    }

    // 4) 其余（update_session 之类的 data）忽略
  }

  function O_isBatch(o) { return String(o || '').toUpperCase() === 'BATCH' }

  return {
    feed: feed,
    markCancelled: function () { if (status === STATUS.PENDING) status = STATUS.CANCELLED },
    markFailed: function () { if (status === STATUS.PENDING) status = STATUS.FAILED },
    heuristic: function () { return !seenTypes },
    result: function () {
      var st = status
      if (st === STATUS.PENDING) st = finished ? STATUS.COMPLETED : STATUS.INCOMPLETE
      return {
        status: st,
        text: textBuf,
        thinkLen: thinkBuf.length,
        otherLen: otherBuf.length,
        messageId: messageId,
        types: seenTypes
      }
    }
  }
}
