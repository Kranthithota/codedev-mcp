/**
 * Health Check Resource
 * Exposes server health status for monitoring
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface HealthStatus {
    status: 'healthy' | 'degraded' | 'unhealthy';
    uptime: number;
    memory: {
        used: number;
        total: number;
        percentage: number;
    };
    version: string;
    timestamp: string;
    checks: {
        name: string;
        status: 'pass' | 'fail';
        message?: string;
    }[];
}

const startTime = Date.now();

async function isBinaryAvailable(binary: string): Promise<boolean> {
    try {
        await execFileAsync('which', [binary]);
        return true;
    } catch {
        return false;
    }
}

export async function getHealthStatus(version: string): Promise<HealthStatus> {
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();

    const checks: HealthStatus['checks'] = [];

    // Check ripgrep availability (async)
    if (await isBinaryAvailable('rg')) {
        checks.push({ name: 'ripgrep', status: 'pass' });
    } else {
        checks.push({ name: 'ripgrep', status: 'fail', message: 'ripgrep not found, using fallback' });
    }

    // Check fd availability (async)
    if (await isBinaryAvailable('fd')) {
        checks.push({ name: 'fd', status: 'pass' });
    } else {
        checks.push({ name: 'fd', status: 'fail', message: 'fd not found, using fallback' });
    }

    // Determine overall status
    const failedChecks = checks.filter(c => c.status === 'fail').length;
    let status: HealthStatus['status'] = 'healthy';
    if (failedChecks > 0) status = 'degraded';
    if (failedChecks === checks.length) status = 'unhealthy';

    return {
        status,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        memory: {
            used: Math.round(memUsage.heapUsed / 1024 / 1024),
            total: Math.round(totalMem / 1024 / 1024),
            percentage: Math.round((memUsage.heapUsed / totalMem) * 100 * 100) / 100,
        },
        version,
        timestamp: new Date().toISOString(),
        checks,
    };
}

export function registerHealthResource(server: McpServer, version: string): void {
    server.resource(
        'health://status',
        'health://status',
        async () => {
            const health = await getHealthStatus(version);
            return {
                contents: [{
                    uri: 'health://status',
                    mimeType: 'application/json',
                    text: JSON.stringify(health, null, 2),
                }],
            };
        }
    );
}
