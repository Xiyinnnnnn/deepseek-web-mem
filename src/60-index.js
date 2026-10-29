// Orama 检索层（第七章）。索引是派生数据，可随时丢弃重建。
import { create, insert, remove, search } from '@orama/orama'
import { CONFIG } from './02-config.js'
import { stats } from './01-stats.js'
import { createTokenizer, selfTest, mode } from './10-tokenizer.js'

export var INDEX_STATE = { IDLE: 'idle', BUILDING: 'building', READY: 'ready', FAILED: 'failed', STALE: 'stale' }

export function createIndexLayer(store) {
  var db = null
  var state = INDEX_STATE.IDLE
  var building = false
  var inflight = null
  var docIds = Object.create(null)   // 已进索引的记忆 id

  function buildDb() {
    return create({
      schema: { userText: 'string', aiHead: 'string', timestamp: 'number' },
      components: { tokenizer: createTokenizer() }
    })
  }

  function aiHeadOf(text) {
    return String(text || '').slice(0, CONFIG.AI_INDEX_CHARS)
  }

  function insertDoc(rec) {
    if (!db || !rec) return false
    try {
      insert(db, {
        id: rec.id,
        userText: rec.userText,
        aiHead: aiHeadOf(rec.aiText),
        timestamp: rec.timestamp || 0
      })
      docIds[rec.id] = true
      return true
    } catch (e) {
      try { stats.set('lastIndexError', String((e && e.name) || e).slice(0, 60)) } catch (e2) {}
      return false
    }
  }

  function removeDoc(id) {
    if (!db || !docIds[id]) return
    try { remove(db, id) } catch (e) {}
    delete docIds[id]
  }

  // 分片建库：每片让出主线程，避免页面加载期长时间占用（7.6）
  function build() {
    if (building) return inflight
    building = true
    state = INDEX_STATE.BUILDING
    docIds = Object.create(null)

    inflight = new Promise(function (resolve) {
      var ok = false
      try {
        if (!selfTest()) {
          stats.inc('tokenizer_failed')
          state = INDEX_STATE.FAILED
          stats.inc('index_failed')
          building = false
          resolve(false)
          return
        }
        if (mode() === 'bigram-fallback') stats.inc('tokenizer_fallback')
        stats.set('tokenizerMode', mode())
        db = buildDb()
        ok = true
      } catch (e) {
        ok = false
      }
      if (!ok || !db) {
        state = INDEX_STATE.FAILED
        stats.inc('index_failed')
        building = false
        resolve(false)
        return
      }

      var all = store.all()
      var pos = 0
      var failedOnce = false

      function step() {
        var end = Math.min(pos + CONFIG.INDEX_CHUNK_SIZE, all.length)
        for (; pos < end; pos++) {
          if (!insertDoc(all[pos])) failedOnce = true
        }
        if (pos < all.length) {
          setTimeout(step, 0)
          return
        }
        state = failedOnce ? INDEX_STATE.STALE : INDEX_STATE.READY
        building = false
        resolve(state === INDEX_STATE.READY)
      }
      if (!all.length) {
        state = INDEX_STATE.READY
        building = false
        resolve(true)
        return
      }
      setTimeout(step, 0)
    })
    return inflight
  }

  var rebuildTimer = null
  function markStale() {
    if (state === INDEX_STATE.READY) state = INDEX_STATE.STALE
    if (rebuildTimer || state !== INDEX_STATE.STALE) return
    rebuildTimer = setTimeout(function () {
      rebuildTimer = null
      if (state === INDEX_STATE.STALE && !building) build()
    }, CONFIG.INDEX_REBUILD_DELAY_MS)
  }

  function isReady() { return state === INDEX_STATE.READY && !!db }

  // 增量：新记忆落库后插入；索引未就绪则保持未就绪（下次重建覆盖）
  function addRecord(rec) {
    if (!isReady()) return false
    // 覆盖写入（重新生成同一条）时先删后插，否则 Orama 会因重复 id 抛错
    if (docIds[rec.id]) removeDoc(rec.id)
    var ok = insertDoc(rec)
    if (!ok) markStale()
    return ok
  }

  function dropRecord(id) {
    if (!isReady()) return
    removeDoc(id)
  }

  async function query(term, opts) {
    if (!isReady()) return []
    opts = opts || {}
    var res = await search(db, {
      term: term,
      properties: ['userText', 'aiHead'],
      boost: { userText: 2, aiHead: 1 },
      threshold: CONFIG.ORAMA_THRESHOLD,
      limit: opts.limit || CONFIG.CANDIDATE_LIMIT
    })
    var out = []
    for (var i = 0; i < res.hits.length; i++) {
      var h = res.hits[i]
      out.push({
        id: h.document.id,
        score: h.score,
        userText: h.document.userText,
        aiHead: h.document.aiHead,
        timestamp: h.document.timestamp
      })
    }
    return out
  }

  return {
    build: build,
    isReady: isReady,
    state: function () { return state },
    addRecord: addRecord,
    dropRecord: dropRecord,
    markStale: markStale,
    query: query,
    rebuild: function () { state = INDEX_STATE.STALE; return build() }
  }
}
