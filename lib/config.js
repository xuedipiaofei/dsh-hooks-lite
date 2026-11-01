/**
 * Pure configuration and matching logic for dsh-hooks-lite.
 *
 * No cordis, node:fs, or child_process imports live here, so every rule can
 * be unit tested without a running harness.
 */

/** Hook events this plugin understands. */
export const HOOK_EVENTS = Object.freeze([
  'pre-tool',
  'post-tool',
  'turn/end',
  'step/end',
  'user/message',
  'session/title',
])

/** Claude-compatible event name carried in the payload for familiarity. */
export const CLAUDE_EVENT = Object.freeze({
  'pre-tool': 'PreToolUse',
  'post-tool': 'PostToolUse',
  'turn/end': 'Stop',
  'step/end': 'StepEnd',
  'user/message': 'UserPromptSubmit',
  'session/title': 'SessionTitle',
})

export const RECENT_RUNS_LIMIT = 20
export const DEFAULT_TIMEOUT_MS = 10_000
export const DEFAULT_FILE = 'hooks.json'

const NUMBER_COMPARATORS = new Set(['gt', 'gte', 'lt', 'lte', 'eq'])

/** Split a dotted path into segments; an empty path is invalid. */
export function pathSegments(path) {
  if (typeof path !== 'string' || path.trim() === '') return []
  return path.split('.').map((segment) => segment.trim()).filter(Boolean)
}

/** Read a nested value without throwing on null/undefined intermediates. */
export function getByPath(value, path) {
  const segments = pathSegments(path)
  let current = value
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = current[segment]
  }
  return current
}

/** Human-readable one-line text from a DSH content block array. */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'file') parts.push('[file]')
  }
  return parts.join('\n').trim()
}

/**
 * Validate and normalize one hook entry.
 * @param entry - raw object from config or hooks.json.
 * @param index - position for an auto-generated id.
 * @returns `{ ok, hook }` or `{ ok:false, error }`.
 */
export function normalizeHook(entry, index = 0) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, error: 'hook entry must be an object' }
  }
  const rawId = entry.id
  const id =
    typeof rawId === 'string' && rawId.trim() !== ''
      ? rawId.trim()
      : typeof entry.name === 'string' && entry.name.trim() !== ''
        ? entry.name.trim()
        : `hook-${index + 1}`
  const on = entry.on ?? entry.event
  if (!HOOK_EVENTS.includes(on)) {
    return { ok: false, error: `hook "${id}": on/event must be one of ${HOOK_EVENTS.join(', ')}` }
  }
  const run = entry.run ?? entry.command
  if (typeof run !== 'string' || run.trim() === '') {
    return { ok: false, error: `hook "${id}": run/command must be a non-empty string` }
  }
  if (entry.tools !== undefined && entry.tools !== null) {
    if (
      !Array.isArray(entry.tools) ||
      entry.tools.length === 0 ||
      entry.tools.some((tool) => typeof tool !== 'string' || tool.trim() === '')
    ) {
      return { ok: false, error: `hook "${id}": tools must be a non-empty array of tool names` }
    }
  }
  if (entry.match !== undefined && entry.match !== null) {
    if (typeof entry.match !== 'object' || Array.isArray(entry.match)) {
      return { ok: false, error: `hook "${id}": match must be an object` }
    }
  }
  if (entry.when !== undefined && entry.when !== null) {
    const values = Array.isArray(entry.when) ? entry.when : [entry.when]
    if (values.some((value) => typeof value !== 'string' || value.trim() === '')) {
      return { ok: false, error: `hook "${id}": when must be a string or an array of strings` }
    }
  }
  if (
    entry.timeoutMs !== undefined &&
    (!Number.isFinite(Number(entry.timeoutMs)) || Number(entry.timeoutMs) <= 0)
  ) {
    return { ok: false, error: `hook "${id}": timeoutMs must be a positive number` }
  }
  if (entry.env !== undefined && entry.env !== null) {
    if (typeof entry.env !== 'object' || Array.isArray(entry.env)) {
      return { ok: false, error: `hook "${id}": env must be an object` }
    }
    for (const [key, value] of Object.entries(entry.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') {
        return { ok: false, error: `hook "${id}": env entries must be string keys and string values` }
      }
    }
  }
  const cwd = entry.cwd
  if (cwd !== undefined && cwd !== null && typeof cwd !== 'string') {
    return { ok: false, error: `hook "${id}": cwd must be "session" or a directory path` }
  }
  return {
    ok: true,
    hook: {
      id,
      on,
      run: run.trim(),
      tools: entry.tools === undefined || entry.tools === null
        ? undefined
        : [...new Set(entry.tools.map((tool) => tool.trim()))],
      match: entry.match === undefined || entry.match === null ? undefined : { ...entry.match },
      when: entry.when === undefined || entry.when === null
        ? undefined
        : (Array.isArray(entry.when) ? [...entry.when] : [entry.when]).map((value) => value.trim()),
      timeoutMs: entry.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Math.trunc(Number(entry.timeoutMs)),
      cwd: cwd === undefined || cwd === null ? undefined : cwd.trim(),
      stdin: entry.stdin !== false,
      block: entry.block !== false,
      enabled: entry.enabled !== false,
      env: entry.env === undefined || entry.env === null
        ? undefined
        : Object.fromEntries(Object.entries(entry.env).map(([key, value]) => [key, String(value)])),
    },
  }
}

