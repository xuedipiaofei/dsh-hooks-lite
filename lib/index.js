/**
 * dsh-hooks-lite — a small, config-driven lifecycle hook plugin for DSH.
 *
 * It fills the same seam as Claude Code / Codex hooks with DSH-native
 * plumbing:
 *   - `tools/pre-execute` + `tools/post-execute` for tool lifecycle hooks;
 *   - `session/event` for turn/step/message/title hooks;
 *   - JSON payload on stdin + DSH_HOOK_* environment variables;
 *   - optional `$DSH_HOME/hooks.json` plus inline profile config;
 *   - `/hooks` and `/hooks-reload` commands.
 *
 * No client bundle, no GUI, no runtime dependencies.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import {
  CLAUDE_EVENT,
  DEFAULT_FILE,
  DEFAULT_TIMEOUT_MS,
  buildPayload,
  contentText,
  matchHook,
  parseHookList,
  pushRecentRun,
  renderHookList,
  renderRecentRuns,
  sessionEventPayload,
} from './config.js'
import { createRunner } from './runner.js'

export const name = 'dsh-hooks-lite'

/** Events delivered through `session/event` (tool events use the tool pipeline). */
const SESSION_EVENTS = new Set(['turn/end', 'step/end', 'user/message', 'session/title'])

function dshHome() {
  return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
}

function readHookFile(file) {
  if (!existsSync(file)) return { hooks: [], errors: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parseHookList(parsed?.hooks, file)
  } catch (error) {
    return {
      hooks: [],
      errors: [`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)}); file hooks skipped`],
    }
  }
}

function loadHooks(config) {
  const home = dshHome()
  const configured = config?.configFile
  const file = configured === undefined || configured === null || configured === ''
    ? join(home, DEFAULT_FILE)
    : isAbsolute(configured)
      ? configured
      : resolve(home, configured)
  const fileState = readHookFile(file)
  const inline = parseHookList(config?.hooks, 'config.hooks')
  const errors = [...fileState.errors, ...inline.errors]
  if (configured !== undefined && configured !== null && configured !== '' && !existsSync(file)) {
    errors.push(`${file}: configFile does not exist`)
  }
  return { file, hooks: [...fileState.hooks, ...inline.hooks], errors }
}

function sessionOf(exec) {
  return exec?.agent?.session ?? exec?.session
}

function cwdOf(session) {
  return session?.header?.cwd ?? process.cwd()
}

function resolveHookCwd(hook, sessionCwd) {
  if (hook.cwd === undefined || hook.cwd === '') return undefined
  if (hook.cwd === 'session') return sessionCwd
  return hook.cwd
}

function toolPayload(event, hookId, exec, session, result) {
  const tool = exec?.name
  const args = exec?.arguments
  const resultView = result === undefined
    ? undefined
    : {
        isError: result.isError === true,
        error: result.error?.message ?? result.error ?? null,
        ...(contentText(result.content) === undefined ? {} : { content: contentText(result.content) }),
      }
  return buildPayload({
    event,
    hookId,
    sessionId: session?.id,
    cwd: cwdOf(session),
    tool,
    args,
    ...(resultView === undefined ? {} : { result: resultView }),
  })
}

function failureReason(hook, outcome) {
  if (outcome.timedOut) return `hook "${hook.id}" timed out after ${hook.timeoutMs}ms`
  if (outcome.error !== undefined) return `hook "${hook.id}" failed: ${outcome.error}`
  const detail = (outcome.stderr ?? '').trim() || (outcome.stdout ?? '').trim()
  return detail === ''
    ? `hook "${hook.id}" blocked the tool (exit ${outcome.exitCode ?? '?'})`
    : `hook "${hook.id}" blocked the tool: ${detail.slice(0, 500)}`
}

