import {
  SPEAKER_INCREMENTAL_THRESHOLD,
  SPEAKER_RECLUSTER_EMBEDDINGS,
  SPEAKER_UNCERTAIN_THRESHOLD,
} from './constants.js'

export function normalizeVector(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null
  const values = vector.map(Number)
  if (values.some((value) => !Number.isFinite(value))) return null
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
  if (!Number.isFinite(norm) || norm <= Number.EPSILON) return null
  return values.map((value) => value / norm)
}

export function cosineSimilarity(a, b) {
  const left = normalizeVector(a)
  const right = normalizeVector(b)
  if (!left || !right || left.length !== right.length) return null
  return left.reduce((sum, value, index) => sum + value * right[index], 0)
}

function speakerId(number) {
  return `speaker-${number}`
}

/**
 * Stable, persisted speaker assignment for live chunks. It intentionally does
 * not keep a bounded history: every embedding is persisted by the Host and the
 * centers remain available for long meetings and restart recovery.
 */
export class IncrementalSpeakerCluster {
  constructor({
    threshold = SPEAKER_INCREMENTAL_THRESHOLD,
    uncertainThreshold = SPEAKER_UNCERTAIN_THRESHOLD,
    maxSpeakers = 64,
    centers = [],
    nextNumber = 1,
  } = {}) {
    this.threshold = threshold
    this.uncertainThreshold = uncertainThreshold
    this.maxSpeakers = maxSpeakers
    this.centers = new Map()
    this.counts = new Map()
    this.nextNumber = nextNumber
    for (const entry of centers || []) {
      const id = typeof entry === 'string' ? entry : entry?.id
      const vector = normalizeVector(typeof entry === 'string' ? null : entry?.vector)
      if (!id || !vector) continue
      this.centers.set(id, vector)
      this.counts.set(id, Number(entry.count) > 0 ? Number(entry.count) : 1)
      const match = /^speaker-(\d+)$/.exec(id)
      if (match) this.nextNumber = Math.max(this.nextNumber, Number(match[1]) + 1)
    }
  }

  assign(vector, { source = 'system', forceSpeakerId = null } = {}) {
    if (forceSpeakerId) {
      const normalized = normalizeVector(vector)
      if (normalized) this.#updateCenter(forceSpeakerId, normalized)
      return {
        speakerId: forceSpeakerId,
        lineage: forceSpeakerId,
        similarity: 1,
        confidence: 1,
        uncertain: false,
      }
    }
    const normalized = normalizeVector(vector)
    if (!normalized) {
      return {
        speakerId: 'speaker-uncertain',
        lineage: 'speaker-uncertain',
        similarity: 0,
        confidence: 0,
        uncertain: true,
      }
    }
    let bestId = null
    let bestSimilarity = -1
    for (const [id, center] of this.centers) {
      const similarity = cosineSimilarity(normalized, center)
      if (similarity !== null && similarity > bestSimilarity) {
        bestId = id
        bestSimilarity = similarity
      }
    }
    if (!bestId || bestSimilarity < this.threshold) {
      if (this.centers.size >= this.maxSpeakers) {
        return {
          speakerId: 'speaker-uncertain',
          lineage: 'speaker-uncertain',
          similarity: Math.max(0, bestSimilarity),
          confidence: Math.max(0, bestSimilarity),
          uncertain: true,
        }
      }
      bestId = speakerId(this.nextNumber++)
      this.centers.set(bestId, normalized)
      this.counts.set(bestId, 1)
      return {
        speakerId: bestId,
        lineage: bestId,
        similarity: 1,
        confidence: 1,
        uncertain: false,
      }
    }
    this.#updateCenter(bestId, normalized)
    const uncertain = bestSimilarity < this.uncertainThreshold
    return {
      speakerId: uncertain ? 'speaker-uncertain' : bestId,
      lineage: uncertain ? bestId : bestId,
      similarity: bestSimilarity,
      confidence: Math.max(0, Math.min(1, bestSimilarity)),
      uncertain,
    }
  }

  #updateCenter(id, vector) {
    const old = this.centers.get(id)
    if (!old) {
      this.centers.set(id, vector)
      this.counts.set(id, 1)
      return
    }
    const count = this.counts.get(id) || 1
    const weight = 1 / Math.min(count + 1, 20)
    const merged = old.map((value, index) => (1 - weight) * value + weight * vector[index])
    const normalized = normalizeVector(merged)
    if (normalized) this.centers.set(id, normalized)
    this.counts.set(id, count + 1)
  }

  addPersistedSpeaker(id, vector, count = 1) {
    const normalized = normalizeVector(vector)
    if (!normalized || typeof id !== 'string') return false
    this.centers.set(id, normalized)
    this.counts.set(id, Math.max(1, Number(count) || 1))
    const match = /^speaker-(\d+)$/.exec(id)
    if (match) this.nextNumber = Math.max(this.nextNumber, Number(match[1]) + 1)
    return true
  }

  stableCenters() {
    return [...this.centers.entries()].map(([id, vector]) => ({
      id,
      vector: [...vector],
      count: this.counts.get(id) || 1,
    }))
  }

  speakerSummary(speakerNames = {}) {
    return this.stableCenters().map(({ id, count }) => ({
      id,
      lineage: id,
      name: speakerNames[id] || id === 'speaker-local' ? (speakerNames[id] || '我') : (speakerNames[id] || id.replace('speaker-', '说话人 ')),
      count,
    }))
  }

  /**
   * Map labels emitted by FunASR ClusterBackend back onto stable IDs. The
   * caller supplies cluster centers when available; labels are never exposed
   * directly because reclustering must not change a user's renamed speaker.
   */
  reconcile(clusterRecords, labels, clusterCenters = []) {
    const records = Array.isArray(clusterRecords) ? clusterRecords : []
    const output = []
    const mapped = new Map()
    for (let i = 0; i < records.length; i += 1) {
      const label = String(labels?.[i] ?? '0')
      const center = normalizeVector(clusterCenters?.[Number(label)]) || normalizeVector(records[i]?.vector)
      let id = mapped.get(label)
      if (!id && center) {
        let best = null
        let bestSimilarity = -1
        for (const [candidate, existing] of this.centers) {
          const similarity = cosineSimilarity(center, existing)
          if (similarity !== null && similarity > bestSimilarity) {
            best = candidate
            bestSimilarity = similarity
          }
        }
        if (best && bestSimilarity >= this.threshold) id = best
      }
      if (!id) {
        id = speakerId(this.nextNumber++)
        if (this.centers.size < this.maxSpeakers && center) this.addPersistedSpeaker(id, center)
      }
      mapped.set(label, id)
      output.push({
        ...records[i],
        speakerId: id,
        lineage: id,
        uncertain: !center,
        confidence: center ? 1 : 0,
      })
    }
    return output
  }

  shouldRecluster(embeddingCount) {
    return embeddingCount >= SPEAKER_RECLUSTER_EMBEDDINGS
      && embeddingCount % SPEAKER_RECLUSTER_EMBEDDINGS === 0
  }
}
