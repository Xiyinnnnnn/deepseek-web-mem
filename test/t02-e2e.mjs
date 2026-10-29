// 端到端闭环：T01 空库放行 / T11 只落库一次 / T02 命中注入 / T25 同会话不重复注入
import { makeEnv, loadBundle } from './harness.mjs'

var env = makeEnv({})
var EP = 'https://chat.deepseek.com/api/v0/chat/completion'

globalThis.__DSMEM_PROTOCOL_OVERRIDE = {
  capturedAt: 'test',
  endpointPath: '/api/v0/chat/completion',
  method: 'POST',
  fields: { userText: 'prompt', sessionId: 'chat_session_id', parentMessageId: 'parent_message_id' },
  sse: {
    eventPathKey: 'p', eventOpKey: 'o', eventValueKey: 'v',
    ops: { APPEND: 'APPEND', SET: 'SET', BATCH: 'BATCH' },
    defaultOpWhenMissing: 'APPEND',
    textFragmentTypes: ['response/content'],
    doneOps: ['FINISHED'],
    errorOps: ['ERROR'],
    moderatedOps: ['MODERATION']
  }
}

// 故意按固定长度切片，制造「事件跨 chunk」与「中文跨 chunk」
function sseResponse(payload, sliceLen) {
  var enc = new TextEncoder()
  var bytes = enc.encode(payload)
  var stream = new ReadableStream({
    start: function (c) {
      for (var i = 0; i < bytes.length; i += sliceLen) c.enqueue(bytes.slice(i, Math.min(i + sliceLen, bytes.length)))
      c.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

var answers = {}
var sent = []
globalThis.fetch = function (input, init) {
  var body = null
  try { body = JSON.parse(init.body) } catch (e) {}
  sent.push(body)
  var prompt = body ? body.prompt : ''
  answers[body.chat_session_id] = (answers[body.chat_session_id] || 0) + 1
  var tail = String(prompt).slice(-6).replace(/"/g, '')
  var payload =
    'data: {"p":"response/thinking_content","o":"APPEND","v":"内部思考不该入库"}\n\n' +
    'data: {"p":"response/content","o":"APPEND","v":"针对你的问题，答案是"}\n\n' +
    'data: {"v":"可以这样做。"}\n\n' +
    'data: {"o":"FINISHED"}\n\n'
  return Promise.resolve(sseResponse(payload, 7))
}

loadBundle('dist/deepseek-web-mem.user.js')
var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
var send = function (payload) {
  return globalThis.fetch(EP, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  }).then(function (r) { return r.text().then(function () { return r }) })
}

var sleep = async function (ms) { await wait(ms) }
var run = async function () {
  await sleep(200)
  console.log('索引状态 =', globalThis.__dsMem.status() && 'ok')
  var s0 = globalThis.__dsMem.stats()
  console.log('T01 空库：注入次数应为 0 =', s0.inject_ok)

  // 轮1（会话 A）：落库种子记忆
  await send({ chat_session_id: 'A', parent_message_id: 'p1', prompt: 'Termux 里怎么用 Python 写爬虫抓取网页' })
  await sleep(150)
  console.log('轮1 后 saved =', globalThis.__dsMem.stats().saved)
  console.log('轮1 请求体 prompt 未被注入 =', sent[0].prompt === 'Termux 里怎么用 Python 写爬虫抓取网页')

  // 轮2（会话 B）：相关问题 → 应命中并注入
  await send({ chat_session_id: 'B', parent_message_id: 'p2', prompt: 'Python 写爬虫怎么绕过反爬限制' })
  await sleep(200)
  var s1 = globalThis.__dsMem.stats()
  console.log('轮2 注入成功数 =', s1.inject_ok)
  var injected = sent[1].prompt
  var hasBlock = injected.indexOf('[[DSMEM:v1 BEGIN]]') === 0
  var keepsOriginal = injected.indexOf('Python 写爬虫怎么绕过反爬限制') !== -1
  console.log('轮2 请求体首部是记忆块 =', hasBlock, '| 保留原始问题 =', keepsOriginal)
  console.log('轮2 落库总数 =', s1.saved)

  // 轮3（仍会话 B）：同一条记忆不应重复注入
  await send({ chat_session_id: 'B', parent_message_id: 'p3', prompt: 'Python 写爬虫怎么绕过反爬限制' })
  await sleep(200)
  var s2 = globalThis.__dsMem.stats()
  console.log('T25 轮3 注入成功数（不应增加）=', s2.inject_ok, '| 轮3 prompt 有块 =', sent[2].prompt.indexOf('[[DSMEM') !== -1)
  console.log('T11 轮3 后 saved =', s2.saved, '(轮2 的重复问题按归一化去重)')

  console.log('\n--- 存储快照 ---')
  var keys = Object.keys(env.kv).filter(function (k) { return k.indexOf('ds_mem_e_') === 0 })
  console.log('记忆条目数 =', keys.length)
  keys.forEach(function (k) {
    var r = JSON.parse(env.kv[k])
    console.log('  ', r.sessionId, '| injected=' + r.injected, '|', r.userText.slice(0, 24), '->', r.aiText.slice(0, 20))
  })
}
run().catch(function (e) { console.log('ERROR', e) })
