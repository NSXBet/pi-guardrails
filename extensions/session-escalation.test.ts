import { describe, expect, it } from "vitest";
import { SessionEscalation } from "./session-escalation";

describe("SessionEscalation", () => {
  it("offers a per-rule session grant at the configured successful-approval threshold", () => {
    const escalation = new SessionEscalation({
      enabled: true,
      approvalThreshold: 2,
    });

    expect(escalation.recordApproval("permission-gate.dangerous-command")).toBe(
      false,
    );
    expect(escalation.recordApproval("permission-gate.dangerous-command")).toBe(
      true,
    );
    expect(escalation.isGranted("permission-gate.dangerous-command")).toBe(
      false,
    );

    escalation.grant("permission-gate.dangerous-command");
    expect(escalation.isGranted("permission-gate.dangerous-command")).toBe(
      true,
    );
  });

  it("does not offer a dismissed rule again during the session", () => {
    const escalation = new SessionEscalation({
      enabled: true,
      approvalThreshold: 2,
    });

    escalation.recordApproval("path-access.outside-workspace");
    expect(escalation.recordApproval("path-access.outside-workspace")).toBe(
      true,
    );
    escalation.dismiss("path-access.outside-workspace");
    expect(escalation.recordApproval("path-access.outside-workspace")).toBe(
      false,
    );
  });

  it("does not track approvals while disabled and reset clears every rule state", () => {
    const escalation = new SessionEscalation({
      enabled: false,
      approvalThreshold: 2,
    });
    expect(escalation.recordApproval("rule")).toBe(false);

    escalation.configure({ enabled: true, approvalThreshold: 2 });
    escalation.recordApproval("rule");
    escalation.grant("rule");
    escalation.dismiss("other-rule");
    escalation.reset();

    expect(escalation.isGranted("rule")).toBe(false);
    expect(escalation.recordApproval("rule")).toBe(false);
    expect(escalation.recordApproval("other-rule")).toBe(false);
  });

  it("normalizes invalid thresholds to the default", () => {
    const escalation = new SessionEscalation({
      enabled: true,
      approvalThreshold: 0,
    });
    expect(escalation.recordApproval("rule")).toBe(false);
    expect(escalation.recordApproval("rule")).toBe(true);
  });
});
