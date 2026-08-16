import { exec as nodeExec } from "node:child_process";
import { promisify } from "node:util";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
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
import { isCommandAllowed, saveCommandSessionGrant } from "./grants";
import { consumeApproval, issueApproval, peekApproval } from "./guidance";
import { createPermissionGateConfirmComponent } from "./prompt";
import {
  collectGuidancePatterns,
  createPermissionGateRule,
  formatAutoDenyReason,
  matchCommandPattern,
  matchGuidancePattern,
} from "./rules";

export default async function permissionGate(pi: ExtensionAPI) {
  await configLoader.load();

  pi.registerCommand("guardrails:yolo", {
    description: "Toggle yolo mode (skip permission-gate prompts)",
    handler: async (args, cmdCtx) => {
      const pg = configLoader.getConfig().permissionGate;
      const arg = args.trim().toLowerCase();

      if (arg === "" || arg === "status") {
        cmdCtx.ui.notify(
          `${pg.yolo ? "🛹 " : ""}[Guardrails] yolo mode is ${pg.yolo ? "on" : "off"}.`,
          "info",
        );
        return;
      }

      const next = arg === "on" ? true : arg === "off" ? false : null;
      if (next === null) {
        cmdCtx.ui.notify(
          "[Guardrails] usage: /guardrails:yolo [on|off|status]",
          "warning",
        );
        return;
      }

      await configLoader.save("memory", { permissionGate: { yolo: next } });
      await configLoader.load();
      cmdCtx.ui.notify(
        `${next ? "🛹 " : ""}[Guardrails] yolo mode ${next ? "enabled" : "disabled"} for this session.`,
        "info",
      );
    },
  });

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
        "guardrails_run_anyway({id}) — run a guidance-blocked command via tool call; user will still be prompted for dangerous commands.",
      promptGuidelines: [
        "When a bash command is soft-blocked with guidance and you still want to run it, call guardrails_run_anyway with the id from the block message.",
        "If the guidance says to stop and ask the user, do that instead.",
        "Do not call guardrails_run_anyway with a made-up or reused id.",
      ],
      parameters: Type.Object({
        id: Type.String({
          description: "The approval id from the guidance block message.",
        }),
        command: Type.Optional(Type.String()),
      }),
      renderShell: "default",
      renderCall({ command, id }, theme) {
        const cmd = command ?? id;
        const text = theme.fg("accent", "$") + " " + theme.fg("toolTitle", cmd);
        return new Text(text, 0, 0);
      },
      prepareArguments(args: unknown) {
        const id = typeof args === "string" ? args : (args as { id: string }).id;
        return { id, command: peekApproval(id) ?? undefined };
      },
      async execute(_toolCallId, { id, command: storedCommand }, signal, _onUpdate, ctx) {
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
        const autoDenyMatch = matchCommandPattern(
          command,
          pg.autoDenyPatterns,
        );
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
          return runCommand(command, ctx.cwd, signal);
        }

        // Dangerous command check + confirm prompt.
        const safety = await checkAction(action, [
          createPermissionGateRule({
            patterns: pg.patterns,
            useBuiltinMatchers: pg.useBuiltinMatchers,
          }),
        ]);

        if (safety.kind === "safe") {
          return runCommand(command, ctx.cwd, signal);
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
          return runCommand(command, ctx.cwd, signal);
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

        type ConfirmResult = "allow" | "allow-session" | "deny" | "stop";
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
          const customResult = await ctx.ui.custom<ConfirmResult>(
            createPermissionGateConfirmComponent(command, safety.reason),
          );
          if (customResult === undefined) {
            const selection = await ctx.ui.select(
              `Dangerous command: ${safety.reason}`,
              ["Allow once", "Allow for session", "Deny", "Decline and stop"],
            );
            if (selection === "Allow once") result = "allow";
            else if (selection === "Allow for session") result = "allow-session";
            else if (selection === "Decline and stop") result = "stop";
            else result = "deny";
          } else {
            result = customResult;
          }
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

        return runCommand(command, ctx.cwd, signal);
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
      "To proceed: read the guidance carefully. If you still want to run the command, call the guardrails_run_anyway tool with the id from the block message. The id is single-use and expires after a few minutes.",
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

    // Guidance soft-block. Always runs, including yolo. Issues a single-use id
    // the model can pass to guardrails_run_anyway to proceed.
    const guidancePatterns = collectGuidancePatterns(configLoader);
    const guidanceMatch = matchGuidancePattern(command, guidancePatterns);
    if (guidanceMatch) {
      const freshId = issueApproval(command);
      const reason =
        `${guidanceMatch.description.trim()}\n` +
        `To run this anyway, call the guardrails_run_anyway tool with id: ${freshId}`;

      emitActionBlocked(pi, {
        feature: "permissionGate",
        action,
        reason,
        block: { source: "permission", metadata: guidanceMatch },
        context: { toolName: "bash", input: event.input },
      });

      return { block: true, reason };
    }

    // Yolo: skip autoDeny and confirmation prompts.
    if (pg.yolo && !pg.yoloRespectAutoDeny) return;

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
    if (pg.yolo) return;

    const safety = await checkAction(action, [
      createPermissionGateRule({
        patterns: config.permissionGate.patterns,
        useBuiltinMatchers: config.permissionGate.useBuiltinMatchers,
      }),
    ]);
    if (safety.kind === "safe") return;

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

    type ConfirmResult = "allow" | "allow-session" | "deny" | "stop";
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
      const customResult = await ctx.ui.custom<ConfirmResult>(
        createPermissionGateConfirmComponent(command, safety.reason),
      );
      if (customResult === undefined) {
        const selection = await ctx.ui.select(
          `Dangerous command: ${safety.reason}`,
          ["Allow once", "Allow for session", "Deny", "Decline and stop"],
        );
        if (selection === "Allow once") result = "allow";
        else if (selection === "Allow for session") result = "allow-session";
        else if (selection === "Decline and stop") result = "stop";
        else result = "deny";
      } else {
        result = customResult;
      }
    } finally {
      pi.events.emit(
        GUARDRAILS_PROMPT_CLOSED_EVENT,
        createPromptClosedPayload(promptOpened),
      );
    }

    if (result === "allow") return;
    if (result === "allow-session") {
      await saveCommandSessionGrant(command);
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
