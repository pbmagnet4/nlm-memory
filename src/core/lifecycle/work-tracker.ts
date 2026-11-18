export class WorkTracker {
  private accepting = true;
  private readonly active = new Set<Promise<unknown>>();

  beginRequest(): (() => void) | undefined {
    if (!this.accepting) return undefined;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    this.track(pending);
    return release;
  }

  track<T>(work: Promise<T>): Promise<T> {
    this.active.add(work);
    void work.then(
      () => this.active.delete(work),
      () => this.active.delete(work),
    );
    return work;
  }

  stopAdmission(): void {
    this.accepting = false;
  }

  isAccepting(): boolean {
    return this.accepting;
  }

  async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active]);
    }
  }
}
