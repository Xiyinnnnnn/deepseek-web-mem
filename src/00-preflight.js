// 能力检测（3.2）。任何一项失败只置不可用，绝不抛错中断脚本（3.4）
export var capabilities = {
  fetch: typeof fetch === 'function',
  promise: typeof Promise !== 'undefined',
  textDecoder: typeof TextDecoder !== 'undefined',
  segmenter: false,
  localStorage: false,
  indexedDB: false,
  clone: false
}

export function detect() {
  try {
    capabilities.segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  } catch (e) { capabilities.segmenter = false }

  try {
    capabilities.indexedDB = typeof indexedDB !== 'undefined'
  } catch (e) { capabilities.indexedDB = false }

  try {
    var k = '__ds_memory_test__'
    localStorage.setItem(k, '1')
    localStorage.removeItem(k)
    capabilities.localStorage = true
  } catch (e) { capabilities.localStorage = false }

  try {
    capabilities.clone = typeof Response !== 'undefined' &&
      typeof Response.prototype.clone === 'function'
  } catch (e) { capabilities.clone = false }

  return capabilities
}
