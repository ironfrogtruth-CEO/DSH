import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'

import { assertRelativeWorkspacePath, canonicalWorkspaceRoot, CodeIndexError, gitBranch, normalizeProjectId, scanWorkspace } from './scanner.js'

const SCHEMA_VERSION = 1

function now() {
  return new Date().toISOString()
}

export function estimateTokens(text) {
  let ascii = 0
  let nonAscii = 0
  for (const character of String(text)) {
    const codePoint = character.codePointAt(0)
    if (codePoint <= 0x7f) ascii += 1
    else if ((codePoint >= 0x1f000 && codePoint <= 0x1faff) || (codePoint >= 0x2600 && codePoint <= 0x27bf)) nonAscii += 2
    else nonAscii += 1
  }
  return Math.ceil(ascii / 4) + nonAscii
}

function trimToTokenBudget(text, maxTokens) {
  let result = ''
  for (const character of String(text)) {
    const next = result + character
    if (estimateTokens(next) > maxTokens) break
    result = next
  }
  return result
}

function ftsQuery(value) {
  const terms = String(value).match(/[A-Za-z0-9_$][A-Za-z0-9_$./:-]*/g) ?? []
  return [...new Set(terms)].map((term) => `"${term.replaceAll('"', '""')}"*`).join(' OR ')
}

function lower(value) {
  return String(value ?? '').toLocaleLowerCase()
}

function provenance({ projectId, workspaceRoot, branch, path, contentHash, source = 'sqlite-code-index' }) {
  return {
    projectId,
    workspaceRoot,
    branch,
    path,
    contentHash: contentHash ?? null,
    source,
    scope: 'workspace',
    untrusted: true,
  }
}

