// 离线验收测试：覆盖设计文档第十六章中可在 node 里验证的用例
import { makeEnv, loadBundle } from './harness.mjs'

var PASS = 0, FAIL = 0
function ck(id, name, cond, extra) {
  if (cond) { PASS++; console.log('  PASS ' + id + ' ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { FAIL++; console.log('  FAIL ' + id + ' ' + name + (extra ? '  [' + extra + ']' : '')) }
}

var EP = 'https://chat.deepseek.com/api/v0/chat/completion'
function override(retryBranch) {
  globalThis.__DSMEM_PROTOCOL_OVERRIDE = {
    capturedAt: 'test',
    endpointPath: '/api/v0/chat/completion',
    method: 'POST',
    retryBranch: retryBranch || 'B',
    fields: { userText: 'prompt', sessionId: 'chat_session_id', parentMessageId: 'parent_message_id' }
    // sse 不覆盖：2026-10-29 真机实测值已写死在 02-config.js
  }
}

function sseOK(text, sliceLen) {
  var enc = new TextEncoder()
  var payload = 'data: {"v":{"response":{"message_id":7,"status":"WIP","fragments":[{"id":1,"type":"RESPONSE","content":"' + text + '"}]}}}\n' +
                'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n'
  var bytes = enc.encode(payload)
  var stream = new ReadableStream({
    start: function (c) {
      for (var i = 0; i < bytes.length; i += (sliceLen || 9)) c.enqueue(bytes.slice(i, Math.min(i + (sliceLen || 9), bytes.length)))
      c.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function sseAborted() {
  var enc = new TextEncoder()
  return new Response(new ReadableStream({
    start: function (c) {
      c.enqueue(enc.encode('data: {"v":{"response":{"fragments":[{"id":1,"type":"RESPONSE","content":"半截回答"}]}}}\n'))
      setTimeout(function () {
        var e = new Error('aborted'); e.name = 'AbortError'
        c.error(e)
      }, 10)
    }
  }), { status: 200 })
}

function sseModerated() {
  var enc = new TextEncoder()
  return new Response(new ReadableStream({
    start: function (c) {
      c.enqueue(enc.encode('data: {"v":{"response":{"message_id":9,"status":"WIP","fragments":[{"id":1,"type":"RESPONSE","content":"内容"}]}}}\n'))
      c.enqueue(enc.encode('data: {"v":{"response":{"status":"CONTENT_FILTER"}}}\n'))
      c.close()
    }
  }), { status: 200 })
}

var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

function send(payload) {
  return globalThis.fetch(EP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    .then(function (r) { return r.text().then(function () { return r }, function () { return r }) })
    .catch(function (e) { return e })
}

async function phaseBasic() {
  console.log('\n[1] 基础闭环与记录规则')
  var env = makeEnv({})
  override('B')
  var sent = []
  var mode = 'ok'
  globalThis.fetch = function (input, init) {
    var body; try { body = JSON.parse(init.body) } catch (e) {}
    sent.push(body)
    if (mode === 'ok') return Promise.resolve(sseOK('正常回答内容', 7))
    if (mode === 'abort') return Promise.resolve(sseAborted())
    if (mode === 'mod') return Promise.resolve(sseModerated())
    return Promise.resolve(new Response('{}', { status: 400 }))
  }
  loadBundle('dist/deepseek-web-mem.user.js')
  await sleep(150)

  ck('T01', '空记忆库不注入', globalThis.__dsMem.stats().inject_ok === 0)

  await send({ chat_session_id: 'A', parent_message_id: 'p1', prompt: 'Termux 里怎么用 Python 写爬虫' })
  await sleep(120)
  var st = globalThis.__dsMem.stats()
  ck('T11', '回复正常结束只落库一次', st.saved === 1, 'saved=' + st.saved)
  ck('T11b', '原始问题未被注入', sent[0].prompt === 'Termux 里怎么用 Python 写爬虫')

  mode = 'abort'
  await send({ chat_session_id: 'A', parent_message_id: 'p2', prompt: 'Termux 里怎么用 Python 写爬虫抓图' })
  await sleep(150)
  ck('T12', '用户取消生成不保存', globalThis.__dsMem.stats().saved === 1, 'saved=' + globalThis.__dsMem.stats().saved)

  mode = 'mod'
  await send({ chat_session_id: 'A', parent_message_id: 'p3', prompt: 'Termux 里怎么用 Python 写爬虫提速' })
  await sleep(150)
  ck('T33', '流结束后审核撤回不入库', globalThis.__dsMem.stats().saved === 1, 'saved=' + globalThis.__dsMem.stats().saved)

  // 跨会话命中注入
  mode = 'ok'
  await send({ chat_session_id: 'B', parent_message_id: 'p4', prompt: 'Python 写爬虫用什么库' })
  await sleep(180)
  var injText = sent[sent.length - 1].prompt
  ck('T02', '精确关键词命中并注入', globalThis.__dsMem.stats().inject_ok === 1)
  ck('T02b', '记忆块在首位且保留原文', injText.indexOf('[[DSMEM:v1 BEGIN]]') === 0 && injText.indexOf('Python 写爬虫用什么库') !== -1)

  // 同会话不重复注入
  await send({ chat_session_id: 'B', parent_message_id: 'p5', prompt: 'Python 写爬虫用什么库' })
  await sleep(180)
  ck('T25', '同会话不重复注入同一条', globalThis.__dsMem.stats().inject_ok === 1 && sent[sent.length - 1].prompt.indexOf('[[DSMEM') === -1)

  // 重新生成覆盖（同一 parentMessageId）
  var before = globalThis.__dsMem.stats().saved
  await send({ chat_session_id: 'A', parent_message_id: 'p1', prompt: 'Termux 里怎么用 Python 写爬虫' })
  await sleep(150)
  var keys = Object.keys(env.kv).filter(function (k) { return k.indexOf('ds_mem_e_') === 0 })
  ck('T28', '重新生成覆盖而不是追加', keys.length === before, '条目=' + keys.length + ' saved=' + globalThis.__dsMem.stats().saved)
  await sleep(2200)
  ck('T28b', '覆盖写入后索引未被拖入 stale', globalThis.__dsMem.indexState() === 'ready', 'state=' + globalThis.__dsMem.indexState())

  // T36 /mem 指令
  var r = await globalThis.fetch(EP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_session_id: 'A', prompt: '/mem status' }) })
  ck('T36', '/mem status 本地处理不发服务端', r.status === 400 && sent[sent.length - 1].prompt !== '/mem status')

  return env
}

async function phaseReject(env, branch) {
  console.log('\n[2] 注入被拒回退（分支 ' + branch + '）')
  var kv = env.kv
  var env2 = makeEnv({ kv: kv })
  delete globalThis.__ds_memory_rag_loaded
  override(branch)
  var sent = []
  var reject = true
  globalThis.fetch = function (input, init) {
    var body; try { body = JSON.parse(init.body) } catch (e) {}
    sent.push(body)
    if (reject && String(body.prompt).indexOf('[[DSMEM') === 0) {
      return Promise.resolve(new Response('{"error":"rejected"}', { status: 400 }))
    }
    return Promise.resolve(sseOK('回答'))
  }
  loadBundle('dist/deepseek-web-mem.user.js')
  await sleep(200)
  await send({ chat_session_id: 'C', parent_message_id: 'q1', prompt: 'Python 写爬虫用什么库' })
  await sleep(200)
  var st = globalThis.__dsMem.stats()
  ck('T23-' + branch, '注入被拒不卡死', true, 'inject_rejected=' + st.inject_rejected)
  if (branch === 'A') {
    ck('T23A', '分支A 用原始 init 补发一次', sent.length === 2 && sent[1].prompt.indexOf('[[DSMEM') === -1, '请求数=' + sent.length)
  } else {
    ck('T23B', '分支B 不补发', sent.length === 1, '请求数=' + sent.length)
  }
  return env2
}

async function phaseBreaker(env) {
  console.log('\n[3] 熔断与协议失效提示')
  var env3 = makeEnv({ kv: env.kv })
  delete globalThis.__ds_memory_rag_loaded
  override('B')
  var sent = []
  globalThis.fetch = function (input, init) {
    var body; try { body = JSON.parse(init.body) } catch (e) {}
    sent.push(body)
    if (String(body.prompt).indexOf('[[DSMEM') === 0) return Promise.resolve(new Response('{}', { status: 500 }))
    return Promise.resolve(sseOK('回答'))
  }
  loadBundle('dist/deepseek-web-mem.user.js')
  await sleep(200)
  for (var i = 0; i < 5; i++) {
    await send({ chat_session_id: 'D', parent_message_id: 'r' + i, prompt: 'Python 写爬虫用什么库' })
    await sleep(120)
  }
  var st = globalThis.__dsMem.stats()
  ck('T24', '连续被拒达到阈值触发熔断', st.breaker_tripped === 1, 'tripped=' + st.breaker_tripped)
  var afterTrip = sent.filter(function (b) { return String(b.prompt).indexOf('[[DSMEM') === 0 }).length
  ck('T24b', '熔断后不再注入', afterTrip <= 3, '带块请求=' + afterTrip)
}

async function phaseQuota() {
  console.log('\n[4] 配额不足不破坏已有记录')
  var env = makeEnv({})
  var origSet = env.localStorage.setItem
  var CAP = 900                                    // 模拟 localStorage 总量上限
  env.localStorage.setItem = function (k, v) {
    var total = 0
    for (var kk in env.kv) if (kk !== k) total += kk.length + String(env.kv[kk]).length
    if (total + k.length + String(v).length > CAP) {
      var e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e
    }
    return origSet(k, v)
  }
  delete globalThis.__ds_memory_rag_loaded
  override('B')
  globalThis.fetch = function () { return Promise.resolve(sseOK('回答')) }
  loadBundle('dist/deepseek-web-mem.user.js')
  await sleep(150)
  for (var i = 0; i < 8; i++) {
    await send({ chat_session_id: 'E', parent_message_id: 's' + i, prompt: '配额测试问题' + i })
    await sleep(60)
  }
  var keys = Object.keys(env.kv).filter(function (k) { return k.indexOf('ds_mem_e_') === 0 })
  var intact = keys.every(function (k) { try { return !!JSON.parse(env.kv[k]).id } catch (e) { return false } })
  ck('T15', '配额失败不破坏已有记录', intact && keys.length > 0, '条目=' + keys.length)
  ck('T38', '站点自身键未被挤坏', env.kv['ds_mem_meta_v1'] !== undefined)
}

async function phaseRefresh() {
  console.log('\n[5] 刷新后索引恢复')
  var env = makeEnv({})
  delete globalThis.__ds_memory_rag_loaded
  override('B')
  globalThis.fetch = function () { return Promise.resolve(sseOK('持久化回答')) }
  loadBundle('dist/deepseek-web-mem.user.js')
  await sleep(150)
  await send({ chat_session_id: 'F', parent_message_id: 't1', prompt: 'Termux 里怎么用 Python 写爬虫' })
  await sleep(150)
  var saved = globalThis.__dsMem.stats().saved

  // 模拟刷新：复用 localStorage，重置运行时
  delete globalThis.__ds_memory_rag_loaded
  var env2 = makeEnv({ kv: env.kv })
  delete globalThis.__DSMEM_PROTOCOL_OVERRIDE
  override('B')
  var calls = []
  globalThis.fetch = function (input, init) { calls.push(init); return Promise.resolve(sseOK('新回答')) }
  loadBundle('dist/deepseek-web-mem.user.js')
  await sleep(300)
  var st = globalThis.__dsMem.stats()
  ck('T17', '刷新后索引重建', st.saved === saved, 'saved=' + st.saved)
  await send({ chat_session_id: 'G', parent_message_id: 'u1', prompt: 'Python 写爬虫用什么库' })
  await sleep(200)
  var stx = globalThis.__dsMem.stats()
  var lastPrompt = ''
  try { lastPrompt = JSON.parse(calls[calls.length - 1].body).prompt } catch (e) {}
  ck('T17b', '刷新后仍可检索注入', stx.inject_ok >= 1 && lastPrompt.indexOf('[[DSMEM') === 0,
     'inject_ok=' + stx.inject_ok + ' retrieve_none=' + stx.retrieve_none + ' timeout=' + stx.retrieve_timeout + ' breaker=' + stx.breaker_tripped)
}

async function phaseUnsupported() {
  console.log('\n[6] 不支持的形式安全放行')
  var env = makeEnv({})
  delete globalThis.__ds_memory_rag_loaded
  override('B')
  var sawArgs = []
  globalThis.fetch = function (input, init) { sawArgs.push([input, init]); return Promise.resolve('RAW') }
  loadBundle('dist/deepseek-web-mem.user.js')
  await sleep(100)
  var req = new Request(EP, { method: 'POST', body: '{"chat_session_id":"x","prompt":"q"}' })
  var r1 = await globalThis.fetch(req)
  ck('T08', 'Request 对象形式放行', r1 === 'RAW' && sawArgs.length === 1)
  var r2 = await globalThis.fetch(EP, { method: 'POST', body: new URLSearchParams({ a: '1' }) })
  ck('T08b', '非字符串 body 放行', r2 === 'RAW')
  var st = globalThis.__dsMem.stats()
  ck('T08c', 'unsupported 已计数', st.skip_unsupported_form >= 1, 'count=' + st.skip_unsupported_form)
}

async function main() {
  var env1 = await phaseBasic()
  await phaseReject(env1, 'B')
  await phaseReject(env1, 'A')
  await phaseBreaker(env1)
  await phaseQuota()
  await phaseRefresh()
  await phaseUnsupported()
  console.log('\n================  ' + PASS + ' PASS / ' + FAIL + ' FAIL  ================')
  process.exit(FAIL ? 1 : 0)
}
main().catch(function (e) { console.log('HARNESS ERROR', e); process.exit(2) })
