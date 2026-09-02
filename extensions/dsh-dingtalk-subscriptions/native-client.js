// Importable companion for Node-side tests and native-adapter code.  The
// browser-loaded client.js below is intentionally a ModuleLoader bundle.

export const NATIVE_HANDLER_NAME = 'dingtalkSubscriptionAdmin'
export const NATIVE_RESULT_CALLBACK = '__dshDingTalkSubscriptionAdminResult'

function randomRequestId() {
  try { return globalThis.crypto?.randomUUID?.() || `req_${Date.now()}_${Math.random().toString(36).slice(2)}` } catch { return `req_${Date.now()}_${Math.random().toString(36).slice(2)}` }
}

export function nativeAdminHandler(windowRef = globalThis.window) {
  return windowRef?.webkit?.messageHandlers?.[NATIVE_HANDLER_NAME] || null
}

export function hasNativeAdminBridge(windowRef = globalThis.window) {
  return typeof nativeAdminHandler(windowRef)?.postMessage === 'function'
}

export const shouldRenderAdminPanel = hasNativeAdminBridge

export class NativeAdminBridgeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'NativeAdminBridgeError'
    this.code = code
  }
}

export function createNativeAdminClient(windowRef = globalThis.window, options = {}) {
  const pending = new Map()
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs || 20_000))
  const previous = windowRef?.[NATIVE_RESULT_CALLBACK]
  let disposed = false

  const handleResult = (message) => {
    let value = message?.detail && typeof message.detail === 'object' ? message.detail : message
    if (typeof value === 'string') {
      try { value = JSON.parse(value) } catch { return false }
    }
    const requestId = String(value?.requestId || '')
    if (!requestId) return false
    const item = pending.get(requestId)
    if (!item) return false
    pending.delete(requestId)
    clearTimeout(item.timer)
    if (value.ok === false) item.reject(new NativeAdminBridgeError(value.code || 'NATIVE_ADMIN_FAILED', value.error || '大神原生管理操作失败'))
    else item.resolve(value.data === undefined ? value : value.data)
    return true
  }

  if (windowRef) windowRef[NATIVE_RESULT_CALLBACK] = handleResult

  const request = (action, payload = {}) => {
    if (disposed) return Promise.reject(new NativeAdminBridgeError('NATIVE_BRIDGE_DISPOSED', '原生管理桥已关闭'))
    const handler = nativeAdminHandler(windowRef)
    if (typeof handler?.postMessage !== 'function') return Promise.reject(new NativeAdminBridgeError('NATIVE_BRIDGE_UNAVAILABLE', '当前环境不是大神.app原生管理面板'))
    const requestId = randomRequestId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new NativeAdminBridgeError('NATIVE_ADMIN_TIMEOUT', '原生管理操作超时')) }, timeoutMs)
      pending.set(requestId, { resolve, reject, timer })
      try { handler.postMessage({ requestId, action: String(action || ''), payload: payload && typeof payload === 'object' ? payload : {} }) } catch (error) {
        clearTimeout(timer)
        pending.delete(requestId)
        reject(new NativeAdminBridgeError('NATIVE_ADMIN_POST_FAILED', String(error?.message || error)))
      }
    })
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new NativeAdminBridgeError('NATIVE_BRIDGE_DISPOSED', '原生管理桥已关闭')) }
    pending.clear()
    if (windowRef && windowRef[NATIVE_RESULT_CALLBACK] === handleResult) {
      if (typeof previous === 'function') windowRef[NATIVE_RESULT_CALLBACK] = previous
      else delete windowRef[NATIVE_RESULT_CALLBACK]
    }
  }

  return Object.freeze({ request, handleResult, dispose, isAvailable: () => hasNativeAdminBridge(windowRef) })
}
