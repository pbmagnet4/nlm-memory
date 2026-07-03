const DEFAULT_CAP = 4;

function parseCap(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CAP;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP;
}

const cap = parseCap(process.env["NLM_RECALL_MAX_INFLIGHT_EMBEDS"]);

let current = 0;
let shedTotal = 0;

export function tryAcquire(): boolean {
  if (current >= cap) {
    shedTotal++;
    return false;
  }
  current++;
  return true;
}

export function release(): void {
  if (current > 0) current--;
}

export interface EmbedInflightSnapshot {
  readonly current: number;
  readonly cap: number;
  readonly shedTotal: number;
}

export function inflightSnapshot(): EmbedInflightSnapshot {
  return { current, cap, shedTotal };
}

export function resetForTests(): void {
  current = 0;
  shedTotal = 0;
}
