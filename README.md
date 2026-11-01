# dsh-hooks-lite

[中文](./README.zh.md)

Lightweight, config-driven lifecycle hooks for DeepSeek Harness. Declare
`event → shell command` in `cordis.patch.yml`; no plugin code, no client bundle,
no runtime dependencies.

```yaml
- id: dsh-hooks-lite
  name: dsh-hooks-lite
  config:
    hooks:
      - id: guard-rm
        on: pre-tool
        tools: [bash, pwsh]
        match:
          args.command: 'rm\s+-rf'
        run: node hooks/guard.mjs
      - id: lint-after-edit
        on: post-tool
        tools: [edit, write]
        run: npm run lint -- --quiet
        timeoutMs: 30000
      - id: notify-done
        on: turn/end
        when: completed
        run: node hooks/notify.mjs
```

## Why this exists

Claude Code and Codex popularized configuration-driven lifecycle hooks. DSH
already has the right seams — `tools/pre-execute`, `tools/post-execute`, and
`session/event` — but no small first-party-style hook plugin.

This plugin is deliberately the **small version** of that idea:

- **Host only.** No Web GUI, no approval flow, no client bundle.
- **Zero runtime dependencies.** Pure ESM + Node child processes.
- **Tool and session events.** Block before a tool call; observe after it;
  react to completed turns, steps, user messages, and title changes.
- **JSON contract.** Every command gets a stable JSON payload on stdin and
  `DSH_HOOK_*` environment variables.
- **Reloadable config.** Inline profile config plus optional
  `$DSH_HOME/hooks.json`; `/hooks-reload` rereads the file.

It is not a compatibility layer for `.claude/settings.json`. If you need the
full multi-harness format, use a dedicated adapter; this one keeps the config
DSH-native and readable.

## Install

From npm:

```sh
dsh plugin --profile web add dsh-hooks-lite
```

From GitHub:

```sh
dsh plugin --profile web add github:xuedipiaofei/dsh-hooks-lite
```

For local development:

```sh
dsh plugin --profile demo add ./dsh-hooks-lite
```

The bundle inserts one `dsh-hooks-lite` row. Add your `config.hooks` to the
profile patch, or create `$DSH_HOME/hooks.json`.

## Events

| `on` | When | Can block? | Useful payload |
|---|---|---|---|
| `pre-tool` | Before a model tool call | **Yes** — nonzero exit denies the call | `toolName`, `args`, `sessionId`, `cwd` |
| `post-tool` | After a tool call settles | No | `toolName`, `args`, `result.isError`, `result.content` |
| `turn/end` | A turn ends | No | `reason` (`completed`, `error`, `aborted`, `blocked`, `max-tokens`, `interrupted`, `forked`), `content` |
| `step/end` | A step ends | No | `data` |
| `user/message` | A user-role message appears | No | `content`, `data.source.kind` |
| `session/title` | Session title changes | No | `title`, `data.source.kind` |

Filter a turn by reason with `when`:

```yaml
- id: notify-error
  on: turn/end
  when: [error, aborted]
  run: node hooks/notify-error.mjs
```

## Fields

| Field | Default | Meaning |
|---|---|---|
| `id` | auto `hook-N` | Stable hook id; must be unique |
| `on` | required | Event from the table above (`event` is accepted as an alias) |
| `run` | required | Shell command (`command` is accepted as an alias) |
| `tools` | all tools | Exact tool names for tool events; ignored by session events |
| `match` | none | Field → regex; dotted paths work (`args.command`, `data.source.kind`). All fields must match |
| `when` | none | `turn/end` reason or reasons |
| `timeoutMs` | `10000` | Per-run timeout; a timed-out pre-tool hook blocks |
| `cwd` | plugin process cwd | `session` uses the session cwd; anything else is a path |
| `stdin` | `true` | Write the full JSON payload to stdin; `false` only uses env |
| `block` | `true` | For `pre-tool`: nonzero exit denies the call; `false` observes only |
| `enabled` | `true` | Disable without deleting |
| `env` | none | Extra environment variables for the child |

`match` values are regular expressions tested against the field's string form.
Use object comparators for numbers:

```yaml
match:
  data.result.toolDurationMs: { gt: 10000 }
```

## Payload and environment

Every command receives one JSON document on stdin:

```json
{
  "source": "dsh-hooks-lite",
  "event": "pre-tool",
  "eventName": "PreToolUse",
  "hookId": "guard-rm",
  "sessionId": "session-...",
  "cwd": "/path/to/project",
  "toolName": "bash",
  "args": { "command": "rm -rf build" }
}
```

`post-tool` adds `result`; session events use `event` (e.g. `turn/end`) and may
carry `reason`, `content`, `title`, and the raw `data` object.

Environment:

```text
DSH_HOOK_ID, DSH_HOOK_EVENT, DSH_HOOK_CWD,
DSH_SESSION_ID, DSH_TOOL_NAME, CLAUDE_PROJECT_DIR
```

A pre-tool hook can deny the call by exiting nonzero. Its stderr (or stdout)
becomes the denial reason:

```js
// hooks/guard.mjs
const payload = JSON.parse(await new Promise((resolve) => {
  let body = ''
  process.stdin.on('data', (chunk) => (body += chunk))
  process.stdin.on('end', () => resolve(body))
}))
if (payload.args.command.includes('rm -rf')) {
  console.error('refusing destructive command')
  process.exit(1)
}
```

## Commands

- `/hooks` — configured hooks, config warnings, recent runs.
- `/hooks-reload` — reread `$DSH_HOME/hooks.json`; inline hooks remain.

## File config

```json
{
  "hooks": [
    {
      "id": "from-file",
      "on": "post-tool",
      "tools": ["edit"],
      "run": "npm run lint"
    }
  ]
}
```

Default path: `$DSH_HOME/hooks.json`. Override with
`configFile` in the plugin row (relative paths resolve against `$DSH_HOME`).
Inline `config.hooks` is appended after file hooks.

## Safety

Hooks are **trusted host configuration**: commands run with the DSH host
process's permissions, not inside the model's tool sandbox. Only enable hooks
you wrote or reviewed. A pre-tool hook can block tool calls; post/session hooks
are fire-and-forget and never change model output.

## Development

```sh
npm test          # pure config tests + fake-context plugin tests
npm run check     # syntax checks
```

## License

MIT © 2026 xuedipiaofei
