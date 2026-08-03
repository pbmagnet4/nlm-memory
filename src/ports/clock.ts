/**
 * Clock — injected time source + coarse interval scheduler.
 *
 * Core modules never call Date.now()/setInterval directly; this port lets
 * tests drive virtual time instead of real timers. Real adapter (daemon
 * composition root) wraps Date.now()/setInterval; tests substitute a
 * virtual-time fake. First consumer: core/jobs/job-supervisor.ts.
 */

export interface Clock {
  now(): number;
  setInterval(fn: () => void, ms: number): void;
}
