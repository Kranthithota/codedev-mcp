/**
 * Fallback Utilities
 * Provides graceful degradation when external binaries are unavailable
 */

import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

// Cache binary availability checks
const binaryCache = new Map<string, boolean>();

/**
 * Check if a binary is available
 */
export function isBinaryAvailable(binary: string): boolean {
    if (binaryCache.has(binary)) {
        return binaryCache.get(binary)!;
    }

    try {
        execSync(`which ${binary}`, { stdio: 'pipe' });
        binaryCache.set(binary, true);
        return true;
    } catch {
        binaryCache.set(binary, false);
        logger.warn(`Binary not available: ${binary}, using fallback`);
        return false;
    }
}

/**
 * Native file listing fallback when fd is unavailable
 */
export async function listFilesNative(
    dir: string,
    options?: { glob?: string; depth?: number; type?: 'file' | 'directory' | 'any' }
): Promise<string[]> {
    const results: string[] = [];
    const maxDepth = options?.depth ?? 10;
    const type = options?.type ?? 'file';

    async function walk(currentDir: string, depth: number): Promise<void> {
        if (depth > maxDepth) return;

        try {
            const entries = await readdir(currentDir, { withFileTypes: true });

            for (const entry of entries) {
                // Skip hidden and common ignore patterns
                if (entry.name.startsWith('.') ||
                    entry.name === 'node_modules' ||
                    entry.name === '__pycache__') {
                    continue;
                }

                const fullPath = join(currentDir, entry.name);
                const relativePath = fullPath.replace(dir + '/', '');

                if (entry.isDirectory()) {
                    if (type === 'directory' || type === 'any') {
                        results.push(relativePath);
                    }
                    await walk(fullPath, depth + 1);
                } else if (entry.isFile()) {
                    if (type === 'file' || type === 'any') {
                        // Apply glob filter if provided
                        if (options?.glob) {
                            const pattern = options.glob.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
                            if (new RegExp(pattern).test(relativePath)) {
                                results.push(relativePath);
                            }
                        } else {
                            results.push(relativePath);
                        }
                    }
                }
            }
        } catch (err) {
            // Ignore permission errors
        }
    }

    await walk(dir, 0);
    return results.slice(0, 10000); // Limit results
}

/**
 * Native grep fallback when ripgrep is unavailable
 */
export async function grepNative(
    dir: string,
    pattern: string,
    options?: { isRegex?: boolean; caseSensitive?: boolean }
): Promise<{ file: string; line: number; text: string }[]> {
    const results: { file: string; line: number; text: string }[] = [];
    const files = await listFilesNative(dir, { type: 'file' });

    const regex = options?.isRegex
        ? new RegExp(pattern, options?.caseSensitive ? '' : 'i')
        : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options?.caseSensitive ? '' : 'i');

    for (const file of files.slice(0, 500)) {
        try {
            const content = await readFile(join(dir, file), 'utf-8');
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                    results.push({
                        file,
                        line: i + 1,
                        text: lines[i].slice(0, 200),
                    });

                    if (results.length >= 100) return results;
                }
            }
        } catch {
            // Skip files that can't be read
        }
    }

    return results;
}

/**
 * Get appropriate search function based on binary availability
 */
export function getSearchStrategy(): 'ripgrep' | 'native' {
    return isBinaryAvailable('rg') ? 'ripgrep' : 'native';
}

/**
 * Get appropriate file listing strategy
 */
export function getListStrategy(): 'fd' | 'native' {
    return isBinaryAvailable('fd') ? 'fd' : 'native';
}
