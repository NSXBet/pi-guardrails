import { describe, expect, it, vi } from "vitest";
import {
  confirmDangerousCommand,
  type ConfirmAskDialogResult,
  type ConfirmDialogUI,
  type ConfirmResult,
} from "./confirm";

function submit(selected: string[]): ConfirmAskDialogResult {
  return {
    kind: "submit",
    results: [{ selectedOptions: selected, timedOut: selected.length === 0 }],
  };
}

function makeUI(overrides: {
  askDialog?: (
    questions: unknown[],
    dialogOptions?: unknown,
  ) => Promise<ConfirmAskDialogResult | undefined>;
  custom?: () => Promise<ConfirmResult | undefined>;
  select?: () => Promise<string | undefined>;
} = {}): ConfirmDialogUI {
  return {
    custom: vi.fn(
      overrides.custom ?? (() => Promise.resolve<ConfirmResult | undefined>(undefined)),
    ) as unknown as ConfirmDialogUI["custom"],
    select: vi.fn(
      overrides.select ?? (() => Promise.resolve<string | undefined>(undefined)),
    ) as unknown as ConfirmDialogUI["select"],
    askDialog: overrides.askDialog,
  };
}

const BASE_ARGS = { command: "rm -rf /", reason: "matches rm -rf pattern" };

describe("confirmDangerousCommand", () => {
  describe("tier 1: askDialog present (omp ≥18, native under Tern TSP)", () => {
    it("maps the four labels to results and skips the legacy component", async () => {
      const cases: [string, ConfirmResult][] = [
        ["Allow once", "allow"],
        ["Allow for session", "allow-session"],
        ["Deny", "deny"],
        ["Decline and stop", "stop"],
      ];
      for (const [label, expected] of cases) {
        const ui = makeUI({ askDialog: () => Promise.resolve(submit([label])) });
        await expect(confirmDangerousCommand(ui, BASE_ARGS)).resolves.toBe(
          expected,
        );
        expect(ui.custom).not.toHaveBeenCalled();
        expect(ui.select).not.toHaveBeenCalled();
      }
    });

    it("fails safe on cancel, timeout, chat, and empty submissions", async () => {
      for (const answer of [
        undefined,
        { kind: "chat" },
        submit([]),
      ] as (ConfirmAskDialogResult | undefined)[]) {
        const ui = makeUI({ askDialog: () => Promise.resolve(answer) });
        await expect(confirmDangerousCommand(ui, BASE_ARGS)).resolves.toBe(
          "deny",
        );
        expect(ui.custom).not.toHaveBeenCalled();
      }
    });

    it("passes reason, agentReason, approval id and a deny recommendation", async () => {
      const askDialog = vi.fn(() =>
        Promise.resolve<ConfirmAskDialogResult>(submit(["Allow once"])),
      );
      const ui = makeUI({ askDialog });
      await confirmDangerousCommand(ui, {
        ...BASE_ARGS,
        meta: { agentReason: "to clean the build dir", approvalId: "abc-123" },
      });
      expect(askDialog).toHaveBeenCalledTimes(1);
      const [questions] = askDialog.mock.calls[0] as [
        {
          id: string;
          question: string;
          header: string;
          options: { label: string }[];
          recommended: number;
        }[],
      ];
      expect(questions).toHaveLength(1);
      expect(questions[0].id).toBe("permission-gate");
      expect(questions[0].header).toBe("guardrails");
      expect(questions[0].question).toContain("Dangerous command: matches rm -rf pattern");
      expect(questions[0].question).toContain("to clean the build dir");
      expect(questions[0].question).toContain("abc-123");
      expect(questions[0].options.map((o) => o.label)).toEqual([
        "Allow once",
        "Allow for session",
        "Deny",
        "Decline and stop",
      ]);
      expect(questions[0].recommended).toBe(2);
    });
  });

  describe("tier 2: no askDialog (upstream pi, legacy path)", () => {
    it("uses the ANSI component result directly", async () => {
      const ui = makeUI({
        custom: () => Promise.resolve("allow"),
        select: () => Promise.resolve(undefined),
      });
      await expect(confirmDangerousCommand(ui, BASE_ARGS)).resolves.toBe(
        "allow",
      );
      expect(ui.select).not.toHaveBeenCalled();
    });

    it("falls back to select when the component is dismissed", async () => {
      const ui = makeUI({
        select: () => Promise.resolve("Decline and stop"),
      });
      await expect(confirmDangerousCommand(ui, BASE_ARGS)).resolves.toBe(
        "stop",
      );
    });

    it("denies when both component and select are dismissed", async () => {
      const ui = makeUI();
      await expect(confirmDangerousCommand(ui, BASE_ARGS)).resolves.toBe(
        "deny",
      );
    });
  });
});
