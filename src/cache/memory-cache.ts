/**
 * In-memory cache with mtime-based invalidation.
 * No external dependencies. Supports TTL and file-change detection.
 */

import { stat } from 'node:fs/promises';

interface CacheEntry<T> {
  data: T;
  /** File modification time (for file-based cache) */
  mtime?: number;
  /** When cached */
  timestamp: number;
  /** Time-to-live in ms */
  ttl: number;
}

/**
 * In-memory cache with TTL and file-mtime-based invalidation.
 */
export class MemoryCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private maxEntries: number;
  private hits = 0;
  private misses = 0;

  /**
   * Create a new MemoryCache instance.
   * @param maxEntries - Maximum number of entries to store before evicting.
   */
  constructor(maxEntries = 5000) {
    this.maxEntries = maxEntries;
  }

  /**
   * Get cached value. Returns null if expired, missing, or file changed.
   * @param key - Cache key to look up.
   * @param filePath - Optional file path for mtime-based invalidation.
   * @returns The cached value or null if not found/expired.
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
   * @param key - Cache key.
   * @param data - Data to cache.
   * @param ttl - Time-to-live in milliseconds.
   * @param filePath - Optional file path for mtime tracking.
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
   * @param keyOrPrefix - Exact key or prefix to invalidate.
   * @returns The number of entries invalidated.
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
   * @param filePath - File path to match against cache keys.
   * @returns The number of entries invalidated.
   */
  invalidateFile(filePath: string): number {
    let count = 0;
    for (const key of this.store.keys()) {
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
   * @returns An object with size, hits, misses, and hitRate.
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
  result: unknown;
  timestamp: number;
  ttl: number;
  toolName: string;
}

/**
 * Cache for tool call results, keyed by tool name and parameters.
 */
export class ToolResultCache {
  private store = new Map<string, ToolResultEntry>();
  private maxEntries: number;
  private hits = 0;
  private misses = 0;

  /**
   * Create a new ToolResultCache instance.
   * @param maxEntries - Maximum number of entries to store before evicting.
   */
  constructor(maxEntries = 2000) {
    this.maxEntries = maxEntries;
  }

  /**
   * Generate a deterministic cache key from tool name + params.
   * @param toolName - Name of the tool.
   * @param params - Tool parameters.
   * @returns A deterministic cache key string.
   */
  private makeKey(toolName: string, params: Record<string, unknown>): string {
    // Sort keys for deterministic hashing
    const sorted = Object.keys(params)
      .sort()
      .reduce(
        (acc, k) => {
          if (params[k] !== undefined) acc[k] = params[k];
          return acc;
        },
        {} as Record<string, unknown>,
      );
    return `tool:${toolName}:${this.simpleHash(JSON.stringify(sorted))}`;
  }

  /**
   * Simple FNV-1a-inspired hash for speed.
   * @param str - String to hash.
   * @returns A base-36 hash string.
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
   * @param toolName - Name of the tool.
   * @param params - Tool parameters.
   * @returns The cached result or null if not found/expired.
   */
  get(toolName: string, params: Record<string, unknown>): unknown | null {
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
   * @param toolName - Name of the tool.
   * @param params - Tool parameters.
   * @param result - The result to cache.
   * @param ttl - Time-to-live in milliseconds.
   */
  set(toolName: string, params: Record<string, unknown>, result: unknown, ttl = 120_000): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }
    const key = this.makeKey(toolName, params);
    this.store.set(key, { result, timestamp: Date.now(), ttl, toolName });
  }

  /**
   * Invalidate all cached results for a specific tool.
   * @param toolName - Name of the tool to invalidate.
   * @returns The number of entries invalidated.
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
   * @param filePath - File path to match against cache keys.
   * @returns The number of entries invalidated.
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

  /**
   * Invalidate all entries.
   */
  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Stats for analytics integration.
   * @returns An object with size, hits, misses, and hitRate.
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

// Singleton instances
export const cache = new MemoryCache();
export const toolResultCache = new ToolResultCache();
