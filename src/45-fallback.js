// 兜底正文提取器（阶段 0 未完成时用）。
// 立场：PROTOCOL.sse 未确认 = 不猜协议，但原始文本里明明有正文——
// 那就按「有则取、无则空」的原则尽力还原：提取失败必须返回 ''，绝不伪造内容。
// 与 50-machine 的分工：machine 走配置驱动（精确），本模块走结构嗅探（宽松），
// 两者结果取更长的那个。

var NOT_TEXT_KEY = /think|reason|search|meta|usage|token|balance|moderat|audit/i

function isContentPath(p) {
  if (!p) return false
  var s = String(p).toLowerCase()
  if (s.indexOf('content') === -1) return false
  return !NOT_TEXT_KEY.test(s)
}

// 从任意 JSON 节点里挖出"像正文"的字符串
function digText(node, depth, out) {
  depth = depth || 0
  if (depth > 8 || node == null) return
  if (typeof node === 'string') return
  if (Array.isArray(node)) {
    for (var i = 0; i < node.length; i++) digText(node[i], depth + 1, out)
    return
  }
  if (typeof node !== 'object') return
  // 真机报文中，正文与思考过程靠 fragment.type 区分（THINK / TOOL_SEARCH / RESPONSE），
  // 光看 key 名分不出来。这里先按 type 整段跳过，避免把思考过程当成回答记住。
  if (typeof node.type === 'string') {
    var t = node.type.toUpperCase()
    if (t === 'THINK' || t === 'THINKING' || t === 'REASONING') return
    if (t.indexOf('TOOL') === 0 || t === 'SEARCH' || t === 'SEARCH_RESULT') return
  }
  for (var k in node) {
    var v = node[k]
    var lk = String(k).toLowerCase()
    if (typeof v === 'string') {
      if ((lk === 'content' || lk === 'content_delta' || lk === 'text') && !NOT_TEXT_KEY.test(lk)) {
        out.push(v)
      }
    } else if (v && typeof v === 'object') {
      // 形如 {"response":{...}} 的包装层，递归进去
      digText(v, depth + 1, out)
    }
  }
}

export function extractFromRawText(rawText) {
  var src = String(rawText || '')
  if (!src) return ''

  var byPath = Object.create(null)      // p -> 文本
  var order = []
  var naked = ''                        // 没有 p 也没有 content 键，但 v 是字符串
  var diged = []                        // 结构嗅探结果

  function put(path, op, val) {
    if (typeof val !== 'string' || !val) return
    if (!isContentPath(path)) return
    if (byPath[path] === undefined) order.push(path)
    if (String(op).toUpperCase() === 'SET') byPath[path] = val
    else byPath[path] = (byPath[path] || '') + val
  }

  function handleOne(obj) {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) {
      for (var a = 0; a < obj.length; a++) handleOne(obj[a])
      return
    }
    var p = obj.p !== undefined ? obj.p : obj.path
    var o = obj.o !== undefined ? obj.o : obj.op
    var v = obj.v !== undefined ? obj.v : obj.value

    if (typeof p === 'string' && p) {
      if (typeof v === 'string') { put(p, o, v); return }
      if (v && typeof v === 'object') { digText(v, 0, diged); return }
    }
    if (typeof v === 'string' && v && !NOT_TEXT_KEY.test(String(o || ''))) {
      naked += v
      return
    }
    digText(obj, 0, diged)
  }

  var lines = src.split('\n')
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var t = line.replace(/^\s+/, '')
    if (t.indexOf('data:') !== 0) continue
    var body = t.slice(5).trim()
    if (!body || body === '[DONE]') continue
    var obj
    try { obj = JSON.parse(body) } catch (e) { continue }
    handleOne(obj)
  }

  var joined = ''
  for (var j = 0; j < order.length; j++) joined += byPath[order[j]]
  if (!joined) joined = naked
  var dug = diged.join('')
  // 取更长者：结构嗅探可能漏掉路径拼接，路径拼接也可能漏掉包装层
  return dug.length > joined.length ? dug : joined
}

// 从非 SSE 的 JSON 响应里取正文（部分接口一次性返回完整结果）
export function extractFromJsonBody(rawText) {
  var s = String(rawText || '').trim()
  if (!s || s.charAt(0) !== '{') return ''
  var obj
  try { obj = JSON.parse(s) } catch (e) { return '' }
  var out = []
  digText(obj, 0, out)
  return out.join('')
}
