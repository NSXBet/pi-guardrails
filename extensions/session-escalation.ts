export type SessionEscalationConfig = {
  enabled: boolean;
  approvalThreshold: number;
};

const DEFAULT_APPROVAL_THRESHOLD = 2;

function normalizeThreshold(value: number): number {
  return Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_APPROVAL_THRESHOLD;
}

export function normalizeSessionEscalationConfig(
  config: Partial<SessionEscalationConfig> | undefined,
): SessionEscalationConfig {
  return {
    enabled: config?.enabled ?? true,
    approvalThreshold: normalizeThreshold(
      config?.approvalThreshold ?? DEFAULT_APPROVAL_THRESHOLD,
    ),
  };
}

export class SessionEscalation {
  private readonly approvals = new Map<string, number>();
  private readonly granted = new Set<string>();
  private readonly dismissed = new Set<string>();
  private config: SessionEscalationConfig;

  constructor(config: Partial<SessionEscalationConfig> | undefined) {
    this.config = normalizeSessionEscalationConfig(config);
  }

  configure(config: Partial<SessionEscalationConfig> | undefined): void {
    this.config = normalizeSessionEscalationConfig(config);
  }

  recordApproval(rule: string): boolean {
    if (
      !this.config.enabled ||
      this.granted.has(rule) ||
      this.dismissed.has(rule)
    ) {
      return false;
    }

    const approvals = (this.approvals.get(rule) ?? 0) + 1;
    this.approvals.set(rule, approvals);
    return approvals === this.config.approvalThreshold;
  }

  isGranted(rule: string): boolean {
    return this.config.enabled && this.granted.has(rule);
  }

  grant(rule: string): void {
    this.granted.add(rule);
  }

  dismiss(rule: string): void {
    this.dismissed.add(rule);
  }

  reset(): void {
    this.approvals.clear();
    this.granted.clear();
    this.dismissed.clear();
  }
}
