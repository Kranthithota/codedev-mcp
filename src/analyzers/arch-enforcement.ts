/**
 * Architecture Enforcement
 * Detects architecture drift between declared and actual layer boundaries,
 * tracks in-progress code migrations, and traces authentication/authorization
 * flows across endpoints.
 */

import { listFiles, searchCode } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/*  detectArchitectureDrift                                           */
/* ------------------------------------------------------------------ */

export interface ArchDriftViolation {
  from: { file: string; layer: string };
  to: { file: string; layer: string };
  type: 'layer-violation' | 'boundary-cross' | 'circular' | 'abstraction-bypass';
  severity: 'warning' | 'error';
  description: string;
}

export interface ArchDriftResult {
  violations: ArchDriftViolation[];
  layers: { name: string; files: number; inbound: number; outbound: number }[];
  declaredArchitecture: 'config-file' | 'inferred' | 'none';
  summary: { totalViolations: number; layerCount: number; worstLayer: string };
  recommendations: string[];
}

/**
 * A declared or inferred architecture layer.
 * `rank` controls the allowed dependency direction: higher ranks may depend on
 * lower ranks, but not the reverse.
 */
interface LayerDef {
  name: string;
  /** Directory patterns that belong to this layer (glob-like fragments). */
  patterns: string[];
  /** Numeric rank in the architecture stack. Higher = closer to the user. */
  rank: number;
}

/** Default layered architecture when no config file is present. */
const DEFAULT_LAYERS: LayerDef[] = [
  { name: 'controllers', patterns: ['controller', 'handler', 'route', 'endpoint', 'api'], rank: 4 },
  { name: 'services', patterns: ['service', 'usecase', 'use-case', 'interactor'], rank: 3 },
  { name: 'repositories', patterns: ['repository', 'repo', 'dal', 'dao', 'data-access', 'store'], rank: 2 },
  { name: 'models', patterns: ['model', 'entity', 'schema', 'domain', 'type'], rank: 1 },
  { name: 'utils', patterns: ['util', 'helper', 'lib', 'common', 'shared', 'pkg'], rank: 0 },
];

/** Determine which layer a file belongs to based on its path segments. */
function classifyFile(filePath: string, layers: LayerDef[]): LayerDef | null {
  const normalized = filePath.toLowerCase().replace(/\\/g, '/');
  for (const layer of layers) {
    for (const pattern of layer.patterns) {
      // Match directory names in the path (e.g., "src/services/user.ts" matches "service")
      if (
        normalized.includes(`/${pattern}/`) ||
        normalized.includes(`/${pattern}s/`) ||
        normalized.startsWith(`${pattern}/`) ||
        normalized.startsWith(`${pattern}s/`)
      ) {
        return layer;
      }
    }
  }
  return null;
}

/** Extract import paths from a source file's content. */
function extractImports(content: string): { importPath: string; line: number }[] {
  const results: { importPath: string; line: number }[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // JS/TS imports
    const jsMatch = lines[i].match(/(?:import|from)\s+['"]([^'"]+)['"]/);
    if (jsMatch) {
      results.push({ importPath: jsMatch[1], line: i + 1 });
      continue;
    }
    // require()
    const reqMatch = lines[i].match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (reqMatch) {
      results.push({ importPath: reqMatch[1], line: i + 1 });
      continue;
    }
    // Python imports
    const pyMatch = lines[i].match(/from\s+(\S+)\s+import/);
    if (pyMatch) {
      results.push({ importPath: pyMatch[1], line: i + 1 });
    }
  }
  return results;
}

/**
 * Try to parse a JSON or simple YAML architecture config.
 * Expected shape: `{ layers: [{ name, patterns, rank }] }`
 */
