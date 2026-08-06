import type { WikiWriter } from "@ports/wiki-writer.js";

export class MemoryWikiWriter implements WikiWriter {
  readonly files = new Map<string, string>();

  async write(relPath: string, content: string): Promise<void> {
    this.files.set(relPath, content);
  }

  async read(relPath: string): Promise<string | null> {
    return this.files.get(relPath) ?? null;
  }

  async remove(relPath: string): Promise<void> {
    this.files.delete(relPath);
  }

  async list(): Promise<ReadonlyArray<string>> {
    return [...this.files.keys()];
  }
}