/**
 * Normalize a list of hooks, keeping valid entries and collecting errors.
 * @param rawHooks - candidate array.
 * @param source - label used in error text (`config.hooks` or a file path).
 */
export function parseHookList(rawHooks, source = 'hooks') {
  if (rawHooks === undefined || rawHooks === null) return { hooks: [], errors: [] }
  if (!Array.isArray(rawHooks)) return { hooks: [], errors: [`${source}: hooks must be an array`] }
  const hooks = []
  const errors = []
  const seen = new Set()
  rawHooks.forEach((entry, index) => {
    const result = normalizeHook(entry, index)
    if (!result.ok) {
      errors.push(`${source}: ${result.error}`)
      return
    }
    if (seen.has(result.hook.id)) {
      errors.push(`${source}: hook "${result.hook.id}": duplicate id (later entry dropped)`)
      return
    }
    seen.add(result.hook.id)
    hooks.push(result.hook)
  })
  return { hooks, errors }
}

/** Compile one match value into a predicate over the field's string form. */
function matchOne(expected, actual) {
  if (expected === undefined || expected === null) return true
  if (typeof expected === 'object' && !Array.isArray(expected)) {
    const numeric = Number(actual)
    if (!Number.isFinite(numeric)) return false
    for (const [operator, raw] of Object.entries(expected)) {
      if (!NUMBER_COMPARATORS.has(operator)) return false
      const target = Number(raw)
      if (!Number.isFinite(target)) return false
      if (operator === 'gt' && !(numeric > target)) return false
      if (operator === 'gte' && !(numeric >= target)) return false
      if (operator === 'lt' && !(numeric < target)) return false
      if (operator === 'lte' && !(numeric <= target)) return false
      if (operator === 'eq' && numeric !== target) return false
    }
    return true
  }
  if (typeof expected !== 'string') return false
  if (actual === undefined || actual === null) return false
  const text = typeof actual === 'object' ? JSON.stringify(actual) : String(actual)
  try {
    return new RegExp(expected, 'u').test(text)
  } catch {
    return false
  }
}

/**
 * Whether one hook applies to a payload.
 * @param hook - normalized hook.
 * @param payload - plain hook payload.
 * @param toolName - optional tool name for tool events.
 */