async function readArchConfig(cwd: string): Promise<{ layers: LayerDef[] } | null> {
  const candidates = ['.architecture.json', 'architecture.yaml', 'architecture.yml', '.architecture.yaml'];
  for (const candidate of candidates) {
    const filePath = path.join(cwd, candidate);
    if (!existsSync(filePath)) continue;
    try {
      const raw = await readFile(filePath, 'utf-8');
      // Try JSON first
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.layers)) return { layers: parsed.layers };
      } catch {
        /* not JSON, try simple YAML parsing */
      }
      // Minimal YAML: extract layer entries line by line
      const layers: LayerDef[] = [];
      let current: Partial<LayerDef> | null = null;
      for (const line of raw.split('\n')) {
        const nameMatch = line.match(/^\s*-\s*name:\s*(.+)/);
        if (nameMatch) {
          if (current?.name) layers.push(current as LayerDef);
          current = { name: nameMatch[1].trim(), patterns: [], rank: layers.length };
          continue;
        }
        const rankMatch = line.match(/^\s*rank:\s*(\d+)/);
        if (rankMatch && current) {
          current.rank = parseInt(rankMatch[1], 10);
          continue;
        }
        const patternMatch = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);
        if (patternMatch && current && !patternMatch[1].match(/^name:|^rank:|^patterns:/)) {
          current.patterns!.push(patternMatch[1].trim());
        }
      }
      if (current?.name) layers.push(current as LayerDef);
      if (layers.length > 0) return { layers };
    } catch {
      /* skip */
    }
  }
  return null;
}

/**
 * Compare the actual import graph against declared (or inferred) architecture
 * layers and detect violations such as lower layers importing upper layers,
 * cross-boundary imports, and circular layer dependencies.
 *
 * If an `.architecture.json` or `architecture.yaml` config exists, its layer
 * definitions are used. Otherwise, layers are inferred from directory naming
 * conventions (controllers, services, repositories, models, utils).
 *
 * @param cwd     - Working directory to scan.
 * @param options - Optional configuration.
 * @param options.fileLimit - Maximum files to analyze (default 500).
 * @param options.directory - Subdirectory to scope the scan to.
 * @returns Architecture drift result with violations, layer stats, and recommendations.
 */
