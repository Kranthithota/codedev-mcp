/**
 * Cross-Repository Intelligence
 * Analyzes how changes ripple across packages in a monorepo,
 * detects contract drift between declared and implemented APIs,
 * and builds dependency impact matrices with risk scores.
 */

import { listFiles, searchCode } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/*  analyzeCrossRepoImpact                                            */
/* ------------------------------------------------------------------ */

export interface CrossRepoImpact {
  changedPackage: string;
  changedFile: string;
  isPublicAPI: boolean;
  affectedPackages: {
    name: string;
    dependencyType: 'direct' | 'transitive';
    riskLevel: 'low' | 'medium' | 'high';
  }[];
}

export interface CrossRepoImpactResult {
  impacts: CrossRepoImpact[];
  dependencyGraph: { from: string; to: string }[];
  summary: {
    totalPackages: number;
    affectedPackages: number;
    highRiskChanges: number;
    publicAPIChanges: number;
  };
  recommendations: string[];
}

/** Internal representation of a discovered workspace package. */
interface WorkspacePkg {
  name: string;
  dir: string;
  deps: string[];
  entryFiles: string[];
}

/**
 * Discover every workspace package under `cwd` by scanning for package.json files.
 * Reads workspace globs from the root package.json / pnpm-workspace.yaml, then
 * falls back to well-known directory conventions.
 */
async function discoverPackages(cwd: string): Promise<WorkspacePkg[]> {
  const packages: WorkspacePkg[] = [];
  let workspaceGlobs: string[] = [];

  // 1. Root package.json workspaces field
  const rootPkg = path.join(cwd, 'package.json');
  if (existsSync(rootPkg)) {
    try {
      const pkg = JSON.parse(await readFile(rootPkg, 'utf-8'));
      if (pkg.workspaces) {
        workspaceGlobs = Array.isArray(pkg.workspaces)
          ? pkg.workspaces
          : pkg.workspaces.packages || [];
      }
    } catch {
      /* skip */
    }
  }

  // 2. pnpm-workspace.yaml
  const pnpmWs = path.join(cwd, 'pnpm-workspace.yaml');
  if (existsSync(pnpmWs)) {
    try {
      const content = await readFile(pnpmWs, 'utf-8');
      const matches = content.matchAll(/- ['"]?([^'"]+)['"]?/g);
      workspaceGlobs = [...matches].map((m) => m[1]);
    } catch {
      /* skip */
    }
  }

  // 3. Resolve globs into package.json locations
  if (workspaceGlobs.length > 0) {
    for (const glob of workspaceGlobs) {
      const pkgFiles = await listFiles(cwd, { glob: `${glob}/package.json` }).catch(
        () => [] as string[],
      );
      for (const pkgFile of pkgFiles.slice(0, 200)) {
        const pkg = await safeReadJson(path.resolve(cwd, pkgFile));
        if (!pkg) continue;
        packages.push({
          name: (pkg.name as string) || path.basename(path.dirname(pkgFile)),
          dir: path.dirname(pkgFile),
          deps: [],
          entryFiles: resolveEntryFiles(pkg, path.dirname(pkgFile)),
        });
      }
    }
  }

  // 4. Fallback: scan well-known directories
  if (packages.length === 0) {
    const patterns = [
      'packages/*/package.json',
      'apps/*/package.json',
      'libs/*/package.json',
      'services/*/package.json',
    ];
    for (const pattern of patterns) {
      const found = await listFiles(cwd, { glob: pattern }).catch(() => [] as string[]);
      for (const file of found.slice(0, 200)) {
        const pkg = await safeReadJson(path.resolve(cwd, file));
        if (!pkg) continue;
        packages.push({
          name: (pkg.name as string) || path.basename(path.dirname(file)),
          dir: path.dirname(file),
          deps: [],
          entryFiles: resolveEntryFiles(pkg, path.dirname(file)),
        });
      }
    }
  }

  return packages;
}

