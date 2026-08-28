import { createHash } from 'node:crypto'

// Canonical JSON serialization contract shared with the ShrimpTank side:
// - object keys are sorted recursively by Unicode code point;
// - arrays keep their order;
// - integer-valued floats (2.0) serialize as integers (2), and -0 becomes 0;
// - no whitespace separators (',' and ':' only);
// - non-ASCII characters are emitted verbatim as UTF-8 (no \u escapes);
// - undefined object values are dropped like JSON.stringify; NaN/Infinity
//   serialize as null; unsupported values (function/symbol) become null.
function codePoints(value) {
  return [...String(value)].map((char) => char.codePointAt(0))
}

function compareCodePointOrder(left, right) {
  const a = codePoints(left)
  const b = codePoints(right)
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return a.length - b.length
}

function escapeString(value) {
  let output = '"'
  for (const char of String(value)) {
    const code = char.codePointAt(0)
    if (char === '"') output += '\\"'
    else if (char === '\\') output += '\\\\'
    else if (char === '\n') output += '\\n'
    else if (char === '\r') output += '\\r'
    else if (char === '\t') output += '\\t'
    else if (char === '\b') output += '\\b'
    else if (char === '\f') output += '\\f'
    else if (code < 0x20) output += `\\u${code.toString(16).padStart(4, '0')}`
    else output += char
  }
  return `${output}"`
}

function serialize(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'string') return escapeString(value)
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort(compareCodePointOrder)
      .map((key) => `${escapeString(key)}:${serialize(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return 'null'
}

export function stableJsonStringifyV1(value) {
  return serialize(value)
}

export function stableJsonChecksumV1(value) {
  return createHash('sha256').update(stableJsonStringifyV1(value)).digest('hex')
}
