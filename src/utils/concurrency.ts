/**
 * Concurrency limiter for parallel tool calls.
 * Prevents resource exhaustion when MCP clients send many requests at once.
 */

/**
 * Semaphore for limiting concurrent operations.
 */
export class Semaphore {
  private current = 0;
  private queue: (() => void)[] = [];

  /**
   * Create a new Semaphore with a maximum concurrency limit.
   * @param maxConcurrent - Maximum number of concurrent operations allowed.
   */
  constructor(private readonly maxConcurrent: number) {}

  /**
   * Acquire a semaphore slot. Waits if at capacity.
   */
  async acquire(): Promise<void> {
    if (this.current < this.maxConcurrent) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Release a semaphore slot, allowing the next queued operation to proceed.
   */
  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }

  /**
   * Wrap an async function with semaphore acquire/release.
   * @param fn - The async function to run under concurrency control.
   * @returns The result of the wrapped function.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Get the number of queued operations waiting for a slot.
   * @returns The number of pending operations.
   */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Get the number of currently active operations.
   * @returns The number of active operations.
   */
  get active(): number {
    return this.current;
  }
}

/**
 * Global tool concurrency limiter.
 * Defaults to 8 concurrent tool executions — enough for parallel use
 * while preventing filesystem/ripgrep thrashing on large codebases.
 */
const MAX_CONCURRENT = parseInt(process.env.CODEDEV_MAX_CONCURRENT || '8', 10);
export const toolLimiter = new Semaphore(MAX_CONCURRENT);
