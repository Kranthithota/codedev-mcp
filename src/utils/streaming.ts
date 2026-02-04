/**
 * Streaming Utilities
 * Provides streaming support for large results
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from './logger.js';

export interface StreamOptions {
    chunkSize?: number;
    delayMs?: number;
    onProgress?: (progress: number, total: number) => void;
}

/**
 * Stream large text content in chunks
 */
export async function* streamContent(
    content: string,
    options: StreamOptions = {}
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
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

/**
 * Stream array results in batches
 */
export async function* streamArray<T>(
    items: T[],
    options: StreamOptions = {}
): AsyncGenerator<T[], void, unknown> {
    const chunkSize = options.chunkSize ?? 50;
    const delayMs = options.delayMs ?? 0;

    for (let i = 0; i < items.length; i += chunkSize) {
        const batch = items.slice(i, i + chunkSize);
        yield batch;

        if (options.onProgress) {
            options.onProgress(i + batch.length, items.length);
        }

        if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

/**
 * Format streaming response with progress
 */
export function formatStreamingResponse(
    chunks: string[],
    metadata: { total: number; processed: number }
): string {
    const progress = Math.round((metadata.processed / metadata.total) * 100);
    return `[Progress: ${progress}%]\n${chunks.join('')}`;
}

/**
 * Wrap a long-running operation with timeout
 */
export async function withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    operationName: string = 'Operation'
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
 */
export function truncateResults<T>(
    items: T[],
    maxItems: number,
    formatItem?: (item: T) => string
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
