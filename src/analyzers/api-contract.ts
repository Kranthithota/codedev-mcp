/**
 * API Contract Analysis
 * Parses OpenAPI/Swagger specs, GraphQL schemas, tRPC routers,
 * and Express/FastAPI route definitions.
 */

import { listFiles } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.js';

export interface ApiEndpoint {
  /** GET, POST, PUT, DELETE, QUERY, MUTATION, SUBSCRIPTION */
  method: string;
  /** /api/users/:id or User.name */
  path: string;
  file: string;
  line: number;
  parameters?: { name: string; in: string; type: string; required?: boolean }[];
  requestBody?: string;
  responseType?: string;
  description?: string;
  source: 'openapi' | 'graphql' | 'trpc' | 'express' | 'fastapi' | 'nestjs';
}

export interface ApiContractResult {
  endpoints: ApiEndpoint[];
  totalEndpoints: number;
  sources: string[];
  specFiles: string[];
  summary: { get: number; post: number; put: number; delete: number; query: number; mutation: number; other: number };
  scannedPatterns: string[];
}

/**
 * Parse OpenAPI/Swagger JSON/YAML.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseOpenAPI(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  try {
    const spec = JSON.parse(content);
    const paths = spec.paths || {};
    for (const [urlPath, methods] of Object.entries(paths)) {
      for (const [method, rawDetails] of Object.entries(methods as Record<string, unknown>)) {
        if (['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(method)) {
          const details = rawDetails as Record<string, unknown>;
          const paramsList = (details.parameters || []) as Record<string, unknown>[];
          const params = paramsList.map((p) => ({
            name: p.name as string,
            in: p.in as string,
            type: ((p.schema as Record<string, unknown>)?.type as string) || 'unknown',
            required: p.required as boolean | undefined,
          }));
          const requestBody = details.requestBody as Record<string, unknown> | undefined;
          const responses = details.responses as Record<string, Record<string, unknown>> | undefined;
          endpoints.push({
            method: method.toUpperCase(),
            path: urlPath,
            file,
            line: 0,
            parameters: params,
            requestBody:
              (
                (requestBody?.content as Record<string, Record<string, { $ref?: string } | unknown>> | undefined)?.[
                  'application/json'
                ]?.schema as { $ref?: string } | undefined
              )?.$ref || undefined,
            responseType:
              (
                (
                  responses?.['200']?.content as Record<string, Record<string, { $ref?: string } | unknown>> | undefined
                )?.['application/json']?.schema as { $ref?: string } | undefined
              )?.$ref || undefined,
            description: (details.summary || details.description) as string | undefined,
            source: 'openapi',
          });
        }
      }
    }
  } catch (error) {
    logger.debug(`Failed to parse OpenAPI spec: ${file}`, { error });
  }
  return endpoints;
}

/**
 * Parse GraphQL schema definitions.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseGraphQL(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];

  // Find type Query, Mutation, Subscription blocks
  const typeBlockRegex = /type\s+(Query|Mutation|Subscription)\s*\{([^}]+)\}/gs;
  let match;

  while ((match = typeBlockRegex.exec(content)) !== null) {
    const blockType = match[1];
    const body = match[2];
    const blockLine = content.substring(0, match.index).split('\n').length;

    const methodMap: Record<string, string> = { Query: 'QUERY', Mutation: 'MUTATION', Subscription: 'SUBSCRIPTION' };

    for (const fieldLine of body.split('\n')) {
      const trimmed = fieldLine.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const fieldMatch = trimmed.match(/(\w+)\s*(?:\(([^)]*)\))?\s*:\s*(.+)/);
      if (fieldMatch) {
        const params = fieldMatch[2]
          ? fieldMatch[2].split(',').map((p) => {
              const [name, type] = p.trim().split(/\s*:\s*/);
              return {
                name: name.replace('!', ''),
                in: 'argument',
                type: (type || 'unknown').replace('!', ''),
                required: p.includes('!'),
              };
            })
          : [];

        endpoints.push({
          method: methodMap[blockType] || 'QUERY',
          path: `${blockType}.${fieldMatch[1]}`,
          file,
          line: blockLine,
          parameters: params,
          responseType: fieldMatch[3].trim().replace('!', ''),
          source: 'graphql',
        });
      }
    }
  }

  return endpoints;
}

