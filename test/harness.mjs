// 最小浏览器环境模拟：用于在 node 里验证打包产物（不替代真机验证）
import fs from 'node:fs'

export function makeEnv(opts) {
  opts = opts || {}
  var ls = opts.kv || Object.create(null)
  var localStorage = {
    getItem: function (k) { return k in ls ? ls[k] : null },
    setItem: function (k, v) { ls[k] = String(v) },
    removeItem: function (k) { delete ls[k] },
    key: function (i) { return Object.keys(ls)[i] || null },
    get length() { return Object.keys(ls).length }
  }

  var toasts = []
  var listeners = []
  var document = {
    addEventListener: function (type, fn, capture) {
      listeners.push({ type: type, fn: fn, capture: !!capture })
      ;(document.__byType[type] = document.__byType[type] || []).push(fn)
    },
    removeEventListener: function () {},
    __byType: Object.create(null),
    __listeners: listeners,
    activeElement: null,
    querySelectorAll: function () { return [] },
    createRange: function () {
      return { selectNodeContents: function () {}, collapse: function () {} }
    },
    body: { appendChild: function (el) { toasts.push(el.textContent) }, removeChild: function () {} },
    createElement: function () {
      return {
        style: { cssText: '' }, textContent: '', setAttribute: function () {},
        remove: function () {}, appendChild: function () {}
      }
    },
    querySelector: function () { return null }
  }

  // 开发者调试口默认不挂载（真机一致）；测试需要 __dsMem，所以这里显式打开
  globalThis.__DSMEM_DEV = true
  globalThis.window = globalThis
  globalThis.localStorage = localStorage
  globalThis.document = document
  globalThis.requestAnimationFrame = function (fn) { fn() }
  globalThis.location = { href: 'https://chat.deepseek.com/a/chat/s/xyz', hash: '' }
  globalThis.getSelection = function () { return { removeAllRanges: function () {}, addRange: function () {} } }

  if (opts.noSegmenter) {
    try { delete Intl.Segmenter } catch (e) {}
    if (typeof Intl.Segmenter === 'function') {
      Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true, writable: true })
    }
  }
  return { toasts: toasts, localStorage: localStorage, kv: ls }
}

export function loadBundle(path) {
  var code = fs.readFileSync(path, 'utf8')
  var fn = new Function(code)
  fn()
}

export function makeFakeFetch(handler) {
  var calls = []
  var f = function (input, init) {
    calls.push({ input: input, init: init })
    return Promise.resolve(handler(input, init, calls.length))
  }
  f.calls = calls
  return f
}
