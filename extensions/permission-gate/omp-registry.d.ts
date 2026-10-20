/**
 * Ambient types for omp's runtime settings registry.
 *
 * The specifier exists only inside the omp host (its extension loader rewrites
 * pi-package specifiers onto host-bundled code); upstream pi has no such
 * module, so this stays ambient and the runtime import is guarded.
 */
declare module "@oh-my-pi/pi-coding-agent/config/registry" {
  /** A typed settings handle resolved by id from the host registry. */
  export interface SettingsHandle {
    get(scope: unknown): unknown;
  }

  /** Resolve a settings handle by id; `undefined` when the id is unknown. */
  export function lookup(id: string): SettingsHandle | undefined;
}