export class CodeIndexStore {
  constructor({ dbPath, storageRoot } = {}) {
    const root = resolve(storageRoot ?? process.env.DSH_CODE_INTELLIGENCE_ROOT ?? join(process.env.DSH_HOME ?? resolve(process.env.HOME ?? '.', '.dsh'), 'code-intelligence'))
    this.dbPath = resolve(dbPath ?? join(root, 'index.sqlite'))
    mkdirSync(dirname(this.dbPath), { recursive: true })
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS index_meta (
        project_id TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        branch TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        last_build_at TEXT,
        listed_count INTEGER NOT NULL DEFAULT 0,
        indexed_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, workspace_root, branch)
      );
      CREATE TABLE IF NOT EXISTS files (
        project_id TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        branch TEXT NOT NULL,
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        scope TEXT NOT NULL,
        untrusted INTEGER NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, workspace_root, branch, path)
      );
      CREATE TABLE IF NOT EXISTS symbols (
        project_id TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        branch TEXT NOT NULL,
        path TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        column_no INTEGER NOT NULL,
        signature TEXT NOT NULL,
        provider TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (project_id, workspace_root, branch, path, ordinal)
      );
      CREATE TABLE IF NOT EXISTS imports (
        project_id TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        branch TEXT NOT NULL,
        path TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        import_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        provider TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (project_id, workspace_root, branch, path, ordinal)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
        project_id UNINDEXED,
        workspace_root UNINDEXED,
        branch UNINDEXED,
        path,
        symbol_text,
        import_text,
        content_hash UNINDEXED,
        tokenize = 'unicode61'
      );
    `)
  }

  close() {
    this.db.close()
  }

  #scope({ projectId, workspaceRoot, branch }) {
    const normalizedProjectId = normalizeProjectId(projectId)
    const root = canonicalWorkspaceRoot(workspaceRoot)
    const branchValue = branch ? String(branch) : gitBranch(root)
    if (!branchValue.trim()) throw new CodeIndexError('BRANCH_REQUIRED', 'git branch is required')
    return { projectId: normalizedProjectId, workspaceRoot: root, branch: branchValue.trim() }
  }

  #deleteFile(scope, path) {
    const where = 'project_id = ? AND workspace_root = ? AND branch = ? AND path = ?'
    this.db.prepare(`DELETE FROM symbols WHERE ${where}`).run(scope.projectId, scope.workspaceRoot, scope.branch, path)
    this.db.prepare(`DELETE FROM imports WHERE ${where}`).run(scope.projectId, scope.workspaceRoot, scope.branch, path)
    this.db.prepare(`DELETE FROM files WHERE ${where}`).run(scope.projectId, scope.workspaceRoot, scope.branch, path)
    this.db.prepare(`DELETE FROM search_fts WHERE project_id = ? AND workspace_root = ? AND branch = ? AND path = ?`).run(scope.projectId, scope.workspaceRoot, scope.branch, path)
  }

  build({ projectId, workspaceRoot, branch, extensions, maxFileBytes } = {}) {
    const scanned = scanWorkspace({ workspaceRoot, extensions, maxFileBytes })
    const scope = this.#scope({ projectId, workspaceRoot: scanned.root, branch: branch ?? scanned.branch })
    if (scope.branch !== scanned.branch) throw new CodeIndexError('BRANCH_CHANGED', `workspace branch changed during scan: requested ${scope.branch}, scanned ${scanned.branch}`)
    const existingRows = this.db.prepare('SELECT path, content_hash, bytes FROM files WHERE project_id = ? AND workspace_root = ? AND branch = ?').all(scope.projectId, scope.workspaceRoot, scope.branch)
    const existing = new Map(existingRows.map((row) => [row.path, row]))
    const current = new Set(scanned.files.map((file) => file.path))
    const stats = { added: 0, updated: 0, unchanged: 0, deleted: 0, skipped: scanned.skipped.length, listed: scanned.listed, indexed: scanned.files.length }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const file of scanned.files) {
        const previous = existing.get(file.path)
        if (previous && previous.content_hash === file.contentHash && Number(previous.bytes) === file.bytes) {
          stats.unchanged += 1
          continue
        }
        this.#deleteFile(scope, file.path)
        this.db.prepare(`INSERT INTO files (project_id, workspace_root, branch, path, language, bytes, content_hash, scope, untrusted, source, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          scope.projectId, scope.workspaceRoot, scope.branch, file.path, file.language, file.bytes, file.contentHash,
          file.scope, file.untrusted ? 1 : 0, file.source, now(),
        )
        const symbolInsert = this.db.prepare(`INSERT INTO symbols
          (project_id, workspace_root, branch, path, ordinal, name, kind, line, column_no, signature, provider, content_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        file.symbols.forEach((symbol, index) => symbolInsert.run(
          scope.projectId, scope.workspaceRoot, scope.branch, file.path, index, symbol.name, symbol.kind,
          symbol.line, symbol.column, symbol.signature, symbol.provider, file.contentHash,
        ))
        const importInsert = this.db.prepare(`INSERT INTO imports
          (project_id, workspace_root, branch, path, ordinal, import_path, line, provider, content_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        file.imports.forEach((item, index) => importInsert.run(
          scope.projectId, scope.workspaceRoot, scope.branch, file.path, index, item.importPath, item.line, item.provider, file.contentHash,
        ))
        this.db.prepare(`INSERT INTO search_fts (project_id, workspace_root, branch, path, symbol_text, import_text, content_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          scope.projectId, scope.workspaceRoot, scope.branch, file.path,
          file.symbols.map((symbol) => `${symbol.name} ${symbol.kind} ${symbol.signature}`).join('\n'),
          file.imports.map((item) => item.importPath).join('\n'), file.contentHash,
        )
        if (previous) stats.updated += 1
        else stats.added += 1
      }
      for (const path of existing.keys()) {
        if (!current.has(path)) {
          this.#deleteFile(scope, path)
          stats.deleted += 1
        }
      }
      this.db.prepare(`INSERT INTO index_meta
        (project_id, workspace_root, branch, schema_version, last_build_at, listed_count, indexed_count, skipped_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, workspace_root, branch) DO UPDATE SET
          schema_version = excluded.schema_version, last_build_at = excluded.last_build_at,
          listed_count = excluded.listed_count, indexed_count = excluded.indexed_count,
          skipped_count = excluded.skipped_count`).run(
        scope.projectId, scope.workspaceRoot, scope.branch, SCHEMA_VERSION, now(), stats.listed, stats.indexed, stats.skipped,
      )
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* preserve original error */ }
      throw error
    }
    return {
      ok: true,
      ...stats,
      projectId: scope.projectId,
      workspaceRoot: scope.workspaceRoot,
      branch: scope.branch,
      dbPath: this.dbPath,
      provider: scanned.files[0]?.symbols?.[0]?.provider ?? 'conservative-regex-v1',
      skippedByReason: scanned.skipped.reduce((counts, item) => ({ ...counts, [item.reason]: (counts[item.reason] ?? 0) + 1 }), {}),
      provenance: { source: 'git-ls-files', projectId: scope.projectId, workspaceRoot: scope.workspaceRoot, branch: scope.branch, scope: 'workspace', untrusted: true, contentHashes: true },
      disclaimer: 'Index state is derived from a conservative scanner; verify source files before acting.',
    }
  }

  status({ projectId, workspaceRoot, branch } = {}) {
    const scope = this.#scope({ projectId, workspaceRoot, branch })
    const meta = this.db.prepare('SELECT * FROM index_meta WHERE project_id = ? AND workspace_root = ? AND branch = ?').get(scope.projectId, scope.workspaceRoot, scope.branch)
    const files = this.db.prepare('SELECT count(*) AS count FROM files WHERE project_id = ? AND workspace_root = ? AND branch = ?').get(scope.projectId, scope.workspaceRoot, scope.branch)
    const symbols = this.db.prepare('SELECT count(*) AS count FROM symbols WHERE project_id = ? AND workspace_root = ? AND branch = ?').get(scope.projectId, scope.workspaceRoot, scope.branch)
    const imports = this.db.prepare('SELECT count(*) AS count FROM imports WHERE project_id = ? AND workspace_root = ? AND branch = ?').get(scope.projectId, scope.workspaceRoot, scope.branch)
    const journal = this.db.prepare('PRAGMA journal_mode').get()
    return {
      ok: true,
      projectId: scope.projectId,
      workspaceRoot: scope.workspaceRoot,
      branch: scope.branch,
      indexed: Boolean(meta),
      files: Number(files?.count ?? 0),
      symbols: Number(symbols?.count ?? 0),
      imports: Number(imports?.count ?? 0),
      lastBuildAt: meta?.last_build_at ?? null,
      lastBuild: meta ? { listed: meta.listed_count, indexed: meta.indexed_count, skipped: meta.skipped_count } : null,
      dbPath: this.dbPath,
      journalMode: journal?.journal_mode ?? journal?.journalMode ?? null,
      scope: 'projectId + workspaceRoot + branch',
      provenance: { source: 'sqlite-code-index', projectId: scope.projectId, workspaceRoot: scope.workspaceRoot, branch: scope.branch, scope: 'workspace', untrusted: true },
      disclaimer: 'Status describes a derived, untrusted index and does not include source contents.',
    }
  }

  #fileRow(scope, path) {
    return this.db.prepare('SELECT * FROM files WHERE project_id = ? AND workspace_root = ? AND branch = ? AND path = ?').get(scope.projectId, scope.workspaceRoot, scope.branch, path)
  }

  #symbols(scope, path, limit = 50) {
    return this.db.prepare('SELECT name, kind, line, column_no AS column, signature, provider, content_hash AS contentHash FROM symbols WHERE project_id = ? AND workspace_root = ? AND branch = ? AND path = ? ORDER BY ordinal LIMIT ?').all(scope.projectId, scope.workspaceRoot, scope.branch, path, limit)
  }

  #imports(scope, path, limit = 50) {
    return this.db.prepare('SELECT import_path AS importPath, line, provider, content_hash AS contentHash FROM imports WHERE project_id = ? AND workspace_root = ? AND branch = ? AND path = ? ORDER BY ordinal LIMIT ?').all(scope.projectId, scope.workspaceRoot, scope.branch, path, limit)
  }

  #result(scope, row, score, matchedBy = []) {
    const path = row.path
    return {
      path,
      language: row.language,
      bytes: Number(row.bytes),
      contentHash: row.content_hash,
      score,
      matchedBy: [...new Set(matchedBy)],
      symbols: this.#symbols(scope, path),
      imports: this.#imports(scope, path),
      provenance: provenance({ projectId: scope.projectId, workspaceRoot: scope.workspaceRoot, branch: scope.branch, path, contentHash: row.content_hash }),
    }
  }

  query({ projectId, workspaceRoot, branch, query, limit = 20 } = {}) {
    if (typeof query !== 'string' || !query.trim()) throw new CodeIndexError('QUERY_REQUIRED', 'query is required')
    const scope = this.#scope({ projectId, workspaceRoot, branch })
    const capped = Math.max(1, Math.min(100, Number(limit) || 20))
    const needle = query.trim()
    const lowerNeedle = lower(needle)
    const hits = new Map()
    const match = ftsQuery(needle)
    if (match) {
      try {
        const rows = this.db.prepare(`SELECT path, bm25(search_fts, 5.0, 3.0, 1.0) AS rank
          FROM search_fts WHERE project_id = ? AND workspace_root = ? AND branch = ? AND search_fts MATCH ?
          ORDER BY rank LIMIT ?`).all(scope.projectId, scope.workspaceRoot, scope.branch, match, capped * 5)
        for (const row of rows) hits.set(row.path, { fts: Math.max(0, -Number(row.rank || 0)), pathHit: 0, symbolHits: 0, importHits: 0, matchedBy: ['fts5'] })
      } catch {
        // A punctuation-heavy query may be rejected by FTS5; LIKE fallback below remains safe.
      }
    }
    const like = `%${lowerNeedle.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
    const rows = this.db.prepare(`SELECT f.path,
        CASE WHEN lower(f.path) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END AS path_hit,
        (SELECT count(*) FROM symbols s WHERE s.project_id = f.project_id AND s.workspace_root = f.workspace_root AND s.branch = f.branch AND s.path = f.path AND lower(s.name) LIKE ? ESCAPE '\\') AS symbol_hits,
        (SELECT count(*) FROM imports i WHERE i.project_id = f.project_id AND i.workspace_root = f.workspace_root AND i.branch = f.branch AND i.path = f.path AND lower(i.import_path) LIKE ? ESCAPE '\\') AS import_hits
      FROM files f WHERE f.project_id = ? AND f.workspace_root = ? AND f.branch = ?
        AND (lower(f.path) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM symbols s2 WHERE s2.project_id = f.project_id AND s2.workspace_root = f.workspace_root AND s2.branch = f.branch AND s2.path = f.path AND lower(s2.name) LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM imports i2 WHERE i2.project_id = f.project_id AND i2.workspace_root = f.workspace_root AND i2.branch = f.branch AND i2.path = f.path AND lower(i2.import_path) LIKE ? ESCAPE '\\'))
      LIMIT ?`).all(like, like, like, scope.projectId, scope.workspaceRoot, scope.branch, like, like, like, capped * 5)
    for (const row of rows) {
      const hit = hits.get(row.path) ?? { fts: 0, pathHit: 0, symbolHits: 0, importHits: 0, matchedBy: [] }
      if (row.path_hit) hit.matchedBy.push('path')
      if (Number(row.symbol_hits)) hit.matchedBy.push('symbol')
      if (Number(row.import_hits)) hit.matchedBy.push('import')
      hit.pathHit = Number(row.path_hit)
      hit.symbolHits = Number(row.symbol_hits)
      hit.importHits = Number(row.import_hits)
      hits.set(row.path, hit)
    }
    const results = []
    for (const [path, hit] of hits) {
      const row = this.#fileRow(scope, path)
      if (!row) continue
      const score = Number((hit.fts + hit.pathHit * 5 + hit.symbolHits * 4 + hit.importHits * 2).toFixed(4))
      results.push(this.#result(scope, row, score, hit.matchedBy))
    }
    results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    return {
      ok: true,
      query: needle,
      results: results.slice(0, capped),
      complete: false,
      candidate: true,
      disclaimer: 'Query results are bounded candidates from a conservative index; verify source files before acting.',
      ranking: 'FTS5 + path + symbol + import mixed score',
      provenance: { projectId: scope.projectId, workspaceRoot: scope.workspaceRoot, branch: scope.branch, scope: 'workspace', untrusted: true },
    }
  }

  repoMap({ projectId, workspaceRoot, branch, maxTokens = 2_000 } = {}) {
    const scope = this.#scope({ projectId, workspaceRoot, branch })
    const budget = Math.max(1, Math.min(32_000, Number(maxTokens) || 2_000))
    const rows = this.db.prepare('SELECT * FROM files WHERE project_id = ? AND workspace_root = ? AND branch = ? ORDER BY path').all(scope.projectId, scope.workspaceRoot, scope.branch)
    const lines = []
    let included = 0
    let truncated = false
    let usedTokens = 0
    for (const row of rows) {
      const symbols = this.#symbols(scope, row.path, 100)
      const header = `${row.path} [${row.language}] hash=${String(row.content_hash).slice(0, 12)} scope=workspace untrusted=true`
      const body = symbols.length ? symbols.map((symbol) => `  ${symbol.kind} ${symbol.name} @${symbol.line}: ${symbol.signature}`).join('\n') : '  (no extracted symbols)'
      const block = `${header}\n${body}\n`
      const blockTokens = estimateTokens(block)
      const remaining = budget - usedTokens
      if (blockTokens > remaining) {
        if (remaining > 0 && included === 0) lines.push(trimToTokenBudget(block, remaining))
        truncated = true
        break
      }
      lines.push(block)
      usedTokens += blockTokens
      included += 1
    }
    const text = lines.join('')
    return {
      ok: true,
      text,
      tokenEstimate: estimateTokens(text),
      maxTokens: budget,
      truncated,
      filesIndexed: rows.length,
      filesIncluded: included,
      complete: false,
      candidate: true,
      budgetComplete: !truncated,
      disclaimer: 'Repository map contains bounded symbol summaries, not complete source or a complete dependency graph.',
      provenance: { projectId: scope.projectId, workspaceRoot: scope.workspaceRoot, branch: scope.branch, scope: 'workspace', untrusted: true },
    }
  }

  testImpact({ projectId, workspaceRoot, branch, changedPaths, limit = 30 } = {}) {
    if (!Array.isArray(changedPaths) || changedPaths.length === 0) throw new CodeIndexError('CHANGED_PATHS_REQUIRED', 'changedPaths must be a non-empty array')
    const scope = this.#scope({ projectId, workspaceRoot, branch })
    const changed = [...new Set(changedPaths.map(assertRelativeWorkspacePath))]
    const rows = this.db.prepare('SELECT * FROM files WHERE project_id = ? AND workspace_root = ? AND branch = ?').all(scope.projectId, scope.workspaceRoot, scope.branch)
    const byPath = new Map(rows.map((row) => [row.path, row]))
    const changedSymbols = new Set()
    for (const path of changed) {
      for (const symbol of this.#symbols(scope, path)) changedSymbols.add(symbol.name)
    }
    const candidates = new Map()
    const add = (path, reason, score) => {
      if (changed.includes(path)) return
      const row = byPath.get(path)
      if (!row) return
      const existing = candidates.get(path) ?? { path, score: 0, reasons: [], contentHash: row.content_hash, provenance: provenance({ projectId: scope.projectId, workspaceRoot: scope.workspaceRoot, branch: scope.branch, path, contentHash: row.content_hash }) }
      existing.score += score
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason)
      candidates.set(path, existing)
    }
    for (const row of rows) {
      const imports = this.#imports(scope, row.path)
      for (const item of imports) {
        for (const changedPath of changed) {
          const importPath = item.importPath.replaceAll('\\', '/')
          const directBase = importPath.startsWith('.') ? posix.normalize(posix.join(posix.dirname(row.path), importPath)) : null
          const changedNoExt = changedPath.replace(/\.[^.]+$/, '')
          const importNoExt = importPath.replace(/\.[^.]+$/, '')
          if (directBase === changedPath || directBase === changedNoExt || importPath === changedPath || importNoExt === changedNoExt || (!importPath.startsWith('.') && importPath.endsWith(posix.basename(changedPath).replace(/\.[^.]+$/, '')))) add(row.path, 'direct-import-candidate', 6)
        }
      }
      if (changedSymbols.size > 0) {
        const symbols = this.#symbols(scope, row.path)
        if (symbols.some((symbol) => changedSymbols.has(symbol.name))) add(row.path, 'symbol-reference-candidate', 4)
      }
      if (changed.some((path) => posix.dirname(path) === posix.dirname(row.path))) add(row.path, 'same-directory-candidate', 1)
      if (/(?:^|[/.])(?:test|tests|spec|__tests__)(?:[/.]|$)|\.(?:test|spec)\.[^.]+$/i.test(row.path)) add(row.path, 'test-name-candidate', 2)
    }
    for (const symbolName of changedSymbols) {
      const match = ftsQuery(symbolName)
      if (!match) continue
      try {
        const references = this.db.prepare(`SELECT path FROM search_fts
          WHERE project_id = ? AND workspace_root = ? AND branch = ? AND search_fts MATCH ? LIMIT 100`).all(
          scope.projectId, scope.workspaceRoot, scope.branch, match,
        )
        for (const reference of references) add(reference.path, 'reference-text-candidate', 3)
      } catch {
        // FTS punctuation or an empty candidate should not block impact hints.
      }
    }
    const capped = Math.max(1, Math.min(100, Number(limit) || 30))
    const result = [...candidates.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, capped)
    return {
      ok: true,
      changedPaths: changed,
      candidates: result,
      complete: false,
      candidate: true,
      method: 'imports + symbol names + same-directory/test naming heuristics',
      disclaimer: 'This is a conservative candidate list, not a complete dependency or test-impact graph.',
      provenance: { projectId: scope.projectId, workspaceRoot: scope.workspaceRoot, branch: scope.branch, scope: 'workspace', untrusted: true },
    }
  }
}
