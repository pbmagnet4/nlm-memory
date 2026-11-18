export interface ShutdownSteps {
  stopAdmission(): void;
  cancelTimers(): void;
  closeServer(): Promise<void>;
  stopWorkers(): void;
  drain(): Promise<void>;
  closeStorage(): Promise<void>;
}

export function createShutdown(steps: ShutdownSteps, timeoutMs: number): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => {
    if (result) return result;
    result = (async () => {
      steps.stopAdmission();
      steps.cancelTimers();
      const serverClosed = steps.closeServer();
      steps.stopWorkers();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      try {
        await Promise.race([
          (async () => {
            await Promise.all([serverClosed, steps.drain()]);
            if (!expired) await steps.closeStorage();
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              expired = true;
              reject(new Error("shutdown timed out"));
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return result;
  };
}
