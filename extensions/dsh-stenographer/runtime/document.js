import { randomUUID } from 'node:crypto'

import {
  AUDIO_SOURCES,
  MAX_DOCUMENT_BLOCKS,
  MAX_SPEAKER_NAME_CHARS,
  MAX_TEXT_CHARS,
} from './constants.js'
import { invalid } from './errors.js'

const BLOCK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T/

export function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

export function newBlockId(prefix = 't') {
  return `${prefix}-${randomUUID()}`
}

export function defaultDocument(now = new Date().toISOString()) {
  return {
    schema: 'stenographer_document.v1',
    revision: 0,
    updatedAt: now,
    blocks: [],
    speakerNames: {},
    speakerLineage: {},
  }
}

function assertObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('INVALID_DOCUMENT', message)
}

function textValue(value, label, max = MAX_TEXT_CHARS) {
  if (typeof value !== 'string' || value.length > max) throw invalid('INVALID_DOCUMENT', `${label}格式无效`)
  return value
}

function idValue(value, label = '块 ID') {
  if (typeof value !== 'string' || !BLOCK_ID_RE.test(value)) throw invalid('INVALID_DOCUMENT', `${label}格式无效`)
  return value
}

function dateValue(value, label) {
  if (typeof value !== 'string' || value.length > 80 || !ISO_DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw invalid('INVALID_DOCUMENT', `${label}格式无效`)
  }
  return value
}

function boundedInt(value, label, { min = 0, max = 86_400_000 } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid('INVALID_DOCUMENT', `${label}格式无效`)
  return value
}

function confidenceValue(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw invalid('INVALID_DOCUMENT', '置信度格式无效')
  return value
}

function normalizeTranscript(block) {
  const id = idValue(block.id)
  const speakerId = block.speakerId === null || block.speakerId === undefined
    ? null
    : idValue(block.speakerId, '说话人 ID')
  const lineage = block.lineage === null || block.lineage === undefined
    ? (speakerId || null)
    : idValue(block.lineage, '说话人 lineage')
  const rawText = textValue(block.rawText ?? '', '原始文本')
  const text = textValue(block.text ?? rawText, '文本')
  const source = block.source === undefined ? 'system' : block.source
  if (!AUDIO_SOURCES.includes(source)) throw invalid('INVALID_DOCUMENT', '转写来源无效')
  const userEdited = Boolean(block.userEdited) || text !== rawText
  const out = {
    ...block,
    type: 'transcript',
    id,
    speakerId,
    startMs: boundedInt(block.startMs ?? 0, '开始时间'),
    endMs: boundedInt(block.endMs ?? block.startMs ?? 0, '结束时间'),
    rawText,
    text,
    isFinal: Boolean(block.isFinal),
    userEdited,
    confidence: confidenceValue(block.confidence),
    source,
    lineage,
  }
  if (out.endMs < out.startMs) throw invalid('INVALID_DOCUMENT', '转写时间范围无效')
  return out
}

function normalizeText(block, now) {
  return {
    ...block,
    type: 'text',
    id: idValue(block.id),
    text: textValue(block.text ?? '', '文字块文本'),
    createdAt: block.createdAt === undefined ? now : dateValue(block.createdAt, '文字块创建时间'),
    updatedAt: block.updatedAt === undefined ? now : dateValue(block.updatedAt, '文字块更新时间'),
  }
}

function normalizeImage(block, now) {
  const mediaId = idValue(block.mediaId, '媒体 ID')
  return {
    ...block,
    type: 'image',
    id: idValue(block.id),
    mediaId,
    caption: textValue(block.caption ?? '', '图片说明', 4_000),
    createdAt: block.createdAt === undefined ? now : dateValue(block.createdAt, '图片创建时间'),
  }
}

export function normalizeBlock(block, { now = new Date().toISOString() } = {}) {
  assertObject(block, '块必须是对象')
  if (!['transcript', 'text', 'image'].includes(block.type)) throw invalid('INVALID_DOCUMENT', '块类型无效')
  if (block.type === 'transcript') return normalizeTranscript(block)
  if (block.type === 'text') return normalizeText(block, now)
  return normalizeImage(block, now)
}

export function validateSpeakerNames(value) {
  if (value === undefined) return undefined
  assertObject(value, '说话人名称必须是对象')
  const output = {}
  for (const [key, name] of Object.entries(value)) {
    idValue(key, '说话人 ID')
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_SPEAKER_NAME_CHARS) {
      throw invalid('INVALID_DOCUMENT', '说话人名称格式无效')
    }
    output[key] = name
  }
  return output
}

