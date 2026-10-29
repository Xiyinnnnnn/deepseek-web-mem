// 记忆存储层（第六章）。异步接口，默认 localStorage 实现，可切 IndexedDB（6.4）。
// 布局：一条记忆一个 key，避免每轮重写整个数组。
import { CONFIG } from './02-config.js'
import { stats } from './01-stats.js'

export function makeLocalBackend() {
  return {
    kind: 'localStorage',
    persistent: true,
    getItem: function (k) { return localStorage.getItem(k) },
    setItem: function (k, v) { localStorage.setItem(k, v) },
    removeItem: function (k) { localStorage.removeItem(k) },
    keys: function () {
      var out = []
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i)
        if (k) out.push(k)
      }
      return out
    }
  }
}

export function makeMemoryBackend() {
  var map = Object.create(null)
  return {
    kind: 'memory',
    persistent: false,
    getItem: function (k) { return k in map ? map[k] : null },
    setItem: function (k, v) { map[k] = String(v) },
    removeItem: function (k) { delete map[k] },
    keys: function () { return Object.keys(map) }
  }
}

function normText(t) {
  return String(t || '').replace(/\s+/g, '').toLowerCase()
}

function cutText(t, limit) {
  var s = String(t || '')
  if (s.length <= limit) return { text: s, truncated: false }
  return { text: s.slice(0, limit), truncated: true }
}

