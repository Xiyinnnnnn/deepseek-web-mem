// SSE 流解析器（9.2）。只负责切事件与解析 data，不写记忆。
// 禁止把网络 chunk 当完整事件：一个事件可跨 chunk，多个事件可在一个 chunk。

export function createSseParser(onEvent) {
  var decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null
  var buffer = ''
  var dataLines = []
  var eventName = ''
  var lastId = ''
  var sawEvent = false

  function looksJson(t) {
    var s = String(t).trim()
    if (!s) return false
    var c = s.charAt(0)
    if (c !== '{' && c !== '[') return false
    try { JSON.parse(s); return true } catch (e) { return false }
  }

  function flushEvent() {
    if (!dataLines.length) {
      if (sawEvent) {
        var ev0 = { event: eventName || 'message', data: '', id: lastId }
        eventName = ''; sawEvent = false
        try { onEvent(ev0) } catch (e) {}
      }
      dataLines = []
      return
    }

    // 真机实测（2026-10-29）：DeepSeek **不用空行分隔事件**，每个 data: 行就是一条独立事件。
    // 标准 SSE 的多行 data 会被拼成一条。两者形式相同，只能靠「拼起来还能不能当 JSON」区分：
    //   - 能 parse → 标准多行 data，整体作为一条事件
    //   - 不能 parse → 逐行独立成事件
    // 原实现一律拼成一条，导致几十条事件被合成一行、JSON.parse 全部失败、正文全丢。
    if (dataLines.length > 1 && !looksJson(dataLines.join('\n'))) {
      var lines = dataLines.slice()
      var evName = eventName
      dataLines = []
      eventName = ''
      sawEvent = false
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i]
        if (!ln || !ln.trim()) continue
        try { onEvent({ event: evName || 'message', data: ln, id: lastId }) } catch (e) {}
        evName = ''                                  // event 名只作用于紧随的一条
      }
      return
    }

    var data = dataLines.join('\n')
    var ev = { event: eventName || 'message', data: data, id: lastId }
    dataLines = []
    eventName = ''
    sawEvent = false
    try { onEvent(ev) } catch (e) { /* 状态机异常不得中断读取 */ }
  }

  function processLine(line) {
    if (line === '') { flushEvent(); return }
    if (line.charAt(0) === ':') return              // 注释行
    var idx = line.indexOf(':')
    var field = idx === -1 ? line : line.slice(0, idx)
    var value = idx === -1 ? '' : line.slice(idx + 1)
    if (value.charAt(0) === ' ') value = value.slice(1)

    if (field === 'data') { dataLines.push(value); sawEvent = true; return }
    if (field === 'event') { eventName = value; sawEvent = true; return }
    if (field === 'id') { lastId = value; return }
    if (field === 'retry') return
  }

  function drain(final) {
    var pos
    while ((pos = buffer.indexOf('\n')) !== -1) {
      var line = buffer.slice(0, pos)
      buffer = buffer.slice(pos + 1)
      if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1)
      processLine(line)
    }
    if (final) {
      if (buffer.length) {
        var tail = buffer
        buffer = ''
        if (tail.charAt(tail.length - 1) === '\r') tail = tail.slice(0, -1)
        processLine(tail)
      }
      flushEvent()
    }
  }

  return {
    // chunk: Uint8Array
    push: function (chunk) {
      if (!chunk) return
      var text
      // 真机缺陷修复：XHR 与「非流式响应」两条路径喂进来的是字符串，
      // 直接丢给 TextDecoder 会抛 ERR_INVALID_ARG_TYPE，且被上层 catch 吞掉 →
      // 表现为「响应明明有内容却一条都解析不出来」。
      if (typeof chunk === 'string') text = chunk
      else if (decoder) text = decoder.decode(chunk, { stream: true })
      else text = String(chunk)
      buffer += text
      drain(false)
    },
    end: function () {
      if (decoder) {
        try { buffer += decoder.decode() } catch (e) {}
      }
      drain(true)
    }
  }
}