export function matchHook(hook, payload, toolName, isToolEvent = true) {
  if (hook.enabled === false) return false
  if (isToolEvent && hook.tools !== undefined) {
    if (toolName === undefined || !hook.tools.includes(toolName)) return false
  }
  if (hook.when !== undefined) {
    const reason =
      payload.reason ??
      payload.data?.reason ??
      payload.reasonKind
    if (reason === undefined || !hook.when.includes(String(reason))) return false
  }
  if (hook.match !== undefined) {
    for (const [path, expected] of Object.entries(hook.match)) {
      const actual = getByPath(payload, path)
      if (!matchOne(expected, actual)) return false
    }
  }
  return true
}

/** Extract a session event's compact payload fields without leaking live objects. */
export function sessionEventPayload(session, event) {
  const data = event?.data
  const reason = data?.reason
  return {
    source: 'dsh-hooks-lite',
    event: event?.type,
    eventName: CLAUDE_EVENT[event?.type] ?? event?.type,
    sessionId: session?.id ?? null,
    cwd: session?.header?.cwd ?? null,
    data: data === undefined ? null : data,
    reason:
      reason === null || reason === undefined
        ? undefined
        : typeof reason === 'object'
          ? (reason.kind ?? reason)
          : reason,
    content: contentText(data?.content) ?? contentText(data?.message?.content) ?? undefined,
    title:
      typeof data?.title === 'string'
        ? data.title
        : typeof data?.snapshot?.title === 'string'
          ? data.snapshot.title
          : undefined,
  }
}

/** Build the JSON payload delivered on stdin and used by match paths. */
export function buildPayload({ event, hookId, sessionId, cwd, tool, args, result, data, reason, content, title, extra }) {
  const payload = {
    source: 'dsh-hooks-lite',
    event,
    eventName: CLAUDE_EVENT[event] ?? event,
    hookId,
    sessionId: sessionId ?? null,
    cwd: cwd ?? null,
  }
  if (tool !== undefined) payload.toolName = tool
  if (args !== undefined) payload.args = args
  if (result !== undefined) payload.result = result
  if (data !== undefined) payload.data = data
  if (reason !== undefined) payload.reason = reason
  if (content !== undefined) payload.content = content
  if (title !== undefined) payload.title = title
  if (extra !== undefined) Object.assign(payload, extra)
  return payload
}

/** Render the configured hook list for `/hooks`. */
export function renderHookList(hooks, errors = []) {
  const lines = []
  if (hooks.length === 0) lines.push('未配置 hook。在 profile 的 cordis.patch.yml 里给 dsh-hooks-lite 加 `config.hooks`。')
  else {
    for (const hook of hooks) {
      const filter = []
      if (hook.tools !== undefined) filter.push(`tools=${hook.tools.join('|')}`)
      if (hook.when !== undefined) filter.push(`when=${hook.when.join('|')}`)
      if (hook.match !== undefined) filter.push(`match=${Object.keys(hook.match).join(',')}`)
      lines.push(
        `- ${hook.enabled ? '●' : '○'} ${hook.id}  [${hook.on}]  ${filter.join(' ') || 'always'}\n    $ ${hook.run}`,
      )
    }
  }
  if (errors.length > 0) lines.push('', '配置警告：', ...errors.map((error) => `! ${error}`))
  return lines.join('\n')
}

/** Render recent hook runs for `/hooks`. */
export function renderRecentRuns(runs) {
  if (runs.length === 0) return '暂无运行记录。'
  return runs.map((run) => {
    const status = run.ok ? 'ok' : `exit ${run.exitCode ?? '?'}${run.timedOut ? ' timeout' : ''}`
    const where = run.tool === undefined ? run.event : `${run.event}/${run.tool}`
    return `- ${new Date(run.at).toISOString()}  ${run.hookId}  (${where})  ${status}  ${run.durationMs}ms${run.error ? `  ${run.error}` : ''}`
  }).join('\n')
}

/** Push one run to the bounded recent-runs ring. */
export function pushRecentRun(runs, record) {
  runs.unshift(record)
  if (runs.length > RECENT_RUNS_LIMIT) runs.length = RECENT_RUNS_LIMIT
  return runs
}
