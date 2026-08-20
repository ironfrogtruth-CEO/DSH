/** Dependency-free fixture contract and validator for offline dsh-evals. */

export const TASK_TYPES = Object.freeze([
  'compaction-retention',
  'memory-retrieval',
  'task-resume',
  'code-context',
  'cross-session-ranking',
  'frontend-signoff',
])

export const FIXTURE_SCHEMA = {
  $id: 'dsh-evals/fixture@1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'fixtureId', 'title', 'taskType', 'input', 'expected'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    fixtureId: { type: 'string', minLength: 1, maxLength: 200 },
    title: { type: 'string', minLength: 1, maxLength: 500 },
    taskType: { type: 'string', enum: TASK_TYPES },
    description: { type: 'string', maxLength: 10_000 },
    input: { type: 'object', additionalProperties: true },
    expected: { type: 'object', additionalProperties: true },
    adapterModule: { type: 'string', minLength: 1, maxLength: 500 },
    requiresModule: { type: 'boolean' },
    metadata: { type: 'object', additionalProperties: true },
  },
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function typeMatches(type, value) {
  if (Array.isArray(type)) return type.some((candidate) => typeMatches(candidate, value))
  if (type === 'object') return isObject(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'integer') return Number.isSafeInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'string') return typeof value === 'string'
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'null') return value === null
  return true
}

function pathFor(path, key) { return typeof key === 'number' ? `${path}[${key}]` : `${path}.${key}` }

function validateNode(schema, value, path, errors) {
  if (schema.const !== undefined && value !== schema.const) errors.push({ path, keyword: 'const', message: `must equal ${String(schema.const)}` })
  if (schema.enum && !schema.enum.includes(value)) errors.push({ path, keyword: 'enum', message: 'must be one of the allowed values' })
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push({ path, keyword: 'type', message: `must be ${Array.isArray(schema.type) ? schema.type.join('|') : schema.type}` })
    return
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path, keyword: 'minLength', message: `must contain at least ${schema.minLength} characters` })
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path, keyword: 'maxLength', message: `must contain at most ${schema.maxLength} characters` })
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => validateNode(schema.items, item, pathFor(path, index), errors))
  if (isObject(value)) {
    for (const required of schema.required || []) if (!Object.hasOwn(value, required)) errors.push({ path: pathFor(path, required), keyword: 'required', message: 'is required' })
    for (const [key, child] of Object.entries(schema.properties || {})) if (Object.hasOwn(value, key)) validateNode(child, value[key], pathFor(path, key), errors)
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties || {}))
      for (const key of Object.keys(value)) if (!known.has(key)) errors.push({ path: pathFor(path, key), keyword: 'additionalProperties', message: 'is not allowed' })
    }
  }
}

export function validateFixture(value) {
  const errors = []
  validateNode(FIXTURE_SCHEMA, value, '$', errors)
  return { ok: errors.length === 0, errors }
}

export class FixtureValidationError extends TypeError {
  constructor(errors) {
    super(`fixture validation failed: ${errors.map((error) => `${error.path} ${error.message}`).join('; ')}`)
    this.name = 'FixtureValidationError'
    this.code = 'FIXTURE_INVALID'
    this.errors = errors
  }
}

export function assertFixture(value) {
  const result = validateFixture(value)
  if (!result.ok) throw new FixtureValidationError(result.errors)
  return value
}
