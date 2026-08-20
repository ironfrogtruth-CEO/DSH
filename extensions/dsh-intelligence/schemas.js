/**
 * Stable, dependency-free contracts for the dsh-intelligence Host package.
 *
 * The objects below intentionally use ordinary JSON Schema vocabulary.  The
 * small validator in this file is kept local so the package can be imported by
 * focused tests without installing a second validation runtime.  A caller can
 * hand the exported schemas to AJV/Zod adapters later without changing the
 * wire contracts.
 */

const id = { type: 'string', minLength: 1, maxLength: 240 }
const timestamp = { type: 'string', format: 'date-time', minLength: 8, maxLength: 80 }
const text = { type: 'string', minLength: 1, maxLength: 200_000 }
const shortText = { type: 'string', minLength: 1, maxLength: 20_000 }
const stringList = {
  type: 'array',
  maxItems: 20_000,
  uniqueItems: true,
  items: { type: 'string', minLength: 1, maxLength: 2_000 },
}
const openObject = { type: 'object', additionalProperties: true }
const revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }

const contextSection = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'content', 'tokenEstimate', 'sourceEventIds', 'memoryIds', 'artifactRefs', 'protected', 'untrusted'],
  properties: {
    id,
    kind: { type: 'string', minLength: 1, maxLength: 120 },
    content: { type: 'string', maxLength: 200_000 },
    tokenEstimate: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    sourceEventIds: stringList,
    memoryIds: stringList,
    artifactRefs: stringList,
    protected: { type: 'boolean' },
    untrusted: { type: 'boolean' },
    priority: { type: 'number', minimum: -1_000_000, maximum: 1_000_000 },
    truncated: { type: 'boolean' },
    provenance: openObject,
  },
}

