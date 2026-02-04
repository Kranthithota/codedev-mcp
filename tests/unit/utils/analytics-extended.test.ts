import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { analytics } from '../../../src/utils/analytics.js';
import type { AnalyticsReport, ToolStats } from '../../../src/utils/analytics.js';

// Mock the dynamic import for DB connection used in record()
const mockLogUsage = vi.fn();
const mockSave = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../src/db/connection.js', () => ({
  getDb: vi.fn().mockResolvedValue({
    logUsage: (...args: any[]) => mockLogUsage(...args),
    save: () => mockSave(),
  }),
}));

/**
 * Helper: wait for the fire-and-forget async DB persistence in record() to settle.
 * The dynamic import + getDb promise chain requires at least one microtask flush.
 */
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 50));

/**
 * Helper: reset the singleton's internal state so tests are isolated.
 * Since the class is not exported and there is no public reset method,
 * we reach into private fields via `any` cast.
 */
function resetAnalytics(): void {
  const a = analytics as any;
  a.calls = [];
  a.startTime = Date.now();
}

describe('Analytics - Extended Tests', () => {
  beforeEach(() => {
    resetAnalytics();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────
  // 1. Singleton accessibility
  // ─────────────────────────────────────────────────────────
  describe('singleton instance', () => {
    it('should be defined and have expected public methods', () => {
      expect(analytics).toBeDefined();
      expect(typeof analytics.record).toBe('function');
      expect(typeof analytics.track).toBe('function');
      expect(typeof analytics.getReport).toBe('function');
      expect(typeof analytics.getSuggestedActions).toBe('function');
    });

    it('should maintain state across calls on the same instance', async () => {
      analytics.record('toolA', 100, true);
      analytics.record('toolB', 200, true);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.totalCalls).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────
  // 2. record() tracks calls correctly
  // ─────────────────────────────────────────────────────────
  describe('record()', () => {
    it('should add a call entry to internal state', async () => {
      analytics.record('search', 150, true);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.totalCalls).toBe(1);
      expect(report.toolStats).toHaveLength(1);
      expect(report.toolStats[0].tool).toBe('search');
    });

    it('should record success=false as an error', async () => {
      analytics.record('search', 100, false);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.totalErrors).toBe(1);
      expect(report.toolStats[0].errorCount).toBe(1);
    });

    it('should default cached to false when not provided', async () => {
      analytics.record('list_files', 80, true);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.cacheHitRate).toBe('0%');
      expect(report.toolStats[0].cacheHits).toBe(0);
    });

    it('should track cached=true when provided', async () => {
      analytics.record('list_files', 5, true, true);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.cacheHitRate).toBe('100%');
      expect(report.toolStats[0].cacheHits).toBe(1);
    });

    it('should persist to DB asynchronously', async () => {
      analytics.record('codebase_map', 250, true, false);
      await flushAsync();

      expect(mockLogUsage).toHaveBeenCalledWith('codebase_map', 250, true, false);
      expect(mockSave).toHaveBeenCalled();
    });

    it('should persist cached flag to DB', async () => {
      analytics.record('search', 10, true, true);
      await flushAsync();

      expect(mockLogUsage).toHaveBeenCalledWith('search', 10, true, true);
    });

    it('should handle multiple rapid calls', async () => {
      for (let i = 0; i < 20; i++) {
        analytics.record('rapid_tool', i * 10, true);
      }
      await flushAsync();

      const report = analytics.getReport();
      expect(report.totalCalls).toBe(20);
      expect(report.toolStats[0].callCount).toBe(20);
    });
  });

  // ─────────────────────────────────────────────────────────
  // 3. track() wraps async functions with timing
  // ─────────────────────────────────────────────────────────
  describe('track()', () => {
    it('should return the result of the wrapped function', async () => {
      const result = await analytics.track('search', async () => {
        return { files: ['a.ts', 'b.ts'] };
      });

      expect(result).toEqual({ files: ['a.ts', 'b.ts'] });
    });

    it('should record a successful call after the function resolves', async () => {
      await analytics.track('list_files', async () => {
        return ['file1.ts'];
      });
      await flushAsync();

      const report = analytics.getReport();
      expect(report.totalCalls).toBe(1);
      expect(report.totalErrors).toBe(0);
      expect(report.toolStats[0].tool).toBe('list_files');
      expect(report.toolStats[0].errorCount).toBe(0);
    });

    it('should measure duration of the wrapped function', async () => {
      await analytics.track('slow_tool', async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 'done';
      });
      await flushAsync();

      const report = analytics.getReport();
      // Duration should be at least 100ms (the sleep time)
      expect(report.toolStats[0].avgDurationMs).toBeGreaterThanOrEqual(80);
    });

    it('should pass cached parameter through to record', async () => {
      await analytics.track(
        'cached_search',
        async () => 'cached_result',
        true,
      );
      await flushAsync();

      const report = analytics.getReport();
      expect(report.toolStats[0].cacheHits).toBe(1);
      expect(report.cacheHitRate).toBe('100%');
    });

    it('should default cached to false', async () => {
      await analytics.track('uncached_tool', async () => 'result');
      await flushAsync();

      const report = analytics.getReport();
      expect(report.toolStats[0].cacheHits).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────
  // 4. track() records errors when the function throws
  // ─────────────────────────────────────────────────────────
  describe('track() error handling', () => {
    it('should re-throw the error from the wrapped function', async () => {
      await expect(
        analytics.track('failing_tool', async () => {
          throw new Error('Something broke');
        }),
      ).rejects.toThrow('Something broke');
    });

    it('should record the call as a failure when the function throws', async () => {
      try {
        await analytics.track('failing_tool', async () => {
          throw new Error('Kaboom');
        });
      } catch {
        // expected
      }
      await flushAsync();

      const report = analytics.getReport();
      expect(report.totalCalls).toBe(1);
      expect(report.totalErrors).toBe(1);
      expect(report.toolStats[0].tool).toBe('failing_tool');
      expect(report.toolStats[0].errorCount).toBe(1);
    });

    it('should still measure duration even when the function throws', async () => {
      try {
        await analytics.track('slow_fail', async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error('Delayed failure');
        });
      } catch {
        // expected
      }
      await flushAsync();

      const report = analytics.getReport();
      expect(report.toolStats[0].avgDurationMs).toBeGreaterThanOrEqual(40);
    });
  });

  // ─────────────────────────────────────────────────────────
  // 5. getReport() returns correct structure
  // ─────────────────────────────────────────────────────────
  describe('getReport() structure', () => {
    it('should return all required fields when no calls are recorded', () => {
      const report = analytics.getReport();

      expect(report).toHaveProperty('uptime');
      expect(report).toHaveProperty('totalCalls');
      expect(report).toHaveProperty('totalErrors');
      expect(report).toHaveProperty('avgResponseMs');
      expect(report).toHaveProperty('cacheHitRate');
      expect(report).toHaveProperty('toolStats');
      expect(report).toHaveProperty('recentCalls');

      expect(typeof report.uptime).toBe('string');
      expect(typeof report.totalCalls).toBe('number');
      expect(typeof report.totalErrors).toBe('number');
      expect(typeof report.avgResponseMs).toBe('number');
      expect(typeof report.cacheHitRate).toBe('string');
      expect(Array.isArray(report.toolStats)).toBe(true);
      expect(Array.isArray(report.recentCalls)).toBe(true);
    });

    it('should return zero values when no calls are recorded', () => {
      const report = analytics.getReport();

      expect(report.totalCalls).toBe(0);
      expect(report.totalErrors).toBe(0);
      expect(report.avgResponseMs).toBe(0);
      expect(report.cacheHitRate).toBe('0%');
      expect(report.toolStats).toHaveLength(0);
      expect(report.recentCalls).toHaveLength(0);
    });

    it('should format uptime as "Xh Ym Zs"', () => {
      const report = analytics.getReport();
      expect(report.uptime).toMatch(/^\d+h \d+m \d+s$/);
    });

    it('should return recentCalls with correct shape', async () => {
      analytics.record('tool_a', 100, true);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.recentCalls).toHaveLength(1);

      const recent = report.recentCalls[0];
      expect(recent).toHaveProperty('tool');
      expect(recent).toHaveProperty('durationMs');
      expect(recent).toHaveProperty('timestamp');
      expect(typeof recent.tool).toBe('string');
      expect(typeof recent.durationMs).toBe('number');
      // timestamp should be an ISO date string
      expect(() => new Date(recent.timestamp)).not.toThrow();
      expect(new Date(recent.timestamp).toISOString()).toBe(recent.timestamp);
    });

    it('should limit recentCalls to the last 10 entries', async () => {
      for (let i = 0; i < 15; i++) {
        analytics.record(`tool_${i}`, 10 + i, true);
      }
      await flushAsync();

      const report = analytics.getReport();
      expect(report.recentCalls).toHaveLength(10);
    });

    it('should return recentCalls in reverse chronological order', async () => {
      analytics.record('first', 10, true);
      analytics.record('second', 20, true);
      analytics.record('third', 30, true);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.recentCalls[0].tool).toBe('third');
      expect(report.recentCalls[1].tool).toBe('second');
      expect(report.recentCalls[2].tool).toBe('first');
    });

    it('should compute cacheHitRate as a percentage string', async () => {
      analytics.record('a', 10, true, true);
      analytics.record('b', 10, true, false);
      analytics.record('c', 10, true, true);
      analytics.record('d', 10, true, false);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.cacheHitRate).toBe('50%');
    });
  });

  // ─────────────────────────────────────────────────────────
  // 6. getReport() aggregates per-tool stats correctly
  // ─────────────────────────────────────────────────────────
  describe('getReport() per-tool aggregation', () => {
    it('should aggregate stats by tool name', async () => {
      analytics.record('search', 100, true);
      analytics.record('search', 200, true);
      analytics.record('search', 300, false);
      analytics.record('list_files', 50, true);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.toolStats).toHaveLength(2);

      const searchStats = report.toolStats.find((s) => s.tool === 'search')!;
      expect(searchStats).toBeDefined();
      expect(searchStats.callCount).toBe(3);
      expect(searchStats.avgDurationMs).toBe(200); // (100+200+300)/3
      expect(searchStats.maxDurationMs).toBe(300);
      expect(searchStats.errorCount).toBe(1);
    });

    it('should compute avgDurationMs correctly', async () => {
      analytics.record('tool', 100, true);
      analytics.record('tool', 300, true);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.toolStats[0].avgDurationMs).toBe(200);
    });

    it('should compute maxDurationMs correctly', async () => {
      analytics.record('tool', 50, true);
      analytics.record('tool', 500, true);
      analytics.record('tool', 200, true);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.toolStats[0].maxDurationMs).toBe(500);
    });

    it('should track cache hits per tool', async () => {
      analytics.record('search', 10, true, true);
      analytics.record('search', 20, true, false);
      analytics.record('search', 5, true, true);
      await flushAsync();

      const report = analytics.getReport();
      const searchStats = report.toolStats.find((s) => s.tool === 'search')!;
      expect(searchStats.cacheHits).toBe(2);
    });

    it('should sort toolStats by callCount descending', async () => {
      analytics.record('rare_tool', 10, true);
      analytics.record('popular_tool', 10, true);
      analytics.record('popular_tool', 20, true);
      analytics.record('popular_tool', 30, true);
      analytics.record('mid_tool', 10, true);
      analytics.record('mid_tool', 20, true);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.toolStats[0].tool).toBe('popular_tool');
      expect(report.toolStats[0].callCount).toBe(3);
      expect(report.toolStats[1].tool).toBe('mid_tool');
      expect(report.toolStats[1].callCount).toBe(2);
      expect(report.toolStats[2].tool).toBe('rare_tool');
      expect(report.toolStats[2].callCount).toBe(1);
    });

    it('should include lastCalled as an ISO date string', async () => {
      analytics.record('tool', 10, true);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.toolStats[0].lastCalled).toBeDefined();
      expect(() => new Date(report.toolStats[0].lastCalled!)).not.toThrow();
    });

    it('should compute overall avgResponseMs across all tools', async () => {
      analytics.record('a', 100, true);
      analytics.record('b', 200, true);
      analytics.record('c', 300, true);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.avgResponseMs).toBe(200); // (100+200+300)/3
    });

    it('should compute totalErrors across all tools', async () => {
      analytics.record('a', 10, false);
      analytics.record('a', 20, true);
      analytics.record('b', 30, false);
      analytics.record('c', 40, false);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.totalErrors).toBe(3);
    });
  });

  // ─────────────────────────────────────────────────────────
  // 7. getSuggestedActions() when no calls made
  // ─────────────────────────────────────────────────────────
  describe('getSuggestedActions() with no calls', () => {
    it('should return starter suggestions when no calls have been made', () => {
      const suggestions = analytics.getSuggestedActions();

      expect(suggestions.length).toBe(3);
      expect(suggestions).toContain('Start with "codebase_map" to get an overview of the project.');
      expect(suggestions).toContain('Use "security_scan" to check for common vulnerabilities.');
      expect(suggestions).toContain('Run "code_health_check" prompt for a complete health audit.');
    });

    it('should return early with only starter suggestions (no other suggestions mixed in)', () => {
      const suggestions = analytics.getSuggestedActions();

      // Should not contain tool-specific suggestions
      for (const s of suggestions) {
        expect(s).not.toContain('error rate');
        expect(s).not.toContain('Average response time');
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 8. getSuggestedActions() suggests security_scan when not used
  // ─────────────────────────────────────────────────────────
  describe('getSuggestedActions() unused tool suggestions', () => {
    it('should suggest security_scan when it has not been used', async () => {
      analytics.record('search', 100, true);
      await flushAsync();

      const suggestions = analytics.getSuggestedActions();
      expect(suggestions.some((s) => s.includes('security_scan'))).toBe(true);
    });

    it('should not suggest security_scan when it has been used', async () => {
      analytics.record('security_scan', 100, true);
      await flushAsync();

      const suggestions = analytics.getSuggestedActions();
      expect(suggestions.some((s) => s.includes('Run "security_scan"'))).toBe(false);
    });

    it('should suggest test_coverage when it has not been used', async () => {
      analytics.record('search', 50, true);
      await flushAsync();

      const suggestions = analytics.getSuggestedActions();
      expect(suggestions.some((s) => s.includes('test_coverage'))).toBe(true);
    });

    it('should suggest dead_code when it has not been used', async () => {
      analytics.record('search', 50, true);
      await flushAsync();

      const suggestions = analytics.getSuggestedActions();
      expect(suggestions.some((s) => s.includes('dead_code'))).toBe(true);
    });

    it('should suggest code_docs when it has not been used', async () => {
      analytics.record('search', 50, true);
      await flushAsync();

      const suggestions = analytics.getSuggestedActions();
      expect(suggestions.some((s) => s.includes('code_docs'))).toBe(true);
    });

    it('should not suggest tools that have been used', async () => {
      analytics.record('security_scan', 100, true);
      analytics.record('test_coverage', 100, true);
      analytics.record('dead_code', 100, true);
      analytics.record('code_docs', 100, true);
      await flushAsync();

      const suggestions = analytics.getSuggestedActions();
      expect(suggestions.some((s) => s.includes('Run "security_scan"'))).toBe(false);
      expect(suggestions.some((s) => s.includes('"test_coverage"'))).toBe(false);
      expect(suggestions.some((s) => s.includes('"dead_code"'))).toBe(false);
      expect(suggestions.some((s) => s.includes('"code_docs"'))).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────
  // 9. getSuggestedActions() flags tools with high error rates
  // ─────────────────────────────────────────────────────────
  describe('getSuggestedActions() high error rate', () => {
    it('should flag a tool with error rate above 30%', async () => {
      // 4 failures out of 10 = 40% error rate
      for (let i = 0; i < 6; i++) {
        analytics.record('flaky_tool', 100, true);
      }
      for (let i = 0; i < 4; i++) {
        analytics.record('flaky_tool', 100, false);
      }
      await flushAsync();

      const suggestions = analytics.getSuggestedActions();
      const errorSuggestion = suggestions.find((s) => s.includes('flaky_tool') && s.includes('error rate'));
      expect(errorSuggestion).toBeDefined();
      expect(errorSuggestion).toContain('40%');
      expect(errorSuggestion).toContain('check the parameters');
    });

    it('should not flag a tool with error rate at or below 30%', async () => {
      // 3 failures out of 10 = 30% error rate (not strictly >30%)
      for (let i = 0; i < 7; i++) {
        analytics.record('ok_tool', 100, true);
      }
      for (let i = 0; i < 3; i++) {
        analytics.record('ok_tool', 100, false);
      }
      await flushAsync();

      const suggestions = analytics.getSuggestedActions();
      const errorSuggestion = suggestions.find((s) => s.includes('ok_tool') && s.includes('error rate'));
      expect(errorSuggestion).toBeUndefined();
    });

    it('should flag multiple tools with high error rates', async () => {
      // First, use the "checked" tools so unused-tool suggestions don't fill up the 5-slot cap
      analytics.record('security_scan', 50, true);
      analytics.record('test_coverage', 50, true);
      analytics.record('dead_code', 50, true);
      analytics.record('code_docs', 50, true);

      // Tool A: 100% error rate
      analytics.record('tool_a', 50, false);
      // Tool B: 50% error rate
      analytics.record('tool_b', 50, true);
      analytics.record('tool_b', 50, false);
      await flushAsync();

      const suggestions = analytics.getSuggestedActions();
      const toolASuggestion = suggestions.find((s) => s.includes('tool_a') && s.includes('error rate'));
      const toolBSuggestion = suggestions.find((s) => s.includes('tool_b') && s.includes('error rate'));
      expect(toolASuggestion).toBeDefined();
      expect(toolBSuggestion).toBeDefined();
    });

    it('should include the computed error percentage in the suggestion', async () => {
      // 2 out of 5 = 40% — but threshold is >30%, so 2/5 is exactly 40%
      for (let i = 0; i < 3; i++) {
        analytics.record('bad_tool', 100, true);
      }
      for (let i = 0; i < 2; i++) {
        analytics.record('bad_tool', 100, false);
      }
      await flushAsync();

      const suggestions = analytics.getSuggestedActions();
      const errorSuggestion = suggestions.find((s) => s.includes('bad_tool'));
      expect(errorSuggestion).toBeDefined();
      expect(errorSuggestion).toContain('40%');
    });
  });

  // ─────────────────────────────────────────────────────────
  // 10. getSuggestedActions() performance suggestion
  // ─────────────────────────────────────────────────────────
  describe('getSuggestedActions() performance suggestion', () => {
    it('should suggest narrowing queries when avgResponseMs > 2000', async () => {
      analytics.record('search', 3000, true);
      analytics.record('search', 2500, true);
      await flushAsync();

      const suggestions = analytics.getSuggestedActions();
      const perfSuggestion = suggestions.find((s) => s.includes('Average response time'));
      expect(perfSuggestion).toBeDefined();
      expect(perfSuggestion).toContain('narrowing search queries');
    });

    it('should not suggest performance improvement when avgResponseMs <= 2000', async () => {
      analytics.record('search', 1000, true);
      analytics.record('search', 2000, true);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.avgResponseMs).toBe(1500);

      const suggestions = analytics.getSuggestedActions();
      const perfSuggestion = suggestions.find((s) => s.includes('Average response time'));
      expect(perfSuggestion).toBeUndefined();
    });

    it('should suggest performance improvement at exactly avgResponseMs = 2001', async () => {
      // Two calls averaging to > 2000
      analytics.record('slow_a', 2002, true);
      analytics.record('slow_b', 2000, true);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.avgResponseMs).toBeGreaterThan(2000);

      const suggestions = analytics.getSuggestedActions();
      const perfSuggestion = suggestions.find((s) => s.includes('Average response time'));
      expect(perfSuggestion).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────
  // 11. History trimming (maxHistory = 5000)
  // ─────────────────────────────────────────────────────────
  describe('history trimming', () => {
    it('should keep at most 5000 entries', async () => {
      // Insert 5010 records
      for (let i = 0; i < 5010; i++) {
        analytics.record('bulk_tool', 10, true);
      }
      await flushAsync();

      const report = analytics.getReport();
      expect(report.totalCalls).toBeLessThanOrEqual(5000);
      expect(report.totalCalls).toBe(5000);
    });

    it('should drop the oldest entries when trimming', async () => {
      // Record 5000 calls of "old_tool"
      for (let i = 0; i < 5000; i++) {
        analytics.record('old_tool', 10, true);
      }
      // Now record 10 calls of "new_tool" pushing old_tool entries out
      for (let i = 0; i < 10; i++) {
        analytics.record('new_tool', 20, true);
      }
      await flushAsync();

      const report = analytics.getReport();
      expect(report.totalCalls).toBe(5000);

      const oldStats = report.toolStats.find((s) => s.tool === 'old_tool');
      const newStats = report.toolStats.find((s) => s.tool === 'new_tool');

      // old_tool should have lost 10 entries
      expect(oldStats!.callCount).toBe(4990);
      expect(newStats!.callCount).toBe(10);
    });

    it('should not trim when exactly at maxHistory', async () => {
      for (let i = 0; i < 5000; i++) {
        analytics.record('exact_tool', 10, true);
      }
      await flushAsync();

      const report = analytics.getReport();
      expect(report.totalCalls).toBe(5000);
    });

    it('should not trim when below maxHistory', async () => {
      for (let i = 0; i < 100; i++) {
        analytics.record('small_tool', 10, true);
      }
      await flushAsync();

      const report = analytics.getReport();
      expect(report.totalCalls).toBe(100);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Additional edge-case coverage
  // ─────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('should limit getSuggestedActions to at most 5 suggestions', async () => {
      // Use a tool that is not one of the "check for unused" tools,
      // plus add high error rates and high response time to generate many suggestions
      analytics.record('custom_tool', 5000, false);
      await flushAsync();

      const suggestions = analytics.getSuggestedActions();
      expect(suggestions.length).toBeLessThanOrEqual(5);
    });

    it('should handle zero-duration calls', async () => {
      analytics.record('instant_tool', 0, true);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.avgResponseMs).toBe(0);
      expect(report.toolStats[0].avgDurationMs).toBe(0);
      expect(report.toolStats[0].maxDurationMs).toBe(0);
    });

    it('should handle a mix of cached and non-cached, success and failure', async () => {
      analytics.record('mixed', 100, true, false);
      analytics.record('mixed', 200, false, true);
      analytics.record('mixed', 300, true, true);
      analytics.record('mixed', 400, false, false);
      await flushAsync();

      const report = analytics.getReport();
      const stats = report.toolStats[0];

      expect(stats.callCount).toBe(4);
      expect(stats.errorCount).toBe(2);
      expect(stats.cacheHits).toBe(2);
      expect(stats.avgDurationMs).toBe(250); // (100+200+300+400)/4
      expect(stats.maxDurationMs).toBe(400);
      expect(report.cacheHitRate).toBe('50%');
    });

    it('should track multiple different tools independently', async () => {
      analytics.record('alpha', 100, true);
      analytics.record('beta', 200, false);
      analytics.record('gamma', 300, true, true);
      await flushAsync();

      const report = analytics.getReport();
      expect(report.toolStats).toHaveLength(3);
      expect(report.totalCalls).toBe(3);
      expect(report.totalErrors).toBe(1);
      expect(report.cacheHitRate).toBe('33%'); // 1/3 rounded

      const alpha = report.toolStats.find((s) => s.tool === 'alpha')!;
      const beta = report.toolStats.find((s) => s.tool === 'beta')!;
      const gamma = report.toolStats.find((s) => s.tool === 'gamma')!;

      expect(alpha.callCount).toBe(1);
      expect(alpha.errorCount).toBe(0);
      expect(alpha.cacheHits).toBe(0);

      expect(beta.callCount).toBe(1);
      expect(beta.errorCount).toBe(1);
      expect(beta.cacheHits).toBe(0);

      expect(gamma.callCount).toBe(1);
      expect(gamma.errorCount).toBe(0);
      expect(gamma.cacheHits).toBe(1);
    });

    it('track() should work sequentially for multiple calls', async () => {
      const r1 = await analytics.track('t1', async () => 'one');
      const r2 = await analytics.track('t2', async () => 'two');
      const r3 = await analytics.track('t3', async () => 'three');
      await flushAsync();

      expect(r1).toBe('one');
      expect(r2).toBe('two');
      expect(r3).toBe('three');

      const report = analytics.getReport();
      expect(report.totalCalls).toBe(3);
    });
  });
});
