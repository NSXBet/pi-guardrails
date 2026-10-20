import { exec as nodeExec } from "node:child_process";
import { promisify } from "node:util";
import {
  type AgentToolResult,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { checkAction } from "../../src/core";
import { configLoader } from "../../src/shared/config";
import {
  createFeatureRegisterPayload,
  createPromptClosedPayload,
  createPromptOpenedPayload,
  emitActionBlocked,
  emitRiskDetected,
  GUARDRAILS_FEATURE_REGISTER_EVENT,
  GUARDRAILS_FEATURE_REQUEST_EVENT,
  GUARDRAILS_PROMPT_CLOSED_EVENT,
  GUARDRAILS_PROMPT_OPENED_EVENT,
  setupLegacyPromptEventAlias,
} from "../../src/shared/events";
import {
  recordSessionEscalationApproval,
  sessionEscalation,
} from "../session-escalation-prompt";
import { type ConfirmResult, confirmDangerousCommand } from "./confirm";
import { isCommandAllowed, saveCommandSessionGrant } from "./grants";
import { consumeApproval, issueApproval, peekApproval } from "./guidance";
import { isHostApprovalYolo } from "./host-yolo";
import {
  collectGuidancePatterns,
  createPermissionGateRule,
  formatAutoDenyReason,
  matchCommandPattern,
  matchGuidancePattern,
} from "./rules";

const YOLO_STATUS_KEY = "guardrails-yolo";
const YOLO_SESSION_STATE_KEY = "__PI_GUARDRAILS_YOLO_SESSION__";

type YoloSessionState = { enabled: boolean };

function getYoloSessionState(): YoloSessionState | undefined {
  return (globalThis as Record<string, unknown>)[YOLO_SESSION_STATE_KEY] as
    | YoloSessionState
    | undefined;
}

function setYoloSessionState(enabled: boolean): void {
  (globalThis as Record<string, unknown>)[YOLO_SESSION_STATE_KEY] = { enabled };
}

function clearYoloSessionState(): void {
  delete (globalThis as Record<string, unknown>)[YOLO_SESSION_STATE_KEY];
}

function updateYoloStatus(
  ctx: Pick<ExtensionContext, "ui">,
  enabled: boolean,
): void {
  // biome-ignore lint/plugin/no-emojis: deliberate skater marker for active YOLO mode
  ctx.ui.setStatus(YOLO_STATUS_KEY, enabled ? "🛹" : undefined);
}

/** `--guardrails-yolo=on|off` CLI flag. Registered here (not env-only) so it shows in `--help`. */
function envGuardrailsYolo(): boolean | null {
  const v = process.env.GUARDRAILS_YOLO?.toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return null;
}

async function setYolo(
  next: boolean,
  persistAcrossReload = false,
): Promise<void> {
  if (persistAcrossReload) setYoloSessionState(next);
  await configLoader.save("memory", { permissionGate: { yolo: next } });
}

export default async function permissionGate(pi: ExtensionAPI) {
  const runApprovedCommand = createCommandRunner(pi);
  await configLoader.load();

  pi.registerFlag?.("guardrails-yolo", {
    description: "Set guardrails yolo mode for this session: on|off",
    type: "string",
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "reload") {
      sessionEscalation.reset();
      clearYoloSessionState();
    }
    const flag = pi.getFlag?.("guardrails-yolo");
    const flagValue =
      typeof flag === "string"
        ? flag.toLowerCase() === "on"
          ? true
          : flag.toLowerCase() === "off"
            ? false
            : null
        : null;
    const next =
      flagValue ??
      envGuardrailsYolo() ??
      (event.reason === "reload"
        ? (getYoloSessionState()?.enabled ?? null)
        : null);
    if (next === null) {
      updateYoloStatus(ctx, configLoader.getConfig().permissionGate.yolo);
      return;
    }
    await setYolo(next);
    updateYoloStatus(ctx, next);
    try {
      ctx.ui.notify(
        next
          ? "[Guardrails] yolo mode ON (permission-gate prompts skipped)"
          : "[Guardrails] yolo mode OFF",
        "warning",
      );
    } catch {}
  });

  function registerYoloCommand(name: string) {
    pi.registerCommand(name, {
      description:
        "Show yolo status or set it on/off. Usage: /guardrails:yolo [on|off]",
      getArgumentCompletions: (prefix) => {
        const commands = [
          {
            value: "on",
            label: "on",
            description: "Enable yolo mode",
          },
          {
            value: "off",
            label: "off",
            description: "Disable yolo mode",
          },
        ];
        return commands.filter((command) => command.value.startsWith(prefix));
      },
      handler: async (args, cmdCtx) => {
        const pg = configLoader.getConfig().permissionGate;
        const arg = args.trim().toLowerCase();

        if (arg === "" || arg === "status") {
          updateYoloStatus(cmdCtx, pg.yolo);
          cmdCtx.ui.notify(
            pg.yolo
              ? "[Guardrails] yolo mode is on."
              : "[Guardrails] yolo mode is off.",
            "info",
          );
          return;
        }

        const next = arg === "on" ? true : arg === "off" ? false : null;
        if (next === null) {
          cmdCtx.ui.notify(
            "[Guardrails] usage: /guardrails:yolo [on|off]",
            "warning",
          );
          return;
        }

        await setYolo(next, true);
        updateYoloStatus(cmdCtx, next);
        cmdCtx.ui.notify(
          next
            ? "[Guardrails] yolo mode enabled for this session."
            : "[Guardrails] yolo mode disabled for this session.",
          "info",
        );
      },
    });
  }

  registerYoloCommand("guardrails:yolo");

  // Tool: model calls this after reading guidance and deciding to proceed.
  // Runs the stored command through the full gate (autoDeny + confirm prompt)
  // with only the guidance soft-block bypassed.
  pi.registerTool(
    defineTool({
      name: "guardrails_run_anyway",
      label: "Run anyway",
      description:
        "Execute a guidance-gated command after reading the guidance. " +
        "The command still goes through normal guardrails — autoDeny hard-blocks " +
        "and dangerous-command confirmation still apply. " +
        "Call this only after reading the guidance message and deciding to proceed.",
      promptSnippet:
        "guardrails_run_anyway({id, reason}) — run a guidance-blocked command via tool call; user will still be prompted for dangerous commands.",
      promptGuidelines: [
        "When a bash command is soft-blocked with guidance and you still want to run it, call guardrails_run_anyway with the id from the block message.",
        "Always include a reason: a short explanation of why you are running the command anyway, so the user sees it above the command.",
        "If the guidance says to stop and ask the user, do that instead.",
        "Do not call guardrails_run_anyway with a made-up or reused id.",
      ],
      parameters: Type.Object({
        id: Type.String({
          description: "The approval id from the guidance block message.",
        }),
        reason: Type.String({
          description:
            "Short explanation of why you are running this command anyway. Shown to the user above the command.",
        }),
        command: Type.Optional(Type.String()),
      }),
      renderShell: "default",
      renderCall({ command, id, reason }, theme) {
        const cmd = command ?? id;
        const lines = [
          reason ? theme.fg("dim", reason) : undefined,
          `${theme.fg("accent", "$")} ${theme.fg("toolTitle", cmd)}`,
        ].filter((line): line is string => Boolean(line));
        return new Text(lines.join("\n"), 0, 0);
      },
      prepareArguments(args: unknown) {
        const { id, reason } =
          typeof args === "string"
            ? { id: args, reason: "" }
            : (args as { id: string; reason: string });
        return { id, reason, command: peekApproval(id) ?? undefined };
      },
      async execute(
        _toolCallId,
        { id, reason: agentReason, command: storedCommand },
        signal,
        _onUpdate,
        ctx,
      ) {
        const command = consumeApproval(id) ?? storedCommand;
        if (!command) {
          return textResult(
            "[guardrails] Approval id not found or expired. Run the original command again to get a fresh id.",
          );
        }

        const config = configLoader.getConfig();
        const pg = config.permissionGate;
        const action = {
          kind: "command" as const,
          command,
          origin: "guardrails_run_anyway",
        };

        // autoDeny: always blocks, even in yolo (matches yoloRespectAutoDeny semantics).
        const autoDenyMatch = matchCommandPattern(command, pg.autoDenyPatterns);
        if (autoDenyMatch) {
          const reason = formatAutoDenyReason(autoDenyMatch);
          emitActionBlocked(pi, {
            feature: "permissionGate",
            action,
            reason,
            block: { source: "permission", metadata: autoDenyMatch },
            context: { toolName: "guardrails_run_anyway", input: { id } },
          });
          return textResult(`[guardrails] ${reason}`);
        }

        // Yolo: skip the confirm prompt, just run.
        if (pg.yolo) {
          return runApprovedCommand(command, ctx.cwd, signal);
        }

        // Dangerous command check + confirm prompt.
        const safety = await checkAction(action, [
          createPermissionGateRule({
            patterns: pg.patterns,
            useBuiltinMatchers: pg.useBuiltinMatchers,
          }),
        ]);

        if (safety.kind === "safe") {
          return runApprovedCommand(command, ctx.cwd, signal);
        }

        const escalationRule = `permission-gate.dangerous-command:${safety.metadata.pattern}`;
        sessionEscalation.configure(pg.sessionEscalation);
        if (sessionEscalation.isGranted(escalationRule)) {
          return runApprovedCommand(command, ctx.cwd, signal);
        }

        emitRiskDetected(pi, {
          feature: "permissionGate",
          risk: safety,
          context: { toolName: "guardrails_run_anyway", input: { id } },
        });

        if (!pg.requireConfirmation) {
          ctx.ui.notify(
            `Dangerous command detected: ${safety.reason}`,
            "warning",
          );
          return runApprovedCommand(command, ctx.cwd, signal);
        }

        if (!ctx.hasUI) {
          const reason = `Dangerous command blocked (no UI to confirm): ${safety.reason}`;
          emitActionBlocked(pi, {
            feature: "permissionGate",
            action: safety.action,
            reason,
            block: { source: "nonInteractive", metadata: safety.metadata },
            context: { toolName: "guardrails_run_anyway", input: { id } },
          });
          return textResult(`[guardrails] ${reason}`);
        }

        const promptOpened = createPromptOpenedPayload({
          feature: "permissionGate",
          action: safety.action,
          reason: safety.reason,
          prompt: { kind: "permission", metadata: safety.metadata },
          context: { toolName: "guardrails_run_anyway", input: { id } },
        });
        pi.events.emit(GUARDRAILS_PROMPT_OPENED_EVENT, promptOpened);

        let result: ConfirmResult;
        try {
          result = await confirmDangerousCommand(ctx.ui, {
            command,
            reason: safety.reason,
            meta: { agentReason, approvalId: id },
          });
        } finally {
          pi.events.emit(
            GUARDRAILS_PROMPT_CLOSED_EVENT,
            createPromptClosedPayload(promptOpened),
          );
        }

        if (result === "deny") {
          const reason = "User denied dangerous command";
          emitActionBlocked(pi, {
            feature: "permissionGate",
            action: safety.action,
            reason,
            block: { source: "user", metadata: safety.metadata },
            context: { toolName: "guardrails_run_anyway", input: { id } },
          });
          return textResult(`[guardrails] ${reason}`);
        }

        if (result === "stop") {
          const reason = "User declined and stopped dangerous command";
          emitActionBlocked(pi, {
            feature: "permissionGate",
            action: safety.action,
            reason,
            block: { source: "user-stop", metadata: safety.metadata },
            context: { toolName: "guardrails_run_anyway", input: { id } },
          });
          ctx.abort();
          return textResult(`[guardrails] ${reason}`);
        }

        if (result === "allow-session") {
          await saveCommandSessionGrant(command);
        }
        await recordSessionEscalationApproval(
          ctx,
          escalationRule,
          pg.sessionEscalation,
          "dangerous-command",
        );

        return runApprovedCommand(command, ctx.cwd, signal);
      },
    }),
  );

  pi.events.on(GUARDRAILS_FEATURE_REQUEST_EVENT, () => {
    pi.events.emit(
      GUARDRAILS_FEATURE_REGISTER_EVENT,
      createFeatureRegisterPayload("permissionGate"),
    );
  });
  setupLegacyPromptEventAlias(pi, "permissionGate");

  pi.on("before_agent_start", (event) => {
    const config = configLoader.getConfig();
    if (!config.enabled || !config.features.permissionGate) return;
    if (collectGuidancePatterns(configLoader).length === 0) return;

    const instructions = [
      "",
      "## Guardrails guidance",
      "Some commands are gated by a guidance rule. When one is blocked you will receive a message explaining the concern, ending with a single-use id.",
      "To proceed: read the guidance carefully. If you still want to run the command, call the guardrails_run_anyway tool with the id from the block message and a reason explaining why you are proceeding. The id is single-use and expires after a few minutes.",
      "The command will still go through normal guardrails — if it is dangerous the user will be prompted to allow or deny it.",
      "If the guidance says to stop and ask the user, do that instead of calling guardrails_run_anyway.",
      "Do not call guardrails_run_anyway with a made-up or reused id.",
    ].join("\n");

    return { systemPrompt: event.systemPrompt + instructions };
  });

  pi.on("tool_call", async (event, ctx) => {
    const config = configLoader.getConfig();
    if (!config.enabled || !config.features.permissionGate) return;
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    const action = { kind: "command" as const, command, origin: "bash" };
    if (isCommandAllowed(command)) return;

    const pg = config.permissionGate;
    // Effective yolo: this extension's switch, or the host running in yolo
    // (omp `tools.approvalMode: yolo` via --yolo/--approval-mode). Both mean
    // the operator already waived per-command prompting.
    const yolo = pg.yolo || (await isHostApprovalYolo(pi));

    // Guidance soft-block. YOLO bypasses guidance along with permission prompts.
    // When enabled, yoloRespectAutoDeny below still decides whether auto-deny runs.
    if (!yolo) {
      const guidancePatterns = collectGuidancePatterns(configLoader);
      const guidanceMatch = matchGuidancePattern(command, guidancePatterns);
      if (guidanceMatch) {
        const freshId = issueApproval(command);
        const reason =
          `${guidanceMatch.description.trim()}\n\n` +
          `To run this anyway, call the tool: guardrails_run_anyway(id: "${freshId}", reason: "<short explanation of why you are proceeding>")`;

        emitActionBlocked(pi, {
          feature: "permissionGate",
          action,
          reason,
          block: { source: "permission", metadata: guidanceMatch },
          context: { toolName: "bash", input: event.input },
        });

        return { block: true, reason };
      }
    }

    // Yolo: skip autoDeny and confirmation prompts.
    if (yolo && !pg.yoloRespectAutoDeny) return;

    const autoDenyMatch = matchCommandPattern(
      command,
      config.permissionGate.autoDenyPatterns,
    );
    if (autoDenyMatch) {
      const reason = formatAutoDenyReason(autoDenyMatch);
      emitActionBlocked(pi, {
        feature: "permissionGate",
        action,
        reason,
        block: { source: "permission", metadata: autoDenyMatch },
        context: { toolName: "bash", input: event.input },
      });
      return { block: true, reason };
    }

    // Yolo with yoloRespectAutoDeny: autoDeny ran above, skip the rest.
    if (yolo) return;

    const safety = await checkAction(action, [
      createPermissionGateRule({
        patterns: config.permissionGate.patterns,
        useBuiltinMatchers: config.permissionGate.useBuiltinMatchers,
      }),
    ]);
    if (safety.kind === "safe") return;

    const escalationRule = `permission-gate.dangerous-command:${safety.metadata.pattern}`;
    sessionEscalation.configure(pg.sessionEscalation);
    if (sessionEscalation.isGranted(escalationRule)) return;

    emitRiskDetected(pi, {
      feature: "permissionGate",
      risk: safety,
      context: { toolName: "bash", input: event.input },
    });
    if (!config.permissionGate.requireConfirmation) {
      ctx.ui.notify(`Dangerous command detected: ${safety.reason}`, "warning");
      return;
    }

    if (!ctx.hasUI) {
      const reason = `Dangerous command blocked (no UI to confirm): ${safety.reason}`;
      emitActionBlocked(pi, {
        feature: "permissionGate",
        action: safety.action,
        reason,
        block: { source: "nonInteractive", metadata: safety.metadata },
        context: { toolName: "bash", input: event.input },
      });
      return { block: true, reason };
    }

    const promptOpened = createPromptOpenedPayload({
      feature: "permissionGate",
      action: safety.action,
      reason: safety.reason,
      prompt: { kind: "permission", metadata: safety.metadata },
      context: { toolName: "bash", input: event.input },
    });
    pi.events.emit(GUARDRAILS_PROMPT_OPENED_EVENT, promptOpened);

    let result: ConfirmResult;
    try {
      result = await confirmDangerousCommand(ctx.ui, {
        command,
        reason: safety.reason,
      });
    } finally {
      pi.events.emit(
        GUARDRAILS_PROMPT_CLOSED_EVENT,
        createPromptClosedPayload(promptOpened),
      );
    }

    if (result === "allow") {
      await recordSessionEscalationApproval(
        ctx,
        escalationRule,
        pg.sessionEscalation,
        "dangerous-command",
      );
      return;
    }
    if (result === "allow-session") {
      await saveCommandSessionGrant(command);
      await recordSessionEscalationApproval(
        ctx,
        escalationRule,
        pg.sessionEscalation,
        "dangerous-command",
      );
      return;
    }

    if (result === "stop") {
      const reason = "User declined and stopped dangerous command";
      emitActionBlocked(pi, {
        feature: "permissionGate",
        action: safety.action,
        reason,
        block: { source: "user-stop", metadata: safety.metadata },
        context: { toolName: "bash", input: event.input },
      });
      ctx.abort();
      return { block: true, reason };
    }

    const reason = "User denied dangerous command";
    emitActionBlocked(pi, {
      feature: "permissionGate",
      action: safety.action,
      reason,
      block: { source: "user", metadata: safety.metadata },
      context: { toolName: "bash", input: event.input },
    });
    return { block: true, reason };
  });
}

const execAsync = promisify(nodeExec);

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

interface OmpExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface OmpExtensionApi {
  exec?: (
    command: string,
    args: string[],
    options: { cwd: string; signal?: AbortSignal },
  ) => Promise<OmpExecResult>;
}

function createCommandRunner(pi: ExtensionAPI) {
  const ompExec = (pi as unknown as OmpExtensionApi).exec;

  if (typeof ompExec === "function") {
    return async (
      command: string,
      cwd: string,
      signal: AbortSignal | undefined,
    ): Promise<AgentToolResult<null>> => {
      const result = await ompExec("sh", ["-lc", command], { cwd, signal });
      return textResult(
        [result.stdout, result.stderr].filter(Boolean).join("\n") ||
          "(no output)",
      );
    };
  }

  return runCommand;
}

async function runCommand(
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<null>> {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, signal });
    const out = [stdout, stderr].filter(Boolean).join("\n");
    return textResult(out || "(no output)");
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    const out = [e.stdout, e.stderr].filter(Boolean).join("\n");
    return textResult(out || `(exit code ${e.code ?? 1})`);
  }
}
