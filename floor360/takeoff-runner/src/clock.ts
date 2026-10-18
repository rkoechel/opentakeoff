// Time as a dependency, so the waker backoff (15-minute retries for up to 4
// hours) and the 60-minute job budget are testable without waiting.

export interface Clock {
  now(): number;
  /** Resolves after ms, or rejects with the signal's reason when aborted. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimeout(t); reject(signal?.reason); };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};
