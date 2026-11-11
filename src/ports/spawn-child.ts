/**
 * ChildHandle/SpawnChild — injected child-process port for job supervision.
 *
 * Real adapter (daemon composition root) wraps child_process.spawn with a
 * line-buffered stdout/stderr reader; tests substitute a fake that lets
 * them drive onLine/onExit directly, no real child_process involved.
 * First consumer: core/jobs/job-supervisor.ts.
 */

export interface ChildHandle {
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

/** `env` is merged over the daemon's environment for the child (may hold secrets). */
export type SpawnChild = (args: string[], env?: Record<string, string>) => ChildHandle;
