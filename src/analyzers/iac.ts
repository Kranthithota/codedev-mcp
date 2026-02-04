/**
 * Infrastructure-as-Code Analysis
 * Parses Terraform, CloudFormation, Docker Compose, and Kubernetes configs.
 * Extracts resources, dependencies, and detects misconfigurations.
 */

import { listFiles } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface IaCResource {
  type: string;
  name: string;
  provider?: string;
  properties: Record<string, string>;
  source: string;
  dependsOn?: string[];
}

export interface IaCResult {
  platform: string[];
  resources: IaCResource[];
  issues: { severity: 'warning' | 'error' | 'info'; message: string; file: string; line?: number }[];
  summary: { totalResources: number; resourceTypes: Record<string, number>; platforms: string[] };
}

function parseTerraform(content: string, file: string): { resources: IaCResource[]; issues: IaCResult['issues'] } {
  const resources: IaCResource[] = [];
  const issues: IaCResult['issues'] = [];

  // Parse resource blocks
  const resMatches = content.matchAll(/resource\s+"(\w+)"\s+"(\w+)"\s*\{([\s\S]*?)\n\}/g);
  for (const match of resMatches) {
    const props: Record<string, string> = {};
    const body = match[3];
    for (const line of body.split('\n')) {
      const propMatch = line.trim().match(/^(\w+)\s*=\s*(.+)/);
      if (propMatch) props[propMatch[1]] = propMatch[2].replace(/"/g, '').trim();
    }
    resources.push({
      type: match[1],
      name: match[2],
      provider: match[1].split('_')[0],
      properties: props,
      source: file,
    });

    // Security checks
    if (match[1].includes('security_group') && body.includes('0.0.0.0/0') && body.includes('ingress')) {
      issues.push({ severity: 'warning', file, message: `Security group "${match[2]}" allows ingress from 0.0.0.0/0` });
    }
    if (match[1].includes('s3_bucket') && !body.includes('versioning')) {
      issues.push({ severity: 'info', file, message: `S3 bucket "${match[2]}" has no versioning configured` });
    }
    if (match[1].includes('rds') && !body.includes('encrypted') && !body.includes('storage_encrypted')) {
      issues.push({ severity: 'warning', file, message: `RDS instance "${match[2]}" may not have encryption enabled` });
    }
  }

  // Parse data sources
  const dataMatches = content.matchAll(/data\s+"(\w+)"\s+"(\w+)"\s*\{/g);
  for (const match of dataMatches) {
    resources.push({
      type: `data.${match[1]}`,
      name: match[2],
      provider: match[1].split('_')[0],
      properties: {},
      source: file,
    });
  }

  // Parse modules
  const modMatches = content.matchAll(/module\s+"(\w+)"\s*\{([\s\S]*?)\n\}/g);
  for (const match of modMatches) {
    const sourceMatch = match[2].match(/source\s*=\s*"([^"]+)"/);
    resources.push({
      type: 'module',
      name: match[1],
      properties: { source: sourceMatch?.[1] || 'unknown' },
      source: file,
    });
  }

  // Check for hardcoded secrets
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/(?:password|secret|api_key|token)\s*=\s*"[^$][^"]+"/i.test(lines[i])) {
      issues.push({
        severity: 'error',
        file,
        line: i + 1,
        message: 'Hardcoded secret detected — use variables or secret manager',
      });
    }
  }

  return { resources, issues };
}

function parseDockerCompose(content: string, file: string): { resources: IaCResource[]; issues: IaCResult['issues'] } {
  const resources: IaCResource[] = [];
  const issues: IaCResult['issues'] = [];
  const lines = content.split('\n');
  let inServices = false;
  let currentService = '';

  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (/^\S/.test(line) && !line.startsWith(' ')) {
      inServices = false;
      continue;
    }

    if (inServices) {
      const svcMatch = line.match(/^ {2}(\w[\w-]*):\s*$/);
      if (svcMatch) {
        currentService = svcMatch[1];
        resources.push({ type: 'docker-service', name: currentService, properties: {}, source: file });
      }
      if (currentService) {
        const imageMatch = line.match(/image:\s*(.+)/);
        if (imageMatch) {
          const res = resources.find((r) => r.name === currentService);
          if (res) res.properties.image = imageMatch[1].trim();
          // Check for latest tag
          if (imageMatch[1].includes(':latest') || !imageMatch[1].includes(':')) {
            issues.push({ severity: 'warning', file, message: `Service "${currentService}" uses unpinned image tag` });
          }
        }
        if (/privileged:\s*true/.test(line)) {
          issues.push({ severity: 'error', file, message: `Service "${currentService}" runs in privileged mode` });
        }
      }
    }
  }

  // Check for volume mounts
  const volMatches = content.matchAll(/- ([./]\S+):(\S+)/g);
  for (const vol of volMatches) {
    if (vol[1] === '/var/run/docker.sock') {
      issues.push({ severity: 'warning', file, message: 'Docker socket mounted — container has host Docker access' });
    }
  }

  return { resources, issues };
}

