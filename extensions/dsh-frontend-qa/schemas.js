/** Pure-JS validators for design and QA manifests. No browser or UI access. */

const DESIGN_SCHEMA_VERSION = 1
const QA_SCHEMA_VERSION = 2
const VERDICT_VALUES = new Set(['pass', 'fail', 'blocked', 'pending'])
const INTERACTION_VALUES = new Set(['passed', 'failed', 'blocked', 'skipped', 'pending'])
const CONSOLE_LEVELS = new Set(['debug', 'info', 'warning', 'error'])

function result(schema, errors = [], warnings = []) {
  return { ok: errors.length === 0, schema, errors, warnings }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredObject(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`)
    return false
  }
  return true
}

function requiredArray(value, path, errors, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    errors.push(`${path} must be a${nonEmpty ? ' non-empty' : ''} array`)
    return false
  }
  return true
}

function requiredString(value, path, errors) {
  if (typeof value !== 'string' || !value.trim()) errors.push(`${path} must be a non-empty string`)
}

function requiredNumber(value, path, errors, { integer = false, min = null } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || (min !== null && value < min)) errors.push(`${path} must be a finite ${integer ? 'integer' : 'number'}${min === null ? '' : ` >= ${min}`}`)
}

function validateTokenMap(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object map`)
    return
  }
  for (const [name, token] of Object.entries(value)) {
    requiredString(name, `${path} key`, errors)
    if (isObject(token)) validateTokenMap(token, `${path}.${name}`, errors)
    else if (!(typeof token === 'string' || typeof token === 'number')) errors.push(`${path}.${name} must be a string or number token`)
  }
}

