// 上下文规模的粗糙估算（用户口径）：1 个中文字符 ≈ 0.6 token，1 个英文字符 ≈ 0.3 token。
// 只用于「这一轮之前上下文有多大了」的粗判，绝不参与检索打分，也不影响注入预算。
// 之所以不精确：网页端拿不到服务端 tokenizer，只能按字符量折算，误差靠阈值留余量吸收。
import { CONFIG } from './02-config.js'

// 中文字符判定：CJK 统一表意文字、假名、谚文、全角符号与中文标点全部 >= U+2E80
export function countByKind(text) {
  var s = String(text == null ? '' : text)
  var cjk = 0
  for (var i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x2E80) cjk++
  }
  return { cjk: cjk, other: s.length - cjk, total: s.length }
}

export function tokensOfCounts(c) {
  if (!c) return 0
  return (c.cjk || 0) * CONFIG.SUM_TOKEN_CJK + (c.other || 0) * CONFIG.SUM_TOKEN_OTHER
}

export function tokensOfText(text) {
  return tokensOfCounts(countByKind(text))
}
