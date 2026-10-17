/** A counting semaphore that caps how many async tasks run at once. */
export class Limiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private max: number) {
    this.max = Math.max(1, max);
  }

  setMax(max: number): void {
    this.max = Math.max(1, max);
    this.drain();
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      // drain() reserves the slot for us before resolving.
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      this.active--;
      this.drain();
    }
  }

  private drain(): void {
    while (this.active < this.max && this.queue.length) {
      this.active++;
      this.queue.shift()!();
    }
  }
}

/** Runs `fn` over `items` with at most `concurrency` in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const wrapped = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return wrapped;
}
