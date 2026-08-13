import type {
  BashToolCallEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ReadToolCallEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  createMock,
  type DeepMocked,
  type PartialFuncReturn,
} from "@golevelup/ts-vitest";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GUARDRAILS_ACTION_BLOCKED_EVENT,
  GUARDRAILS_FEATURE_REGISTER_EVENT,
  GUARDRAILS_FEATURE_REQUEST_EVENT,
  GUARDRAILS_PROMPT_CLOSED_EVENT,
  GUARDRAILS_PROMPT_OPENED_EVENT,
  type GuardrailsPromptOpenedPayload,
} from "../../src/shared/events";
import permissionGate from "./index";
import * as configModule from "../../src/shared/config";

const mockModule = configModule as unknown as {
  __setPermissionGate: (o: Record<string, unknown>) => void;
  __setRawConfig: (raw: Record<string, unknown> | null) => void;
};

function setPermissionGate(overrides: Record<string, unknown>) {
  mockModule.__setPermissionGate(overrides);
}

function setRawConfig(raw: Record<string, unknown> | null) {
  mockModule.__setRawConfig(raw);
}

// Control the config the hook sees without touching the real config loader.
vi.mock("../../src/shared/config", () => {
  const state = {
    overrides: {} as Record<string, unknown>,
    rawConfig: null as Record<string, unknown> | null,
  };
  function makeConfig() {
    return {
      enabled: true,
      features: { permissionGate: true, policies: true, pathAccess: true },
      permissionGate: {
        patterns: [{ pattern: "dangerous-cmd", description: "test danger" }],
        useBuiltinMatchers: false,
        requireConfirmation: true,
        allowedPatterns: [],
        autoDenyPatterns: [],
        yolo: false,
        yoloRespectAutoDeny: false,
        ...state.overrides,
      },
    };
  }

  return {
    __setPermissionGate(overrides: Record<string, unknown>) {
      state.overrides = overrides;
    },
    __setRawConfig(raw: Record<string, unknown> | null) {
      state.rawConfig = raw;
    },
    configLoader: {
      load: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
      getConfig: vi.fn(() => makeConfig()),
      getRawConfig: vi.fn(() => state.rawConfig),
    },
  };
});

type ToolCallHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;

function registeredToolCallHandler(pi: DeepMocked<ExtensionAPI>) {
  const calls: unknown[][] = pi.on.mock.calls;
  return calls.find(([event]) => event === "tool_call")?.[1] as
    | ToolCallHandler
    | undefined;
}

function createCtx(overrides: PartialFuncReturn<ExtensionContext> = {}) {
  return createMock<ExtensionContext>({
    hasUI: true,
    mode: "tui",
    ui: {
      custom: vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn(),
    },
    abort: vi.fn(),
    ...overrides,
  });
}

const DANGEROUS_EVENT = {
  type: "tool_call",
  toolCallId: "dangerous-call",
  toolName: "bash",
  input: { command: "dangerous-cmd" },
} satisfies BashToolCallEvent;

