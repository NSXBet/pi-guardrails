import { createPermissionGateConfirmComponent } from "./prompt";

export type ConfirmResult = "allow" | "allow-session" | "deny" | "stop";

/**
 * Minimal structural contract for omp 18.x's `ctx.ui.askDialog` (rendered as a
 * native Tern sheet under TSP terminals, ANSI dialog elsewhere). Absent in
 * upstream pi, hence optional and structurally typed here — the extension
 * package compiles against `@earendil-works/pi-coding-agent`, which does not
 * declare `askDialog`.
 */
export interface ConfirmAskDialogQuestion {
    id: string;
    question: string;
    header?: string;
    options: { label: string; description?: string; preview?: string }[];
    recommended?: number;
}

export interface ConfirmAskDialogResultItem {
    selectedOptions: string[];
    timedOut?: boolean;
}

export type ConfirmAskDialogResult =
    | { kind: "submit"; results: ConfirmAskDialogResultItem[] }
    | { kind: "chat" };

export interface ConfirmDialogUI {
    custom<T>(factory: unknown, options?: unknown): Promise<T | undefined>;
    select(title: string, options: string[]): Promise<string | undefined>;
    askDialog?(
        questions: ConfirmAskDialogQuestion[],
        dialogOptions?: unknown,
    ): Promise<ConfirmAskDialogResult | undefined>;
    /** Fire-and-forget toast, present on omp/pi ui contexts. Optional: tier-2 callers may omit it. */
    notify?(message: string, level?: string): void;
}

const CONFIRM_LABELS = [
    "Allow once",
    "Allow for session",
    "Deny",
    "Decline and stop",
] as const;

/**
 * globalThis key pi-yuri-extensions' yes module uses. Lives on globalThis (not
 * a module variable) because this extension and pi-yuri-extensions are loaded
 * by separate jiti instances; globalThis is the only shared object.
 */
const YES_MODE_KEY = "__PI_YES_MODE__";

function labelToResult(label: string | undefined): ConfirmResult {
    if (label === "Allow once") return "allow";
    if (label === "Allow for session") return "allow-session";
    if (label === "Decline and stop") return "stop";
    return "deny";
}

/**
 * Shared dangerous-command confirmation for both prompt sites (the
 * `guardrails_run_anyway` tool and the bash pre-exec hook).
 *
 * Tier 1 (omp ≥18 with `askDialog`): one rich ask dialog. Under a Tern TSP
 * terminal the runtime draws it as a native sheet; elsewhere it is omp's ANSI
 * dialog. Any answer without an explicit selection (cancel, timeout, chat)
 * maps to `deny` — same fail-safe as the ANSI component's n/esc.
 *
 * Tier 2 (upstream pi, older omp, or degenerate answers): the original ANSI
 * component with the `select` fallback, byte-identical to the previous
 * behavior.
 */
export async function confirmDangerousCommand(
    ui: ConfirmDialogUI,
    args: {
        command: string;
        reason: string;
        meta?: { agentReason?: string; approvalId?: string };
    },
): Promise<ConfirmResult> {
    const { command, reason, meta } = args;

    // YES mode (`pi --yes`, YES=1, /yes on) auto-approves every interactive
    // prompt. Other extensions auto-approve by patching ctx.ui methods, but
    // guardrails calls ui methods directly with `.call(ui, ...)`, so patches
    // don't intercept it — check the flag at the single choke point instead.
    const globals = globalThis as Record<string, unknown>;
    if (globals[YES_MODE_KEY] === true) {
        try {
            ui.notify?.("[guardrails] YES mode: dangerous command auto-approved", "warning");
        } catch {
            // ui.notify is best-effort; auto-allow must not depend on it.
        }
        return "allow";
    }

    const askDialog = ui.askDialog;
    if (typeof askDialog === "function") {
        let question = `Dangerous command: ${reason}`;
        if (meta?.agentReason) question += `\n\n${meta.agentReason}`;
        if (meta?.approvalId) question += `\n\n(approval id: ${meta.approvalId})`;

        const answer = await askDialog.call(ui, [
            {
                id: "permission-gate",
                question,
                header: "guardrails",
                options: [
                    {
                        label: "Allow once",
                        description: "Run this command once",
                    },
                    {
                        label: "Allow for session",
                        description:
                            "Allow this command for the rest of this session",
                    },
                    {
                        label: "Deny",
                        description: "Block this command",
                    },
                    {
                        label: "Decline and stop",
                        description:
                            "Block the command and stop the current turn",
                    },
                ],
                recommended: 2,
            },
        ]);

        if (answer?.kind === "submit") {
            const label = answer.results[0]?.selectedOptions[0];
            if (label) return labelToResult(label);
        }
        // No explicit selection (cancel/timeout/chat): fail safe.
        return "deny";
    }

    const customResult = await ui.custom<ConfirmResult>(
        createPermissionGateConfirmComponent(command, reason, meta),
    );
    if (customResult !== undefined) return customResult;
    const selection = await ui.select(
        `Dangerous command: ${reason}`,
        [...CONFIRM_LABELS],
    );
    return labelToResult(selection);
}