export async function detectArchitectureDrift(
  cwd: string,
  options?: { fileLimit?: number; directory?: string },
): Promise<ArchDriftResult> {
  const fileLimit = options?.fileLimit ?? 500;
  const dir = options?.directory ? path.resolve(cwd, options.directory) : cwd;

  // 1. Determine layer definitions
  const config = await readArchConfig(cwd);
  const layers: LayerDef[] = config?.layers ?? DEFAULT_LAYERS;
  const declaredArchitecture: ArchDriftResult['declaredArchitecture'] = config
    ? 'config-file'
    : layers === DEFAULT_LAYERS
      ? 'inferred'
      : 'none';

  // 2. Scan source files
  const files = await listFiles(dir, {
    glob: '**/*.{ts,tsx,js,jsx,py,java,go,rs}',
  }).catch(() => [] as string[]);

  const violations: ArchDriftViolation[] = [];
  const layerStats = new Map<string, { files: number; inbound: number; outbound: number }>();
  for (const layer of layers) {
    layerStats.set(layer.name, { files: 0, inbound: 0, outbound: 0 });
  }

  // 3. Check CODEOWNERS for ownership boundaries
  const codeownersPath = path.join(cwd, 'CODEOWNERS');
  const altCodeownersPath = path.join(cwd, '.github', 'CODEOWNERS');
  const ownerBoundaries = new Map<string, string>();
  const ownersFile = existsSync(codeownersPath)
    ? codeownersPath
    : existsSync(altCodeownersPath)
      ? altCodeownersPath
      : null;

  if (ownersFile) {
    try {
      const content = await readFile(ownersFile, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          ownerBoundaries.set(parts[0], parts.slice(1).join(' '));
        }
      }
    } catch {
      /* skip */
    }
  }

  // 4. Build import graph and check for violations
  for (const file of files.slice(0, fileLimit)) {
    const fromLayer = classifyFile(file, layers);
    if (!fromLayer) continue;

    const stats = layerStats.get(fromLayer.name)!;
    stats.files++;

    let content: string;
    try {
      content = await readFile(path.resolve(dir, file), 'utf-8');
    } catch {
      continue;
    }

    const imports = extractImports(content);
    for (const { importPath, line } of imports) {
      // Only examine relative imports (cross-layer within the project)
      if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue;

      const resolvedImport = path.normalize(path.join(path.dirname(file), importPath)).replace(/\\/g, '/');
      const toLayer = classifyFile(resolvedImport, layers);
      if (!toLayer || toLayer.name === fromLayer.name) continue;

      stats.outbound++;
      const toStats = layerStats.get(toLayer.name);
      if (toStats) toStats.inbound++;

      // Layer violation: lower-rank importing higher-rank
      if (fromLayer.rank < toLayer.rank) {
        violations.push({
          from: { file, layer: fromLayer.name },
          to: { file: resolvedImport, layer: toLayer.name },
          type: 'layer-violation',
          severity: 'error',
          description: `"${fromLayer.name}" (rank ${fromLayer.rank}) imports from "${toLayer.name}" (rank ${toLayer.rank}). Lower layers must not depend on higher layers.`,
        });
      }

      // Abstraction bypass: controllers reaching into repositories directly
      if (
        fromLayer.rank - toLayer.rank > 1 &&
        fromLayer.rank >= 3 &&
        toLayer.rank <= 1
      ) {
        violations.push({
          from: { file, layer: fromLayer.name },
          to: { file: resolvedImport, layer: toLayer.name },
          type: 'abstraction-bypass',
          severity: 'warning',
          description: `"${fromLayer.name}" skips intermediate layers to import from "${toLayer.name}". Use the service layer as an intermediary.`,
        });
      }

      // CODEOWNERS boundary cross check
      if (ownerBoundaries.size > 0) {
        const fromOwner = findOwner(file, ownerBoundaries);
        const toOwner = findOwner(resolvedImport, ownerBoundaries);
        if (fromOwner && toOwner && fromOwner !== toOwner) {
          violations.push({
            from: { file, layer: fromLayer.name },
            to: { file: resolvedImport, layer: toLayer.name },
            type: 'boundary-cross',
            severity: 'warning',
            description: `Import crosses CODEOWNERS boundary: "${file}" (${fromOwner}) imports from "${resolvedImport}" (${toOwner}).`,
          });
        }
      }
    }
  }

  // 5. Detect circular layer dependencies
  const layerImports = new Map<string, Set<string>>();
  for (const v of violations) {
    if (!layerImports.has(v.from.layer)) layerImports.set(v.from.layer, new Set());
    layerImports.get(v.from.layer)!.add(v.to.layer);
  }
  for (const [layerA, targets] of layerImports) {
    for (const layerB of targets) {
      if (layerImports.get(layerB)?.has(layerA)) {
        // Only add if not already present
        const exists = violations.some(
          (v) => v.type === 'circular' && v.from.layer === layerA && v.to.layer === layerB,
        );
        if (!exists) {
          violations.push({
            from: { file: '', layer: layerA },
            to: { file: '', layer: layerB },
            type: 'circular',
            severity: 'error',
            description: `Circular dependency between layers "${layerA}" and "${layerB}".`,
          });
        }
      }
    }
  }

  // 6. Build result
  const layerResults = layers.map((l) => ({
    name: l.name,
    ...(layerStats.get(l.name) || { files: 0, inbound: 0, outbound: 0 }),
  }));

  const violationsByLayer = new Map<string, number>();
  for (const v of violations) {
    violationsByLayer.set(v.from.layer, (violationsByLayer.get(v.from.layer) || 0) + 1);
  }
  const worstLayer =
    [...violationsByLayer.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'none';

  const recommendations: string[] = [];
  const errorCount = violations.filter((v) => v.severity === 'error').length;
  if (errorCount > 0) {
    recommendations.push(
      `${errorCount} error-level violation(s) detected. Refactor imports to respect layer boundaries.`,
    );
  }
  const bypassCount = violations.filter((v) => v.type === 'abstraction-bypass').length;
  if (bypassCount > 0) {
    recommendations.push(
      `${bypassCount} abstraction bypass(es) found. Route calls through the service layer instead of accessing lower layers directly.`,
    );
  }
  const circularCount = violations.filter((v) => v.type === 'circular').length;
  if (circularCount > 0) {
    recommendations.push(
      `${circularCount} circular layer dependency detected. Break cycles by introducing interfaces or event-based communication.`,
    );
  }
  if (declaredArchitecture === 'inferred') {
    recommendations.push(
      'No architecture config file found. Consider adding an .architecture.json to codify layer rules.',
    );
  }
  if (violations.length === 0) {
    recommendations.push('No architecture violations detected. Layer boundaries are respected.');
  }

  return {
    violations: violations.slice(0, 200),
    layers: layerResults,
    declaredArchitecture,
    summary: {
      totalViolations: violations.length,
      layerCount: layers.length,
      worstLayer,
    },
    recommendations,
  };
}

