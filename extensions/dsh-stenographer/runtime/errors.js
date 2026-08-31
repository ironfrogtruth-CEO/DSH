export class StenographerError extends Error {
  constructor(code, message, { status = 400, details = undefined, cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'StenographerError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export function stableError(error, fallback = '速记员服务暂时不可用') {
  if (error instanceof StenographerError) return error
  const message = String(error?.message || error || fallback).slice(0, 500)
  return new StenographerError('INTERNAL_ERROR', message, { status: 500, cause: error })
}

export function errorBody(error) {
  const normalized = stableError(error)
  const payload = {
    code: normalized.code,
    message: String(normalized.message || '速记员请求失败').slice(0, 500),
  }
  if (normalized.details !== undefined) payload.details = normalized.details
  return { ok: false, error: payload }
}

export function invalid(code, message, details) {
  return new StenographerError(code, message, { status: 400, details })
}

export function unauthorized(code, message = '速记员上传凭证无效') {
  return new StenographerError(code, message, { status: 401 })
}

export function notFound(code, message) {
  return new StenographerError(code, message, { status: 404 })
}

export function conflict(code, message, details) {
  return new StenographerError(code, message, { status: 409, details })
}

export function tooLarge(code, message, details) {
  return new StenographerError(code, message, { status: 413, details })
}

export function unavailable(code, message, details) {
  return new StenographerError(code, message, { status: 503, details })
}