/**
 * Parse Express/Fastify route definitions.
 * Supports multiple Express patterns:
 * - router.get('/path', handler)
 * - app.post('/path', handler)
 * - router.route('/path').get(handler).post(handler)
 * - express.Router().get('/path', handler)
 * - Routes with variables: router.get(pathVar, handler)
 * - Routes with template literals: router.get(`/api/${version}/users`, handler)
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseExpressRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  
  // Pattern 1: Standard router.get/post/put/delete/patch('/path', ...)
  // Matches: router.get('/api/users', handler) or app.post('/api/users', handler)
  const standardRouteRegex = /(?:app|router|express\.Router\(\)|express\(\))\.(get|post|put|delete|patch|all|use)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  let match;
  
  while ((match = standardRouteRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    const method = match[1].toUpperCase();
    const path = match[2];
    
    // Skip 'use' and 'all' methods unless they have specific paths
    if (method === 'USE' && !path.match(/^\/[^/]/)) continue;
    
    endpoints.push({
      method: method === 'ALL' ? 'ANY' : method,
      path: path,
      file,
      line,
      source: 'express',
    });
  }
  
  // Pattern 2: router.route('/path').get(...).post(...)
  const routeChainRegex = /(?:app|router)\.route\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\.(get|post|put|delete|patch)\s*\(/gi;
  while ((match = routeChainRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    endpoints.push({
      method: match[2].toUpperCase(),
      path: match[1],
      file,
      line,
      source: 'express',
    });
  }
  
  // Pattern 3: Routes with variables (router.get(pathVar, handler))
  // Try to find path variables defined earlier in the file
  const pathVarRegex = /(?:const|let|var)\s+(\w+Path)\s*=\s*['"`]([^'"`]+)['"`]/g;
  const pathVars = new Map<string, string>();
  let pathMatch;
  while ((pathMatch = pathVarRegex.exec(content)) !== null) {
    pathVars.set(pathMatch[1], pathMatch[2]);
  }
  
  // Pattern 4: Routes using path variables
  const varRouteRegex = /(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*(\w+Path)/gi;
  while ((match = varRouteRegex.exec(content)) !== null) {
    const pathVar = match[2];
    const pathValue = pathVars.get(pathVar);
    if (pathValue) {
      const line = content.substring(0, match.index).split('\n').length;
      endpoints.push({
        method: match[1].toUpperCase(),
        path: pathValue,
        file,
        line,
        source: 'express',
      });
    }
  }
  
  // Pattern 5: Template literal routes: router.get(`/api/${version}/users`, ...)
  const templateRouteRegex = /(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*`([^`]+)`/gi;
  while ((match = templateRouteRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    // Extract static parts of template literal (remove ${...} parts)
    const path = match[2].replace(/\$\{[^}]+\}/g, '*');
    endpoints.push({
      method: match[1].toUpperCase(),
      path: path,
      file,
      line,
      source: 'express',
    });
  }
  
  // Pattern 6: Express Router instances: const router = express.Router(); router.get(...)
  // This is already covered by Pattern 1, but let's also check for mounted routers
  const mountedRouterRegex = /(?:app|router)\.use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(\w+Router|\w+Routes)/gi;
  while ((match = mountedRouterRegex.exec(content)) !== null) {
    const basePath = match[1];
    const routerName = match[2];
    // Try to find routes in the router definition
    const routerDefRegex = new RegExp(`(?:const|let|var)\\s+${routerName}\\s*=\\s*express\\.Router\\(\\)[\\s\\S]*?`, 'i');
    const routerDef = content.match(routerDefRegex);
    if (routerDef) {
      const routerContent = routerDef[0];
      const routerRouteRegex = new RegExp(`(?:router|${routerName})\\.(get|post|put|delete|patch)\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'gi');
      const routerRoutes = routerContent.matchAll(routerRouteRegex);
      for (const routeMatch of routerRoutes) {
        const line = content.substring(0, match.index).split('\n').length;
        endpoints.push({
          method: routeMatch[1].toUpperCase(),
          path: `${basePath}${routeMatch[2]}`.replace(/\/+/g, '/'),
          file,
          line,
          source: 'express',
        });
      }
    }
  }

  return endpoints;
}

/**
 * Parse FastAPI route decorators.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseFastAPIRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const routeRegex = /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    // Try to extract the function signature
    const afterDeco = content.substring(match.index + match[0].length);
    const funcMatch = afterDeco.match(/(?:async\s+)?def\s+\w+\s*\(([^)]*)\)/);
    const params =
      funcMatch?.[1]
        ?.split(',')
        .map((p) => p.trim())
        .filter((p) => p && !p.startsWith('self') && !p.startsWith('request'))
        .map((p) => {
          const [name, type] = p.split(/\s*:\s*/);
          return { name, in: 'parameter', type: type || 'unknown' };
        }) || [];

    endpoints.push({
      method: match[1].toUpperCase(),
      path: match[2],
      file,
      line,
      parameters: params,
      source: 'fastapi',
    });
  }

  return endpoints;
}

/**
 * Parse NestJS controller decorators.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseNestJSRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  if (!/@Controller/.test(content)) return endpoints;

  const controllerPath = content.match(/@Controller\s*\(\s*['"]([^'"]*)['"]\s*\)/)?.[1] || '';
  const routeRegex = /@(Get|Post|Put|Delete|Patch)\s*\(\s*(?:['"]([^'"]*)['"]\s*)?\)/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    const methodPath = match[2] || '';
    endpoints.push({
      method: match[1].toUpperCase(),
      path: `/${controllerPath}/${methodPath}`.replace(/\/+/g, '/'),
      file,
      line,
      source: 'nestjs',
    });
  }

  return endpoints;
}

/**
 * Main API contract analysis function.
 * @param cwd - The working directory to scan.
 * @returns The API contract analysis result.
 */
