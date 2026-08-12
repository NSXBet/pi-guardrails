import { randomUUID } from "node:crypto";

/** Marker the model appends to a command to self-approve a guidance block. */
export const GUIDANCE_MARKER_PREFIX = "# guardrails:approve:";

/** How long an issued approval id stays valid. */
const APPROVAL_TTL_MS = 5 * 60 * 1000;

interface Approval {
  command: string;
  expiresAt: number;
}

/**
 * Single-use, expiring approval ids. In-memory only — approvals do not survive
 * a session restart. This is process-global state shared across the hook.
 */
const approvals = new Map<string, Approval>();

function sweepExpired(now: number): void {
  for (const [id, approval] of approvals) {
    if (approval.expiresAt <= now) approvals.delete(id);
  }
}

/** Issue a fresh approval id bound to a specific command. */
export function issueApproval(command: string): string {
  const now = Date.now();
  sweepExpired(now);
  const id = randomUUID();
  approvals.set(id, { command, expiresAt: now + APPROVAL_TTL_MS });
  return id;
}

/**
 * Extract the approval id from a command's marker, if present.
 * Matches `# guardrails:approve:<id>` where `<id>` is non-whitespace.
 */
export function extractApprovalId(command: string): string | null {
  const index = command.indexOf(GUIDANCE_MARKER_PREFIX);
  if (index === -1) return null;
  const id = command
    .slice(index + GUIDANCE_MARKER_PREFIX.length)
    .trim()
    .split(/\s+/)[0];
  return id ? id : null;
}

/**
 * Consume an approval id for a command. Returns true only when the id exists,
 * is unexpired, and was issued for this exact command. Consumed ids are removed
 * so they cannot be reused.
 */
export function consumeApproval(command: string, id: string): boolean {
  const now = Date.now();
  sweepExpired(now);
  const approval = approvals.get(id);
  if (!approval) return false;
  if (approval.expiresAt <= now) {
    approvals.delete(id);
    return false;
  }
  if (approval.command !== command) return false;
  approvals.delete(id);
  return true;
}