function validateFont(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`)
    return
  }
  requiredString(value.family ?? value.name, `${path}.family`, errors)
  if (value.weights !== undefined) {
    if (!Array.isArray(value.weights) || value.weights.some((weight) => !Number.isInteger(weight) || weight < 100 || weight > 1000)) errors.push(`${path}.weights must contain font weights 100-1000`)
  }
  if (value.source !== undefined) requiredString(value.source, `${path}.source`, errors)
}

export function validateDesignSystemManifest(manifest) {
  const errors = []
  const warnings = []
  if (!requiredObject(manifest, 'manifest', errors)) return result('DesignSystemManifest.v1', errors, warnings)
  if (manifest.schemaVersion !== DESIGN_SCHEMA_VERSION) errors.push(`schemaVersion must be ${DESIGN_SCHEMA_VERSION}`)

  if (!requiredObject(manifest.fonts, 'fonts', errors)) return result('DesignSystemManifest.v1', errors, warnings)
  if (Array.isArray(manifest.fonts.families)) {
    if (manifest.fonts.families.length === 0) errors.push('fonts.families must not be empty')
    manifest.fonts.families.forEach((font, index) => validateFont(font, `fonts.families[${index}]`, errors))
  } else if (manifest.fonts.body || manifest.fonts.heading || manifest.fonts.mono) {
    for (const role of ['body', 'heading', 'mono']) if (manifest.fonts[role] !== undefined) validateFont(manifest.fonts[role], `fonts.${role}`, errors)
  } else {
    validateFont(manifest.fonts, 'fonts', errors)
  }

  for (const field of ['colors', 'spacing', 'radius', 'elevation']) {
    if (!requiredObject(manifest[field], field, errors)) continue
    const tokenContainer = manifest[field].tokens ?? manifest[field].scale ?? manifest[field].values ?? manifest[field]
    validateTokenMap(tokenContainer, `${field}.tokens`, errors)
  }
  if (!requiredObject(manifest.icon, 'icon', errors)) return result('DesignSystemManifest.v1', errors, warnings)
  if (manifest.icon.set !== undefined) requiredString(manifest.icon.set, 'icon.set', errors)
  else if (manifest.icon.family !== undefined) requiredString(manifest.icon.family, 'icon.family', errors)
  else errors.push('icon.set or icon.family is required')
  if (!requiredObject(manifest.motion, 'motion', errors)) return result('DesignSystemManifest.v1', errors, warnings)
  const motionDurations = manifest.motion.durations ?? manifest.motion.duration
  const motionEasing = manifest.motion.easings ?? manifest.motion.easing
  if (motionDurations !== undefined) validateTokenMap(motionDurations, 'motion.durations', errors)
  if (motionEasing !== undefined) validateTokenMap(motionEasing, 'motion.easings', errors)
  if (motionDurations === undefined && motionEasing === undefined) errors.push('motion.durations or motion.easings is required')
  if (!requiredObject(manifest.breakpoint, 'breakpoint', errors)) return result('DesignSystemManifest.v1', errors, warnings)
  if (manifest.breakpoint.values !== undefined) validateTokenMap(manifest.breakpoint.values, 'breakpoint.values', errors)
  else {
    const breakpointValues = Object.fromEntries(Object.entries(manifest.breakpoint).filter(([key]) => !['names', 'unit'].includes(key)))
    validateTokenMap(breakpointValues, 'breakpoint.values', errors)
  }
  if (manifest.spacing.unit !== undefined) requiredNumber(manifest.spacing.unit, 'spacing.unit', errors, { min: 0 })
  if (manifest.icon.sizes !== undefined && (!Array.isArray(manifest.icon.sizes) || manifest.icon.sizes.some((size) => !Number.isFinite(size) || size <= 0))) errors.push('icon.sizes must contain positive numbers')
  if (manifest.motion.reducedMotion !== undefined && typeof manifest.motion.reducedMotion !== 'boolean') errors.push('motion.reducedMotion must be boolean')
  if (manifest.breakpoint.names !== undefined && (!Array.isArray(manifest.breakpoint.names) || manifest.breakpoint.names.some((name) => typeof name !== 'string' || !name.trim()))) errors.push('breakpoint.names must contain non-empty strings')
  if (manifest.colors.tokens === undefined && manifest.colors.semantic === undefined && manifest.colors.palette === undefined) warnings.push('colors has no explicit tokens/semantic/palette map')
  return result('DesignSystemManifest.v1', errors, warnings)
}

function validateViewport(viewport, path, errors) {
  if (!isObject(viewport)) {
    errors.push(`${path} must be an object`)
    return
  }
  requiredString(viewport.id ?? viewport.name, `${path}.id`, errors)
  requiredNumber(viewport.width, `${path}.width`, errors, { integer: true, min: 1 })
  requiredNumber(viewport.height, `${path}.height`, errors, { integer: true, min: 1 })
  if (viewport.deviceScaleFactor !== undefined) requiredNumber(viewport.deviceScaleFactor, `${path}.deviceScaleFactor`, errors, { min: 0.1 })
}

function validateScreenshot(item, path, errors) {
  if (!isObject(item)) {
    errors.push(`${path} must be an object`)
    return
  }
  requiredString(item.id, `${path}.id`, errors)
  requiredString(item.path, `${path}.path`, errors)
  requiredString(item.viewport, `${path}.viewport`, errors)
  requiredString(item.theme, `${path}.theme`, errors)
  requiredString(item.state, `${path}.state`, errors)
  if (typeof item.reviewed !== 'boolean') errors.push(`${path}.reviewed must be boolean`)
}

function validateVisualDiff(item, path, errors) {
  if (!isObject(item)) {
    errors.push(`${path} must be an object`)
    return
  }
  requiredString(item.id, `${path}.id`, errors)
  requiredString(item.baselinePath, `${path}.baselinePath`, errors)
  requiredString(item.actualPath, `${path}.actualPath`, errors)
  if (item.diffPath !== undefined) requiredString(item.diffPath, `${path}.diffPath`, errors)
  if (item.diffRatio !== undefined) requiredNumber(item.diffRatio, `${path}.diffRatio`, errors, { min: 0 })
  if (typeof item.reviewed !== 'boolean') errors.push(`${path}.reviewed must be boolean`)
}

export function validateDesignQAManifest(manifest) {
  const errors = []
  const warnings = []
  if (!requiredObject(manifest, 'manifest', errors)) return result('DesignQAManifest.v2', errors, warnings)
  if (manifest.schemaVersion !== QA_SCHEMA_VERSION) errors.push(`schemaVersion must be ${QA_SCHEMA_VERSION}`)
  if (!requiredArray(manifest.viewports, 'viewports', errors, { nonEmpty: true })) return result('DesignQAManifest.v2', errors, warnings)
  manifest.viewports.forEach((viewport, index) => validateViewport(viewport, `viewports[${index}]`, errors))
  for (const field of ['themes', 'states', 'screenshots', 'visualDiffs', 'console', 'page', 'network', 'a11y', 'interactions', 'trace', 'reviewed', 'verdict']) {
    if (manifest[field] === undefined) errors.push(`${field} is required`)
  }
  if (!requiredArray(manifest.themes, 'themes', errors, { nonEmpty: true })) return result('DesignQAManifest.v2', errors, warnings)
  manifest.themes.forEach((theme, index) => {
    if (!isObject(theme)) errors.push(`themes[${index}] must be an object`)
    else requiredString(theme.id ?? theme.name, `themes[${index}].id`, errors)
  })
  if (!requiredArray(manifest.states, 'states', errors, { nonEmpty: true })) return result('DesignQAManifest.v2', errors, warnings)
  manifest.states.forEach((state, index) => {
    if (!isObject(state)) errors.push(`states[${index}] must be an object`)
    else requiredString(state.id ?? state.name, `states[${index}].id`, errors)
  })
  if (Array.isArray(manifest.screenshots)) manifest.screenshots.forEach((item, index) => validateScreenshot(item, `screenshots[${index}]`, errors))
  if (Array.isArray(manifest.visualDiffs)) manifest.visualDiffs.forEach((item, index) => validateVisualDiff(item, `visualDiffs[${index}]`, errors))
  if (!Array.isArray(manifest.console)) errors.push('console must be an array')
  else manifest.console.forEach((entry, index) => {
    if (!isObject(entry)) errors.push(`console[${index}] must be an object`)
    else {
      if (!CONSOLE_LEVELS.has(entry.level)) errors.push(`console[${index}].level must be debug/info/warning/error`)
      requiredString(entry.message, `console[${index}].message`, errors)
    }
  })
  if (!requiredObject(manifest.page, 'page', errors)) return result('DesignQAManifest.v2', errors, warnings)
  if (manifest.page.url !== undefined) requiredString(manifest.page.url, 'page.url', errors)
  if (manifest.page.path !== undefined) requiredString(manifest.page.path, 'page.path', errors)
  if (!Array.isArray(manifest.network)) errors.push('network must be an array')
  else manifest.network.forEach((entry, index) => {
    if (!isObject(entry)) errors.push(`network[${index}] must be an object`)
    else {
      if (entry.url !== undefined) requiredString(entry.url, `network[${index}].url`, errors)
      if (entry.status !== undefined && !(Number.isInteger(entry.status) || typeof entry.status === 'string')) errors.push(`network[${index}].status must be an integer or string`)
      if (entry.error !== undefined && typeof entry.error !== 'string') errors.push(`network[${index}].error must be a string`)
    }
  })
  if (!Array.isArray(manifest.a11y)) errors.push('a11y must be an array')
  else manifest.a11y.forEach((entry, index) => {
    if (!isObject(entry)) errors.push(`a11y[${index}] must be an object`)
    else {
      if (entry.id !== undefined) requiredString(entry.id, `a11y[${index}].id`, errors)
      if (entry.message !== undefined) requiredString(entry.message, `a11y[${index}].message`, errors)
      if (entry.impact !== undefined) requiredString(entry.impact, `a11y[${index}].impact`, errors)
      if (entry.resolved !== undefined && typeof entry.resolved !== 'boolean') errors.push(`a11y[${index}].resolved must be boolean`)
    }
  })
  if (!Array.isArray(manifest.interactions)) errors.push('interactions must be an array')
  else manifest.interactions.forEach((item, index) => {
    if (!isObject(item)) errors.push(`interactions[${index}] must be an object`)
    else {
      requiredString(item.id, `interactions[${index}].id`, errors)
      if (!INTERACTION_VALUES.has(item.status)) errors.push(`interactions[${index}].status is invalid`)
      if (typeof item.critical !== 'boolean') errors.push(`interactions[${index}].critical must be boolean`)
    }
  })
  if (!requiredObject(manifest.trace, 'trace', errors)) return result('DesignQAManifest.v2', errors, warnings)
  if (manifest.trace.path !== undefined) requiredString(manifest.trace.path, 'trace.path', errors)
  if (manifest.trace.reviewed !== undefined && typeof manifest.trace.reviewed !== 'boolean') errors.push('trace.reviewed must be boolean')
  if (typeof manifest.reviewed !== 'boolean') errors.push('reviewed must be boolean')
  if (!requiredObject(manifest.verdict, 'verdict', errors)) return result('DesignQAManifest.v2', errors, warnings)
  for (const field of ['functional', 'visual', 'a11y', 'overall']) if (!VERDICT_VALUES.has(manifest.verdict[field])) errors.push(`verdict.${field} must be pass/fail/blocked/pending`)
  return result('DesignQAManifest.v2', errors, warnings)
}

function unresolvedA11y(item) {
  if (!isObject(item)) return true
  const impact = String(item.impact ?? '').toLowerCase()
  return ['critical', 'serious', 'high'].includes(impact) && item.resolved !== true && item.status !== 'passed'
}

export function evaluateFrontendSignoff(manifest) {
  const validation = validateDesignQAManifest(manifest)
  const blockers = [...validation.errors]
  if (!validation.ok) return { ok: false, reviewed: false, blockers, functional: { ok: false }, visual: { ok: false }, a11y: { ok: false }, verdict: manifest?.verdict ?? null }
  const unreviewedScreenshots = manifest.screenshots.filter((item) => item.reviewed !== true).map((item) => item.id)
  const unreviewedDiffs = manifest.visualDiffs.filter((item) => item.reviewed !== true).map((item) => item.id)
  const consoleErrors = manifest.console.filter((entry) => entry.level === 'error').map((entry) => entry.message)
  const networkErrors = manifest.network.filter((entry) => entry.error || entry.ok === false || entry.status === 'error' || (Number.isFinite(entry.status) && entry.status >= 400)).map((entry) => entry.url ?? entry.message ?? 'network error')
  const failedCriticalInteractions = manifest.interactions.filter((item) => item.critical === true && item.status !== 'passed').map((item) => item.id)
  const a11yBlockers = manifest.a11y.filter(unresolvedA11y).map((item) => item.id ?? item.message ?? 'a11y issue')
  if (manifest.reviewed !== true) blockers.push('manifest.reviewed must be true')
  if (unreviewedScreenshots.length) blockers.push(`unreviewed screenshots: ${unreviewedScreenshots.join(', ')}`)
  if (unreviewedDiffs.length) blockers.push(`unreviewed visual diffs: ${unreviewedDiffs.join(', ')}`)
  if (consoleErrors.length) blockers.push(`console errors: ${consoleErrors.join('; ')}`)
  if (networkErrors.length) blockers.push(`network errors: ${networkErrors.join('; ')}`)
  if (failedCriticalInteractions.length) blockers.push(`critical interactions not passed: ${failedCriticalInteractions.join(', ')}`)
  if (a11yBlockers.length) blockers.push(`a11y blockers: ${a11yBlockers.join(', ')}`)
  const functional = { ok: consoleErrors.length === 0 && networkErrors.length === 0 && failedCriticalInteractions.length === 0, consoleErrors, networkErrors, failedCriticalInteractions }
  const visual = { ok: manifest.reviewed === true && unreviewedScreenshots.length === 0 && unreviewedDiffs.length === 0, unreviewedScreenshots, unreviewedDiffs }
  const a11y = { ok: a11yBlockers.length === 0, blockers: a11yBlockers }
  const verdict = { ...manifest.verdict }
  const ok = blockers.length === 0 && functional.ok && visual.ok && a11y.ok && verdict.functional === 'pass' && verdict.visual === 'pass' && verdict.a11y === 'pass' && verdict.overall === 'pass'
  return { ok, reviewed: manifest.reviewed, blockers, functional, visual, a11y, verdict }
}