export async function analyzeApiContracts(cwd: string): Promise<ApiContractResult> {
  const allEndpoints: ApiEndpoint[] = [];
  const specFiles: string[] = [];
  const sources = new Set<string>();

  // Find spec files
  const jsonFiles = await listFiles(cwd, { glob: '**/*.{json,yaml,yml}' });
  const gqlFiles = await listFiles(cwd, { glob: '**/*.{graphql,gql}' });
  const tsFiles = await listFiles(cwd, { glob: '**/*.{ts,tsx,js,jsx}' });
  const pyFiles = await listFiles(cwd, { glob: '**/*.py' });

  // OpenAPI specs
  for (const f of jsonFiles.filter((f) => /swagger|openapi/i.test(f)).slice(0, 10)) {
    try {
      const content = await readFile(path.join(cwd, f), 'utf-8');
      const eps = parseOpenAPI(content, f);
      if (eps.length > 0) {
        allEndpoints.push(...eps);
        specFiles.push(f);
        sources.add('openapi');
      }
    } catch (error) {
      logger.debug(`Failed to parse possible OpenAPI spec: ${f}`, { error });
    }
  }

  // GraphQL schemas
  for (const f of gqlFiles.slice(0, 20)) {
    try {
      const content = await readFile(path.join(cwd, f), 'utf-8');
      const eps = parseGraphQL(content, f);
      if (eps.length > 0) {
        allEndpoints.push(...eps);
        specFiles.push(f);
        sources.add('graphql');
      }
    } catch (error) {
      logger.debug(`Failed to parse possible OpenAPI spec: ${f}`, { error });
    }
  }

  // Express/NestJS routes - prioritize route files
  const routeFiles = tsFiles.filter((f) => 
    /routes?|controllers?|api|endpoints?/i.test(f) || 
    /\.route\.(ts|js)$/i.test(f)
  );
  const otherTsFiles = tsFiles.filter((f) => !routeFiles.includes(f));
  
  // Check route files first (more likely to contain routes)
  for (const f of [...routeFiles, ...otherTsFiles].slice(0, 500)) {
    try {
      const content = await readFile(path.join(cwd, f), 'utf-8');
      
      // Enhanced Express detection - check for multiple patterns
      if (
        /(?:app|router|express\.Router)\.(get|post|put|delete|patch|all|use|route)\s*\(/i.test(content) ||
        /express\.Router\(\)/i.test(content) ||
        /from\s+['"]express['"]/i.test(content) ||
        /require\s*\(['"]express['"]\)/i.test(content)
      ) {
        const eps = parseExpressRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('express');
        }
      }
      
      // NestJS detection
      if (/@Controller/.test(content)) {
        const eps = parseNestJSRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('nestjs');
        }
      }
    } catch (error) {
      logger.debug(`Failed to parse possible route file: ${f}`, { error });
    }
  }

  // FastAPI routes
  for (const f of pyFiles.slice(0, 200)) {
    try {
      const content = await readFile(path.join(cwd, f), 'utf-8');
      if (/@(?:app|router)\.(get|post|put|delete)/.test(content)) {
        const eps = parseFastAPIRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('fastapi');
        }
      }
    } catch (error) {
      logger.debug(`Failed to parse possible OpenAPI spec: ${f}`, { error });
    }
  }

  // Also check for GraphQL in TS/JS files
  for (const f of tsFiles.filter((f) => /schema|graphql|typeDefs/i.test(f)).slice(0, 20)) {
    try {
      const content = await readFile(path.join(cwd, f), 'utf-8');
      if (/type\s+(?:Query|Mutation)\s*\{/.test(content)) {
        const eps = parseGraphQL(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('graphql');
        }
      }
    } catch (error) {
      logger.debug(`Failed to parse possible OpenAPI spec: ${f}`, { error });
    }
  }

  const summary = { get: 0, post: 0, put: 0, delete: 0, query: 0, mutation: 0, other: 0 };
  for (const ep of allEndpoints) {
    const m = ep.method.toLowerCase();
    if (m === 'get') summary.get++;
    else if (m === 'post') summary.post++;
    else if (m === 'put' || m === 'patch') summary.put++;
    else if (m === 'delete') summary.delete++;
    else if (m === 'query') summary.query++;
    else if (m === 'mutation') summary.mutation++;
    else summary.other++;
  }

  const scannedPatterns = [
    '**/*.{json,yaml,yml} (OpenAPI/Swagger containing swagger|openapi)',
    '**/*.{graphql,gql} (GraphQL schemas)',
    '**/routes/**/*.{ts,tsx,js,jsx} (Express route files - prioritized)',
    '**/*.{ts,tsx,js,jsx} (Express/NestJS routes: router.get/post, router.route(), express.Router())',
    '**/*.py (FastAPI routes with @app.get/post)',
  ];

  return {
    endpoints: allEndpoints,
    totalEndpoints: allEndpoints.length,
    sources: Array.from(sources),
    specFiles: [...new Set(specFiles)],
    summary,
    scannedPatterns,
  };
}
