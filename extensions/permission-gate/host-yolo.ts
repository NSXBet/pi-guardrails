/**
 * Host approval-mode bridge.
 *
 * omp (the host) resolves tool approval through `tools.approvalMode`
 * (`--approval-mode`, `--yolo`, `/settings`), which is a completely separate
 * switch from this extension's `permissionGate.yolo`. In yolo the host
 * auto-approves every tool tier, so prompting here defeats the point of the
 * mode: the gate treats a host yolo exactly like `permissionGate.yolo`.
 *
 * The registry specifier resolves to the host-bundled registry inside omp
 * (its extension loader rewrites pi-package specifiers onto host code). On
 * upstream pi or any host without it the import fails and this returns false,
 * which preserves the prompting status quo — fail safe, never fail open.
 */
import type * as OmpRegistry from "@oh-my-pi/pi-coding-agent/config/registry";

/** Scope host: `pi.pi` (package exports) carries the live settings store in omp. */
interface SettingsScopeHost {
  pi?: { settings?: unknown };
}

let registryPromise: Promise<typeof OmpRegistry | undefined> | undefined;

function loadRegistry(): Promise<typeof OmpRegistry | undefined> {
  registryPromise ??= import("@oh-my-pi/pi-coding-agent/config/registry").catch(
    () => undefined,
  );
  return registryPromise;
}

/**
 * True when the running host's effective approval mode is `yolo`.
 * Any failure (upstream pi, unknown setting, inaccessible scope) → false.
 */
export async function isHostApprovalYolo(pi: unknown): Promise<boolean> {
  const scope = (pi as SettingsScopeHost).pi?.settings;
  if (scope === undefined) return false;
  const registry = await loadRegistry();
  const handle = registry?.lookup("tools.approvalMode");
  if (!handle) return false;
  return handle.get(scope) === "yolo";
}
