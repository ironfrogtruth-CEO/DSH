// @local/dsh-stenographer — Host runtime for the privacy-bounded 速记员 panel.
// The client bundle owns presentation; this bundle owns the authenticated,
// persistent API, audio journals, model workers, final reconciliation and
// handoff snapshots.
import { API_BASE_PATH, MODEL_ROOT, STORAGE_ROOT } from './runtime/constants.js'
import { StenographerService } from './runtime/service.js'
import { FakeModelBackend, LocalModelBackend, ModelSupervisor, JsonLineWorker } from './runtime/model-supervisor.js'
import { IncrementalSpeakerCluster, cosineSimilarity, normalizeVector } from './runtime/speaker-cluster.js'

export const name = 'dsh-stenographer'
export const inject = ['webServer', 'credentials']

export { API_BASE_PATH, MODEL_ROOT, STORAGE_ROOT }
export { StenographerService }
export { FakeModelBackend, LocalModelBackend, ModelSupervisor, JsonLineWorker }
export { IncrementalSpeakerCluster, cosineSimilarity, normalizeVector }

export function createStenographerService(options = {}) {
  return new StenographerService(options)
}

export function apply(ctx, config = {}) {
  const service = new StenographerService({
    storageRoot: config.storageRoot || STORAGE_ROOT,
    modelRoot: config.modelRoot || MODEL_ROOT,
    supervisor: config.supervisor,
    backend: config.backend,
    now: config.now,
    port: config.port || ctx.webServer?.port || 3080,
    host: config.host || ctx.webServer?.host || '127.0.0.1',
    logger: config.logger || ctx.logger,
    fetchImpl: config.fetchImpl,
    writerApiUrl: config.writerApiUrl,
    apiKeyResolver: config.apiKeyResolver || (() => ctx.credentials?.resolve?.('ZHIPU_API_KEY')),
  })
  const register = () => ctx.webServer.register({
    kind: 'prefix',
    path: API_BASE_PATH,
    handler: (req, res) => service.handle(req, res),
  })
  const effect = () => {
    const dispose = register()
    // Route registration must not block web-server boot on a model load. The
    // first request awaits the same ready promise and reports failures via the
    // stable API envelope.
    service.ready().catch((error) => config.logger?.error?.(`stenographer init: ${error?.message || error}`))
    return () => {
      dispose?.()
      service.close().catch((error) => config.logger?.warn?.(`stenographer close: ${error?.message || error}`))
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(effect, 'dsh-stenographer: local stenographer API')
  else effect()
  return service
}

export default { name, inject, apply }