function parseK8sManifest(content: string, file: string): { resources: IaCResource[]; issues: IaCResult['issues'] } {
  const resources: IaCResource[] = [];
  const issues: IaCResult['issues'] = [];

  const kindMatch = content.match(/kind:\s*(\w+)/);
  const nameMatch = content.match(/name:\s*(\S+)/);

  if (kindMatch) {
    const props: Record<string, string> = {};
    const nsMatch = content.match(/namespace:\s*(\S+)/);
    if (nsMatch) props.namespace = nsMatch[1];
    const imageMatch = content.match(/image:\s*(\S+)/);
    if (imageMatch) props.image = imageMatch[1];
    const replicaMatch = content.match(/replicas:\s*(\d+)/);
    if (replicaMatch) props.replicas = replicaMatch[1];

    resources.push({ type: `k8s/${kindMatch[1]}`, name: nameMatch?.[1] || 'unnamed', properties: props, source: file });

    // Security checks
    if (/runAsRoot:\s*true/.test(content) || /privileged:\s*true/.test(content)) {
      issues.push({
        severity: 'error',
        file,
        message: `${kindMatch[1]} "${nameMatch?.[1]}" runs as root or privileged`,
      });
    }
    if (imageMatch && (imageMatch[1].includes(':latest') || !imageMatch[1].includes(':'))) {
      issues.push({
        severity: 'warning',
        file,
        message: `${kindMatch[1]} "${nameMatch?.[1]}" uses unpinned image tag`,
      });
    }
    if (kindMatch[1] === 'Deployment' && !content.includes('resources:')) {
      issues.push({ severity: 'info', file, message: `Deployment "${nameMatch?.[1]}" has no resource limits defined` });
    }
  }

  return { resources, issues };
}

/**
 * Analyze Infrastructure-as-Code files in a directory for resources and issues.
 * @param cwd - The working directory
 * @param options - Analysis options
 * @param options.directory - Subdirectory to scan
 * @returns IaC analysis results with resources, issues, and summary
 */
export async function analyzeIaC(cwd: string, options?: { directory?: string }): Promise<IaCResult> {
  const dir = path.resolve(cwd, options?.directory || '.');
  const allResources: IaCResource[] = [];
  const allIssues: IaCResult['issues'] = [];
  const platforms = new Set<string>();

  // Terraform
  const tfFiles = await listFiles(dir, { glob: '**/*.tf' }).catch(() => [] as string[]);
  for (const file of tfFiles.slice(0, 50)) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');
      const { resources, issues } = parseTerraform(content, file);
      allResources.push(...resources);
      allIssues.push(...issues);
      if (resources.length > 0) platforms.add('terraform');
    } catch {
      /* skip */
    }
  }

  // Docker Compose
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const files = await listFiles(dir, { glob: `**/${name}` }).catch(() => [] as string[]);
    for (const file of files.slice(0, 10)) {
      try {
        const content = await readFile(path.resolve(dir, file), 'utf-8');
        const { resources, issues } = parseDockerCompose(content, file);
        allResources.push(...resources);
        allIssues.push(...issues);
        if (resources.length > 0) platforms.add('docker-compose');
      } catch {
        /* skip */
      }
    }
  }

  // Kubernetes manifests
  const k8sFiles = await listFiles(dir, { glob: '**/*.{yml,yaml}' }).catch(() => [] as string[]);
  for (const file of k8sFiles.slice(0, 50)) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');
      if (/apiVersion:/.test(content) && /kind:/.test(content)) {
        const { resources, issues } = parseK8sManifest(content, file);
        allResources.push(...resources);
        allIssues.push(...issues);
        if (resources.length > 0) platforms.add('kubernetes');
      }
    } catch {
      /* skip */
    }
  }

  const resourceTypes: Record<string, number> = {};
  for (const r of allResources) {
    resourceTypes[r.type] = (resourceTypes[r.type] || 0) + 1;
  }

  return {
    platform: [...platforms],
    resources: allResources.slice(0, 200),
    issues: allIssues.slice(0, 100),
    summary: { totalResources: allResources.length, resourceTypes, platforms: [...platforms] },
  };
}
