# dsh-hooks-lite

[English](./README.md)

给 DeepSeek Harness 用的轻量、配置驱动生命周期 hooks。在
`cordis.patch.yml` 里声明「事件 → shell 命令」即可，不用写插件代码、没有
客户端 bundle、零运行时依赖。

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

## 为什么做这个

Claude Code / Codex 把「配置驱动的生命周期 hooks」做成了常见工作流。DSH
本身已经有合适的接缝——`tools/pre-execute`、`tools/post-execute` 和
`session/event`——但还缺一个足够轻的原生 hook 插件。

这个插件刻意做成**小版本**：

- **只有 Host 侧**：没有 Web GUI、没有审批弹窗、没有客户端代码
- **零运行时依赖**：纯 ESM + Node 子进程
- **工具 + 会话事件**：工具调用前拦截、调用后观察；回合完成、步骤结束、
  用户消息、标题变化都能触发
- **稳定 JSON 契约**：命令从 stdin 收到完整 payload，同时有 `DSH_HOOK_*`
  环境变量
- **配置可重载**：profile 内联配置 + 可选 `$DSH_HOME/hooks.json`；
  `/hooks-reload` 重读文件

它不是 `.claude/settings.json` 兼容层。要完整多 harness 格式请用专门的适配器；
这个插件保持 DSH 原生、配置短、行为可预测。

## 安装

从 npm：

```sh
dsh plugin --profile web add dsh-hooks-lite
```

从 GitHub：

```sh
dsh plugin --profile web add github:xuedipiaofei/dsh-hooks-lite
```

本地开发：

```sh
dsh plugin --profile demo add ./dsh-hooks-lite
```

bundle 只插入一行 `dsh-hooks-lite`。在 profile patch 里加 `config.hooks`，或创建
`$DSH_HOME/hooks.json`。

## 事件

| `on` | 触发时机 | 能否阻断 | 常用 payload |
|---|---|---|---|
| `pre-tool` | 模型工具调用前 | **可以**：非零退出会拒绝调用 | `toolName`、`args`、`sessionId`、`cwd` |
| `post-tool` | 工具调用结束后 | 不能 | `toolName`、`args`、`result.isError`、`result.content` |
| `turn/end` | 回合结束 | 不能 | `reason`（`completed` / `error` / `aborted` / `blocked` / `max-tokens` / `interrupted` / `forked`）、`content` |
| `step/end` | 步骤结束 | 不能 | `data` |
| `user/message` | 出现用户消息 | 不能 | `content`、`data.source.kind` |
| `session/title` | 会话标题变化 | 不能 | `title`、`data.source.kind` |

用 `when` 过滤回合结果：

```yaml
- id: notify-error
  on: turn/end
  when: [error, aborted]
  run: node hooks/notify-error.mjs
```

## 字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `id` | 自动 `hook-N` | hook 唯一标识 |
| `on` | 必填 | 上表事件（可用 `event` 别名） |
| `run` | 必填 | shell 命令（可用 `command` 别名） |
| `tools` | 全部工具 | 工具事件按工具名精确匹配；会话事件忽略 |
| `match` | 无 | 字段 → 正则，支持点路径（`args.command`、`data.source.kind`）；全部匹配才触发 |
| `when` | 无 | `turn/end` 的结束原因，字符串或数组 |
| `timeoutMs` | `10000` | 单次超时；pre-tool 超时会阻断 |
| `cwd` | 插件进程目录 | `session` 表示会话工作目录；其它值按路径处理 |
| `stdin` | `true` | 把完整 JSON payload 写入 stdin；`false` 时只用环境变量 |
| `block` | `true` | 仅 `pre-tool`：非零退出是否阻断；`false` 只观察 |
| `enabled` | `true` | 临时停用 |
| `env` | 无 | 给子进程追加环境变量 |

`match` 的值是正则，匹配字段的字符串形式；数字比较用对象：

```yaml
match:
  data.result.toolDurationMs: { gt: 10000 }
```

## Payload 与环境变量

命令从 stdin 收到一行 JSON：

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

`post-tool` 额外带 `result`；会话事件里 `event` 是 `turn/end` 等，可能带
`reason`、`content`、`title` 和原始 `data`。

环境变量：

```text
DSH_HOOK_ID, DSH_HOOK_EVENT, DSH_HOOK_CWD,
DSH_SESSION_ID, DSH_TOOL_NAME, CLAUDE_PROJECT_DIR
```

pre-tool hook 用非零退出拒绝调用；stderr（或 stdout）会成为拒绝原因：

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

## 命令

- `/hooks`：列出当前 hooks、配置警告、最近运行记录
- `/hooks-reload`：重读 `$DSH_HOME/hooks.json`；内联 hooks 保持不变

## 文件配置

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

默认路径 `$DSH_HOME/hooks.json`。可以在插件行里用 `configFile` 覆盖（相对路径
按 `$DSH_HOME` 解析）。内联 `config.hooks` 追加在文件 hooks 之后。

## 安全边界

hooks 是**受信任的 host 配置**：命令以 DSH host 进程权限运行，不在模型的工具
沙箱里。只启用你自己写或审查过的 hook。pre-tool 能阻断工具调用；
post-tool / 会话 hooks 是 fire-and-forget，不会改变模型输出。

## 开发

```sh
npm test          # 纯配置测试 + fake context 插件测试
npm run check     # 语法检查
```

## License

MIT © 2026 xuedipiaofei
