/**
 * Tool Usage Analytics
 * Tracks which tools are called most, response times, cache hit rates.
 * Exposed via server://stats resource.
 */

export interface ToolCall {
  tool: string;
  timestamp: number;
  durationMs: number;
  success: boolean;
  cached: boolean;
}

export interface ToolStats {
  tool: string;
  callCount: number;
  avgDurationMs: number;
  maxDurationMs: number;
  errorCount: number;
  cacheHits: number;
  lastCalled?: string;
}

export interface AnalyticsReport {
  uptime: string;
  totalCalls: number;
  totalErrors: number;
  avgResponseMs: number;
  cacheHitRate: string;
  toolStats: ToolStats[];
  recentCalls: { tool: string; durationMs: number; timestamp: string }[];
}

class Analytics {
  private calls: ToolCall[] = [];
  private startTime = Date.now();
  /** Keep last 5000 calls */
  private maxHistory = 5000;

  /**
   * Record a tool call.
   * @param tool - Tool name.
   * @param durationMs - Duration in milliseconds.
   * @param success - Whether the call succeeded.
   * @param cached - Whether the result was from cache.
   */
  record(tool: string, durationMs: number, success: boolean, cached: boolean = false) {
    this.calls.push({ tool, timestamp: Date.now(), durationMs, success, cached });
    // Trim old history
    if (this.calls.length > this.maxHistory) {
      this.calls = this.calls.slice(-this.maxHistory);
    }

    // Persist async (fire and forget)
    import('../db/connection.js').then(({ getDb }) => {
      // Lazy import to avoid circular dep if any
      getDb()
        .then((db) => {
          db.logUsage(tool, durationMs, success, cached);
          db.save().catch(() => {
            /* Silently ignore save errors to avoid polluting structured logs */
          });
        })
        .catch(() => {});
    });
  }

  /**
   * Wrap an async tool handler with timing and recording.
   * @param tool - Tool name.
   * @param fn - The async function to wrap.
   * @param cached - Whether the result is from cache.
   * @returns The result of the wrapped function.
   */
  async track<T>(tool: string, fn: () => Promise<T>, cached: boolean = false): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      this.record(tool, Date.now() - start, true, cached);
      return result;
    } catch (error) {
      this.record(tool, Date.now() - start, false, cached);
      throw error;
    }
  }

  /**
   * Get full analytics report.
   * @returns The analytics report with uptime, totals, and per-tool stats.
   */
  getReport(): AnalyticsReport {
    const uptimeMs = Date.now() - this.startTime;
    const hours = Math.floor(uptimeMs / 3600000);
    const mins = Math.floor((uptimeMs % 3600000) / 60000);
    const secs = Math.floor((uptimeMs % 60000) / 1000);

    // Aggregate by tool
    const toolMap = new Map<string, ToolCall[]>();
    for (const call of this.calls) {
      if (!toolMap.has(call.tool)) toolMap.set(call.tool, []);
      toolMap.get(call.tool)!.push(call);
    }

    const toolStats: ToolStats[] = Array.from(toolMap.entries())
      .map(([tool, calls]) => ({
        tool,
        callCount: calls.length,
        avgDurationMs: Math.round(calls.reduce((sum, c) => sum + c.durationMs, 0) / calls.length),
        maxDurationMs: Math.max(...calls.map((c) => c.durationMs)),
        errorCount: calls.filter((c) => !c.success).length,
        cacheHits: calls.filter((c) => c.cached).length,
        lastCalled: new Date(calls[calls.length - 1].timestamp).toISOString(),
      }))
      .sort((a, b) => b.callCount - a.callCount);

    const totalCalls = this.calls.length;
    const totalErrors = this.calls.filter((c) => !c.success).length;
    const totalCached = this.calls.filter((c) => c.cached).length;
    const avgResponseMs =
      totalCalls > 0 ? Math.round(this.calls.reduce((sum, c) => sum + c.durationMs, 0) / totalCalls) : 0;

    // Recent 10 calls
    const recentCalls = this.calls
      .slice(-10)
      .reverse()
      .map((c) => ({
        tool: c.tool,
        durationMs: c.durationMs,
        timestamp: new Date(c.timestamp).toISOString(),
      }));

    return {
      uptime: `${hours}h ${mins}m ${secs}s`,
      totalCalls,
      totalErrors,
      avgResponseMs,
      cacheHitRate: totalCalls > 0 ? `${Math.round((totalCached / totalCalls) * 100)}%` : '0%',
      toolStats,
      recentCalls,
    };
  }

  /**
   * Get suggested actions based on analytics and codebase state.
   * @returns A list of suggested actions.
   */
  getSuggestedActions(): string[] {
    const suggestions: string[] = [];
    const report = this.getReport();

    if (report.totalCalls === 0) {
      suggestions.push('Start with "codebase_map" to get an overview of the project.');
      suggestions.push('Use "security_scan" to check for common vulnerabilities.');
      suggestions.push('Run "code_health_check" prompt for a complete health audit.');
      return suggestions;
    }

    // Check what hasn't been used
    const usedTools = new Set(report.toolStats.map((s) => s.tool));
    if (!usedTools.has('security_scan')) suggestions.push('Run "security_scan" to check for vulnerabilities.');
    if (!usedTools.has('test_coverage')) suggestions.push('Check "test_coverage" to see what needs more tests.');
    if (!usedTools.has('dead_code')) suggestions.push('Use "dead_code" to find unused exports and orphan files.');
    if (!usedTools.has('code_docs'))
      suggestions.push('Use "code_docs" with action "undocumented" to find undocumented APIs.');

    // High error tools
    for (const stat of report.toolStats) {
      if (stat.errorCount > stat.callCount * 0.3) {
        suggestions.push(
          `Tool "${stat.tool}" has a ${Math.round((stat.errorCount / stat.callCount) * 100)}% error rate — check the parameters.`,
        );
      }
    }

    // Performance suggestions
    if (report.avgResponseMs > 2000) {
      suggestions.push(
        'Average response time is high — consider narrowing search queries with file_glob or directory parameters.',
      );
    }

    return suggestions.slice(0, 5);
  }
}

// Singleton instance
export const analytics = new Analytics();
