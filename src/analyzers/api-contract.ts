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
  method: string; // GET, POST, PUT, DELETE, QUERY, MUTATION, SUBSCRIPTION
  path: string; // /api/users/:id or User.name
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
 * @param content
 * @param file
 */
function parseOpenAPI(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  try {
    const spec = JSON.parse(content);
    const paths = spec.paths || {};
    for (const [urlPath, methods] of Object.entries(paths)) {
      for (const [method, details] of Object.entries(methods as Record<string, any>)) {
        if (['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(method)) {
          const params = (details.parameters || []).map((p: any) => ({
            name: p.name,
            in: p.in,
            type: p.schema?.type || 'unknown',
            required: p.required,
          }));
          endpoints.push({
            method: method.toUpperCase(),
            path: urlPath,
            file,
            line: 0,
            parameters: params,
            requestBody: details.requestBody?.content?.['application/json']?.schema?.$ref || undefined,
            responseType: details.responses?.['200']?.content?.['application/json']?.schema?.$ref || undefined,
            description: details.summary || details.description,
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
 * @param content
 * @param file
 */
function parseGraphQL(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const lines = content.split('\n');

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
 * @param content
 * @param file
 */
function parseExpressRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const routeRegex = /(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    endpoints.push({
      method: match[1].toUpperCase(),
      path: match[2],
      file,
      line,
      source: 'express',
    });
  }

  return endpoints;
}

/**
 * Parse FastAPI route decorators.
 * @param content
 * @param file
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
 * @param content
 * @param file
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
 * @param cwd
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

  // Express/NestJS routes
  for (const f of tsFiles.slice(0, 300)) {
    try {
      const content = await readFile(path.join(cwd, f), 'utf-8');
      if (/(?:app|router)\.(get|post|put|delete|patch)\s*\(/i.test(content)) {
        const eps = parseExpressRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('express');
        }
      }
      if (/@Controller/.test(content)) {
        const eps = parseNestJSRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('nestjs');
        }
      }
    } catch (error) {
      logger.debug(`Failed to parse possible OpenAPI spec: ${f}`, { error });
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
    '**/*.{ts,tsx,js,jsx} (Express/NestJS routes with router.get/post/decorators)',
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
