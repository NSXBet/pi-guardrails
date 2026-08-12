import type { Action, Rule } from "../../src/core";
import { checkDangerousCommand } from "../../src/core/commands";
import type { DangerousPattern, PatternConfig } from "../../src/shared/config";
import { compileCommandPatterns } from "../../src/shared/matching";

export type PermissionGateMeta = {
  command: string;
  description: string;
  pattern: string;
};

export type PermissionGateRuleOptions = {
  patterns: DangerousPattern[];
  useBuiltinMatchers: boolean;
};

export function createPermissionGateRule({
  patterns,
  useBuiltinMatchers,
}: PermissionGateRuleOptions): Rule<PermissionGateMeta> {
  const compiledPatterns = compileCommandPatterns(patterns);

  return {
    key: "permission-gate.dangerous-command",
    check(action: Action) {
      if (action.kind !== "command") return { kind: "pass" };

      const match = checkDangerousCommand({
        command: action.command,
        patterns: compiledPatterns,
        useBuiltinMatchers,
        fallbackPatterns: patterns,
      });
      if (!match) return { kind: "pass" };

      return {
        kind: "match",
        reason: match.description,
        metadata: {
          command: action.command,
          description: match.description,
          pattern: match.pattern,
        },
      };
    },
  };
}

export function matchCommandPattern(
  command: string,
  patterns: PatternConfig[],
): PatternConfig | null {
  const compiled = compileCommandPatterns(patterns);
  for (let i = 0; i < compiled.length; i++) {
    if (compiled[i].test(command)) return patterns[i];
  }
  return null;
}

export function matchesAnyCommandPattern(
  command: string,
  patterns: PatternConfig[],
): boolean {
  return matchCommandPattern(command, patterns) !== null;
}

export function matchGuidancePattern(
  command: string,
  patterns: DangerousPattern[],
): DangerousPattern | null {
  return matchCommandPattern(command, patterns) as DangerousPattern | null;
}

/**
 * Legacy guidance entry: a customPatterns / guidanceOnlyPatterns object that
 * carries its soft-block message in a `guidance` field instead of
 * `description`.
 */
export type LegacyGuidancePattern = PatternConfig & { guidance?: string };

/** Minimal raw-config source for guidance collection (per-scope). */
export interface GuidanceConfigSource {
  getRawConfig(scope: "global" | "local" | "memory"): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readGuidanceEntries(
  raw: unknown,
  push: (entry: LegacyGuidancePattern, text: string) => void,
): void {
  if (!isRecord(raw)) return;

  const permissionGate = raw.permissionGate;
  const customPatterns = isRecord(permissionGate)
    ? permissionGate.customPatterns
    : undefined;
  if (Array.isArray(customPatterns)) {
    for (const entry of customPatterns) {
      if (!isRecord(entry) || typeof entry.pattern !== "string") continue;
      const text =
        typeof entry.guidance === "string" ? entry.guidance.trim() : "";
      if (text) push(entry as unknown as LegacyGuidancePattern, text);
    }
  }

  const guidanceOnly = raw.guidanceOnlyPatterns;
  if (Array.isArray(guidanceOnly)) {
    for (const entry of guidanceOnly) {
      if (!isRecord(entry) || typeof entry.pattern !== "string") continue;
      const text =
        typeof entry.guidance === "string"
          ? entry.guidance.trim()
          : typeof entry.description === "string"
            ? entry.description.trim()
            : "";
      if (text) push(entry as unknown as LegacyGuidancePattern, text);
    }
  }
}

/**
 * Collect guidance patterns from the user's config shape across all scopes
 * (global -> local -> memory, deduped by pattern string): any
 * `permissionGate.customPatterns` entry with a `guidance` field, plus every
 * top-level `guidanceOnlyPatterns` entry. Each is normalized to a
 * DangerousPattern whose `description` is the guidance message.
 */
export function collectGuidancePatterns(
  source: GuidanceConfigSource,
): DangerousPattern[] {
  const out: DangerousPattern[] = [];
  const seen = new Set<string>();

  const push = (entry: LegacyGuidancePattern, text: string) => {
    if (seen.has(entry.pattern)) return;
    seen.add(entry.pattern);
    const result: DangerousPattern = {
      pattern: entry.pattern,
      description: text,
    };
    if (entry.regex !== undefined) result.regex = entry.regex;
    out.push(result);
  };

  for (const scope of ["global", "local", "memory"] as const) {
    readGuidanceEntries(source.getRawConfig(scope), push);
  }

  return out;
}

export function formatAutoDenyReason(pattern: PatternConfig): string {
  const description = pattern.description?.trim();
  return description
    ? `Command auto-denied: ${description}`
    : "Command matched auto-deny pattern and was blocked automatically.";
}
