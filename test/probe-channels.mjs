// 验证抓包版三路挂钩真的装上：页面不用 fetch 时也能抓到
import { makeEnv, loadBundle } from './harness.mjs'

makeEnv({})

var openCalled = 0, sendCalled = 0
function XHR() { this._h = [] }
XHR.prototype.open = function (m, u) { openCalled++; this._m = m; this._u = u }
XHR.prototype.setRequestHeader = function (k, v) { this._h.push(k) }
XHR.prototype.send = function (b) { sendCalled++ }
globalThis.XMLHttpRequest = XHR

function ES(u) { this.u = u }
globalThis.EventSource = ES
function WS(u) { this.u = u }
globalThis.WebSocket = WS

globalThis.fetch = function () { return Promise.resolve(new Response('x')) }

loadBundle('dist/via-dsmem-probe.user.js')

console.log('XHR.open 已被包装 =', XHR.prototype.open !== Object.getPrototypeOf(new XHR()).open || String(XHR.prototype.open).indexOf('native') === -1)
console.log('EventSource 类型 =', typeof window.EventSource, '| 与原始不同 =', window.EventSource !== ES)
console.log('WebSocket 与原始不同 =', window.WebSocket !== WS)

var x = new XMLHttpRequest()
x.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion')
x.setRequestHeader('content-type', 'application/json')
x.setRequestHeader('x-ds-pow-response', 'SECRET-TOKEN-VALUE')
x.send('{"chat_session_id":"abc","prompt":"你好"}')

new window.EventSource('https://chat.deepseek.com/api/v0/sse?x=1')
new window.WebSocket('wss://chat.deepseek.com/ws')

var ch = globalThis.__dsMem.channels()
console.log('通道计数 =', JSON.stringify(ch))
console.log('原 XHR.send 仍被调用 =', sendCalled === 1)
var rep = globalThis.__dsMem.probe()
console.log('--- 报告 ---')
console.log(rep)
console.log('--- 敏感值是否泄漏 ---')
console.log('报告含 SECRET-TOKEN-VALUE =', rep.indexOf('SECRET-TOKEN-VALUE') !== -1)
console.log('报告含 你好 =', rep.indexOf('你好') !== -1)
