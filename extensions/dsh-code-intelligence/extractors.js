/** Conservative, dependency-free symbol/import extraction.
 *
 * This is intentionally a small provider interface, not SCIP or a parser.
 * Callers must treat every result as a candidate with source provenance.
 */

export const EXTRACTOR_PROVIDER = 'conservative-regex-v1'

const LANGUAGE_BY_EXTENSION = new Map([
  ['.js', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'],
  ['.ts', 'typescript'], ['.tsx', 'typescript'], ['.jsx', 'javascript'],
  ['.py', 'python'], ['.go', 'go'], ['.rs', 'rust'], ['.java', 'java'],
])

const SYMBOL_PATTERNS = {
  javascript: [
    [/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|:)/, 'variable'],
    [/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, 'type'],
  ],
  typescript: [
    [/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|:)/, 'variable'],
    [/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, 'type'],
  ],
  python: [
    [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, 'function'],
    [/^\s*class\s+([A-Za-z_]\w*)/, 'class'],
  ],
  go: [
    [/^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)\s*\(/, 'function'],
    [/^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, 'type'],
  ],
  rust: [
    [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, 'function'],
    [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, 'type'],
    [/^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)/, 'module'],
  ],
  java: [
    [/^\s*(?:public|private|protected|abstract|final|static\s+)*\s*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, 'type'],
    [/^\s*(?:public|private|protected|static|final|synchronized|abstract\s+)+[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|throws)/, 'function'],
  ],
}

function languageForPath(path) {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? LANGUAGE_BY_EXTENSION.get(path.slice(dot).toLowerCase()) ?? 'text' : 'text'
}

function importMatches(language, line) {
  const matches = []
  if (language === 'javascript' || language === 'typescript') {
    const patterns = [
      /\bimport\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/,
      /\bexport\s+[^'";]+?\s+from\s+['"]([^'"]+)['"]/,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/,
    ]
    for (const pattern of patterns) {
      const match = line.match(pattern)
      if (match) matches.push(match[1])
    }
  } else if (language === 'python') {
    const from = line.match(/^\s*from\s+([\w.]+)\s+import\s+/)
    const direct = line.match(/^\s*import\s+([\w.]+)/)
    if (from) matches.push(from[1])
    if (direct) matches.push(direct[1])
  } else if (language === 'go') {
    const single = line.match(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/)
    const grouped = line.match(/^\s*"([^"]+)"/)
    if (single) matches.push(single[1])
    else if (grouped) matches.push(grouped[1])
  } else if (language === 'rust') {
    const use = line.match(/^\s*(?:pub\s+)?use\s+([^;{]+)/)
    const externCrate = line.match(/^\s*extern\s+crate\s+([\w:]+)/)
    if (use) matches.push(use[1].trim())
    if (externCrate) matches.push(externCrate[1])
  } else if (language === 'java') {
    const match = line.match(/^\s*import\s+(?:static\s+)?([\w.]+)/)
    if (match) matches.push(match[1])
  }
  return [...new Set(matches)]
}

export function extractSymbolsAndImports({ path, content }) {
  const language = languageForPath(path)
  const lines = String(content).split(/\r?\n/)
  const symbols = []
  const imports = []
  const patterns = SYMBOL_PATTERNS[language] ?? []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const [pattern, kind] of patterns) {
      const match = line.match(pattern)
      if (match) {
        symbols.push({
          name: match[1],
          kind,
          line: index + 1,
          column: Math.max(1, line.indexOf(match[1]) + 1),
          signature: line.trim().slice(0, 300),
          provider: EXTRACTOR_PROVIDER,
        })
        break
      }
    }
    for (const importPath of importMatches(language, line)) {
      imports.push({
        importPath,
        line: index + 1,
        provider: EXTRACTOR_PROVIDER,
      })
    }
  }
  return { language, symbols, imports, provider: EXTRACTOR_PROVIDER }
}

export function supportedLanguage(path) {
  return languageForPath(path)
}