/** JSON Schema-like public contracts. */
export const JSON_SCHEMAS = {
  TaskSpec: {
    $id: 'dsh-intelligence/TaskSpec@1',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'taskId', 'projectId', 'title', 'objective', 'status', 'protectedConstraints', 'acceptance', 'createdAt', 'updatedAt', 'revision'],
    properties: {
      schemaVersion: { type: 'integer', const: 1 },
      taskId: id,
      projectId: id,
      title: shortText,
      objective: text,
      status: { type: 'string', enum: ['planned', 'active', 'blocked', 'done', 'cancelled'] },
      protectedConstraints: { ...stringList, maxItems: 500 },
      acceptance: { ...stringList, maxItems: 500 },
      createdAt: timestamp,
      updatedAt: timestamp,
      revision,
      metadata: openObject,
    },
  },

  TaskNode: {
    $id: 'dsh-intelligence/TaskNode@1',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'nodeId', 'taskId', 'projectId', 'title', 'kind', 'status', 'dependsOn', 'evidenceIds', 'createdAt', 'updatedAt', 'revision'],
    properties: {
      schemaVersion: { type: 'integer', const: 1 },
      nodeId: id,
      taskId: id,
      projectId: id,
      title: shortText,
      kind: { type: 'string', enum: ['plan', 'execute', 'verify', 'review', 'handoff'] },
      status: { type: 'string', enum: ['planned', 'active', 'blocked', 'done', 'cancelled'] },
      dependsOn: stringList,
      evidenceIds: stringList,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision,
      metadata: openObject,
    },
  },

  EvidenceRecord: {
    $id: 'dsh-intelligence/EvidenceRecord@1',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'evidenceId', 'taskId', 'projectId', 'kind', 'status', 'summary', 'sourceRefs', 'createdAt', 'untrusted'],
    properties: {
      schemaVersion: { type: 'integer', const: 1 },
      evidenceId: id,
      taskId: id,
      projectId: id,
      kind: { type: 'string', enum: ['test', 'artifact', 'source', 'observation', 'approval', 'command'] },
      status: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
      summary: text,
      sourceRefs: stringList,
      createdAt: timestamp,
      untrusted: { type: 'boolean' },
      metadata: openObject,
    },
  },

  ContinuationCapsule: {
    $id: 'dsh-intelligence/ContinuationCapsule@1',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'capsuleId', 'taskId', 'projectId', 'sessionId', 'goal', 'protectedConstraints', 'planSnapshot', 'activeTask', 'decisions', 'touchedFiles', 'testsAndEvidence', 'errorsAndAttempts', 'artifacts', 'pendingJobs', 'nextAction', 'sourceEventIds', 'createdAt', 'revision'],
    properties: {
      schemaVersion: { type: 'integer', const: 1 },
      capsuleId: id,
      taskId: id,
      projectId: id,
      sessionId: id,
      goal: text,
      protectedConstraints: { ...stringList, maxItems: 500 },
      planSnapshot: openObject,
      activeTask: { anyOf: [openObject, { type: 'null' }] },
      decisions: { type: 'array', maxItems: 10_000, items: openObject },
      touchedFiles: stringList,
      testsAndEvidence: { type: 'array', maxItems: 10_000, items: openObject },
      errorsAndAttempts: { type: 'array', maxItems: 10_000, items: openObject },
      artifacts: { type: 'array', maxItems: 10_000, items: openObject },
      pendingJobs: { type: 'array', maxItems: 10_000, items: openObject },
      nextAction: { anyOf: [text, openObject] },
      sourceEventIds: stringList,
      createdAt: timestamp,
      revision,
      metadata: openObject,
    },
  },

  ContextRequest: {
    $id: 'dsh-intelligence/ContextRequest@1',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'requestId', 'sessionId', 'projectId', 'tokenBudget', 'query', 'mode', 'protectedConstraints'],
    properties: {
      schemaVersion: { type: 'integer', const: 1 },
      requestId: id,
      sessionId: id,
      taskId: id,
      projectId: id,
      modelTarget: openObject,
      tokenBudget: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      query: { type: 'string', maxLength: 20_000 },
      mode: { type: 'string', enum: ['plan', 'act', 'debug', 'review', 'architect'] },
      protectedConstraints: { ...stringList, maxItems: 500 },
      createdAt: timestamp,
      metadata: openObject,
    },
  },

  OmissionRecord: {
    $id: 'dsh-intelligence/OmissionRecord@1',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'omissionId', 'sectionId', 'reason', 'sourceEventIds', 'memoryIds', 'artifactRefs', 'protected', 'createdAt'],
    properties: {
      schemaVersion: { type: 'integer', const: 1 },
      omissionId: id,
      sectionId: id,
      reason: { type: 'string', enum: ['budget', 'scope', 'stale', 'low_signal', 'untrusted', 'dedupe', 'failed', 'protected_over_budget'] },
      sourceEventIds: stringList,
      memoryIds: stringList,
      artifactRefs: stringList,
      protected: { type: 'boolean' },
      createdAt: timestamp,
      detail: { type: 'string', maxLength: 4_000 },
    },
  },

  ContextBundle: {
    $id: 'dsh-intelligence/ContextBundle@1',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'bundleId', 'requestId', 'sessionId', 'projectId', 'sections', 'sourceEventIds', 'memoryIds', 'artifactRefs', 'omitted', 'estimatedTokens', 'tokenBudget', 'hasUntrusted', 'untrustedSourceIds', 'createdAt', 'provenance'],
    properties: {
      schemaVersion: { type: 'integer', const: 1 },
      bundleId: id,
      requestId: id,
      sessionId: id,
      taskId: id,
      projectId: id,
      sections: { type: 'array', maxItems: 50_000, items: contextSection },
      sourceEventIds: stringList,
      memoryIds: stringList,
      artifactRefs: stringList,
      omitted: { type: 'array', maxItems: 50_000, items: { $ref: 'dsh-intelligence/OmissionRecord@1' } },
      estimatedTokens: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      tokenBudget: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      hasUntrusted: { type: 'boolean' },
      untrustedSourceIds: stringList,
      createdAt: timestamp,
      provenance: openObject,
      metadata: openObject,
    },
  },
}

