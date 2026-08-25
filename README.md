![banner](https://github.com/yurifrl/pi-guardrails/raw/main/banner.png)

# Guardrails

Guardrails adds safety checks to Pi so agents are less likely to read secrets, write protected files, access paths outside the workspace, or run dangerous shell commands by accident.

This package installs four Pi extensions:

- **guardrails** for file protection policies, settings, onboarding, and examples.
- **path-access** for controlling access outside the current workspace.
- **permission-gate** for confirming or blocking risky shell commands.
- **herdr** for reporting Guardrails approval prompts to Herdr.

---

## Fork additions (yurifrl)

This is a fork of [`yurifrl/pi-guardrails`](https://github.com/yurifrl/pi-guardrails). Everything below this section is unchanged upstream behaviour. The additions live entirely inside `permission-gate`.

### Guidance

Soft-block dangerous commands with an educational message instead of immediately prompting the user. Add a `guidance` field to any entry in `permissionGate.customPatterns`, or add entries to the top-level `guidanceOnlyPatterns` array:

```json
{
  "permissionGate": {
    "customPatterns": [
      {
        "pattern": "git push.*(--force|-f)",
        "description": "force push",
        "guidance": "Force push is gated — your rules say NEVER force push. STOP and ask the user.",
        "regex": true
      }
    ]
  },
  "guidanceOnlyPatterns": [
    {
      "pattern": "(^|[^a-zA-Z0-9_])op\\s",
      "guidance": "op (1Password CLI) reads secrets — route THROUGH 1Password, never copy raw secrets to disk.",
      "regex": true
    }
  ]
}
```

When a guidance pattern matches, the agent receives the guidance message and is told to call the `guardrails_run_anyway` tool if it still wants to proceed. The command then runs through the full normal gate — auto-deny still blocks, and dangerous commands still show the user a confirmation prompt.

The approval id is single-use and expires after 5 minutes. The system prompt is automatically extended with instructions explaining this flow whenever guidance patterns are configured.

### YOLO mode

Skip all confirmation prompts and auto-deny blocks for the session:

```text
/guardrails:yolo on
/guardrails:yolo off
/guardrails:yolo status
/guardrails:yolo:on
/guardrails:yolo:off
```

`/guardrails:yolo:on` and `/guardrails:yolo:off` are fixed-outcome aliases for scripting (no args to parse). Yolo mode can also be set at launch:

```bash
pi --guardrails-yolo=on
GUARDRAILS_YOLO=on pi
```

Precedence: `--guardrails-yolo` flag > `GUARDRAILS_YOLO` env > `permissionGate.yolo` config. YOLO bypasses guidance, auto-deny blocks, and confirmation prompts. To keep auto-deny patterns active in YOLO mode, set `permissionGate.yoloRespectAutoDeny: true` in your config.

### `guardrails_run_anyway` tool

Registered automatically by `permission-gate`. The agent calls this tool after reading a guidance message and deciding to proceed. It accepts the single-use id from the block message and a required `reason` explaining why it's proceeding, resolves the stored command, and runs it through the full gate (auto-deny + user confirmation if dangerous). The reason is displayed above the command in the tool call UI.

### Config example

```json
{
  "permissionGate": {
    "yolo": false,
    "yoloRespectAutoDeny": false,
    "customPatterns": [
      {
        "pattern": "\\brm\\s",
        "description": "delete files",
        "guidance": "rm is gated — for source under version control, move to trash path instead. rm is fine only for .agents/tmp, build outputs, or already-committed files.",
        "regex": true
      },
      {
        "pattern": "git stash",
        "description": "stash uncommitted work",
        "guidance": "git stash is gated — it hides uncommitted work and is easy to lose track of. Prefer committing instead."
      }
    ]
  },
  "guidanceOnlyPatterns": [
    {
      "pattern": "(^|[^a-zA-Z0-9_])op\\s",
      "guidance": "op (1Password CLI) will ask for user input — avoid using it or do all you can before requesting user attention.",
      "regex": true
    }
  ]
}
```

---

## Install

```bash
pi install git@github.com:yurifrl/pi-guardrails.git
```

## First run

After installing, run the onboarding command to choose a starting setup:

```text
/guardrails:onboarding
```

[Guardrails onboarding walkthrough](https://github.com/yurifrl/pi-guardrails)

You can change everything later with:

```text
/guardrails:settings
```

## Included extensions

### guardrails

The `guardrails` extension owns file protection policies and the user-facing commands.

Use it to protect files like `.env`, private keys, local credentials, generated logs, database dumps, or any project-specific path you do not want Pi to read or modify without clear intent.

[Guardrails policies and settings walkthrough](https://github.com/yurifrl/pi-guardrails)

Useful commands:

```text
/guardrails:settings
/guardrails:onboarding
/guardrails:examples
```

#### Herdr integration

The included Herdr adapter reports active Guardrails approval prompts through Herdr's `herdr:blocked` event. Herdr can then show the Pi pane as blocked while it waits for a permission-gate or path-access decision.

The adapter has no configuration or direct Herdr dependency. Its emitted events have no effect unless Herdr's Pi integration is active.

### path-access

The `path-access` extension checks tool calls that target paths outside the current working directory.

It can allow, block, or ask before Pi accesses files elsewhere on your machine. In ask mode, you can allow one file or a directory once, for the session, or always.

Granted paths are stored in `pathAccess.allowedPaths` as explicit `{ kind, path }` entries: `file` matches the exact path, `directory` matches the directory and its descendants. Edit them through `/guardrails:settings` (Path Access → Allowed paths, Tab toggles file/directory) or directly in the settings file. Paths support `~/` for home. Existing configs using the legacy string form (trailing `/` for directories) are migrated automatically.

[Guardrails path access prompt walkthrough](https://github.com/yurifrl/pi-guardrails)

### permission-gate

The `permission-gate` extension detects dangerous bash commands before they run.

It catches built-in risky patterns like recursive deletes, privileged commands, disk formatting, broad permission changes, and configured custom patterns. You can allow once, allow for the session, deny, decline and stop (which also aborts the current turn), or configure auto-deny rules.

[Guardrails permission gate walkthrough](https://github.com/yurifrl/pi-guardrails)

## Extension events

Guardrails emits paired prompt lifecycle events on Pi's shared event bus:

- Global: `~/.pi/agent/extensions/guardrails.json`
- Project: `.pi/extensions/guardrails.json`

Guardrails writes a `$schema` field to saved settings files, so modern editors provide autocomplete and validation. The generated schema is committed at [`schema.json`](schema.json).

## Examples

Use the examples command to add common policy and command presets without replacing your existing config:

```text
/guardrails:examples
```

[Guardrails examples command walkthrough](https://github.com/yurifrl/pi-guardrails)

The available presets live in [`extensions/guardrails/commands/settings/examples.ts`](extensions/guardrails/commands/settings/examples.ts).

## Similar but different

Pi is designed to make agent safety extensible. Guardrails focuses on deterministic, configurable file policies, outside-workspace path access, and dangerous-command prompts. Other packages tend to fall into two useful groups.

See [pi.dev/packages](https://pi.dev/packages) for the full registry of Pi extensions.

### Make one yourself!

If Guardrails or the alternatives below do not fit your needs, you can also make your own. Start from the [Pi permission gate example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/permission-gate.ts), then ask Pi to customize it for your workflow.

### Permission and policy gates

These packages add checks around tool calls before they run. They are closest to Guardrails when you want policy enforcement without changing where Pi executes.

- [@gotgenes/pi-permission-system](https://pi.dev/packages/%40gotgenes/pi-permission-system): broad permission enforcement for Pi tool calls.
- [@vtstech/pi-security](https://pi.dev/packages/%40vtstech/pi-security): command, path, network, mode, and audit controls.
- [pi-control](https://github.com/mcowger/pi-control/blob/main/README.md): location-scoped, action-based policies for tool calls, with allow, log, ask, and deny outcomes before execution.
- [@casualjim/pi-heimdall](https://pi.dev/packages/%40casualjim/pi-heimdall): secret exposure guards, command policies, protected `.env` files, and a sandbox guard.
- [pi-file-permissions](https://pi.dev/packages/pi-file-permissions): file-level permissions for read, write, edit, find, grep, and ls tools.
- [pi-secret-guard](https://pi.dev/packages/pi-secret-guard): focused protection against committing or pushing secrets to git.

### Sandboxes and containment

These packages reduce blast radius by running Pi, subagents, or tool calls inside a constrained environment. They can be a better fit when you want isolation first and prompts second.

- [Pi + Gondolin sandbox example](https://github.com/earendil-works/gondolin/blob/main/host/examples/pi-gondolin.ts): upstream example that runs Pi tools inside a Gondolin micro-VM.
- [pi-sandbox](https://pi.dev/packages/pi-sandbox): OS-level sandboxing for bash, with allow/deny checks and prompts for file tools.
- [pi-container-sandbox](https://pi.dev/packages/pi-container-sandbox): runs read, write, edit, bash, and user bash operations inside a Docker or Apple container session.
- [@alexanderfortin/pi-freestyle-sandbox](https://pi.dev/packages/%40alexanderfortin/pi-freestyle-sandbox): runs sandboxed subagents in Freestyle cloud VMs.
- [@the-agency/vmpi](https://pi.dev/packages/%40the-agency/vmpi): runs Pi inside a QEMU microVM with limited filesystem and network access.
- [pi-claude-sandbox](https://pi.dev/packages/pi-claude-sandbox): Claude-style OS sandboxing with interactive permission prompts.

## Development

```bash
pnpm test         # Run tests
pnpm test:watch   # Run tests in watch mode
pnpm typecheck    # Type check
pnpm lint         # Lint
pnpm format       # Format
pnpm gen:schema   # Regenerate schema.json
pnpm check:schema # Verify schema.json is current
```
