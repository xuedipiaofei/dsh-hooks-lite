/**
 * Minimal shell-command runner for hook commands.
 *
 * Hooks are trusted host configuration; this deliberately uses
 * `spawn(command, { shell: true })` rather than the DSH shell executor, so it
 * works in every composition (including ones without a shell provider) and
 * never touches the model-facing shell tool or its sandbox policy.
 */
import { spawn } from 'node:child_process'

const MAX_CAPTURE_BYTES = 32 * 1024

function cap(text) {
  if (Buffer.byteLength(text, 'utf8') <= MAX_CAPTURE_BYTES) return text
  return Buffer.from(text, 'utf8')
    .subarray(0, MAX_CAPTURE_BYTES)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')
}

function terminate(child) {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref()
    } catch {
      // fall through to the direct kill
    }
  }
  try {
    child.kill()
  } catch {
    // already gone
  }
}

function envFor(hook, payload, cwd) {
  const env = { ...process.env, ...(hook.env ?? {}) }
  env.DSH_HOOK_ID = hook.id
  env.DSH_HOOK_EVENT = hook.on
  env.DSH_HOOK_CWD = cwd
  env.CLAUDE_PROJECT_DIR = cwd
  if (payload.sessionId !== null && payload.sessionId !== undefined) {
    env.DSH_SESSION_ID = String(payload.sessionId)
  }
  if (payload.toolName !== undefined) env.DSH_TOOL_NAME = payload.toolName
  return env
}

/**
 * Run one command with a supplied spawn function. Resolves a terminal outcome
 * for every path (nonzero exit, timeout, spawn error); it never rejects.
 */
function runWithSpawn(doSpawn, hook, payload, { cwd, logger, background = false } = {}) {
  const workdir = cwd ?? process.cwd()
  const startedAt = Date.now()
  const input = hook.stdin !== false ? JSON.stringify(payload) : undefined
  return new Promise((resolve) => {
    let child
    try {
      child = doSpawn(hook.run, {
        shell: true,
        cwd: workdir,
        env: envFor(hook, payload, workdir),
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      resolve({ ok: false, exitCode: null, timedOut: false, durationMs: Date.now() - startedAt, error: message, stdout: '', stderr: '' })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timer

    const finish = (outcome) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      const result = {
        ok: outcome.ok,
        exitCode: outcome.exitCode ?? null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: cap(stdout),
        stderr: cap(stderr),
        signal: outcome.signal ?? null,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      }
      if (!result.ok) {
        const detail = result.stderr.trim() || result.stdout.trim() || result.error
        if (detail !== undefined && detail !== '') {
          logger?.warn?.(`[dsh-hooks-lite] ${hook.id} (${hook.on}) failed: ${detail.slice(0, 300)}`)
        }
      }
      resolve(result)
    }

    child.once('error', (error) => finish({ ok: false, exitCode: null, error: error.message }))
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('close', (code, signal) => finish({ ok: code === 0, exitCode: code, signal }))

    timer = setTimeout(() => {
      timedOut = true
      terminate(child)
      finish({ ok: false, exitCode: null, error: 'timeout' })
    }, hook.timeoutMs)

    if (input !== undefined && child.stdin !== null) {
      child.stdin.on('error', () => {})
      child.stdin.write(input)
      child.stdin.end()
    }
    if (background) child.unref()
  })
}

/**
 * Run one hook command (not tied to a plugin lifetime).
 * @param hook - normalized hook.
 * @param payload - plain JSON payload.
 * @param options - `{ cwd, logger, background }`.
 */
export function runHookCommand(hook, payload, options = {}) {
  return runWithSpawn(spawn, hook, payload, options)
}

/**
 * Runner owning its child processes so plugin teardown can terminate them.
 * @param options - `{ logger, record }`.
 */
export function createRunner({ logger, record } = {}) {
  const children = new Set()
  let disposed = false
  const trackedSpawn = (...args) => {
    const child = spawn(...args)
    children.add(child)
    child.once('close', () => children.delete(child))
    return child
  }

  return {
    async run(hook, payload, { cwd, background = false } = {}) {
      if (disposed) {
        return { ok: false, exitCode: null, timedOut: false, durationMs: 0, error: 'disposed', stdout: '', stderr: '' }
      }
      const outcome = await runWithSpawn(trackedSpawn, hook, payload, { cwd, logger, background })
      record?.({ hookId: hook.id, event: hook.on, tool: payload.toolName, at: Date.now(), ...outcome })
      return outcome
    },
    dispose() {
      disposed = true
      for (const child of children) terminate(child)
      children.clear()
    },
  }
}
