import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionEscalation } from "./session-escalation";

export const sessionEscalation = new SessionEscalation({
  enabled: true,
  approvalThreshold: 2,
});

export async function recordSessionEscalationApproval(
  ctx: ExtensionContext,
  rule: string,
  config: { enabled: boolean; approvalThreshold: number } | undefined,
  promptKind: "confirmation" | "dangerous-command",
): Promise<void> {
  sessionEscalation.configure(config);
  if (!sessionEscalation.recordApproval(rule) || !ctx.hasUI) return;

  const title =
    promptKind === "dangerous-command"
      ? "Dangerous command approved repeatedly"
      : "Guardrail approved repeatedly";
  const choice = await ctx.ui.select(title, [
    "Allow this guardrail for this session",
    "Keep asking",
  ]);

  if (choice === "Allow this guardrail for this session") {
    sessionEscalation.grant(rule);
  } else {
    sessionEscalation.dismiss(rule);
  }
}