export function validateDocument(document, { now = new Date().toISOString(), allowMissingBlocks = false } = {}) {
  assertObject(document, '文档必须是对象')
  if (document.schema !== undefined && document.schema !== 'stenographer_document.v1') throw invalid('INVALID_DOCUMENT', '文档 schema 无效')
  const rawBlocks = document.blocks
  if (rawBlocks === undefined && allowMissingBlocks) return { ...defaultDocument(now), ...cloneJson(document), blocks: undefined }
  if (!Array.isArray(rawBlocks) || rawBlocks.length > MAX_DOCUMENT_BLOCKS) throw invalid('INVALID_DOCUMENT', '文档块数量无效')
  const blocks = rawBlocks.map((block) => normalizeBlock(block, { now }))
  const ids = new Set()
  for (const block of blocks) {
    if (ids.has(block.id)) throw invalid('INVALID_DOCUMENT', '文档块 ID 不能重复')
    ids.add(block.id)
  }
  const speakerNames = validateSpeakerNames(document.speakerNames) || {}
  const speakerLineage = validateSpeakerNames(document.speakerLineage) || {}
  return {
    ...cloneJson(document),
    schema: 'stenographer_document.v1',
    blocks,
    speakerNames,
    speakerLineage,
    revision: Number.isSafeInteger(document.revision) && document.revision >= 0 ? document.revision : 0,
    updatedAt: document.updatedAt === undefined ? now : dateValue(document.updatedAt, '文档更新时间'),
  }
}

export function patchDocument(current, patch, { now = new Date().toISOString() } = {}) {
  assertObject(patch, '文档更新必须是对象')
  const next = cloneJson(current || defaultDocument(now))
  if (patch.blocks !== undefined) {
    const checked = validateDocument({ schema: 'stenographer_document.v1', blocks: patch.blocks }, { now })
    const prior = new Map((next.blocks || []).map((block) => [block.id, block]))
    next.blocks = checked.blocks.map((block) => {
      const old = prior.get(block.id)
      if (!old || old.type !== 'transcript') return block
      // Once a user changed a transcript, later model reconciliation must not
      // silently turn it back into raw model output.
      if (old.userEdited) return { ...block, userEdited: true }
      return block
    })
  }
  if (patch.speakerNames !== undefined) {
    const names = validateSpeakerNames(patch.speakerNames)
    next.speakerNames = { ...(next.speakerNames || {}), ...names }
  }
  if (patch.speakerLineage !== undefined) {
    const lineage = validateSpeakerNames(patch.speakerLineage)
    next.speakerLineage = { ...(next.speakerLineage || {}), ...lineage }
  }
  next.schema = 'stenographer_document.v1'
  next.updatedAt = now
  return next
}

function mergeTranscript(oldBlock, freshBlock) {
  if (!oldBlock) return freshBlock
  const merged = { ...freshBlock, id: oldBlock.id }
  if (oldBlock.userEdited) {
    merged.text = oldBlock.text
    merged.userEdited = true
  } else if (freshBlock.text !== freshBlock.rawText) {
    merged.userEdited = true
  }
  // Keep a user-assigned lineage if the final cluster produced a new temporary
  // label. Speaker display names are keyed by stable lineage in the document.
  if (oldBlock.lineage && freshBlock.lineage === 'speaker-uncertain') merged.lineage = oldBlock.lineage
  return merged
}

export function reconcileDocument(current, freshBlocks, { now = new Date().toISOString() } = {}) {
  const currentDoc = validateDocument(current || defaultDocument(now), { now })
  const fresh = (freshBlocks || []).map((block) => normalizeBlock(block, { now }))
  const oldTranscripts = currentDoc.blocks.filter((block) => block.type === 'transcript')
  let freshIndex = 0
  let oldIndex = 0
  const blocks = []
  for (const block of currentDoc.blocks) {
    if (block.type !== 'transcript') {
      blocks.push(block)
      continue
    }
    const next = fresh[freshIndex++]
    if (next) {
      blocks.push(mergeTranscript(block, next))
      oldIndex += 1
    } else if (block.userEdited) {
      // Never throw away a manually repaired block just because a final model
      // returned fewer segments.
      blocks.push(block)
      oldIndex += 1
    }
  }
  while (freshIndex < fresh.length) blocks.push(fresh[freshIndex++])
  // `oldTranscripts` is intentionally evaluated above to make the preservation
  // rule explicit and to guard future changes from accidentally reordering the
  // transcript slots around text/image blocks.
  void oldTranscripts
  void oldIndex
  return {
    ...currentDoc,
    blocks,
    updatedAt: now,
  }
}

export function renderTranscriptMarkdown(document, { mediaPaths = new Map(), speakerNames = {} } = {}) {
  const doc = validateDocument(document)
  const lines = ['# 速记记录', '']
  for (const block of doc.blocks) {
    if (block.type === 'transcript') {
      const speaker = speakerNames[block.lineage] || speakerNames[block.speakerId] || block.speakerId || '未识别说话人'
      const uncertain = block.uncertain || block.speakerId === 'speaker-uncertain' ? '（待确认）' : ''
      lines.push(`**${speaker}${uncertain}** · ${formatTime(block.startMs)}–${formatTime(block.endMs)}`)
      lines.push(block.text || block.rawText || '（无文字）')
      lines.push('')
    } else if (block.type === 'text') {
      lines.push(block.text, '')
    } else {
      const path = mediaPaths.get(block.mediaId) || block.mediaId
      lines.push(`![${block.caption || '图片'}](${path})`, '')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
