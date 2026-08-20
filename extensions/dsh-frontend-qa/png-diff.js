import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32BE(offset)
}

function channelsForColorType(colorType) {
  return { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType] ?? 0
}

export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('invalid PNG signature')
  let offset = 8
  let width
  let height
  let bitDepth
  let colorType
  let interlace
  const idat = []
  while (offset + 12 <= buffer.length) {
    const length = readUInt32(buffer, offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) throw new Error('truncated PNG chunk')
    const data = buffer.subarray(dataStart, dataEnd)
    if (type === 'IHDR') {
      width = readUInt32(data, 0)
      height = readUInt32(data, 4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset = dataEnd + 4
  }
  const channels = channelsForColorType(colorType)
  if (!width || !height || bitDepth !== 8 || !channels || interlace !== 0) throw new Error('PNG must be 8-bit non-interlaced grayscale/RGB/RGBA')
  const rowBytes = width * channels
  const expectedBytes = height * (rowBytes + 1)
  const compressed = Buffer.concat(idat)
  const scanlines = inflateSync(compressed)
  if (scanlines.length < expectedBytes) throw new Error('PNG scanline data is truncated')
  const raw = Buffer.alloc(height * rowBytes)
  let inputOffset = 0
  for (let y = 0; y < height; y += 1) {
    const filter = scanlines[inputOffset++]
    const rowStart = y * rowBytes
    const previousStart = (y - 1) * rowBytes
    for (let x = 0; x < rowBytes; x += 1) {
      const value = scanlines[inputOffset++]
      const left = x >= channels ? raw[rowStart + x - channels] : 0
      const up = y > 0 ? raw[previousStart + x] : 0
      const upperLeft = y > 0 && x >= channels ? raw[previousStart + x - channels] : 0
      if (filter === 0) raw[rowStart + x] = value
      else if (filter === 1) raw[rowStart + x] = (value + left) & 0xff
      else if (filter === 2) raw[rowStart + x] = (value + up) & 0xff
      else if (filter === 3) raw[rowStart + x] = (value + Math.floor((left + up) / 2)) & 0xff
      else if (filter === 4) raw[rowStart + x] = (value + paeth(left, up, upperLeft)) & 0xff
      else throw new Error(`unsupported PNG filter ${filter}`)
    }
  }
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    const source = i * channels
    const target = i * 4
    if (colorType === 6) rgba.set(raw.subarray(source, source + 4), target)
    else if (colorType === 2) {
      rgba[target] = raw[source]; rgba[target + 1] = raw[source + 1]; rgba[target + 2] = raw[source + 2]; rgba[target + 3] = 255
    } else if (colorType === 4) {
      rgba[target] = raw[source]; rgba[target + 1] = raw[source]; rgba[target + 2] = raw[source]; rgba[target + 3] = raw[source + 1]
    } else {
      rgba[target] = raw[source]; rgba[target + 1] = raw[source]; rgba[target + 2] = raw[source]; rgba[target + 3] = 255
    }
  }
  return { width, height, data: rgba }
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const value of buffer) crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii')
  const body = Buffer.concat([name, data])
  const output = Buffer.alloc(12 + data.length)
  output.writeUInt32BE(data.length, 0)
  body.copy(output, 4)
  output.writeUInt32BE(crc32(body), 8 + data.length)
  return output
}

export function encodePng({ width, height, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || !Buffer.isBuffer(data) || data.length !== width * height * 4) throw new Error('encodePng expects RGBA data with valid dimensions')
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0
    data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

export function comparePngBuffers(baselineBuffer, actualBuffer, { threshold = 0.1 } = {}) {
  const baseline = decodePng(baselineBuffer)
  const actual = decodePng(actualBuffer)
  const dimensions = {
    baseline: { width: baseline.width, height: baseline.height },
    actual: { width: actual.width, height: actual.height },
    equal: baseline.width === actual.width && baseline.height === actual.height,
  }
  if (!dimensions.equal) return { ok: false, code: 'DIMENSIONS_MISMATCH', diffPixels: null, diffRatio: null, dimensions }
  const safeThreshold = Math.max(0, Math.min(1, Number(threshold) || 0))
  const diff = Buffer.alloc(actual.data.length)
  let diffPixels = 0
  for (let i = 0; i < actual.data.length; i += 4) {
    const delta = Math.max(
      Math.abs(baseline.data[i] - actual.data[i]),
      Math.abs(baseline.data[i + 1] - actual.data[i + 1]),
      Math.abs(baseline.data[i + 2] - actual.data[i + 2]),
      Math.abs(baseline.data[i + 3] - actual.data[i + 3]),
    ) / 255
    if (delta > safeThreshold) {
      diffPixels += 1
      diff[i] = 255; diff[i + 1] = 0; diff[i + 2] = 0; diff[i + 3] = 255
    } else {
      const shade = Math.round((actual.data[i] + actual.data[i + 1] + actual.data[i + 2]) / 3)
      diff[i] = shade; diff[i + 1] = shade; diff[i + 2] = shade; diff[i + 3] = 255
    }
  }
  return { ok: diffPixels === 0, code: diffPixels === 0 ? 'MATCH' : 'PIXELS_DIFFER', diffPixels, diffRatio: diffPixels / (actual.width * actual.height), dimensions, diffPng: encodePng({ width: actual.width, height: actual.height, data: diff }) }
}

export function visualDiff({ baselinePath, actualPath, diffPath, threshold = 0.1 } = {}) {
  const result = comparePngBuffers(readFileSync(baselinePath), readFileSync(actualPath), { threshold })
  if (diffPath && result.diffPng) writeFileSync(diffPath, result.diffPng)
  delete result.diffPng
  return { ...result, baselineHash: createHash('sha256').update(readFileSync(baselinePath)).digest('hex'), actualHash: createHash('sha256').update(readFileSync(actualPath)).digest('hex') }
}
