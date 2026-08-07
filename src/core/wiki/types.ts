import type { Fact } from "@shared/types.js";

export interface WikiConfig {
  readonly minFacts: number;
  readonly minSessions: number;
  /** Base URL a page's session links point at. Config because a page outlives
   *  the process that wrote it and a synced vault must not carry dead
   *  loopback links. */
  readonly linkBase: string;
}

export interface PageRollup {
  /** Canonical spelling, chosen deterministically when a page merges more
   *  than one colliding spelling. See rollup.ts for the selection rule. */
  readonly subject: string;
  readonly slug: string;
  readonly current: ReadonlyArray<Fact>;
  readonly superseded: ReadonlyArray<Fact>;
  readonly sessionIds: ReadonlyArray<string>;
  /** Other subjects that earned a page and share a session with this one. */
  readonly related: ReadonlyArray<string>;
  /** Other spellings that merged into this page. Empty when nothing merged. */
  readonly aliases: ReadonlyArray<string>;
}

export interface RenderedPage {
  readonly relPath: string;
  readonly content: string;
}

export interface ProjectionResult {
  readonly written: number;
  readonly unchanged: number;
  readonly removed: number;
  /** Number of pages selection produced, i.e. distinct slug groups — not the
   *  number of selected subjects, since a merge makes those diverge. */
  readonly qualifying: number;
  readonly onDisk: number;
  /** qualifying minus onDisk after the run. Nonzero means a run failed. */
  readonly coverageDrift: number;
}