export function createStore(backend) {
  var be = backend
  var meta = { v: CONFIG.SCHEMA_VERSION, ids: [], chars: 0, savedAt: 0 }
  var ready = false
  var index = Object.create(null)      // id -> { id, sessionId, parentMessageId, normUser, timestamp }
  var totalChars = 0

  function isEntryKey(k) { return k.indexOf(CONFIG.KEY_PREFIX) === 0 }

  function readMeta() {
    try {
      var raw = JSON.parse(be.getItem(CONFIG.KEY_META) || 'null')
      if (raw && Array.isArray(raw.ids)) return raw
    } catch (e) { stats.inc('read_fail') }
    return null
  }

  // 扫描所有条目键，返回 [{key, rec}]，顺带发现孤儿/损坏
  function scanEntries() {
    var keys = []
    try { keys = be.keys() } catch (e) { stats.inc('read_fail'); return [] }
    var out = []
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i]
      if (!isEntryKey(k)) continue
      var rec = null
      try { rec = JSON.parse(be.getItem(k) || 'null') } catch (e) { stats.inc('read_fail') }
      if (!rec || !rec.id) { try { be.removeItem(k) } catch (e) {} ; continue }
      out.push({ key: k, rec: rec })
    }
    return out
  }

  // 目录与条目不一致时以条目为准重建（6.3）
  function rebuild() {
    var entries = scanEntries()
    entries.sort(function (a, b) { return (a.rec.timestamp || 0) - (b.rec.timestamp || 0) })
    index = Object.create(null)
    totalChars = 0
    var ids = []
    for (var i = 0; i < entries.length; i++) {
      var r = entries[i].rec
      ids.push(r.id)
      totalChars += (r.userText || '').length + (r.aiText || '').length
      index[r.id] = {
        id: r.id,
        sessionId: r.sessionId,
        parentMessageId: r.parentMessageId == null ? null : r.parentMessageId,
        normUser: normText(r.userText),
        timestamp: r.timestamp || 0,
        len: (r.userText || '').length + (r.aiText || '').length
      }
    }
    meta = { v: CONFIG.SCHEMA_VERSION, ids: ids, chars: totalChars, savedAt: Date.now() }
    writeMeta()
    return entries.length
  }

  function writeMeta() {
    try {
      be.setItem(CONFIG.KEY_META, JSON.stringify(meta))
      return true
    } catch (e) {
      stats.inc('save_fail')
      return false
    }
  }

  function init() {
    if (ready) return true
    var m = readMeta()
    if (m) {
      meta = { v: m.v || CONFIG.SCHEMA_VERSION, ids: Array.isArray(m.ids) ? m.ids : [], chars: m.chars || 0, savedAt: m.savedAt || 0 }
      // 轻量一致性检查：目录条数 vs 实际条目数
      var entries = scanEntries()
      if (entries.length !== meta.ids.length) { rebuild(); }
      else {
        index = Object.create(null)
        totalChars = 0
        for (var i = 0; i < entries.length; i++) {
          var r = entries[i].rec
          totalChars += (r.userText || '').length + (r.aiText || '').length
          index[r.id] = {
            id: r.id, sessionId: r.sessionId,
            parentMessageId: r.parentMessageId == null ? null : r.parentMessageId,
            normUser: normText(r.userText), timestamp: r.timestamp || 0,
            len: (r.userText || '').length + (r.aiText || '').length
          }
        }
        if (entries.length === 0) { index = Object.create(null); totalChars = 0 }
      }
    } else {
      rebuild()
    }
    ready = true
    return true
  }

  function newId() {
    return 'mem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
  }

  function findExisting(sessionId, parentMessageId, userText) {
    var target
    if (parentMessageId != null) {
      target = { sessionId: sessionId, parent: parentMessageId }
    } else {
      target = { sessionId: sessionId, norm: normText(userText) }
    }
    var ids = meta.ids
    for (var i = ids.length - 1; i >= 0; i--) {
      var m = index[ids[i]]
      if (!m) continue
      if (target.parent !== undefined) {
        if (m.sessionId === sessionId && m.parentMessageId === target.parent) return m
      } else {
        if (m.sessionId === sessionId && m.normUser === target.norm) return m
      }
    }
    return null
  }

  function evictOldest(count) {
    var removed = []
    var ids = meta.ids.slice()
    for (var i = 0; i < ids.length && removed.length < count; i++) {
      var id = ids[i]
      try {
        be.removeItem(CONFIG.KEY_PREFIX + id)
        var m = index[id]
        if (m && m.len) totalChars -= m.len
        delete index[id]
        removed.push(id)
      } catch (e) {}
    }
    if (removed.length) {
      var keep = []
      for (var j = 0; j < meta.ids.length; j++) if (removed.indexOf(meta.ids[j]) === -1) keep.push(meta.ids[j])
      meta.ids = keep
      meta.chars = totalChars
      writeMeta()
    }
    return removed
  }

  function evictUntilFit(extraChars) {
    var removed = []
    while (meta.ids.length && (meta.ids.length + 1 > CONFIG.MAX_ENTRIES || totalChars + extraChars > CONFIG.MAX_TOTAL_CHARS)) {
      var batch = Math.max(1, Math.ceil(meta.ids.length * CONFIG.EVICT_RATIO))
      var r = evictOldest(Math.min(batch, meta.ids.length))
      if (!r.length) break
      removed = removed.concat(r)
      if (meta.ids.length === 0) break
    }
    return removed
  }

  // 返回 { ok, id, evicted[], reason }
  function put(record) {
    if (!ready && !init()) return { ok: false, reason: 'not_ready' }
    if (!record || !record.sessionId) return { ok: false, reason: 'no_session' }

    var u = cutText(record.userText, CONFIG.MAX_USER_TEXT_CHARS)
    var a = cutText(record.aiText, CONFIG.MAX_AI_TEXT_CHARS)
    // 实测修正：原实现要求 aiText 非空才落库，而响应侧协议未确认时正文永远提取不到，
    // 结果是一条记忆都存不下来（count 恒为 0）。记忆的检索价值主要来自 userText，
    // 所以这里只要求 userText 非空，aiText 允许暂空，由 putAi 稍后补写。
    if (!u.text) return { ok: false, reason: 'empty' }

    // 每次写入前重新读目录的最新版本（6.5 多标签页）
    var fresh = readMeta()
    if (fresh && Array.isArray(fresh.ids) && fresh.ids.length !== meta.ids.length) init()

    var existing = findExisting(record.sessionId, record.parentMessageId, u.text)
    var rec = {
      id: existing ? existing.id : newId(),
      sessionId: String(record.sessionId),
      parentMessageId: record.parentMessageId == null ? null : record.parentMessageId,
      userText: u.text,
      aiText: a.text,
      timestamp: Date.now(),
      injected: !!record.injected,
      injectedIds: Array.isArray(record.injectedIds) ? record.injectedIds.slice(0, CONFIG.TOP_K) : [],
      truncated: u.truncated || a.truncated,
      schemaVersion: CONFIG.SCHEMA_VERSION
    }

    var delta = rec.userText.length + rec.aiText.length
    var evicted = evictUntilFit(delta)

    function attempt() {
      be.setItem(CONFIG.KEY_PREFIX + rec.id, JSON.stringify(rec))
    }

    var oldRaw = null
    if (existing) { try { oldRaw = be.getItem(CONFIG.KEY_PREFIX + rec.id) } catch (e) {} }

    try {
      attempt()
    } catch (e) {
      var name = (e && e.name) || ''
      stats.inc('save_fail')
      if (/quota/i.test(name) || /quota/i.test(String(e && e.message))) {
        stats.inc('save_quota_fail')
        var drop = Math.max(1, Math.ceil(meta.ids.length * CONFIG.EVICT_RATIO))
        evicted = evicted.concat(evictOldest(drop))
        try {
          attempt()
        } catch (e2) {
          // 仍失败：放弃本条，总预算下调一半，不破坏已有记录
          CONFIG.MAX_TOTAL_CHARS = Math.floor(CONFIG.MAX_TOTAL_CHARS / 2)
          return { ok: false, reason: 'quota', evicted: evicted }
        }
      } else {
        return { ok: false, reason: 'write_error', evicted: evicted }
      }
    }

    // 记目录
    if (!existing) {
      if (meta.ids.indexOf(rec.id) === -1) meta.ids.push(rec.id)
      totalChars += delta
    } else if (oldRaw) {
      try {
        var old = JSON.parse(oldRaw)
        totalChars += delta - ((old.userText || '').length + (old.aiText || '').length)
      } catch (e) { totalChars += delta }
    } else {
      meta.ids.push(rec.id)
      totalChars += delta
    }

    meta.chars = totalChars
    meta.savedAt = Date.now()
    if (!writeMeta()) {
      // 目录写失败 → 删除刚写的条目，回滚（6.3 第 3 步）
      try { be.removeItem(CONFIG.KEY_PREFIX + rec.id) } catch (e) {}
      var pos = meta.ids.indexOf(rec.id)
      if (pos !== -1) meta.ids.splice(pos, 1)
      totalChars -= delta
      return { ok: false, reason: 'meta_write', evicted: evicted }
    }

    index[rec.id] = {
      id: rec.id, sessionId: rec.sessionId, parentMessageId: rec.parentMessageId,
      normUser: normText(rec.userText), timestamp: rec.timestamp, len: delta
    }
    stats.inc('saved')
    stats.set('lastSavedAt', rec.timestamp)
    stats.save()
    return { ok: true, id: rec.id, replaced: !!existing, evicted: evicted }
  }

  // 响应正文后到：补写已落库记录的 aiText（写入失败不影响 userText 记忆）
  function putAi(id, aiText) {
    var rec = get(id)
    if (!rec) return { ok: false, reason: 'missing' }
    var a = cutText(aiText, CONFIG.MAX_AI_TEXT_CHARS)
    if (!a.text) return { ok: false, reason: 'empty' }
    var oldLen = String(rec.aiText || '').length
    rec.aiText = a.text
    rec.truncated = !!(rec.truncated || a.truncated)
    var delta = rec.aiText.length - oldLen
    try {
      be.setItem(CONFIG.KEY_PREFIX + id, JSON.stringify(rec))
    } catch (e) {
      stats.inc('save_fail')
      return { ok: false, reason: 'write_error' }
    }
    totalChars += delta
    meta.chars = totalChars
    writeMeta()
    var m = index[id]
    if (m) m.len = String(rec.userText || '').length + rec.aiText.length
    stats.inc('ai_filled')
    return { ok: true, id: id, rec: rec }
  }

  function get(id) {
    try {
      var raw = be.getItem(CONFIG.KEY_PREFIX + id)
      return raw ? JSON.parse(raw) : null
    } catch (e) { stats.inc('read_fail'); return null }
  }

  function all() {
    var out = []
    for (var i = 0; i < meta.ids.length; i++) {
      var r = get(meta.ids[i])
      if (r) out.push(r)
    }
    out.sort(function (a, b) { return (a.timestamp || 0) - (b.timestamp || 0) })
    return out
  }

  function remove(id) {
    try { be.removeItem(CONFIG.KEY_PREFIX + id) } catch (e) {}
    var pos = meta.ids.indexOf(id)
    if (pos !== -1) meta.ids.splice(pos, 1)
    var m = index[id]
    delete index[id]
    meta.chars = totalChars
    writeMeta()
    return !!m || pos !== -1
  }

  function clearAll() {
    var ids = meta.ids.slice()
    for (var i = 0; i < ids.length; i++) {
      try { be.removeItem(CONFIG.KEY_PREFIX + ids[i]) } catch (e) {}
    }
    meta = { v: CONFIG.SCHEMA_VERSION, ids: [], chars: 0, savedAt: Date.now() }
    index = Object.create(null)
    totalChars = 0
    writeMeta()
    stats.inc('mem_cleared')
    return ids.length
  }

  return {
    init: init,
    kind: function () { return be.kind },
    persistent: function () { return be.persistent },
    put: put,
    putAi: putAi,
    get: get,
    all: all,
    remove: remove,
    clearAll: clearAll,
    ids: function () { return meta.ids.slice() },
    count: function () { return meta.ids.length },
    chars: function () { return totalChars },
    metaOf: function (id) { return index[id] || null },
    rebuild: rebuild
  }
}