/** Find the CODEOWNERS owner for a given file path. */
function findOwner(filePath: string, boundaries: Map<string, string>): string | null {
  let bestMatch = '';
  let bestOwner: string | null = null;
  for (const [pattern, owner] of boundaries) {
    const normalized = pattern.replace(/^\//g, '');
    if (filePath.startsWith(normalized) && normalized.length > bestMatch.length) {
      bestMatch = normalized;
      bestOwner = owner;
    }
  }
  return bestOwner;
}

/* ------------------------------------------------------------------ */
/*  trackMigrations                                                   */
/* ------------------------------------------------------------------ */

export interface Migration {
  id: string;
  name: string;
  oldPattern: string;
  newPattern: string;
  oldUsages: { file: string; line: number }[];
  newUsages: { file: string; line: number }[];
  completionPercent: number;
  status: 'not-started' | 'in-progress' | 'nearly-complete' | 'complete';
}

export interface MigrationTrackingResult {
  migrations: Migration[];
  summary: { total: number; inProgress: number; complete: number; overallCompletion: number };
  recommendations: string[];
}

/** Definition of a migration pattern to detect. */
interface MigrationDef {
  id: string;
  name: string;
  /** Regex pattern for the old/legacy usage. */
  oldPattern: string;
  /** Regex pattern for the new/modern usage. */
  newPattern: string;
  /** File glob to search within. */
  fileGlob: string;
}

/** Built-in migration detections covering common JS/TS modernization paths. */
const BUILTIN_MIGRATIONS: MigrationDef[] = [
  {
    id: 'cjs-to-esm',
    name: 'CommonJS to ESM',
    oldPattern: 'require\\s*\\(',
    newPattern: '\\bimport\\s+.*\\s+from\\s+',
    fileGlob: '*.{ts,tsx,js,jsx,mjs,cjs}',
  },
  {
    id: 'class-to-functional',
    name: 'React Class Components to Functional Components',
    oldPattern: 'class\\s+\\w+\\s+extends\\s+(?:React\\.)?(?:Component|PureComponent)',
    newPattern: '(?:function\\s+\\w+|const\\s+\\w+\\s*=\\s*(?:\\([^)]*\\)|\\w+)\\s*=>).*(?:useState|useEffect|useRef|useCallback|useMemo)',
    fileGlob: '*.{tsx,jsx}',
  },
  {
    id: 'callbacks-to-promises',
    name: 'Callbacks to Promises/Async-Await',
    oldPattern: 'function\\s*\\([^)]*callback[^)]*\\)|\\bcb\\s*\\(',
    newPattern: '\\basync\\s+function\\b|\\bawait\\s+|new\\s+Promise\\s*\\(',
    fileGlob: '*.{ts,tsx,js,jsx}',
  },
  {
    id: 'var-to-const-let',
    name: 'var to let/const',
    oldPattern: '\\bvar\\s+',
    newPattern: '\\b(?:const|let)\\s+',
    fileGlob: '*.{ts,tsx,js,jsx}',
  },
  {
    id: 'moment-to-modern',
    name: 'moment.js to dayjs/date-fns',
    oldPattern: "(?:require\\s*\\(\\s*['\"]moment['\"]|from\\s+['\"]moment['\"])",
    newPattern: "(?:require\\s*\\(\\s*['\"](?:dayjs|date-fns)['\"]|from\\s+['\"](?:dayjs|date-fns)['\"])",
    fileGlob: '*.{ts,tsx,js,jsx}',
  },
];

/**
 * Search for all occurrences of a regex pattern using `searchCode`, returning
 * file + line pairs, capped at `maxResults`.
 */
async function findPatternUsages(
  cwd: string,
  pattern: string,
  fileGlob: string,
  maxResults = 200,
): Promise<{ file: string; line: number }[]> {
  try {
    const results = await searchCode({
      cwd,
      pattern,
      isRegex: true,
      fileGlob,
      maxResults,
    });
    return results.map((r) => ({ file: r.file, line: r.line }));
  } catch {
    return [];
  }
}

/**
 * Detect and track in-progress code migrations by searching for co-existing
 * old and new patterns (e.g., `require()` alongside `import`, React class
 * components alongside functional components).
 *
 * Built-in detections:
 * - CommonJS --> ESM (`require()` vs `import`)
 * - Class components --> Functional components (React)
 * - Callbacks --> Promises --> Async/Await
 * - `var` --> `let`/`const`
 * - moment.js --> dayjs/date-fns
 *
 * Custom migrations can be supplied via `options.customMigrations`.
 *
 * @param cwd     - Working directory to scan.
 * @param options - Optional configuration.
 * @param options.customMigrations - Additional migration definitions to check.
 * @param options.includeBuiltin   - Whether to include built-in migration checks (default true).
 * @param options.maxResults       - Maximum pattern matches per migration (default 200).
 * @returns Migration tracking result with per-migration completion and recommendations.
 */
export async function trackMigrations(
  cwd: string,
  options?: {
    customMigrations?: MigrationDef[];
    includeBuiltin?: boolean;
    maxResults?: number;
  },
): Promise<MigrationTrackingResult> {
  const maxResults = options?.maxResults ?? 200;
  const defs: MigrationDef[] = [
    ...(options?.includeBuiltin !== false ? BUILTIN_MIGRATIONS : []),
    ...(options?.customMigrations || []),
  ];

  // Also search for TODO/FIXME migration comments
  const migrationTodos = await findPatternUsages(
    cwd,
    '(?:TODO|FIXME|HACK).*(?:migrat|deprecat|upgrade|replace)',
    '*.{ts,tsx,js,jsx,py,java,go,rs}',
    100,
  );

  const migrations: Migration[] = [];
  let totalCompletion = 0;
  let completedCount = 0;
  let inProgressCount = 0;

  for (const def of defs) {
    const [oldUsages, newUsages] = await Promise.all([
      findPatternUsages(cwd, def.oldPattern, def.fileGlob, maxResults),
      findPatternUsages(cwd, def.newPattern, def.fileGlob, maxResults),
    ]);

    const total = oldUsages.length + newUsages.length;
    if (total === 0) continue; // This migration is not relevant to the project

    const completionPercent =
      total > 0 ? Math.round((newUsages.length / total) * 100) : 0;

    let status: Migration['status'] = 'not-started';
    if (completionPercent === 100) status = 'complete';
    else if (completionPercent >= 80) status = 'nearly-complete';
    else if (completionPercent > 0) status = 'in-progress';

    if (status === 'complete') completedCount++;
    if (status === 'in-progress' || status === 'nearly-complete') inProgressCount++;

    totalCompletion += completionPercent;

    migrations.push({
      id: def.id,
      name: def.name,
      oldPattern: def.oldPattern,
      newPattern: def.newPattern,
      oldUsages: oldUsages.slice(0, 50),
      newUsages: newUsages.slice(0, 50),
      completionPercent,
      status,
    });
  }

  // If we found migration TODOs, create a synthetic migration entry
  if (migrationTodos.length > 0) {
    migrations.push({
      id: 'todo-migration-comments',
      name: 'Migration TODO/FIXME Comments',
      oldPattern: 'TODO|FIXME.*migrat',
      newPattern: '(resolved)',
      oldUsages: migrationTodos.slice(0, 50),
      newUsages: [],
      completionPercent: 0,
      status: 'in-progress',
    });
    inProgressCount++;
  }

  const overallCompletion =
    migrations.length > 0 ? Math.round(totalCompletion / migrations.length) : 100;

  const recommendations: string[] = [];
  const nearlyComplete = migrations.filter((m) => m.status === 'nearly-complete');
  if (nearlyComplete.length > 0) {
    recommendations.push(
      `${nearlyComplete.length} migration(s) are nearly complete: ${nearlyComplete.map((m) => m.name).join(', ')}. A small effort can finish them.`,
    );
  }
  const stalled = migrations.filter(
    (m) => m.status === 'in-progress' && m.completionPercent < 20,
  );
  if (stalled.length > 0) {
    recommendations.push(
      `${stalled.length} migration(s) have barely started: ${stalled.map((m) => m.name).join(', ')}. Consider prioritizing or abandoning them.`,
    );
  }
  if (migrationTodos.length > 0) {
    recommendations.push(
      `${migrationTodos.length} TODO/FIXME comment(s) reference migrations. Review and resolve them.`,
    );
  }
  if (migrations.length === 0) {
    recommendations.push('No active migrations detected in the codebase.');
  }

  return {
    migrations,
    summary: {
      total: migrations.length,
      inProgress: inProgressCount,
      complete: completedCount,
      overallCompletion,
    },
    recommendations,
  };
}

/* ------------------------------------------------------------------ */
/*  analyzeAuthFlows                                                  */
/* ------------------------------------------------------------------ */

export interface AuthEndpoint {
  file: string;
  line: number;
  route: string;
  method: string;
  hasAuth: boolean;
  authType?: string;
  middlewares: string[];
}

export interface AuthFlowResult {
  endpoints: AuthEndpoint[];
  authPatterns: { pattern: string; count: number; files: string[] }[];
  unprotectedEndpoints: AuthEndpoint[];
  inconsistencies: {
    group: string;
    protected: number;
    unprotected: number;
    files: string[];
  }[];
  summary: {
    totalEndpoints: number;
    protected: number;
    unprotected: number;
    authMethods: string[];
  };
  recommendations: string[];
}

/** Known auth middleware / decorator patterns with their type classification. */
const AUTH_PATTERNS: { pattern: RegExp; type: string; label: string }[] = [
  { pattern: /@Auth\b|@Authorized\b|@UseGuards\s*\(\s*Auth/i, type: 'decorator', label: '@Auth decorator' },
  { pattern: /requireAuth|isAuthenticated|ensureAuth|checkAuth/i, type: 'middleware', label: 'Auth middleware' },
  { pattern: /passport\.authenticate/i, type: 'passport', label: 'Passport.js' },
  { pattern: /jwt\.verify|jwtVerify|verifyToken|verifyJwt/i, type: 'jwt', label: 'JWT verification' },
  { pattern: /oauth2?\.authorize|oauth2?\.authenticate/i, type: 'oauth', label: 'OAuth' },
  { pattern: /@login_required|@permission_required/i, type: 'decorator', label: 'Python auth decorator' },
  { pattern: /\[Authorize\]|\[AllowAnonymous\]/i, type: 'attribute', label: 'ASP.NET [Authorize]' },
  { pattern: /@PreAuthorize|@Secured|@RolesAllowed/i, type: 'annotation', label: 'Spring Security' },
  { pattern: /AuthGuard|RolesGuard|JwtGuard|SessionGuard/i, type: 'guard', label: 'NestJS Guard' },
  { pattern: /auth_middleware|authenticate_user|current_user/i, type: 'middleware', label: 'Auth middleware function' },
];

/** Route definition patterns for common frameworks. */
const ROUTE_PATTERNS: {
  pattern: RegExp;
  methodGroup: number;
  pathGroup: number;
}[] = [
  // Express: router.get('/path', ...) or app.post('/path', ...)
  {
    pattern: /(?:app|router|server)\.(get|post|put|delete|patch|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    methodGroup: 1,
    pathGroup: 2,
  },
  // NestJS: @Get('/path'), @Post('/path')
  {
    pattern: /@(Get|Post|Put|Delete|Patch)\s*\(\s*['"]([^'"]*)['"]\s*\)/gi,
    methodGroup: 1,
    pathGroup: 2,
  },
  // FastAPI: @app.get('/path')
  {
    pattern: /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi,
    methodGroup: 1,
    pathGroup: 2,
  },
  // Flask: @app.route('/path', methods=['GET'])
  {
    pattern: /@(?:app|blueprint)\.(route|get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi,
    methodGroup: 1,
    pathGroup: 2,
  },
  // Spring: @GetMapping('/path')
  {
    pattern: /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]/gi,
    methodGroup: 1,
    pathGroup: 2,
  },
];

/**
 * Parse a single source file for route definitions and their associated auth
 * checks. Examines lines around each route definition for auth patterns.
 */
function parseFileForAuthEndpoints(content: string, file: string): AuthEndpoint[] {
  const endpoints: AuthEndpoint[] = [];
  const lines = content.split('\n');

  for (const routePattern of ROUTE_PATTERNS) {
    routePattern.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = routePattern.pattern.exec(content)) !== null) {
      const line = content.substring(0, match.index).split('\n').length;
      const method = (match[routePattern.methodGroup] || 'GET').toUpperCase();
      const route = match[routePattern.pathGroup] || '/';

      if (method === 'ROUTE') continue;

      // Look at a window of lines around the route definition for auth patterns
      const windowStart = Math.max(0, line - 8);
      const windowEnd = Math.min(lines.length, line + 3);
      const window = lines.slice(windowStart, windowEnd).join('\n');

      // Also check the entire line and a few lines before for middleware chains
      // e.g., router.get('/path', authMiddleware, handler)
      const routeLine = lines[line - 1] || '';
      const prevLines = lines.slice(Math.max(0, line - 5), line).join('\n');

      const middlewares: string[] = [];
      let hasAuth = false;
      let authType: string | undefined;

      for (const ap of AUTH_PATTERNS) {
        if (ap.pattern.test(window) || ap.pattern.test(routeLine) || ap.pattern.test(prevLines)) {
          hasAuth = true;
          authType = ap.type;
          middlewares.push(ap.label);
        }
      }

      // Also detect inline middleware references in the route definition line
      const middlewareMatch = routeLine.match(
        /,\s*(\w+(?:Auth|Guard|Middleware|Protected|Secure)\w*)/gi,
      );
      if (middlewareMatch) {
        for (const mw of middlewareMatch) {
          const name = mw.replace(/^,\s*/, '');
          if (!middlewares.includes(name)) {
            middlewares.push(name);
            hasAuth = true;
            if (!authType) authType = 'middleware';
          }
        }
      }

      endpoints.push({
        file,
        line,
        route,
        method: method === 'ALL' ? 'ANY' : method,
        hasAuth,
        authType,
        middlewares,
      });
    }
  }

  return endpoints;
}

/**
 * Trace authentication and authorization flows across the codebase.
 *
 * Finds route/endpoint definitions, checks which have auth middleware or
 * decorators attached, and flags inconsistencies (e.g., some routes in a
 * logical group are protected while others are not).
 *
 * @param cwd     - Working directory to scan.
 * @param options - Optional configuration.
 * @param options.fileLimit - Maximum source files to scan (default 500).
 * @param options.fileGlob  - Glob pattern for files to scan.
 * @returns Auth flow analysis with endpoints, patterns, inconsistencies, and recommendations.
 */
export async function analyzeAuthFlows(
  cwd: string,
  options?: { fileLimit?: number; fileGlob?: string },
): Promise<AuthFlowResult> {
  const fileLimit = options?.fileLimit ?? 500;
  const glob = options?.fileGlob ?? '**/*.{ts,tsx,js,jsx,py,java,go,rs,cs}';

  const files = await listFiles(cwd, { glob }).catch(() => [] as string[]);
  const endpoints: AuthEndpoint[] = [];
  const authPatternCounts = new Map<string, { count: number; files: Set<string> }>();

  for (const file of files.slice(0, fileLimit)) {
    let content: string;
    try {
      content = await readFile(path.resolve(cwd, file), 'utf-8');
    } catch {
      continue;
    }

    // Collect auth pattern occurrences across the project
    for (const ap of AUTH_PATTERNS) {
      if (ap.pattern.test(content)) {
        const entry = authPatternCounts.get(ap.label) || { count: 0, files: new Set<string>() };
        entry.count++;
        entry.files.add(file);
        authPatternCounts.set(ap.label, entry);
      }
    }

    // Parse route definitions with auth checks
    const fileEndpoints = parseFileForAuthEndpoints(content, file);
    endpoints.push(...fileEndpoints);
  }

  // Deduplicate endpoints (same file + line + route)
  const seen = new Set<string>();
  const deduped: AuthEndpoint[] = [];
  for (const ep of endpoints) {
    const key = `${ep.file}:${ep.line}:${ep.method}:${ep.route}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(ep);
    }
  }

  const unprotectedEndpoints = deduped.filter((ep) => !ep.hasAuth);

  // Detect inconsistencies: group routes by their base path prefix
  const inconsistencies: AuthFlowResult['inconsistencies'] = [];
  const routeGroups = new Map<string, AuthEndpoint[]>();

  for (const ep of deduped) {
    // Group by the first two path segments, e.g., /api/users
    const segments = ep.route.split('/').filter(Boolean);
    const groupKey = '/' + segments.slice(0, Math.min(2, segments.length)).join('/');
    if (!routeGroups.has(groupKey)) routeGroups.set(groupKey, []);
    routeGroups.get(groupKey)!.push(ep);
  }

  for (const [group, eps] of routeGroups) {
    if (eps.length < 2) continue;
    const protectedCount = eps.filter((e) => e.hasAuth).length;
    const unprotectedCount = eps.length - protectedCount;

    // Inconsistency: some protected, some not
    if (protectedCount > 0 && unprotectedCount > 0) {
      inconsistencies.push({
        group,
        protected: protectedCount,
        unprotected: unprotectedCount,
        files: [...new Set(eps.map((e) => e.file))],
      });
    }
  }

  // Build auth patterns summary
  const authPatterns = [...authPatternCounts.entries()]
    .map(([pattern, data]) => ({
      pattern,
      count: data.count,
      files: [...data.files].slice(0, 20),
    }))
    .sort((a, b) => b.count - a.count);

  const authMethods = [...new Set(deduped.filter((e) => e.authType).map((e) => e.authType!))];

  // Recommendations
  const recommendations: string[] = [];
  if (unprotectedEndpoints.length > 0) {
    recommendations.push(
      `${unprotectedEndpoints.length} endpoint(s) have no detected auth protection. Verify these are intentionally public.`,
    );
  }
  if (inconsistencies.length > 0) {
    recommendations.push(
      `${inconsistencies.length} route group(s) have mixed auth coverage: ${inconsistencies.map((i) => i.group).slice(0, 5).join(', ')}. Ensure consistency within each API group.`,
    );
  }
  if (authMethods.length > 2) {
    recommendations.push(
      `${authMethods.length} distinct auth methods detected (${authMethods.join(', ')}). Consider standardizing on fewer auth approaches.`,
    );
  }
  if (deduped.length === 0) {
    recommendations.push(
      'No route endpoints detected. This may be a library or non-HTTP project.',
    );
  }
  if (deduped.length > 0 && unprotectedEndpoints.length === 0) {
    recommendations.push('All detected endpoints have auth checks. Good security posture.');
  }

  return {
    endpoints: deduped.slice(0, 500),
    authPatterns,
    unprotectedEndpoints: unprotectedEndpoints.slice(0, 200),
    inconsistencies,
    summary: {
      totalEndpoints: deduped.length,
      protected: deduped.length - unprotectedEndpoints.length,
      unprotected: unprotectedEndpoints.length,
      authMethods,
    },
    recommendations,
  };
}
