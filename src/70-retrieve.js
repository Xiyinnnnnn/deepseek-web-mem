// 检索与注入策略（第八章）。
// 重要实测修正：Orama 3.1.18 的 search().threshold 不是"命中词比例"，
// 而是结果集按条数插值裁剪（0 = 要求命中全部词，1 = 命中任一即可，中间值按条数切）。
// 因此这里用 threshold=1 宽召回，再自行按 token 覆盖率裁剪。
import { CONFIG } from './02-config.js'
import { stats } from './01-stats.js'
import { tokenize } from './10-tokenizer.js'
import { buildMemoryBlock } from './30-block.js'

function normText(t) {
  return String(t || '').replace(/\s+/g, '').toLowerCase()
}

function uniq(arr) {
  var seen = Object.create(null)
  var out = []
  for (var i = 0; i < arr.length; i++) {
    if (!arr[i] || seen[arr[i]]) continue
    seen[arr[i]] = true
    out.push(arr[i])
  }
  return out
}

function coverage(queryTokens, docText) {
  if (!queryTokens.length) return 0
  var docTokens = tokenize(docText)
  var set = Object.create(null)
  for (var i = 0; i < docTokens.length; i++) set[docTokens[i]] = true
  var hit = 0
  for (var j = 0; j < queryTokens.length; j++) if (set[queryTokens[j]]) hit++
  return hit / queryTokens.length
}

export function preprocessQuery(userText) {
  var q = String(userText || '').slice(0, CONFIG.QUERY_MAX_CHARS).trim()
  if (!q) return null
  var tokens = uniq(tokenize(q))
  if (tokens.length < CONFIG.MIN_QUERY_TOKENS) return null
  return { term: q, tokens: tokens }
}

// deps: { index, store, injected: InjectedRegistry, sessionOff: Set }
export async function planInjection(deps, info) {
  var index = deps.index
  if (!index.isReady()) return null

  var prep = preprocessQuery(info.userText)
  if (!prep) return null

  var candidates = await index.query(prep.term, { limit: CONFIG.CANDIDATE_LIMIT })
  if (!candidates.length) return null

  var injectedIds = deps.injected.idsFor(info.sessionId)
  var seen = Object.create(null)
  var scored = []

  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i]
    var meta = deps.store.metaOf(c.id)
    if (!meta) continue
    if (meta.sessionId === info.sessionId) continue            // 排除本会话自身记忆（8.2）
    if (injectedIds[c.id]) continue                            // 本会话已注入
    var normUser = meta.normUser
    if (seen[normUser]) continue                               // 同一问题只留最新（已按时间排序）
    seen[normUser] = true

    var cov = coverage(prep.tokens, c.userText + ' ' + (c.aiHead || ''))
    if (cov < CONFIG.COVERAGE_MIN) continue

    var score = c.score * (meta.injected ? CONFIG.ECHO_PENALTY : 1)   // 回声降权
    scored.push({ id: c.id, score: score, coverage: cov, userText: c.userText })
  }

  if (!scored.length) return null

  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score
    return b.coverage - a.coverage
  })
  var top1 = scored[0].score
  var kept = []
  for (var k = 0; k < scored.length && kept.length < CONFIG.TOP_K; k++) {
    if (scored[k].score < top1 * CONFIG.SCORE_RATIO_MIN) break
    kept.push(scored[k])
  }
  if (!kept.length) return null

  var items = []
  for (var m = 0; m < kept.length; m++) {
    var rec = deps.store.get(kept[m].id)
    if (!rec) continue
    items.push({ id: rec.id, userText: rec.userText, aiText: rec.aiText })
  }
  var built = buildMemoryBlock(items)
  if (!built) return null

  stats.inc('retrieve_hit')
  return { block: built.block, ids: built.ids }
}

export function withTimeout(promise, ms, onTimeout) {
  return new Promise(function (resolve, reject) {
    var done = false
    var timer = setTimeout(function () {
      if (done) return
      done = true
      if (onTimeout) { try { onTimeout() } catch (e) {} }
      resolve(null)
    }, ms)
    promise.then(function (v) {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(v)
    }, function (e) {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(e)
    })
  })
}
