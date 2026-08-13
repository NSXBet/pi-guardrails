import { randomBytes } from "node:crypto";

const APPROVAL_TTL_MS = 5 * 60 * 1000;

interface Approval {
  command: string;
  expiresAt: number;
}

const approvals = new Map<string, Approval>();

function sweepExpired(now: number): void {
  for (const [id, approval] of approvals) {
    if (approval.expiresAt <= now) approvals.delete(id);
  }
}

/** Issue a short 7-char hex approval id (like a git short hash). */
export function issueApproval(command: string): string {
  const now = Date.now();
  sweepExpired(now);
  const id = randomBytes(4).toString("hex").slice(0, 7);
  approvals.set(id, { command, expiresAt: now + APPROVAL_TTL_MS });
  return id;
}

/** Peek at the stored command for an id without consuming it. */
export function peekApproval(id: string): string | null {
  const approval = approvals.get(id);
  if (!approval || approval.expiresAt <= Date.now()) return null;
  return approval.command;
}

/**
 * Consume an approval id. Returns the stored command if the id exists and
 * is unexpired, null otherwise. Consumed ids are removed — single use.
 */
export function consumeApproval(id: string): string | null {
  const now = Date.now();
  sweepExpired(now);
  const approval = approvals.get(id);
  if (!approval || approval.expiresAt <= now) {
    approvals.delete(id);
    return null;
  }
  approvals.delete(id);
  return approval.command;
}
