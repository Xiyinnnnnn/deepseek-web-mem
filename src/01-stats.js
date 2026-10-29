// 诊断计数器：只存数字与时间戳，绝不落任何对话内容（13.1 / 13.4）
import { CONFIG } from './02-config.js'

var KEYS = [
  'saved', 'skip_parse', 'skip_no_session', 'skip_other_endpoint', 'skip_unsupported_form',
  'retrieve_hit', 'retrieve_none', 'retrieve_timeout', 'retrieve_error',
  'inject_ok', 'inject_rejected', 'breaker_tripped',
  'tokenizer_fallback', 'tokenizer_failed', 'index_failed',
  'save_fail', 'save_quota_fail', 'read_fail',
  'parse_fail_run', 'extract_fail_run', 'mem_cleared',
  'ai_filled', 'xhr_hit', 'xhr_inject_ok', 'saved_pending', 'tap_saved', 'xhr_aborted_before_send', 'rollback',
  'cmd_local', 'cmd_blocked_xhr', 'cmd_blocked_fetch', 'off_pass'
]

export var stats = (function () {
  var data = { v: 1, lastSavedAt: 0, tokenizerMode: '' }
  for (var i = 0; i < KEYS.length; i++) data[KEYS[i]] = 0

  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(CONFIG.KEY_STATS) || 'null')
      if (raw && typeof raw === 'object') {
        for (var k in data) if (typeof raw[k] === typeof data[k]) data[k] = raw[k]
      }
    } catch (e) { /* 统计失败绝不冒泡 */ }
    return data
  }
  function save() {
    try { localStorage.setItem(CONFIG.KEY_STATS, JSON.stringify(data)) } catch (e) {}
  }
  return {
    load: load,
    save: save,
    inc: function (k, n) { if (typeof data[k] === 'number') data[k] += n === undefined ? 1 : n; },
    set: function (k, v) { data[k] = v },
    get: function (k) { return data[k] },
    snapshot: function () {
      var o = {}
      for (var k in data) o[k] = data[k]
      return o
    },
    resetRun: function () { data.parse_fail_run = 0; data.extract_fail_run = 0 }
  }
})()
