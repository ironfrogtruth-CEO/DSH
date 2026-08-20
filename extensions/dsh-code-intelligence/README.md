# dsh-code-intelligence

Host-only local code intelligence MVP for DeepSeek Harness. It is deliberately explicit: registering the bundle does not read a session, inject a repo map, or modify model context. The model must call one of these tools:

- `code_index_build`
- `code_index_status`
- `code_index_query`
- `code_repo_map`
- `code_test_impact`

## Storage and scope

The index uses Node's built-in `node:sqlite` with WAL mode and FTS5. The default database is `~/.dsh/code-intelligence/index.sqlite`; `DSH_CODE_INTELLIGENCE_ROOT` can select another storage root. Every row is isolated by:

`projectId + canonical workspaceRoot + git branch + relative path + content hash`

The index stores symbol/import candidates, file metadata, source provider, scope, `untrusted`, and SHA-256 provenance. Incremental builds compare content hashes and remove rows for files no longer present in the accepted Git file list.

## Scanner boundary

Build uses `git ls-files -co --exclude-standard -z`, a controlled source extension allowlist, canonical path checks, and a one-megabyte default file limit. Binary files, secret-shaped names (`.env`, credentials, keys, certificates, private-key names), ignored files, symlink escapes, and files outside the workspace are excluded. The scanner requires a Git worktree; it never follows an external path.

The extractor provider is `conservative-regex-v1`. It recognizes basic functions/classes/types/imports in JavaScript/TypeScript, Python, Go, Rust, and Java. It is not a complete parser, SCIP index, call graph, or language server.

## Result contracts

`code_repo_map` is token-bounded with a conservative estimator: ASCII uses roughly four characters per token, while CJK and emoji receive one or two-token weights. It returns only path/language/symbol summaries and never exceeds the requested budget. `code_index_query` combines FTS5, path, symbol, and import signals but returns `complete: false`, `candidate: true`, and a verification disclaimer because the index is conservative and bounded. `code_test_impact` returns candidates from imports, symbol names, reference text, same-directory proximity, and test/spec naming; it always returns `complete: false` and a disclaimer because the method is intentionally conservative.

All model-facing results carry `provenance`, `scope: workspace`, `untrusted: true`, and content hashes. Callers must verify source files before editing or treating a candidate as a complete dependency result.

## Activation

`cordis.patch.yml` is an explicit opt-in bundle patch. This directory alone does not activate the tools, and the package has no `client.js`, CSS, JSX/TSX, Swift, UI bundle, or automatic session hook. The Host store is registered with `ctx.effect` so a plugin reload closes the SQLite handle and resets the process-local singleton.
