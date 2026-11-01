import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildPayload,
  contentText,
  getByPath,
  matchHook,
  normalizeHook,
  parseHookList,
  sessionEventPayload,
} from '../lib/config.js'

test('normalizes minimal and aliased hook entries', () => {
  const result = normalizeHook({
    id: 'lint',
    event: 'post-tool',
    command: 'npm run lint',
    tools: ['edit', 'write', 'edit'],
    timeoutMs: 1234.9,
    block: false,
    stdin: false,
  })
  assert.equal(result.ok, true)
  assert.equal(result.hook.on, 'post-tool')
  assert.equal(result.hook.run, 'npm run lint')
  assert.deepEqual(result.hook.tools, ['edit', 'write'])
  assert.equal(result.hook.timeoutMs, 1234)
  assert.equal(result.hook.block, false)
  assert.equal(result.hook.stdin, false)
})

test('rejects invalid events, commands, tools, and env', () => {
  assert.equal(normalizeHook({ id: 'x', on: 'nope', run: 'true' }).ok, false)
  assert.equal(normalizeHook({ id: 'x', on: 'pre-tool', run: '' }).ok, false)
  assert.equal(normalizeHook({ id: 'x', on: 'pre-tool', run: 'true', tools: [] }).ok, false)
  assert.equal(normalizeHook({ id: 'x', on: 'pre-tool', run: 'true', env: { 'BAD-KEY': 'v' } }).ok, false)
})

test('parses a list, keeps valid entries, and rejects duplicate ids', () => {
  const { hooks, errors } = parseHookList([
    { id: 'a', on: 'pre-tool', run: 'true' },
    { id: 'a', on: 'post-tool', run: 'true' },
    { id: 'b', on: 'turn/end', run: 'true', when: 'completed' },
    { id: 'c', on: 'unknown', run: 'true' },
  ])
  assert.deepEqual(hooks.map((hook) => hook.id), ['a', 'b'])
  assert.equal(errors.length, 2)
})

test('matches tools, when-reason, regex fields, and numeric comparisons', () => {
  const base = normalizeHook({ id: 'h', on: 'post-tool', run: 'true' }).hook
  const payload = {
    toolName: 'bash',
    reason: 'completed',
    tool: { name: 'bash' },
    data: { toolDurationMs: 12000, session: { title: 'hello' } },
  }
  assert.equal(matchHook(base, payload, 'bash'), true)
  assert.equal(matchHook({ ...base, tools: ['edit'] }, payload, 'bash'), false)
  assert.equal(matchHook({ ...base, when: ['error'] }, payload, 'bash'), false)
  assert.equal(matchHook({ ...base, when: ['completed'] }, payload, 'bash'), true)
  assert.equal(matchHook({ ...base, match: { toolName: '^ba' } }, payload, 'bash'), true)
  assert.equal(matchHook({ ...base, match: { 'tool.name': '^read' } }, payload, 'bash'), false)
  assert.equal(matchHook({ ...base, match: { 'data.toolDurationMs': { gt: 10000 } } }, payload, 'bash'), true)
  assert.equal(matchHook({ ...base, match: { 'data.toolDurationMs': '>10000' } }, payload, 'bash'), false)
  assert.equal(matchHook({ ...base, match: { 'data.session.title': 'hell' } }, payload, 'bash'), true)
  assert.equal(matchHook({ ...base, tools: ['edit'] }, { reason: 'completed' }, undefined, false), true)
})

test('dot paths, content text, and payload shapes', () => {
  assert.equal(getByPath({ a: { b: 3 } }, 'a.b'), 3)
  assert.equal(getByPath(null, 'a.b'), undefined)
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'image' }]), 'a\n[image]')
  const payload = buildPayload({
    event: 'pre-tool',
    hookId: 'h',
    sessionId: 's',
    cwd: '/tmp',
    tool: 'bash',
    args: { command: 'ls' },
  })
  assert.equal(payload.event, 'pre-tool')
  assert.equal(payload.eventName, 'PreToolUse')
  assert.deepEqual(payload.args, { command: 'ls' })
})

test('session event payload extracts reason, content, and title', () => {
  const session = { id: 's', header: { cwd: '/work' } }
  const event = {
    type: 'turn/end',
    data: { reason: { kind: 'completed' }, content: [{ type: 'text', text: 'done' }] },
  }
  const payload = sessionEventPayload(session, event)
  assert.equal(payload.event, 'turn/end')
  assert.equal(payload.sessionId, 's')
  assert.equal(payload.cwd, '/work')
  assert.equal(payload.reason, 'completed')
  assert.equal(payload.content, 'done')
  assert.equal(payload.eventName, 'Stop')
})
