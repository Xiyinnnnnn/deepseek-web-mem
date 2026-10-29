import { makeEnv, loadBundle } from './harness.mjs'
const EP = 'https://chat.deepseek.com/api/v0/chat/completion'
const env = makeEnv({})
globalThis.__DSMEM_PROTOCOL_OVERRIDE = {
  endpointPath: '/api/v0/chat/completion', method: 'POST', retryBranch: 'B',
  fields: { userText: 'prompt', sessionId: 'chat_session_id', parentMessageId: 'parent_message_id' },
  sse: { eventPathKey: 'p', eventOpKey: 'o', eventValueKey: 'v', ops: { APPEND: 'APPEND', SET: 'SET', BATCH: 'BATCH' }, defaultOpWhenMissing: 'APPEND', textFragmentTypes: ['response/content'], doneOps: ['FINISHED'] }
}
function resp(t) {
  const enc = new TextEncoder()
  const p = 'data: {"p":"response/content","o":"APPEND","v":"' + t + '"}\n\ndata: {"o":"FINISHED"}\n\n'
  const b = enc.encode(p)
  return new Response(new ReadableStream({ start(c) { c.enqueue(b); c.close() } }), { status: 200 })
}
let realFetch = function () { return Promise.resolve(resp('回答' + Math.random().toString(36).slice(2, 5))) }
globalThis.fetch = realFetch
loadBundle('dist/deepseek-web-mem.user.js')
const sleep = ms => new Promise(r => setTimeout(r, ms))
await sleep(100)
for (let i = 0; i < 6; i++) {
  await globalThis.fetch(EP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_session_id: 'X', parent_message_id: 'p' + i, prompt: 'Termux 里怎么用 Python 写爬虫 第' + i + '个问题' }) })
  await sleep(80)
}
const st = globalThis.__dsMem.stats()
console.log('saved=', st.saved, 'inject_ok=', st.inject_ok, 'lastIndexError=', st.lastIndexError)
globalThis.__dsMem.status()