/**
 * Wire hooks into one DSH context.
 * @param ctx - cordis host context.
 * @param config - `{ hooks?: HookSpec[], configFile?: string }`.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger
  let state = loadHooks(config)
  let hooks = state.hooks
  const warnings = [...state.errors]
  const recentRuns = []
  const runner = createRunner({
    logger,
    record: (record) => pushRecentRun(recentRuns, record),
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => runner.dispose(), 'dsh-hooks-lite: runner')
  }

  let warningsLogged = false
  const warnOnce = () => {
    if (warningsLogged) return
    warningsLogged = true
    for (const warning of warnings) logger?.warn?.(`[dsh-hooks-lite] ${warning}`)
  }
  warnOnce()

  const resolveCwd = (hook, session) => resolveHookCwd(hook, cwdOf(session))
  const enabledHooks = (event) => hooks.filter((hook) => hook.enabled && hook.on === event)

  /** Register a waterfall listener through ctx.effect when available. */
  const effect = (register, label) => {
    if (typeof ctx.effect === 'function') ctx.effect(register, label)
    else register()
  }

  effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    const session = sessionOf(exec)
    for (const hook of enabledHooks('pre-tool')) {
      if (!matchHook(hook, buildPayload({ event: 'pre-tool', hookId: hook.id, sessionId: session?.id, cwd: cwdOf(session), tool: exec?.name, args: exec?.arguments }), exec?.name)) continue
      const payload = toolPayload('pre-tool', hook.id, exec, session)
      const outcome = await runner.run(hook, payload, { cwd: resolveCwd(hook, session) })
      if (!outcome.ok && hook.block) return { kind: 'deny', reason: failureReason(hook, outcome) }
    }
    return next()
  }), 'dsh-hooks-lite: pre-tool')

  effect(() => ctx.on('tools/post-execute', (exec, result, next) => {
    const session = sessionOf(exec)
    for (const hook of enabledHooks('post-tool')) {
      if (!matchHook(hook, buildPayload({ event: 'post-tool', hookId: hook.id, sessionId: session?.id, cwd: cwdOf(session), tool: exec?.name, args: exec?.arguments, result: { isError: result?.isError === true } }), exec?.name)) continue
      const payload = toolPayload('post-tool', hook.id, exec, session, result)
      void runner.run(hook, payload, { cwd: resolveCwd(hook, session), background: true })
    }
    return next()
  }), 'dsh-hooks-lite: post-tool')

  effect(() => ctx.on('session/event', (session, event) => {
    if (!SESSION_EVENTS.has(event?.type)) return
    const payload = sessionEventPayload(session, event)
    for (const hook of enabledHooks(event.type)) {
      const hookPayload = { ...payload, hookId: hook.id }
      if (!matchHook(hook, hookPayload, undefined, false)) continue
      void runner.run(hook, hookPayload, { cwd: resolveCwd(hook, session), background: true })
    }
  }), 'dsh-hooks-lite: session events')

  const registerCommands = (commands) => {
    if (typeof commands?.register !== 'function') return
    effect(() => commands.register({
      name: 'hooks',
      description: 'List dsh-hooks-lite hooks, config warnings, and recent runs',
      handler: () => ({
        kind: 'success',
        text: [
          '# dsh-hooks-lite',
          `config file: ${state.file}${existsSync(state.file) ? '' : ' (not found)'}`,
          '',
          renderHookList(hooks, warnings),
          '',
          '# Recent runs',
          '',
          renderRecentRuns(recentRuns),
        ].join('\n'),
      }),
    }), 'dsh-hooks-lite: /hooks')

    effect(() => commands.register({
      name: 'hooks-reload',
      description: 'Re-read the hook config file and replace the active hook list',
      handler: () => {
        const next = loadHooks(config)
        state = next
        hooks = next.hooks
        warnings.push(...next.errors)
        warningsLogged = false
        warnOnce()
        return {
          kind: 'success',
          text: `reloaded ${hooks.length} hooks from ${next.file}\n\n${renderHookList(hooks, next.errors)}`,
        }
      },
    }), 'dsh-hooks-lite: /hooks-reload')
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (scope) => registerCommands(scope.commands))
  } else {
    registerCommands(ctx.get?.('commands'))
  }

  if (typeof ctx.logger?.info === 'function' && hooks.length > 0) {
    ctx.logger.info(`[dsh-hooks-lite] loaded ${hooks.length} hooks (${state.file})`)
  }
}

export { CLAUDE_EVENT, DEFAULT_TIMEOUT_MS }
