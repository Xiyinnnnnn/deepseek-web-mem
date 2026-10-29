// 自实现中文 tokenizer：照 @orama/tokenizers 3.1.18 的契约，但 segmenter 惰性创建 + 二元组降级
// 关键：模块顶层绝不触碰 Intl.Segmenter（官方 mandarin.js 在这里直接 new，无 Segmenter 环境会炸整个 bundle）
import { normalizeToken } from '@orama/orama/internals'

var STOP = ('的 了 是 在 我 你 他 她 它 我们 你们 他们 这 那 这个 那个 一个 什么 怎么 如何 可以 吗 呢 吧 啊 就 都 也 还 和 与 或 但 而 及 对 从 到 把 被 让 给 为 以 于 之 其 或 有 没有 不 很 太 更 最 会 能 要 想 说 看 做 用 去 来 上 下 里 中 后 前 时 时候 因为 所以 如果 虽然 但是 已经 现在 这样 那样 一些 这些 那些 怎么 为什么 哪 哪个 多少 几 等 吧 呀 哦 嗯').split(' ')
var stopSet = Object.create(null)
for (var i = 0; i < STOP.length; i++) stopSet[STOP[i]] = true

var segmenter = null
var segmenterTried = false
export var tokenizerFallback = false

function getSegmenter() {
  if (segmenterTried) return segmenter
  segmenterTried = true
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
    }
  } catch (e) { segmenter = null }
  return segmenter
}

// 降级分词：先按文字类型拆段，中文段字符二元组，英文数字段整词（修复 V2 的 py/yt/th 问题）
export function tokenizeFallback(text) {
  var runs = String(text || '').toLowerCase().match(/[\u4e00-\u9fff]+|[a-z0-9]+/g) || []
  var tokens = []
  for (var i = 0; i < runs.length; i++) {
    var run = runs[i]
    if (/^[a-z0-9]+$/.test(run) || run.length === 1) { tokens.push(run); continue }
    for (var j = 0; j < run.length - 1; j++) tokens.push(run.slice(j, j + 2))
  }
  return tokens
}

export function tokenize(raw) {
  var text = String(raw || '').toLowerCase()
  var tokens = []
  var seg = getSegmenter()
  if (seg) {
    var it = seg.segment(text)
    for (var s of it) if (s.isWordLike) tokens.push(s.segment)
  } else {
    tokenizerFallback = true
    tokens = tokenizeFallback(text)
  }
  var out = []
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i]
    if (!t || stopSet[t]) continue
    out.push(t)
  }
  return out
}

function tokenizeInternal(input, language, prop) {
  if (typeof input !== 'string') return [input]
  var tokens
  if (prop && this && this.tokenizeSkipProperties && this.tokenizeSkipProperties.has(prop)) {
    tokens = [normalizeToken(prop)]
  } else {
    tokens = tokenize(input)
  }
  // 官方 trim 逻辑：去掉首尾空串 token
  while (tokens.length && tokens[tokens.length - 1] === '') tokens.pop()
  while (tokens.length && tokens[0] === '') tokens.shift()
  if (!this || !this.allowDuplicates) return Array.from(new Set(tokens))
  return tokens
}

export function createTokenizer(config) {
  config = config || {}
  var tk = {
    language: 'custom-zh',
    tokenize: tokenizeInternal,
    stemmerSkipProperties: new Set(config.stemmerSkipProperties ? [config.stemmerSkipProperties].flat() : []),
    tokenizeSkipProperties: new Set(config.tokenizeSkipProperties ? [config.tokenizeSkipProperties].flat() : []),
    stopWords: config.stopWords,
    allowDuplicates: Boolean(config.allowDuplicates),
    normalizeToken: normalizeToken,
    normalizationCache: new Map()
  }
  tk.tokenize = tokenizeInternal.bind(tk)
  return tk
}

// ---- 7.3 启动自检：不能仅以 Intl.Segmenter 存在作为成功标准 ----
export function selfTest() {
  var probes = ['Python写爬虫怎么绕过反爬', '本地检索系统']
  for (var i = 0; i < probes.length; i++) {
    var t = tokenize(probes[i])
    if (!t.length) return false
  }
  // 词级模式额外要求：英文不被拆成字母二元组
  if (!tokenizerFallback) {
    var t2 = tokenize('python 爬虫')
    if (t2.indexOf('python') === -1) return false
  }
  return true
}

export function mode() {
  return tokenizerFallback ? 'bigram-fallback' : 'word-segmenter'
}
