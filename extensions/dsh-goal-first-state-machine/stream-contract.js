function stripMarker(line) {
  return line.replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)、]\s*)/, '').trim()
}

function preamble(line) {
  return /^(?:好的|可以|当然|改写如下|答案如下|以下是|结果如下|建议改为|可改为)\s*[：:]?\s*$/i.test(line)
}

export function oneSentence(text) {
  const lines = String(text || '').split(/\r?\n/).map(stripMarker).filter(Boolean)
  let candidate = ''
  for (let line of lines) {
    if (preamble(line)) continue
    line = line.replace(/^(?:好的|可以|当然)[，,]\s*/i, '').trim()
    line = line.replace(/^(?:好的|可以|当然|改写如下|答案如下|以下是|结果如下|建议改为|可改为)\s*[：:]\s*/i, '').trim()
    if (!line) continue
    candidate = line
    break
  }
  if (!candidate) return ''
  const match = candidate.match(/^.*?[。！？!?](?=$|\s)/)
  return (match?.[0] || candidate).trim()
}

function textFromChunk(chunk) {
  if (chunk?.type === 'text-delta') return chunk.text || ''
  if (chunk?.type === 'block-end' && chunk.block?.type === 'text') return chunk.block.text || ''
  return ''
}

function assembledText(chunks) {
  const deltas = new Map()
  const closed = new Map()
  const order = []
  for (const chunk of chunks) {
    if (chunk?.type === 'text-delta') {
      if (!deltas.has(chunk.index)) order.push(chunk.index)
      deltas.set(chunk.index, `${deltas.get(chunk.index) || ''}${chunk.text || ''}`)
    } else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') {
      if (!deltas.has(chunk.index) && !closed.has(chunk.index)) order.push(chunk.index)
      closed.set(chunk.index, chunk.block.text || '')
    }
  }
  return { order, text: order.map((index) => closed.get(index) ?? deltas.get(index) ?? '').filter(Boolean).join('\n') }
}

function successfulPureText(chunks) {
  if (chunks.some((chunk) => chunk?.type === 'tool-call-delta' || chunk?.block?.type === 'tool-call')) return false
  const finish = chunks.findLast((chunk) => chunk?.type === 'finish')
  return !finish || !finish.reason?.kind || finish.reason.kind === 'stop'
}

export function rewriteOneSentenceChunks(chunks, maxBufferChars = 65_536) {
  const size = chunks.reduce((sum, chunk) => sum + textFromChunk(chunk).length, 0)
  if (size > maxBufferChars || !successfulPureText(chunks)) return { chunks, changed: false, reason: size > maxBufferChars ? 'overflow' : 'non-text-or-non-success' }
  const assembled = assembledText(chunks)
  if (assembled.order.length === 0) return { chunks, changed: false, reason: 'no-text' }
  const reduced = oneSentence(assembled.text)
  if (!reduced || (assembled.order.length === 1 && assembled.text.trim() === reduced)) return { chunks, changed: false, reason: 'already-compliant' }
  const primary = assembled.order[0]
  let emitted = false
  const output = []
  const emitText = () => {
    if (emitted) return
    emitted = true
    output.push({ type: 'text-delta', index: primary, text: reduced })
  }
  for (const chunk of chunks) {
    const isTextStart = chunk?.type === 'block-start' && chunk.blockType === 'text'
    const isTextDelta = chunk?.type === 'text-delta'
    const isTextEnd = chunk?.type === 'block-end' && chunk.block?.type === 'text'
    if ((isTextStart || isTextDelta || isTextEnd) && chunk.index !== primary) continue
    if (isTextDelta) continue
    if (isTextEnd) {
      emitText()
      output.push({ ...chunk, block: { ...chunk.block, text: reduced } })
      continue
    }
    if ((chunk?.type === 'usage' || chunk?.type === 'finish') && !emitted) emitText()
    if (chunk?.type === 'finish' && chunk.replayState !== undefined) {
      const { replayState: _discarded, ...safeFinish } = chunk
      output.push(safeFinish)
    } else output.push(chunk)
  }
  if (!emitted) emitText()
  return { chunks: output, changed: true, reason: 'contract-enforced', text: reduced }
}

export async function* enforceOneSentenceStream(stream, contract, maxBufferChars = 65_536) {
  if (contract?.exactSentences !== 1 || contract?.resultOnly !== true) {
    yield* stream
    return
  }
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const rewritten = rewriteOneSentenceChunks(chunks, maxBufferChars)
  yield* rewritten.chunks
}
