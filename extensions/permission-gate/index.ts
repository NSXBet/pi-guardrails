import {
  type ExtensionAPI,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
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
import {
  consumeApproval,
  extractApprovalId,
  GUIDANCE_MARKER_PREFIX,
  issueApproval,
} from "./guidance";
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
          `[Guardrails] yolo mode is ${pg.yolo ? "on" : "off"}.`,
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
        `[Guardrails] yolo mode ${next ? "enabled" : "disabled"} for this session.`,
        "info",
      );
    },
  });

  pi.events.on(GUARDRAILS_FEATURE_REQUEST_EVENT, () => {
    pi.events.emit(
      GUARDRAILS_FEATURE_REGISTER_EVENT,
      createFeatureRegisterPayload("permissionGate"),
    );
  });
  setupLegacyPromptEventAlias(pi, "permissionGate");

  // Teach the agent how to respond to a guidance soft-block: read the message,
  // then resend the same command with the single-use approval marker.
  pi.on("before_agent_start", (event) => {
    const config = configLoader.getConfig();
    if (!config.enabled || !config.features.permissionGate) return;
    if (collectGuidancePatterns(configLoader).length === 0) return;

    const instructions = [
      "",
      "## Guardrails guidance",
      "Some commands are gated by a guidance rule. When one is blocked you will receive a message explaining the concern, ending with a single-use approval marker like `# guardrails:approve:<id>`.",
      "To proceed: read the guidance, then resend the exact same command with that marker appended. The id is single-use and expires after a few minutes.",
      "Do not invent or reuse marker ids, and do not strip the gated command down to dodge the rule. If the guidance says to stop and ask the user, stop and ask.",
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

    // Guidance: soft-block with an educational message + single-use approval
    // marker. Resending with the correct marker allows it. Runs in all modes,
    // including yolo. Match against the command with any marker stripped so an
    // approved retry doesn't re-match on the marker text itself.
    const approvalId = extractApprovalId(command);
    const baseCommand = approvalId
      ? command.replace(GUIDANCE_MARKER_PREFIX + approvalId, "").trim()
      : command;

    const guidancePatterns = collectGuidancePatterns(configLoader);
    const guidanceMatch = matchGuidancePattern(baseCommand, guidancePatterns);
    if (guidanceMatch) {
      const approved = approvalId !== null && consumeApproval(baseCommand, approvalId);
      if (!approved) {
        const freshId = issueApproval(baseCommand);
        const reason = `${guidanceMatch.description.trim()} To run this anyway, resend the command with the marker: ${GUIDANCE_MARKER_PREFIX}${freshId}`;

        emitActionBlocked(pi, {
          feature: "permissionGate",
          action,
          reason,
          block: { source: "permission", metadata: guidanceMatch },
          context: { toolName: "bash", input: event.input },
        });

        return { block: true, reason };
      }
      // Approved via marker: fall through (yolo/autoDeny/confirm still apply).
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
      prompt: {
        kind: "permission",
        metadata: safety.metadata,
      },
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