describe("permissionGate extension hook", () => {
  let pi: DeepMocked<ExtensionAPI>;
  let toolCallHandler: ToolCallHandler | undefined;

  beforeEach(async () => {
    pi = createMock<ExtensionAPI>();
    await permissionGate(pi);
    toolCallHandler = registeredToolCallHandler(pi);
  });

  it("registers the permissionGate feature on request", async () => {
    const registration = pi.events.on.mock.calls.find(
      ([event]) => event === GUARDRAILS_FEATURE_REQUEST_EVENT,
    );

    assert(registration, "feature request handler should be registered");
    registration[1](undefined);
    expect(pi.events.emit).toHaveBeenCalledWith(
      GUARDRAILS_FEATURE_REGISTER_EVENT,
      expect.objectContaining({
        feature: { id: "permissionGate" },
      }),
    );
  });

  it("returns undefined for safe commands", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const result = await toolCallHandler(
      {
        type: "tool_call",
        toolCallId: "safe-call",
        toolName: "bash",
        input: { command: "echo hello" },
      } satisfies BashToolCallEvent,
      createCtx(),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for non-bash tools", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const result = await toolCallHandler(
      {
        type: "tool_call",
        toolCallId: "read-call",
        toolName: "read",
        input: { path: "dangerous-cmd" },
      } satisfies ReadToolCallEvent,
      createCtx(),
    );
    expect(result).toBeUndefined();
  });

  it("deny returns { block: true } without aborting the turn", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const ctx = createCtx({
      ui: { custom: vi.fn().mockResolvedValue("deny"), select: vi.fn() },
    });

    const result = await toolCallHandler(DANGEROUS_EVENT, ctx);

    expect(result).toEqual({
      block: true,
      reason: "User denied dangerous command",
    });
    expect(ctx.abort).not.toHaveBeenCalled();
    expect(pi.events.emit).toHaveBeenCalledWith(
      GUARDRAILS_ACTION_BLOCKED_EVENT,
      expect.objectContaining({
        block: expect.objectContaining({ source: "user" }),
      }),
    );
  });

  it("stop calls ctx.abort() and returns { block: true } with user-stop source", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const ctx = createCtx({
      ui: { custom: vi.fn().mockResolvedValue("stop"), select: vi.fn() },
    });

    const result = await toolCallHandler(DANGEROUS_EVENT, ctx);

    expect(result).toEqual({
      block: true,
      reason: "User declined and stopped dangerous command",
    });
    expect(ctx.abort).toHaveBeenCalledTimes(1);
    expect(pi.events.emit).toHaveBeenCalledWith(
      GUARDRAILS_ACTION_BLOCKED_EVENT,
      expect.objectContaining({
        block: expect.objectContaining({ source: "user-stop" }),
      }),
    );
  });

  it("allow once returns undefined and does not abort", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const ctx = createCtx({
      ui: { custom: vi.fn().mockResolvedValue("allow"), select: vi.fn() },
    });

    const result = await toolCallHandler(DANGEROUS_EVENT, ctx);
    expect(result).toBeUndefined();
    expect(ctx.abort).not.toHaveBeenCalled();

    const opened = pi.events.emit.mock.calls.find(
      ([event]) => event === GUARDRAILS_PROMPT_OPENED_EVENT,
    )?.[1] as GuardrailsPromptOpenedPayload | undefined;
    assert(opened, "prompt opened event should be emitted");
    expect(pi).toHaveEmitted(
      GUARDRAILS_PROMPT_CLOSED_EVENT,
      expect.objectContaining({ prompt: { id: opened.prompt.id } }),
    );
  });

  it("closes the prompt when its UI throws", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const ctx = createCtx({
      ui: {
        custom: vi.fn().mockRejectedValue(new Error("UI failed")),
        select: vi.fn(),
      },
    });

    await expect(toolCallHandler(DANGEROUS_EVENT, ctx)).rejects.toThrow(
      "UI failed",
    );

    const opened = pi.events.emit.mock.calls.find(
      ([event]) => event === GUARDRAILS_PROMPT_OPENED_EVENT,
    )?.[1] as GuardrailsPromptOpenedPayload | undefined;
    assert(opened, "prompt opened event should be emitted");
    expect(pi).toHaveEmitted(
      GUARDRAILS_PROMPT_CLOSED_EVENT,
      expect.objectContaining({ prompt: { id: opened.prompt.id } }),
    );
  });

  it("RPC fallback exposes 'Decline and stop' and maps it to stop", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const select = vi.fn().mockResolvedValue("Decline and stop");
    const ctx = createCtx({
      ui: { custom: vi.fn().mockResolvedValue(undefined), select },
    });

    const result = await toolCallHandler(DANGEROUS_EVENT, ctx);

    expect(select).toHaveBeenCalledWith(
      expect.stringContaining("test danger"),
      expect.arrayContaining([
        "Allow once",
        "Allow for session",
        "Deny",
        "Decline and stop",
      ]),
    );
    expect(result).toEqual({
      block: true,
      reason: "User declined and stopped dangerous command",
    });
    expect(ctx.abort).toHaveBeenCalledTimes(1);
  });

  it("non-interactive (no UI) blocks with nonInteractive source and does not abort", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const ctx = createCtx({ hasUI: false });
    const result = await toolCallHandler(DANGEROUS_EVENT, ctx);

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("no UI to confirm"),
    });
    expect(ctx.abort).not.toHaveBeenCalled();
    expect(pi.events.emit).toHaveBeenCalledWith(
      GUARDRAILS_ACTION_BLOCKED_EVENT,
      expect.objectContaining({
        block: expect.objectContaining({ source: "nonInteractive" }),
      }),
    );
  });

  describe("yolo mode", () => {
    beforeEach(() => {
      setPermissionGate({ yolo: true });
    });

    it("skips the confirmation prompt for dangerous commands", async () => {
      assert(toolCallHandler, "tool_call handler should be registered");

      const ctx = createCtx();
      const result = await toolCallHandler(DANGEROUS_EVENT, ctx);

      expect(result).toBeUndefined();
      expect(ctx.ui.custom).not.toHaveBeenCalled();
      expect(ctx.ui.select).not.toHaveBeenCalled();
    });

    it("bypasses autoDeny when yoloRespectAutoDeny is false", async () => {
      assert(toolCallHandler, "tool_call handler should be registered");
      setPermissionGate({
        yolo: true,
        yoloRespectAutoDeny: false,
        autoDenyPatterns: [{ pattern: "dangerous-cmd", description: "denied" }],
      });

      const result = await toolCallHandler(DANGEROUS_EVENT, createCtx());
      expect(result).toBeUndefined();
    });

    it("still blocks autoDeny when yoloRespectAutoDeny is true", async () => {
      assert(toolCallHandler, "tool_call handler should be registered");
      setPermissionGate({
        yolo: true,
        yoloRespectAutoDeny: true,
        autoDenyPatterns: [{ pattern: "dangerous-cmd", description: "denied" }],
      });

      const result = await toolCallHandler(DANGEROUS_EVENT, createCtx());
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("denied"),
      });
    });
  });

  describe("guidance", () => {
    beforeEach(() => {
      setPermissionGate({ patterns: [] });
      setRawConfig({
        permissionGate: {
          customPatterns: [
            {
              pattern: "dangerous-cmd",
              description: "blocking description",
              guidance: "do the safe thing instead",
              regex: true,
            },
          ],
        },
      });
    });

    it("soft-blocks a matched command and tells model to call guardrails_run_anyway", async () => {
      assert(toolCallHandler, "tool_call handler should be registered");

      const result = await toolCallHandler(DANGEROUS_EVENT, createCtx());

      expect(result?.block).toBe(true);
      expect(result?.reason).toContain("do the safe thing instead");
      expect(result?.reason).toContain("guardrails_run_anyway");
      expect(pi.events.emit).toHaveBeenCalledWith(
        GUARDRAILS_ACTION_BLOCKED_EVENT,
        expect.objectContaining({
          block: expect.objectContaining({ source: "permission" }),
        }),
      );
    });

    it("still enforces guidance in yolo mode", async () => {
      assert(toolCallHandler, "tool_call handler should be registered");
      setPermissionGate({ yolo: true, patterns: [] });

      const result = await toolCallHandler(DANGEROUS_EVENT, createCtx());
      expect(result?.block).toBe(true);
      expect(result?.reason).toContain("do the safe thing instead");
    });

    it("reads guidanceOnlyPatterns entries too", async () => {
      assert(toolCallHandler, "tool_call handler should be registered");
      setRawConfig({
        guidanceOnlyPatterns: [
          { pattern: "dangerous-cmd", guidance: "only guidance here", regex: true },
        ],
      });

      const result = await toolCallHandler(DANGEROUS_EVENT, createCtx());
      expect(result?.block).toBe(true);
      expect(result?.reason).toContain("only guidance here");
    });
  });

  describe("before_agent_start system prompt", () => {
    function registeredBeforeAgentStart(pi: DeepMocked<ExtensionAPI>) {
      const calls: unknown[][] = pi.on.mock.calls;
      return calls.find(([event]) => event === "before_agent_start")?.[1] as
        | ExtensionHandler<
            import("@earendil-works/pi-coding-agent").BeforeAgentStartEvent,
            import("@earendil-works/pi-coding-agent").BeforeAgentStartEventResult
          >
        | undefined;
    }

    it("appends guidance instructions when guidance patterns exist", async () => {
      setRawConfig({
        permissionGate: {
          customPatterns: [
            { pattern: "dangerous-cmd", guidance: "be careful", regex: true },
          ],
        },
      });
      const handler = registeredBeforeAgentStart(pi);
      assert(handler, "before_agent_start handler should be registered");

      const result = await handler(
        {
          type: "before_agent_start",
          prompt: "hi",
          systemPrompt: "BASE",
          systemPromptOptions: {},
        } as never,
        createCtx(),
      );

      expect(result?.systemPrompt).toContain("BASE");
      expect(result?.systemPrompt).toContain("Guardrails guidance");
      expect(result?.systemPrompt).toContain("guardrails_run_anyway");
    });

    it("returns undefined when no guidance patterns exist", async () => {
      setRawConfig(null);
      const handler = registeredBeforeAgentStart(pi);
      assert(handler, "before_agent_start handler should be registered");

      const result = await handler(
        {
          type: "before_agent_start",
          prompt: "hi",
          systemPrompt: "BASE",
          systemPromptOptions: {},
        } as never,
        createCtx(),
      );

      expect(result).toBeUndefined();
    });
  });
});
