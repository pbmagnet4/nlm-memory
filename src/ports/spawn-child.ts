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

export type SpawnChild = (args: string[]) => ChildHandle;