/** Derive the public entry files from a package.json's main/exports/types fields. */
function resolveEntryFiles(pkg: Record<string, unknown>, pkgDir: string): string[] {
  const entries: string[] = [];
  const candidates = [pkg.main, pkg.module, pkg.types, pkg.typings] as (string | undefined)[];

  // Handle "exports" map (string or object with "." key)
  if (typeof pkg.exports === 'string') {
    candidates.push(pkg.exports);
  } else if (pkg.exports && typeof pkg.exports === 'object') {
    const exp = pkg.exports as Record<string, unknown>;
    const dot = exp['.'];
    if (typeof dot === 'string') {
      candidates.push(dot);
    } else if (dot && typeof dot === 'object') {
      const dotObj = dot as Record<string, unknown>;
      for (const v of Object.values(dotObj)) {
        if (typeof v === 'string') candidates.push(v);
      }
    }
  }

  for (const c of candidates) {
    if (typeof c === 'string') entries.push(path.normalize(c));
  }

  // Also consider conventional index files
  for (const idx of ['index.ts', 'index.js', 'src/index.ts', 'src/index.js']) {
    if (existsSync(path.resolve(pkgDir, idx))) entries.push(idx);
  }

  return [...new Set(entries)];
}

/** Safely read and parse a JSON file, returning null on failure. */
async function safeReadJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Build the cross-package dependency graph by reading each package's
 * dependencies / devDependencies / peerDependencies.
 */
