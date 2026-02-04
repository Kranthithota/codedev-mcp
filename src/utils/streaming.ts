/**
 * Streaming Utilities
 * Provides streaming support for large results
 */

import { logger } from './logger.js';

export interface StreamOptions {
  chunkSize?: number;
  delayMs?: number;
  onProgress?: (progress: number, total: number) => void;
}

/**
 * Stream large text content in chunks
 * @param content - The text content to stream.
 * @param options - Streaming options (chunkSize, delayMs, onProgress).
 * @returns An async generator yielding string chunks.
 */
export async function* streamContent(
  content: string,
  options: StreamOptions = {},
): AsyncGenerator<string, void, unknown> {
  const chunkSize = options.chunkSize ?? 4096;
  const delayMs = options.delayMs ?? 0;

  for (let i = 0; i < content.length; i += chunkSize) {
    const chunk = content.slice(i, i + chunkSize);
    yield chunk;

    if (options.onProgress) {
      options.onProgress(i + chunk.length, content.length);
    }

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Stream array results in batches
 * @param items - The array of items to stream.
 * @param options - Streaming options (chunkSize, delayMs, onProgress).
 * @returns An async generator yielding batches of items.
 */
export async function* streamArray<T>(items: T[], options: StreamOptions = {}): AsyncGenerator<T[], void, unknown> {
  const chunkSize = options.chunkSize ?? 50;
  const delayMs = options.delayMs ?? 0;

  for (let i = 0; i < items.length; i += chunkSize) {
    const batch = items.slice(i, i + chunkSize);
    yield batch;

    if (options.onProgress) {
      options.onProgress(i + batch.length, items.length);
    }

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Format streaming response with progress
 * @param chunks - The chunks to format.
 * @param metadata - Metadata with total and processed counts.
 * @param metadata.total - Total number of items.
 * @param metadata.processed - Number of items processed.
 * @returns A formatted string with progress indicator.
 */
export function formatStreamingResponse(chunks: string[], metadata: { total: number; processed: number }): string {
  const progress = Math.round((metadata.processed / metadata.total) * 100);
  return `[Progress: ${progress}%]\n${chunks.join('')}`;
}

/**
 * Wrap a long-running operation with timeout
 * @param operation - The promise to wrap with a timeout.
 * @param timeoutMs - The timeout duration in milliseconds.
 * @param operationName - A name for the operation (used in error messages).
 * @returns The result of the operation.
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  operationName: string = 'Operation',
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } catch (error) {
    logger.warn(`${operationName} timeout`, { timeoutMs });
    throw error;
  }
}

/**
 * Truncate large results with summary
 * @param items - The array of items to truncate.
 * @param maxItems - Maximum number of items to keep.
 * @returns An object with truncated items and metadata.
 */
export function truncateResults<T>(
  items: T[],
  maxItems: number,
): { items: T[]; truncated: boolean; total: number; shown: number } {
  const truncated = items.length > maxItems;
  const shown = Math.min(items.length, maxItems);

  return {
    items: items.slice(0, maxItems),
    truncated,
    total: items.length,
    shown,
  };
}
