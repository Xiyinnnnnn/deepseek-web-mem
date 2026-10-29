// 用真机报文验证状态机：正文与 THINK/TOOL_SEARCH 必须分开
import { createMachine, STATUS } from '../src/50-machine.js'
import { createSseParser } from '../src/40-sse.js'

var PASS = 0, FAIL = 0
function ck(id, name, cond, extra) {
  if (cond) { PASS++; console.log('  PASS ' + id + ' ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { FAIL++; console.log('  FAIL ' + id + ' ' + name + (extra ? '  [' + extra + ']' : '')) }
}

// 真机报文（2026-10-29 抓取，按原样保留结构，正文片段追加在末尾模拟）
var RAW = [
  'event: ready',
  'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
  'event: update_session',
  'data: {"updated_at":1793248845.832685}',
  'data: {"v":{"response":{"message_id":2,"parent_id":1,"role":"ASSISTANT","status":"WIP","fragments":[{"id":2,"type":"THINK","content":"用户","references":[]}]}}}',
  'data: {"p":"response/conversation_mode","v":"DEEP_SEARCH"}',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"想知道"}',
  'data: {"v":"如何"}',
  'data: {"v":"安装"}',
  'data: {"v":"Python"}',
  'data: {"v":"。"}',
  'data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":0.729002801}',
  'data: {"p":"response/has_pending_fragment","v":true}',
  'data: {"p":"response","o":"BATCH","v":[{"p":"fragments","o":"APPEND","v":[{"id":3,"type":"TOOL_SEARCH","status":"WIP","content":null,"queries":[{"query":"Python 安装步骤"}]}]},{"p":"has_pending_fragment","o":"SET","v":false}]}',
  'data: {"p":"response/fragments/-1/results","o":"SET","v":[{"url":"http://x","title":"t"}]}',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"搜索结果标题"}',
  'data: {"p":"response","o":"BATCH","v":[{"p":"fragments","o":"APPEND","v":[{"id":4,"type":"RESPONSE","status":"WIP","content":"先下载安装包，"}]}]}',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"然后运行安装程序。"}',
  'data: {"v":"记得勾选 PATH。"}',
  'data: {"p":"response/fragments/-1/status","o":"SET","v":"FINISHED"}',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  ''
].join('\n')

function run(raw) {
  var m = createMachine()
  var p = createSseParser(function (ev) { m.feed(ev) })
  p.push(raw)
  p.end()
  return m.result()
}

console.log('[T50] 真机报文解析')
var r = run(RAW)

ck('T50a', '正文只取 RESPONSE 片段',
   r.text === '先下载安装包，然后运行安装程序。记得勾选 PATH。', 'text=' + JSON.stringify(r.text))
ck('T50b', 'THINK 内容不进正文', r.text.indexOf('想知道') === -1 && r.text.indexOf('用户') === -1)
ck('T50c', 'TOOL_SEARCH 内容不进正文', r.text.indexOf('搜索结果标题') === -1)
ck('T50d', 'THINK 内容被单独收集', r.thinkLen === 16, 'thinkLen=' + r.thinkLen)
ck('T50e', 'TOOL 内容被单独收集', r.otherLen > 4, 'otherLen=' + r.otherLen)
ck('T50f', '识别到三种片段类型', r.types && r.types.THINK === 1 && r.types.TOOL_SEARCH === 1 && r.types.RESPONSE === 1,
   JSON.stringify(r.types))
ck('T50g', '完成状态已识别', r.status === STATUS.COMPLETED, 'status=' + r.status)
ck('T50h', 'messageId 取自快照', String(r.messageId) === '2', 'messageId=' + r.messageId)

console.log('\n[T51] 裸增量必须跟随当前片段')
var raw2 = [
  'data: {"v":{"response":{"status":"WIP","fragments":[{"id":1,"type":"THINK","content":""}]}}}',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"思考"}',
  'data: {"v":"继续思考"}',
  'data: {"p":"response","o":"BATCH","v":[{"p":"fragments","o":"APPEND","v":[{"id":2,"type":"RESPONSE","content":"正"}]}]}',
  'data: {"v":"文"}',
  ''
].join('\n')
var r2 = run(raw2)
ck('T51a', 'THINK 阶段的裸增量进 think', r2.text === '正文', 'text=' + JSON.stringify(r2.text))
ck('T51b', 'THINK 累积正确', r2.thinkLen >= 6, 'thinkLen=' + r2.thinkLen)

console.log('\n[T52] 无快照（-1 无对应片段）时按正文兜底')
var raw3 = 'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"裸正文"}\n\n'
var r3 = run(raw3)
ck('T52a', '不丢字', r3.text === '裸正文', 'text=' + JSON.stringify(r3.text))
ck('T52b', '状态为 INCOMPLETE 而非 COMPLETED', r3.status === STATUS.INCOMPLETE, 'status=' + r3.status)

console.log('\n[T53] 中断与失败')
var m4 = createMachine()
var p4 = createSseParser(function (ev) { m4.feed(ev) })
p4.push('data: {"v":{"response":{"fragments":[{"id":1,"type":"RESPONSE","content":"半截"}]}}}\n\n')
p4.end()
m4.markCancelled()
ck('T53a', '取消标记生效', m4.result().status === STATUS.CANCELLED, 'status=' + m4.result().status)
ck('T53b', '半截正文仍可取', m4.result().text === '半截')

console.log('\n================  ' + PASS + ' PASS / ' + FAIL + ' FAIL  ================')
if (FAIL) process.exit(1)