// Resolve the only reference used above without making the validator a full
// JSON-Schema implementation.  The exported schema remains valid JSON Schema.
JSON_SCHEMAS.ContextBundle.properties.omitted.items = JSON_SCHEMAS.OmissionRecord

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pathFor(path, key) {
  if (typeof key === 'number') return `${path}[${key}]`
  return path ? `${path}.${key}` : String(key)
}

function typeMatches(type, value) {
  if (Array.isArray(type)) return type.some((item) => typeMatches(item, value))
  switch (type) {
    case 'object': return isObject(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

function validateNode(schema, value, path, errors) {
  if (!schema || typeof schema !== 'object') return
  if (schema.anyOf) {
    const branches = []
    for (const branch of schema.anyOf) {
      const branchErrors = []
      validateNode(branch, value, path, branchErrors)
      if (!branchErrors.length) return
      branches.push(branchErrors)
    }
    errors.push({ path, keyword: 'anyOf', message: 'value does not match any allowed shape', branches })
    return
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push({ path, keyword: 'const', expected: schema.const, actual: value })
    return
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, keyword: 'enum', expected: schema.enum, actual: value })
    return
  }
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push({ path, keyword: 'type', expected: schema.type, actual: value === null ? 'null' : typeof value })
    return
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path, keyword: 'minLength', expected: schema.minLength, actual: value.length })
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path, keyword: 'maxLength', expected: schema.maxLength, actual: value.length })
    if (schema.format === 'date-time' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) errors.push({ path, keyword: 'format', expected: 'date-time', actual: value })
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, keyword: 'minimum', expected: schema.minimum, actual: value })
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, keyword: 'maximum', expected: schema.maximum, actual: value })
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, keyword: 'minItems', expected: schema.minItems, actual: value.length })
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, keyword: 'maxItems', expected: schema.maxItems, actual: value.length })
    if (schema.uniqueItems) {
      const seen = new Set()
      for (const item of value) {
        const marker = JSON.stringify(item)
        if (seen.has(marker)) {
          errors.push({ path, keyword: 'uniqueItems', message: 'array contains duplicates' })
          break
        }
        seen.add(marker)
      }
    }
    if (schema.items) value.forEach((item, index) => validateNode(schema.items, item, pathFor(path, index), errors))
  }
  if (isObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push({ path: pathFor(path, key), keyword: 'required', message: 'property is required' })
    if (schema.properties) {
      for (const [key, child] of Object.entries(schema.properties)) if (Object.prototype.hasOwnProperty.call(value, key)) validateNode(child, value[key], pathFor(path, key), errors)
    }
    if (schema.additionalProperties === false && schema.properties) {
      const known = new Set(Object.keys(schema.properties))
      for (const key of Object.keys(value)) if (!known.has(key)) errors.push({ path: pathFor(path, key), keyword: 'additionalProperties', message: 'property is not allowed' })
    }
  }
}

/**
 * Validate a named contract.  The result is deliberately AJV-shaped enough
 * for callers to use without coupling to a validator implementation.
 */
export function validate(name, value) {
  const schema = JSON_SCHEMAS[name]
  if (!schema) throw new Error(`Unknown dsh-intelligence schema: ${name}`)
  const errors = []
  validateNode(schema, value, '$', errors)
  return { ok: errors.length === 0, errors }
}

export class SchemaValidationError extends TypeError {
  constructor(name, errors) {
    super(`${name} validation failed: ${errors.map((item) => `${item.path} ${item.message || item.keyword}`).join('; ')}`)
    this.name = 'SchemaValidationError'
    this.code = 'SCHEMA_VALIDATION_FAILED'
    this.schema = name
    this.errors = errors
  }
}

export function assertValid(name, value) {
  const result = validate(name, value)
  if (!result.ok) throw new SchemaValidationError(name, result.errors)
  return value
}

export function isValid(name, value) {
  return validate(name, value).ok
}

/** Stable convenience validators for downstream compaction and memory code. */
export function validateContinuationCapsule(value) {
  return validate('ContinuationCapsule', value)
}

export function assertContinuationCapsule(value) {
  return assertValid('ContinuationCapsule', value)
}

export const CONTRACT_NAMES = Object.freeze(Object.keys(JSON_SCHEMAS))
