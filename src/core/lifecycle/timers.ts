export class ManagedTimers {
  private stopped = false;
  private readonly timers = new Set<NodeJS.Timeout>();

  interval(callback: () => void, milliseconds: number): NodeJS.Timeout {
    if (this.stopped) throw new Error("timers are stopped");
    const timer = setInterval(() => { if (!this.stopped) callback(); }, milliseconds);
    this.timers.add(timer);
    return timer;
  }

  timeout(callback: () => void, milliseconds: number): NodeJS.Timeout {
    if (this.stopped) throw new Error("timers are stopped");
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) callback();
    }, milliseconds);
    this.timers.add(timer);
    return timer;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
