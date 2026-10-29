// T05：环境没有 Intl.Segmenter 时，脚本必须正常加载并注册拦截器，进入降级分词
import { makeEnv, loadBundle } from './harness.mjs'

makeEnv({ noSegmenter: true })
console.log('Intl.Segmenter 可用性 =', typeof Intl.Segmenter)

var original = function () { return Promise.resolve('ORIGINAL') }
globalThis.fetch = original

loadBundle('dist/deepseek-web-mem.user.js')

console.log('loadedd 标志 =', globalThis.__ds_memory_rag_loaded)
console.log('fetch 已被包装 =', globalThis.fetch !== original)
var ok = globalThis.__ds_memory_rag_loaded === true && globalThis.fetch !== original

globalThis.fetch('https://chat.deepseek.com/api/v0/chat/completion', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: '测试' })
}).then(function (r) {
  console.log('放行后返回值 =', r)
  console.log('原 fetch 被调用 =', original !== globalThis.fetch)
  console.log(ok ? 'T05 PASS' : 'T05 FAIL')
})
