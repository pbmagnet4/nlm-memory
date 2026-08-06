/**
 * WikiWriter — the projection's only IO seam.
 *
 * Core wiki modules never touch node:fs; they emit rendered strings and this
 * port persists them. Tests substitute MemoryWikiWriter so the idempotence
 * contract is verified without a disk.
 *
 * Paths are relative to a writer-owned root. An implementation must reject a
 * path that escapes it.
 */

export interface WikiWriter {
  write(relPath: string, content: string): Promise<void>;
  /** Current content, or null when absent. Reconcile compares against this to
   *  skip byte-identical files, which is what makes a repeat run free. */
  read(relPath: string): Promise<string | null>;
  remove(relPath: string): Promise<void>;
  /** Markdown files currently present, relative paths, sentinel excluded. */
  list(): Promise<ReadonlyArray<string>>;
}
