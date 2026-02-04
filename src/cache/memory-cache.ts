/**
 * In-memory cache with mtime-based invalidation.
 * No external dependencies. Supports TTL and file-change detection.
 */

import { stat } from 'node:fs/promises';

interface CacheEntry<T> {
  data: T;
  mtime?: number; // File modification time (for file-based cache)
  timestamp: number; // When cached
  ttl: number; // Time-to-live in ms
}

/**
 *
 */
export class MemoryCache {
  private store = new Map<string, CacheEntry<any>>();
  private maxEntries: number;
  private hits = 0;
  private misses = 0;

  /**
   *
   * @param maxEntries
   */
  constructor(maxEntries = 5000) {
    this.maxEntries = maxEntries;
  }

  /**
   * Get cached value. Returns null if expired, missing, or file changed.
   * @param key
   * @param filePath
   */
  async get<T>(key: string, filePath?: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.store.delete(key);
      this.misses++;
      return null;
    }

    // Check file mtime if applicable
    if (filePath && entry.mtime !== undefined) {
      try {
        const s = await stat(filePath);
        if (s.mtimeMs !== entry.mtime) {
          this.store.delete(key);
          this.misses++;
          return null;
        }
      } catch {
        this.store.delete(key);
        this.misses++;
        return null;
      }
    }

    this.hits++;
    return entry.data as T;
  }

  /**
   * Set cached value with optional file path for mtime tracking.
   * @param key
   * @param data
   * @param ttl
   * @param filePath
   */
  async set<T>(key: string, data: T, ttl = 60_000, filePath?: string): Promise<void> {
    // Evict oldest if at capacity
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }

    let mtime: number | undefined;
    if (filePath) {
      try {
        const s = await stat(filePath);
        mtime = s.mtimeMs;
      } catch {
        /* no mtime tracking */
      }
    }

    this.store.set(key, { data, mtime, timestamp: Date.now(), ttl });
  }

  /**
   * Invalidate specific key or pattern.
   * @param keyOrPrefix
   */
  invalidate(keyOrPrefix: string): number {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key === keyOrPrefix || key.startsWith(keyOrPrefix + ':')) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Invalidate all entries related to a file path.
   * @param filePath
   */
  invalidateFile(filePath: string): number {
    let count = 0;
    for (const [key, entry] of this.store.entries()) {
      if (key.includes(filePath)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get cache statistics.
   */
  stats(): { size: number; hits: number; misses: number; hitRate: string } {
    const total = this.hits + this.misses;
    return {
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${Math.round((this.hits / total) * 100)}%` : 'N/A',
    };
  }
}

/**
 * Conversation-Aware Tool Result Cache.
 * Caches full tool responses keyed by hash(toolName + JSON(params)).
 * Gives instant replay when the same tool is called with identical params.
 */

interface ToolResultEntry {
  result: any;
  timestamp: number;
  ttl: number;
  toolName: string;
}

/**
 *
 */
export class ToolResultCache {
  private store = new Map<string, ToolResultEntry>();
  private maxEntries: number;
  private hits = 0;
  private misses = 0;

  /**
   *
   * @param maxEntries
   */
  constructor(maxEntries = 2000) {
    this.maxEntries = maxEntries;
  }

  /**
   * Generate a deterministic cache key from tool name + params.
   * @param toolName
   * @param params
   */
  private makeKey(toolName: string, params: Record<string, any>): string {
    // Sort keys for deterministic hashing
    const sorted = Object.keys(params)
      .sort()
      .reduce(
        (acc, k) => {
          if (params[k] !== undefined) acc[k] = params[k];
          return acc;
        },
        {} as Record<string, any>,
      );
    return `tool:${toolName}:${this.simpleHash(JSON.stringify(sorted))}`;
  }

  /**
   * Simple FNV-1a-inspired hash for speed.
   * @param str
   */
  private simpleHash(str: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  /**
   * Get cached tool result. Returns null on miss.
   * @param toolName
   * @param params
   */
  get(toolName: string, params: Record<string, any>): any | null {
    const key = this.makeKey(toolName, params);
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.store.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.result;
  }

  /**
   * Cache a tool result. Default TTL: 120s (tools may return stale data for file changes).
   * @param toolName
   * @param params
   * @param result
   * @param ttl
   */
  set(toolName: string, params: Record<string, any>, result: any, ttl = 120_000): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }
    const key = this.makeKey(toolName, params);
    this.store.set(key, { result, timestamp: Date.now(), ttl, toolName });
  }

  /**
   * Invalidate all cached results for a specific tool.
   * @param toolName
   */
  invalidateTool(toolName: string): number {
    let count = 0;
    for (const [key, entry] of this.store.entries()) {
      if (entry.toolName === toolName) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Invalidate all cached results that might reference a file path.
   * @param filePath
   */
  invalidateForFile(filePath: string): number {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.includes(filePath)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Invalidate all entries. */
  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** Stats for analytics integration. */
  stats(): { size: number; hits: number; misses: number; hitRate: string } {
    const total = this.hits + this.misses;
    return {
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${Math.round((this.hits / total) * 100)}%` : 'N/A',
    };
  }
}

// Singleton instances
export const cache = new MemoryCache();
export const toolResultCache = new ToolResultCache();
