/**
 * NLM_HOSTED=1 switches the daemon to hosted posture. Under hosted mode,
 * LOCAL-dispositioned routes (whole-DB dataset/backup/restore/stats,
 * process-global classifier swap) and M6-FILTER routes (citation events,
 * recall/facts stats+recent, hook-memo trio — file-state surfaces not yet
 * tenant-attributed) return 403 before touching any handler (program spec
 * §4.6). Local mode (the default, no env set) is unaffected.
 */
export function isHostedMode(): boolean {
  return process.env["NLM_HOSTED"] === "1";
}
