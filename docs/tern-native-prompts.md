# Tern-native guardrails prompts — research & plan

Goal: detect when guardrails runs inside [Tern](https://tern.build) and use Tern's
integrated interface for the dangerous-command prompt instead of the ANSI
pi-tui component — retrocompatible with every other runtime/terminal.

## Findings

### The bridge is TSP, already owned by the runtime

Tern (Stencil's Rust terminal) speaks the **Tern Surface Protocol (TSP) v1**
in-band on the pty: APC frames `ESC _ tsp;<verb>;…;ESC \`, a hello handshake
(`tsp;q` → `tsp;r` with `features[]`, `cols`, limits), surfaces rendered
natively by the terminal, and events (`key`, `act`, `focus`, `error`, `gone`)
flowing back. Wire shapes: `@oh-my-pi/pi-wire/src/tsp.ts` (`TSP_VERSION = 1`,
default APC chunk limit 65 536). Normative docs: `docs.stencil.so/tern/protocol`.

- **omp (oh-my-pi) already implements it.** omp 18.12.1 (the build Tern manages
  under `~/Library/Application Support/Tern/omp/versions/`) handshakes on
  startup and its TUI (`@oh-my-pi/pi-tui`) `describe()`s components into native
  nodes — overlay cards, select lists, action buttons with keycaps — when the
  handshake succeeded, and falls back to its own ANSI renderer otherwise.
  `/usage`, `/context`, `/jobs` already render as native Tern sheets.
- **Upstream pi (earendil-works, 1.3.0) has no TSP code at all** — verified
  against its dist. Any Tern-native rendering must therefore come from the
  *runtime*, never from an extension.

### Tern plugins cannot do this

Tern plugins are Luau modules (`tern plugin install github.com/OWNER/REPO`,
SDK docs at `docs.stencil.so/tern`). They get panes (`cx.session:panes()`),
surfaces, mailboxes, the blob dir — but **no visibility into another process's
pty byte stream**, so a plugin can never intercept omp's prompts. The existing
precedent `pi-tern` (Ghost-9) reaches Tern only via mailbox + `tern whoami`,
and explicitly refuses to write TSP frames from extension code: pi-tui frames
are multi-write synchronized-output transactions and a second writer tears
them. Conclusion: the bridge is the runtime's TSP support, consumed through
runtime APIs — not plugin code, not raw TSP from guardrails.

### Detection: env vars are enough

Every pane Tern spawns carries (verified in-session):

| Var | Meaning |
|---|---|
| `TERM_PROGRAM=tern` | Host identity |
| `TERN_PANE` / `TERN_PANE_SOCKET` | Pane id / daemon socket |
| `TERN_BLOB_DIR` | Binary blob exchange dir |
| `TERN_COMPLETE`, `TERN_LENSES`, `TERN_ACP` | Feature flags |

`isTernHost() = process.env.TERM_PROGRAM === "tern"`. Error directions are both
safe: nested tmux/screen eats the TSP handshake (env says tern, runtime renders
its ANSI dialog — fine); ssh doesn't forward the env (detection says not-tern,
current prompt stays — fine). The actual TSP state is runtime-internal and not
queryable from an extension in omp 18.12.1.

### The API already exists: `ctx.ui.askDialog`

omp's `ExtensionUIContext` (18.12.1) exposes optional native-capable dialogs:

- `askDialog?(questions, dialogOptions)` — rich ask dialog ("when the
  interactive TUI surface is available"). Questions take `id`, `question`,
  `header`, options `{ label, description, preview }`; under TSP the runtime
  draws it as a native sheet (overlay card + select list + action buttons);
  elsewhere it is an ANSI `AskDialogComponent`. Returns the selected option
  ids, or `undefined` on cancel/timeout.
- `approve?(prompt, dialogOptions)` — once/session/deny only. **Rejected**: no
  "Decline and stop" outcome, which the permission gate requires.
- Upstream pi 1.3.0 has **neither** `askDialog` nor `approve` on `ctx.ui` —
  only `select`/`confirm`/`custom`. So the new path must be an optional call
  with the current flow as fallback.

## Plan

### Change: one helper, three tiers

The permission gate has two identical confirmation blocks — the
`guardrails_run_anyway` tool (`extensions/permission-gate/index.ts` ~L317) and
the `bash` pre-exec hook (~L511). Extract a single helper
(`extensions/permission-gate/confirm.ts`):

```ts
confirmDangerousCommand(ctx, pi, {
  command, reason, metadata, meta?,   // agentReason/approvalId for tool path
}): Promise<"allow" | "allow-session" | "deny" | "stop">
```

Tiers inside the helper:

1. **Tern + omp (native)** — `isTernHost() && ctx.ui.askDialog` present:
   one question, `header: "guardrails"`, options
   `Allow once` / `Allow for session` / `Deny` (recommended) / `Decline and
   stop`, `description`s carrying the command + reason. Map selected option id
   back to `ConfirmResult`. On `undefined`, fall through to tier 3.
2. **omp/pi interactive (current look)** — `ctx.ui.custom` +
   `createPermissionGateConfirmComponent` exactly as today, with the existing
   `ctx.ui.select` fallback on `undefined`.
3. **Headless** — unchanged `ctx.hasUI` block path, handled by callers.

`GUARDRAILS_PROMPT_OPENED/CLOSED` events wrap the whole helper call once, in
each call site, as today.

Net effect in Tern: the runtime turns the ask dialog into a native Tern sheet
(keycaps, mouse, descriptions) with **zero TSP code in guardrails**. Outside
Tern: byte-identical behavior to today. Retrocompatible by construction —
optional call + runtime-owned fallback.

### Phases

1. **Pure refactor** — extract `confirmDangerousCommand`, both call sites use
   it, vitest green, no behavior change.
2. **Native branch** — `isTernHost()` util + askDialog tier + option-id
   mapping + undefined→select fallback. Unit tests: mocked `ctx.ui` spy
   asserting (a) mapping of all four ids, (b) `undefined` → select fallback,
   (c) custom-component path when `askDialog` is absent (pi), (d) events still
   emitted once.
3. **Live verification** — in Tern (this omp session): trigger a pattern-matched
   command in a sandbox dir, confirm the native sheet appears and each choice
   produces the right outcome. In a plain terminal: current ANSI prompt.
4. **Optional** — `preview` showing the full command; propose an upstream
   `ctx.ui.capabilities.nativeSurface` flag in omp to replace env sniffing
   (prefer it when present, env fallback otherwise).

### Risks / notes

- `ExtensionAskDialogResultItem`'s exact shape must be read from omp 18.12.1
  d.ts at implementation time; map by option `id`, not label.
- Tern manages the omp version (`versions/18.12.1` today) — version drift is
  covered by the optional call + fallback.
- Other guardrails custom UI (onboarding, path-access, examples) can adopt
  `askDialog`/`select` the same way later; out of scope here.