function buildDependencyGraph(
  packages: WorkspacePkg[],
  cwd: string,
): { graph: { from: string; to: string }[]; adjacency: Map<string, string[]>; reverseAdj: Map<string, string[]> } {
  const names = new Set(packages.map((p) => p.name));
  const graph: { from: string; to: string }[] = [];
  const adjacency = new Map<string, string[]>();
  const reverseAdj = new Map<string, string[]>();

  for (const pkg of packages) {
    const pkgJsonPath = path.resolve(cwd, pkg.dir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    try {
      const raw = JSON.parse(require('node:fs').readFileSync(pkgJsonPath, 'utf-8'));
      const allDeps = {
        ...raw.dependencies,
        ...raw.devDependencies,
        ...raw.peerDependencies,
      };
      for (const dep of Object.keys(allDeps)) {
        if (names.has(dep)) {
          pkg.deps.push(dep);
          graph.push({ from: pkg.name, to: dep });
          if (!adjacency.has(pkg.name)) adjacency.set(pkg.name, []);
          adjacency.get(pkg.name)!.push(dep);
          if (!reverseAdj.has(dep)) reverseAdj.set(dep, []);
          reverseAdj.get(dep)!.push(pkg.name);
        }
      }
    } catch {
      /* skip */
    }
  }

  return { graph, adjacency, reverseAdj };
}

/** Collect transitive dependants by walking `reverseAdj` breadth-first. */
function transitiveConsumers(
  pkg: string,
  reverseAdj: Map<string, string[]>,
  maxDepth = 10,
): Map<string, 'direct' | 'transitive'> {
  const result = new Map<string, 'direct' | 'transitive'>();
  const queue: { name: string; depth: number }[] = (reverseAdj.get(pkg) || []).map((n) => ({
    name: n,
    depth: 1,
  }));
  const visited = new Set<string>([pkg]);

  while (queue.length > 0) {
    const { name, depth } = queue.shift()!;
    if (visited.has(name) || depth > maxDepth) continue;
    visited.add(name);
    result.set(name, depth === 1 ? 'direct' : 'transitive');
    for (const next of reverseAdj.get(name) || []) {
      queue.push({ name: next, depth: depth + 1 });
    }
  }

  return result;
}

/**
 * Analyze how a set of changed files propagates impact across packages in a
 * monorepo or multi-package workspace.
 *
 * For each changed file the function determines the owning package, whether
 * the change touches the package's public API, and which downstream packages
 * are affected (directly or transitively).
 *
 * @param cwd          - Workspace root directory.
 * @param changedFiles - Paths of changed files, relative to `cwd`.
 * @param options      - Optional overrides.
 * @param options.maxTransitiveDepth - Maximum depth for transitive dependency traversal (default 10).
 * @returns Cross-repository impact analysis with dependency graph and recommendations.
 */
export async function analyzeCrossRepoImpact(
  cwd: string,
  changedFiles: string[],
  options?: { maxTransitiveDepth?: number },
): Promise<CrossRepoImpactResult> {
  const packages = await discoverPackages(cwd);
  const { graph, reverseAdj } = buildDependencyGraph(packages, cwd);

  const impacts: CrossRepoImpact[] = [];
  const affectedSet = new Set<string>();
  let highRisk = 0;
  let publicAPICount = 0;

  for (const file of changedFiles.slice(0, 500)) {
    const normalized = path.normalize(file);

    // Determine which package owns this file
    const ownerPkg = packages.find((p) => normalized.startsWith(p.dir + path.sep) || normalized.startsWith(p.dir + '/'));
    if (!ownerPkg) continue;

    // Is this file part of the public API?
    const relToPackage = path.relative(ownerPkg.dir, normalized);
    const isPublicAPI = ownerPkg.entryFiles.some(
      (entry) =>
        path.normalize(entry) === relToPackage ||
        relToPackage.replace(/\.[^.]+$/, '') === path.normalize(entry).replace(/\.[^.]+$/, ''),
    );

    if (isPublicAPI) publicAPICount++;

    // Find affected packages
    const consumers = transitiveConsumers(
      ownerPkg.name,
      reverseAdj,
      options?.maxTransitiveDepth ?? 10,
    );

    const affected: CrossRepoImpact['affectedPackages'] = [];
    for (const [name, depType] of consumers) {
      let riskLevel: 'low' | 'medium' | 'high' = 'low';
      if (isPublicAPI && depType === 'direct') riskLevel = 'high';
      else if (isPublicAPI) riskLevel = 'medium';
      else if (depType === 'direct') riskLevel = 'medium';

      if (riskLevel === 'high') highRisk++;
      affected.push({ name, dependencyType: depType, riskLevel });
      affectedSet.add(name);
    }

    impacts.push({
      changedPackage: ownerPkg.name,
      changedFile: file,
      isPublicAPI,
      affectedPackages: affected,
    });
  }

  // Build recommendations
  const recommendations: string[] = [];
  if (publicAPICount > 0) {
    recommendations.push(
      `${publicAPICount} change(s) touch public APIs. Consider updating changelogs and bumping versions.`,
    );
  }
  if (highRisk > 0) {
    recommendations.push(
      `${highRisk} high-risk downstream impact(s) detected. Run integration tests for affected consumers.`,
    );
  }
  if (affectedSet.size > packages.length * 0.5 && packages.length > 2) {
    recommendations.push(
      'More than half the workspace is affected. Consider a workspace-wide CI run.',
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('Changes appear to be internal with low cross-package risk.');
  }

  return {
    impacts,
    dependencyGraph: graph,
    summary: {
      totalPackages: packages.length,
      affectedPackages: affectedSet.size,
      highRiskChanges: highRisk,
      publicAPIChanges: publicAPICount,
    },
    recommendations,
  };
}

/* ------------------------------------------------------------------ */
/*  detectContractDrift                                               */
/* ------------------------------------------------------------------ */

export interface ContractDrift {
  type: 'openapi' | 'graphql' | 'grpc' | 'rest';
  endpoint: string;
  method?: string;
  status: 'documented-only' | 'implemented-only' | 'mismatch';
  severity: 'info' | 'warning' | 'error';
  details: string;
}

export interface ContractDriftResult {
  drifts: ContractDrift[];
  contracts: { file: string; type: string; endpointCount: number }[];
  summary: { totalEndpoints: number; documented: number; implemented: number; drifts: number };
  recommendations: string[];
}

/** Extract route paths declared in an OpenAPI JSON spec. */
function extractOpenAPIEndpoints(content: string): { method: string; path: string }[] {
  const endpoints: { method: string; path: string }[] = [];
  try {
    const spec = JSON.parse(content);
    const paths = spec.paths || {};
    for (const [urlPath, methods] of Object.entries(paths)) {
      for (const method of Object.keys(methods as Record<string, unknown>)) {
        if (['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(method)) {
          endpoints.push({ method: method.toUpperCase(), path: urlPath });
        }
      }
    }
  } catch {
    /* malformed spec */
  }
  return endpoints;
}

/** Extract query/mutation names from GraphQL schema text. */
function extractGraphQLOperations(content: string): { method: string; path: string }[] {
  const ops: { method: string; path: string }[] = [];
  const blockRe = /type\s+(Query|Mutation|Subscription)\s*\{([^}]+)\}/gs;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(content)) !== null) {
    const blockType = match[1];
    for (const line of match[2].split('\n')) {
      const fieldMatch = line.trim().match(/^(\w+)\s*(?:\(|:)/);
      if (fieldMatch) {
        ops.push({ method: blockType.toUpperCase(), path: fieldMatch[1] });
      }
    }
  }
  return ops;
}

/** Extract service/rpc names from a .proto file. */
function extractProtoRPCs(content: string): { method: string; path: string }[] {
  const rpcs: { method: string; path: string }[] = [];
  const serviceRe = /service\s+(\w+)\s*\{([^}]+)\}/gs;
  let match: RegExpExecArray | null;
  while ((match = serviceRe.exec(content)) !== null) {
    const svcName = match[1];
    const rpcRe = /rpc\s+(\w+)\s*\(/g;
    let rpcMatch: RegExpExecArray | null;
    while ((rpcMatch = rpcRe.exec(match[2])) !== null) {
      rpcs.push({ method: 'RPC', path: `${svcName}.${rpcMatch[1]}` });
    }
  }
  return rpcs;
}

/** Common HTTP method patterns found in source code (Express, Fastify, NestJS, etc.) */
const ROUTE_IMPLEMENTATION_PATTERNS = [
  // Express / Koa / Fastify style
  /(?:app|router|server|fastify)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
  // NestJS decorators
  /@(Get|Post|Put|Delete|Patch)\s*\(\s*['"]([^'"]*)['"]\s*\)/gi,
  // Spring @Mapping
  /@(?:Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]/gi,
];

/**
 * Detect drift between declared API contracts (OpenAPI specs, GraphQL schemas,
 * gRPC proto files) and the routes actually implemented in source code.
 *
 * Compares declared endpoints against implemented routes and flags:
 * - Endpoints that are documented but not implemented.
 * - Endpoints that are implemented but not documented.
 *
 * @param cwd     - Working directory to scan.
 * @param options - Optional configuration.
 * @param options.fileLimit - Maximum source files to scan for implementations (default 500).
 * @returns Contract drift report with drifts, contracts found, and recommendations.
 */
export async function detectContractDrift(
  cwd: string,
  options?: { fileLimit?: number },
): Promise<ContractDriftResult> {
  const fileLimit = options?.fileLimit ?? 500;
  const drifts: ContractDrift[] = [];
  const contracts: ContractDriftResult['contracts'] = [];
  const documented = new Map<string, { method: string; path: string; type: ContractDrift['type'] }>();
  const implemented = new Map<string, { method: string; path: string }>();

  // ---- 1. Find OpenAPI / Swagger specs ----
  const specFiles = await listFiles(cwd, {
    glob: '**/*.{json,yaml,yml}',
  }).catch(() => [] as string[]);

  for (const f of specFiles.filter((f) => /swagger|openapi/i.test(f)).slice(0, 20)) {
    try {
      const content = await readFile(path.resolve(cwd, f), 'utf-8');
      const eps = extractOpenAPIEndpoints(content);
      if (eps.length > 0) {
        contracts.push({ file: f, type: 'openapi', endpointCount: eps.length });
        for (const ep of eps) {
          const key = `${ep.method}:${ep.path}`;
          documented.set(key, { ...ep, type: 'openapi' });
        }
      }
    } catch {
      /* skip */
    }
  }

  // ---- 2. Find GraphQL schemas ----
  const gqlFiles = await listFiles(cwd, {
    glob: '**/*.{graphql,gql}',
  }).catch(() => [] as string[]);

  for (const f of gqlFiles.slice(0, 30)) {
    try {
      const content = await readFile(path.resolve(cwd, f), 'utf-8');
      const ops = extractGraphQLOperations(content);
      if (ops.length > 0) {
        contracts.push({ file: f, type: 'graphql', endpointCount: ops.length });
        for (const op of ops) {
          const key = `${op.method}:${op.path}`;
          documented.set(key, { ...op, type: 'graphql' });
        }
      }
    } catch {
      /* skip */
    }
  }

  // ---- 3. Find gRPC proto files ----
  const protoFiles = await listFiles(cwd, { glob: '**/*.proto' }).catch(
    () => [] as string[],
  );

  for (const f of protoFiles.slice(0, 30)) {
    try {
      const content = await readFile(path.resolve(cwd, f), 'utf-8');
      const rpcs = extractProtoRPCs(content);
      if (rpcs.length > 0) {
        contracts.push({ file: f, type: 'grpc', endpointCount: rpcs.length });
        for (const rpc of rpcs) {
          const key = `RPC:${rpc.path}`;
          documented.set(key, { method: rpc.method, path: rpc.path, type: 'grpc' });
        }
      }
    } catch {
      /* skip */
    }
  }

  // ---- 4. Scan source for implemented routes ----
  const srcFiles = await listFiles(cwd, {
    glob: '**/*.{ts,tsx,js,jsx,py,java,go,rs}',
  }).catch(() => [] as string[]);

  for (const f of srcFiles.slice(0, fileLimit)) {
    try {
      const content = await readFile(path.resolve(cwd, f), 'utf-8');
      for (const pattern of ROUTE_IMPLEMENTATION_PATTERNS) {
        // Reset regex lastIndex for each file
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(content)) !== null) {
          // Groups vary per pattern; find the method and path
          const method = (m[1] || 'GET').toUpperCase();
          const routePath = m[2] || m[1] || '';
          if (!routePath) continue;
          const key = `${method}:${routePath}`;
          implemented.set(key, { method, path: routePath });
        }
      }
    } catch {
      /* skip */
    }
  }

  // ---- 5. Compare documented vs implemented ----
  for (const [key, doc] of documented) {
    if (!implemented.has(key)) {
      drifts.push({
        type: doc.type,
        endpoint: doc.path,
        method: doc.method,
        status: 'documented-only',
        severity: 'warning',
        details: `Endpoint ${doc.method} ${doc.path} is documented but no matching implementation was found.`,
      });
    }
  }

  for (const [key, impl] of implemented) {
    if (documented.size > 0 && !documented.has(key)) {
      drifts.push({
        type: 'rest',
        endpoint: impl.path,
        method: impl.method,
        status: 'implemented-only',
        severity: 'info',
        details: `Endpoint ${impl.method} ${impl.path} is implemented but not found in any API contract file.`,
      });
    }
  }

  // ---- 6. Build recommendations ----
  const recommendations: string[] = [];
  const docOnlyCount = drifts.filter((d) => d.status === 'documented-only').length;
  const implOnlyCount = drifts.filter((d) => d.status === 'implemented-only').length;

  if (docOnlyCount > 0) {
    recommendations.push(
      `${docOnlyCount} endpoint(s) are documented but appear unimplemented. Verify or remove stale contract entries.`,
    );
  }
  if (implOnlyCount > 0) {
    recommendations.push(
      `${implOnlyCount} endpoint(s) are implemented without contract documentation. Update API specs to match.`,
    );
  }
  if (contracts.length === 0) {
    recommendations.push(
      'No API contract files found (OpenAPI, GraphQL, or Proto). Consider adding an API specification.',
    );
  }
  if (drifts.length === 0 && contracts.length > 0) {
    recommendations.push('No drift detected. API contracts and implementations are in sync.');
  }

  return {
    drifts: drifts.slice(0, 200),
    contracts,
    summary: {
      totalEndpoints: documented.size + implemented.size,
      documented: documented.size,
      implemented: implemented.size,
      drifts: drifts.length,
    },
    recommendations,
  };
}

