/**
 * Concurrency limiter for parallel tool calls.
 * Prevents resource exhaustion when MCP clients send many requests at once.
 */

export class Semaphore {
    private current = 0;
    private queue: (() => void)[] = [];

    constructor(private readonly maxConcurrent: number) {}

    async acquire(): Promise<void> {
        if (this.current < this.maxConcurrent) {
            this.current++;
            return;
        }
        return new Promise<void>((resolve) => {
            this.queue.push(resolve);
        });
    }

    release(): void {
        this.current--;
        const next = this.queue.shift();
        if (next) {
            this.current++;
            next();
        }
    }

    /** Wrap an async function with semaphore acquire/release. */
    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    get pending(): number {
        return this.queue.length;
    }

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
