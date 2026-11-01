import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../lib/index.js'

const NODE = JSON.stringify(process.execPath)

class FakeCtx {
  constructor() {
    this.handlers = new Map()
    this.effects = []
    this.commands = []
    this.warnings = []
    this.logger = {
      info: () => {},
      warn: (line) => this.warnings.push(line),
    }
  }
  on(event, handler) {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return () => {
      this.handlers.set(event, (this.handlers.get(event) ?? []).filter((item) => item !== handler))
    }
  }
  effect(register) {
    const disposer = register()
    this.effects.push(disposer)
    return disposer
  }
  inject(names, callback) {
    callback({ commands: { register: (definition) => this.commands.push(definition) } })
  }
  get(name) {
    if (name === 'commands') return { register: (definition) => this.commands.push(definition) }
    return undefined
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('pre-tool: matching failing hook denies; success allows; block:false observes', async () => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-hooks-home-'))
  const ctx = new FakeCtx()
  apply(ctx, {
    configFile: join(process.env.DSH_HOME, 'hooks.json'),
    hooks: [
      { id: 'deny-rm', on: 'pre-tool', tools: ['bash'], match: { 'args.command': 'rm\\s+-rf' }, run: `${NODE} -e "process.exit(1)"` },
      { id: 'allow-edit', on: 'pre-tool', tools: ['edit'], run: `${NODE} -e "process.exit(0)"` },
      { id: 'observe-fail', on: 'pre-tool', tools: ['read'], block: false, run: `${NODE} -e "process.exit(2)"` },
    ],
  })
  const pre = ctx.handlers.get('tools/pre-execute')[0]
  const session = { id: 's1', header: { cwd: process.env.DSH_HOME } }
  const allow = () => ({ kind: 'allow' })

  const denied = await pre({ name: 'bash', arguments: { command: 'rm -rf build' }, agent: { session } }, allow)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /deny-rm/u)

  const allowed = await pre({ name: 'edit', arguments: { path: 'a.js' }, agent: { session } }, allow)
  assert.deepEqual(allowed, { kind: 'allow' })

  const observed = await pre({ name: 'read', arguments: { path: 'a.js' }, agent: { session } }, allow)
  assert.deepEqual(observed, { kind: 'allow' })
})

test('post-tool and turn/end hooks run without changing the pipeline', async () => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-hooks-home-'))
  const ctx = new FakeCtx()
  apply(ctx, {
    configFile: join(process.env.DSH_HOME, 'hooks.json'),
    hooks: [
      { id: 'after-edit', on: 'post-tool', tools: ['edit'], run: `${NODE} -e "process.exit(0)"` },
      { id: 'done', on: 'turn/end', when: ['completed'], run: `${NODE} -e "process.exit(0)"` },
    ],
  })
  const post = ctx.handlers.get('tools/post-execute')[0]
  const marker = { kind: 'accept' }
  const result = post({ name: 'edit', arguments: {}, agent: { session: { id: 's', header: { cwd: process.env.DSH_HOME } } } }, { isError: false, content: [] }, () => marker)
  assert.equal(result, marker)

  const onSession = ctx.handlers.get('session/event')[0]
  onSession(
    { id: 's', header: { cwd: process.env.DSH_HOME } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  )
  await wait(250)

  const command = ctx.commands.find((entry) => entry.name === 'hooks')
  assert.ok(command)
  const output = command.handler()
  assert.match(output.text, /after-edit/u)
  assert.match(output.text, /done/u)
  assert.match(output.text, /Recent runs/u)
})

test('/hooks-reload rereads the file and replaces hooks', () => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-hooks-home-'))
  const file = join(process.env.DSH_HOME, 'hooks.json')
  writeFileSync(file, JSON.stringify({ hooks: [{ id: 'from-file', on: 'pre-tool', run: `${NODE} -e "process.exit(0)"` }] }))
  const ctx = new FakeCtx()
  apply(ctx, { configFile: file, hooks: [{ id: 'inline', on: 'pre-tool', run: 'true' }] })
  const reload = ctx.commands.find((entry) => entry.name === 'hooks-reload')
  assert.ok(reload)
  writeFileSync(file, JSON.stringify({ hooks: [{ id: 'reloaded', on: 'pre-tool', run: 'true' }] }))
  const result = reload.handler()
  assert.match(result.text, /reloaded 2 hooks/u)
  assert.match(result.text, /reloaded/u)
})