/* ------------------------------------------------------------------ */
/*  buildDependencyImpactMatrix                                       */
/* ------------------------------------------------------------------ */

export interface PackageRisk {
  package: string;
  consumers: string[];
  couplingDepth: number;
  changeFrequency: number;
  hasTests: boolean;
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export interface DependencyImpactMatrix {
  packages: PackageRisk[];
  matrix: { from: string; to: string; weight: number }[];
  hotspots: string[];
  summary: {
    totalPackages: number;
    highRisk: number;
    avgCoupling: number;
    maxCoupling: number;
  };
  recommendations: string[];
}

/**
 * Count the maximum transitive dependency depth starting from a given package.
 * Uses BFS to measure the longest chain of dependencies.
 */
function measureCouplingDepth(pkg: string, adjacency: Map<string, string[]>): number {
  let maxDepth = 0;
  const visited = new Set<string>([pkg]);
  const queue: { name: string; depth: number }[] = (adjacency.get(pkg) || []).map((n) => ({
    name: n,
    depth: 1,
  }));

  while (queue.length > 0) {
    const { name, depth } = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    if (depth > maxDepth) maxDepth = depth;
    for (const next of adjacency.get(name) || []) {
      queue.push({ name: next, depth: depth + 1 });
    }
  }

  return maxDepth;
}

/**
 * Count commits touching files under `pkgDir` in the last N days using git log.
 */
async function getChangeFrequency(cwd: string, pkgDir: string, days = 90): Promise<number> {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--oneline', `--since=${since}`, '--', pkgDir],
      { cwd, timeout: 10000 },
    );
    return stdout.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Build a comprehensive dependency impact matrix across all packages in the
 * workspace, scoring each package by coupling depth, change frequency, test
 * coverage of its boundary, and number of consumers.
 *
 * High coupling + low test coverage + high change frequency = high risk.
 *
 * @param cwd     - Workspace root directory.
 * @param options - Optional configuration.
 * @param options.days           - Look-back window for change frequency in days (default 90).
 * @param options.riskThreshold  - Score above which a package is flagged as a hotspot (default 60).
 * @returns Dependency impact matrix with per-package risk scores and recommendations.
 */
export async function buildDependencyImpactMatrix(
  cwd: string,
  options?: { days?: number; riskThreshold?: number },
): Promise<DependencyImpactMatrix> {
  const days = options?.days ?? 90;
  const riskThreshold = options?.riskThreshold ?? 60;

  const packages = await discoverPackages(cwd);
  const { graph, adjacency, reverseAdj } = buildDependencyGraph(packages, cwd);

  const packageRisks: PackageRisk[] = [];
  const matrix: DependencyImpactMatrix['matrix'] = [];

  for (const pkg of packages) {
    // Consumers (packages that depend on this one)
    const consumers = reverseAdj.get(pkg.name) || [];

    // Coupling depth
    const couplingDepth = measureCouplingDepth(pkg.name, adjacency);

    // Change frequency via git log
    const changeFrequency = await getChangeFrequency(cwd, pkg.dir, days);

    // Check for tests
    const testFiles = await listFiles(path.resolve(cwd, pkg.dir), {
      glob: '**/*.{test,spec}.{ts,tsx,js,jsx}',
    }).catch(() => [] as string[]);
    const hasTests = testFiles.length > 0;

    // Calculate risk score (0-100)
    // Factors: coupling depth (0-30), consumer count (0-25), change frequency (0-25), no tests (0-20)
    const couplingScore = Math.min(couplingDepth * 10, 30);
    const consumerScore = Math.min(consumers.length * 5, 25);
    const changeScore = Math.min(changeFrequency * 0.5, 25);
    const testPenalty = hasTests ? 0 : 20;
    const riskScore = Math.min(
      Math.round(couplingScore + consumerScore + changeScore + testPenalty),
      100,
    );

    let riskLevel: PackageRisk['riskLevel'] = 'low';
    if (riskScore >= 80) riskLevel = 'critical';
    else if (riskScore >= 60) riskLevel = 'high';
    else if (riskScore >= 35) riskLevel = 'medium';

    packageRisks.push({
      package: pkg.name,
      consumers,
      couplingDepth,
      changeFrequency,
      hasTests,
      riskScore,
      riskLevel,
    });

    // Add weighted edges to matrix
    for (const dep of pkg.deps) {
      const depRisk = packageRisks.find((p) => p.package === dep);
      const weight = depRisk ? depRisk.riskScore : riskScore;
      matrix.push({ from: pkg.name, to: dep, weight });
    }
  }

  // Re-compute matrix weights now that all scores are available
  for (const edge of matrix) {
    const depPkg = packageRisks.find((p) => p.package === edge.to);
    if (depPkg) edge.weight = depPkg.riskScore;
  }

  const hotspots = packageRisks
    .filter((p) => p.riskScore >= riskThreshold)
    .sort((a, b) => b.riskScore - a.riskScore)
    .map((p) => p.package);

  const couplings = packageRisks.map((p) => p.couplingDepth);
  const avgCoupling =
    couplings.length > 0
      ? Math.round((couplings.reduce((a, b) => a + b, 0) / couplings.length) * 10) / 10
      : 0;
  const maxCoupling = couplings.length > 0 ? Math.max(...couplings) : 0;

  const highRisk = packageRisks.filter(
    (p) => p.riskLevel === 'high' || p.riskLevel === 'critical',
  ).length;

  // Recommendations
  const recommendations: string[] = [];
  const untested = packageRisks.filter((p) => !p.hasTests && p.consumers.length > 0);
  if (untested.length > 0) {
    recommendations.push(
      `${untested.length} package(s) with consumers have no tests: ${untested.map((p) => p.package).slice(0, 5).join(', ')}. Add integration tests for their public interfaces.`,
    );
  }
  if (hotspots.length > 0) {
    recommendations.push(
      `High-risk hotspots: ${hotspots.slice(0, 5).join(', ')}. Reduce coupling or increase test coverage.`,
    );
  }
  if (maxCoupling > 5) {
    recommendations.push(
      `Maximum coupling depth is ${maxCoupling}. Consider flattening deeply nested dependency chains.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('All packages have reasonable risk levels. No immediate action required.');
  }

  return {
    packages: packageRisks,
    matrix,
    hotspots,
    summary: { totalPackages: packages.length, highRisk, avgCoupling, maxCoupling },
    recommendations,
  };
}
