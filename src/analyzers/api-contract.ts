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
  source:
    | 'openapi'
    | 'graphql'
    | 'trpc'
    | 'express'
    | 'fastapi'
    | 'nestjs'
    | 'flask'
    | 'django'
    | 'rails'
    | 'sinatra'
    | 'laravel'
    | 'spring'
    | 'jaxrs'
    | 'gin'
    | 'echo'
    | 'fiber'
    | 'chi'
    | 'actix'
    | 'rocket'
    | 'axum'
    | 'aspnet'
    | 'koa'
    | 'fastify'
    | 'hapi';
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

  // Pattern 1: Named Router variables with routes
  // Matches: export const studentSectorPriorityRoute = express.Router();
  //          studentSectorPriorityRoute.get("/student/:studentId", handler);
  // Also matches: const router = express.Router(); router.get(...)
  // First, find all Router() variable declarations (more flexible - not just *Route*)
  const routerVarRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*express\.Router\(\)/gi;
  const routerVars = new Map<string, number>();
  let routerMatch;
  while ((routerMatch = routerVarRegex.exec(content)) !== null) {
    routerVars.set(routerMatch[1], routerMatch.index);
  }

  // Now find routes using these router variables
  for (const [routerVar] of routerVars) {
    // Escape special regex characters in routerVar name
    const escapedVar = routerVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const routerVarRegex2 = new RegExp(
      `${escapedVar}\\.(get|post|put|delete|patch|all|use)\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`,
      'gi',
    );
    let routeMatch;
    while ((routeMatch = routerVarRegex2.exec(content)) !== null) {
      const line = content.substring(0, routeMatch.index).split('\n').length;
      const method = routeMatch[1].toUpperCase();
      const path = routeMatch[2];
      if (method === 'USE' && !path.match(/^\/[^/]/)) continue;
      endpoints.push({
        method: method === 'ALL' ? 'ANY' : method,
        path: path,
        file,
        line,
        source: 'express',
      });
    }
  }

  // Pattern 1b: Standard router.get/post/put/delete/patch('/path', ...)
  // Matches: router.get('/api/users', handler) or app.post('/api/users', handler)
  // Also matches: router.get("/api/users", handler) with double quotes
  // Also matches: router.get(`/api/users`, handler) with template literals
  // Also matches: const router = express.Router(); router.get(...)
  const standardRouteRegex =
    /(?:app|router|express\.Router\(\)|express\(\))\s*\.(get|post|put|delete|patch|all|use)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
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
  const routeChainRegex =
    /(?:app|router)\.route\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\.(get|post|put|delete|patch)\s*\(/gi;
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

  // Pattern 6: Routes exported as arrays or objects
  // Matches: export default [{ method: 'GET', path: '/api/users', handler }]
  // Matches: export const routes = [{ method: 'GET', path: '/api/users' }]
  const exportedRoutesRegex = /export\s+(?:default\s+)?(?:const|let|var)?\s*\w*\s*=\s*\[([\s\S]*?)\]/g;
  let exportedMatch;
  while ((exportedMatch = exportedRoutesRegex.exec(content)) !== null) {
    const routesArray = exportedMatch[1];
    // Try to extract route objects from the array
    const routeObjRegex =
      /\{\s*(?:method|path|route|url)\s*:\s*['"`]([^'"`]+)['"`]\s*,\s*(?:method|path|route|url)\s*:\s*['"`]([^'"`]+)['"`]/gi;
    let routeObjMatch;
    while ((routeObjMatch = routeObjRegex.exec(routesArray)) !== null) {
      const line = content.substring(0, exportedMatch.index).split('\n').length;
      // Determine which is method and which is path
      const first = routeObjMatch[1];
      const second = routeObjMatch[2];
      const method = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(first.toUpperCase())
        ? first.toUpperCase()
        : second.toUpperCase();
      const path = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(first.toUpperCase()) ? second : first;
      if (method && path && path.startsWith('/')) {
        endpoints.push({ method, path, file, line, source: 'express' });
      }
    }
  }

  // Pattern 7: Express Router instances: const router = express.Router(); router.get(...)
  // This is already covered by Pattern 1, but let's also check for mounted routers
  const mountedRouterRegex = /(?:app|router)\.use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(\w+Router|\w+Routes)/gi;
  while ((match = mountedRouterRegex.exec(content)) !== null) {
    const basePath = match[1];
    const routerName = match[2];
    // Try to find routes in the router definition
    const routerDefRegex = new RegExp(
      `(?:const|let|var)\\s+${routerName}\\s*=\\s*express\\.Router\\(\\)[\\s\\S]*?`,
      'i',
    );
    const routerDef = content.match(routerDefRegex);
    if (routerDef) {
      const routerContent = routerDef[0];
      const routerRouteRegex = new RegExp(
        `(?:router|${routerName})\\.(get|post|put|delete|patch)\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`,
        'gi',
      );
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
 * Parse Flask route decorators.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseFlaskRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const routeRegex = /@(?:app|blueprint|router)\.(route|get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    const method = match[1].toUpperCase() === 'ROUTE' ? 'GET' : match[1].toUpperCase();
    const path = match[2];
    endpoints.push({
      method,
      path,
      file,
      line,
      source: 'flask',
    });
  }

  return endpoints;
}

/**
 * Parse Django REST Framework viewsets and views.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseDjangoRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];

  // Django REST Framework ViewSet with router
  if (/class\s+\w+ViewSet/.test(content) || /from\s+rest_framework/.test(content)) {
    const viewsetMatch = content.match(/class\s+(\w+ViewSet)/);
    if (viewsetMatch) {
      // Common ViewSet actions
      const actions = ['list', 'create', 'retrieve', 'update', 'partial_update', 'destroy'];
      for (const action of actions) {
        if (new RegExp(`def\\s+${action}`).test(content)) {
          endpoints.push({
            method:
              action === 'list' || action === 'retrieve'
                ? 'GET'
                : action === 'create'
                  ? 'POST'
                  : action === 'destroy'
                    ? 'DELETE'
                    : 'PUT',
            path: `/${action}`,
            file,
            line: 0,
            source: 'django',
          });
        }
      }
    }
  }

  // Django function-based views with decorators
  const decoratorRegex = /@(?:api_view|action)\s*\([^)]*\)\s*(?:@\w+\s*\([^)]*\)\s*)*def\s+(\w+)\s*\(/gi;
  let match;
  while ((match = decoratorRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    endpoints.push({
      method: 'GET',
      path: `/${match[1]}`,
      file,
      line,
      source: 'django',
    });
  }

  return endpoints;
}

/**
 * Parse Rails routes.rb file.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseRailsRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  // Rails route syntax: get '/users', to: 'users#index'
  const routeRegex = /(get|post|put|patch|delete|resources?)\s+['"]([^'"]+)['"]/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    const method = match[1].toUpperCase();
    const path = match[2];

    if (method === 'RESOURCES' || method === 'RESOURCE') {
      // RESTful resource routes
      const resourceName = path.replace(/^\//, '').replace(/\/$/, '');
      endpoints.push(
        { method: 'GET', path: `/${resourceName}`, file, line, source: 'rails' },
        { method: 'POST', path: `/${resourceName}`, file, line, source: 'rails' },
        { method: 'GET', path: `/${resourceName}/:id`, file, line, source: 'rails' },
        { method: 'PUT', path: `/${resourceName}/:id`, file, line, source: 'rails' },
        { method: 'DELETE', path: `/${resourceName}/:id`, file, line, source: 'rails' },
      );
    } else {
      endpoints.push({
        method: method === 'PATCH' ? 'PUT' : method,
        path,
        file,
        line,
        source: 'rails',
      });
    }
  }

  return endpoints;
}

/**
 * Parse Sinatra routes.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseSinatraRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const routeRegex = /(get|post|put|delete|patch)\s+['"]([^'"]+)['"]/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    endpoints.push({
      method: match[1].toUpperCase(),
      path: match[2],
      file,
      line,
      source: 'sinatra',
    });
  }

  return endpoints;
}

/**
 * Parse Laravel routes.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseLaravelRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  // Laravel route syntax: Route::get('/users', [UserController::class, 'index']);
  const routeRegex = /Route::(get|post|put|delete|patch|any|match)\s*\(\s*['"]([^'"]+)['"]/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    const method = match[1].toUpperCase();
    endpoints.push({
      method: method === 'ANY' || method === 'MATCH' ? 'ANY' : method,
      path: match[2],
      file,
      line,
      source: 'laravel',
    });
  }

  // Laravel resource routes: Route::resource('users', UserController::class);
  const resourceRegex = /Route::resource\s*\(\s*['"]([^'"]+)['"]/gi;
  while ((match = resourceRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    const resourceName = match[1];
    endpoints.push(
      { method: 'GET', path: `/${resourceName}`, file, line, source: 'laravel' },
      { method: 'POST', path: `/${resourceName}`, file, line, source: 'laravel' },
      { method: 'GET', path: `/${resourceName}/{id}`, file, line, source: 'laravel' },
      { method: 'PUT', path: `/${resourceName}/{id}`, file, line, source: 'laravel' },
      { method: 'DELETE', path: `/${resourceName}/{id}`, file, line, source: 'laravel' },
    );
  }

  return endpoints;
}

/**
 * Parse Spring Boot @RequestMapping annotations.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseSpringRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  if (!/@(?:RestController|Controller)/.test(content)) return endpoints;

  const classPath =
    content.match(
      /@(?:RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*\(\s*value\s*=\s*['"]([^'"]+)['"]/,
    )?.[1] ||
    content.match(/@RequestMapping\s*\(\s*['"]([^'"]+)['"]/)?.[1] ||
    '';

  const methodRegex =
    /@(?:GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*\(\s*(?:value\s*=\s*)?['"]([^'"]*)['"]/gi;
  let match;

  while ((match = methodRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    const methodPath = match[1];
    const fullAnnotation = content.substring(match.index, content.indexOf(')', match.index) + 1);
    let method = 'GET';
    if (/GetMapping/.test(fullAnnotation)) method = 'GET';
    else if (/PostMapping/.test(fullAnnotation)) method = 'POST';
    else if (/PutMapping/.test(fullAnnotation)) method = 'PUT';
    else if (/DeleteMapping/.test(fullAnnotation)) method = 'DELETE';
    else if (/PatchMapping/.test(fullAnnotation)) method = 'PATCH';
    else if (/RequestMapping/.test(fullAnnotation)) {
      const methodMatch = fullAnnotation.match(/method\s*=\s*RequestMethod\.(\w+)/);
      if (methodMatch) method = methodMatch[1].toUpperCase();
    }

    endpoints.push({
      method,
      path: `/${classPath}/${methodPath}`.replace(/\/+/g, '/'),
      file,
      line,
      source: 'spring',
    });
  }

  return endpoints;
}

/**
 * Parse JAX-RS annotations.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseJAXRSRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  if (!/@Path/.test(content)) return endpoints;

  const classPath = content.match(/@Path\s*\(\s*['"]([^'"]+)['"]/)?.[1] || '';
  const methodRegex = /@(GET|POST|PUT|DELETE|PATCH|Path)\s*\(\s*(?:value\s*=\s*)?['"]([^'"]*)['"]/gi;
  let match;

  while ((match = methodRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    const annotation = match[1];
    const path = match[2] || '';
    let method = 'GET';
    if (annotation === 'GET') method = 'GET';
    else if (annotation === 'POST') method = 'POST';
    else if (annotation === 'PUT') method = 'PUT';
    else if (annotation === 'DELETE') method = 'DELETE';
    else if (annotation === 'PATCH') method = 'PATCH';

    endpoints.push({
      method,
      path: `/${classPath}/${path}`.replace(/\/+/g, '/'),
      file,
      line,
      source: 'jaxrs',
    });
  }

  return endpoints;
}

/**
 * Parse Go Gin routes.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseGinRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const routeRegex = /(?:router|r|engine)\.(GET|POST|PUT|DELETE|PATCH|Any)\s*\(\s*['"]([^'"]+)['"]/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    endpoints.push({
      method: match[1] === 'Any' ? 'ANY' : match[1],
      path: match[2],
      file,
      line,
      source: 'gin',
    });
  }

  return endpoints;
}

/**
 * Parse Go Echo routes.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseEchoRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const routeRegex = /(?:e|app|router)\.(GET|POST|PUT|DELETE|PATCH|Any)\s*\(\s*['"]([^'"]+)['"]/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    endpoints.push({
      method: match[1] === 'Any' ? 'ANY' : match[1],
      path: match[2],
      file,
      line,
      source: 'echo',
    });
  }

  return endpoints;
}

/**
 * Parse Go Fiber routes.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseFiberRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const routeRegex = /(?:app|router)\.(Get|Post|Put|Delete|Patch|All)\s*\(\s*['"]([^'"]+)['"]/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    endpoints.push({
      method: match[1] === 'All' ? 'ANY' : match[1].toUpperCase(),
      path: match[2],
      file,
      line,
      source: 'fiber',
    });
  }

  return endpoints;
}

/**
 * Parse Go Chi routes.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseChiRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const routeRegex = /(?:r|router|mux)\.(Get|Post|Put|Delete|Patch|Method)\s*\(\s*['"]([^'"]+)['"]/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    endpoints.push({
      method: match[1] === 'Method' ? 'ANY' : match[1].toUpperCase(),
      path: match[2],
      file,
      line,
      source: 'chi',
    });
  }

  return endpoints;
}

/**
 * Parse Rust Actix-web routes.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseActixRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const routeRegex = /\.(route|get|post|put|delete)\s*\(\s*['"]([^'"]+)['"]/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    const method = match[1].toUpperCase() === 'ROUTE' ? 'GET' : match[1].toUpperCase();
    endpoints.push({
      method,
      path: match[2],
      file,
      line,
      source: 'actix',
    });
  }

  return endpoints;
}

/**
 * Parse Rust Rocket routes.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseRocketRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const routeRegex = /#\[(get|post|put|delete|patch|head|options)\s*\(['"]([^'"]+)['"]/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    endpoints.push({
      method: match[1].toUpperCase(),
      path: match[2],
      file,
      line,
      source: 'rocket',
    });
  }

  return endpoints;
}

/**
 * Parse Rust Axum routes.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseAxumRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const routeRegex = /\.(route|get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    const method = match[1].toUpperCase() === 'ROUTE' ? 'GET' : match[1].toUpperCase();
    endpoints.push({
      method,
      path: match[2],
      file,
      line,
      source: 'axum',
    });
  }

  return endpoints;
}

/**
 * Parse ASP.NET Core controllers.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseAspNetRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  if (!/\[ApiController\]/.test(content) && !/class\s+\w+Controller/.test(content)) return endpoints;

  const routePrefix = content.match(/\[Route\s*\(\s*['"]([^'"]+)['"]/)?.[1] || '';
  const methodRegex = /\[(HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch)\s*(?:\(\s*['"]([^'"]*)['"]\s*)?\)\]/gi;
  let match;

  while ((match = methodRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    const method = match[1].replace('Http', '').toUpperCase();
    const path = match[2] || '';
    endpoints.push({
      method,
      path: `/${routePrefix}/${path}`.replace(/\/+/g, '/'),
      file,
      line,
      source: 'aspnet',
    });
  }

  return endpoints;
}

/**
 * Parse Koa routes.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseKoaRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const routeRegex = /(?:router|app)\.(get|post|put|delete|patch|all)\s*\(\s*['"]([^'"]+)['"]/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    endpoints.push({
      method: match[1].toUpperCase() === 'ALL' ? 'ANY' : match[1].toUpperCase(),
      path: match[2],
      file,
      line,
      source: 'koa',
    });
  }

  return endpoints;
}

/**
 * Parse Fastify routes.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseFastifyRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const routeRegex = /(?:fastify|app)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    endpoints.push({
      method: match[1].toUpperCase(),
      path: match[2],
      file,
      line,
      source: 'fastify',
    });
  }

  return endpoints;
}

/**
 * Parse Hapi routes.
 * @param content - The file content to parse.
 * @param file - The file path.
 * @returns Parsed API endpoints.
 */
function parseHapiRoutes(content: string, file: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const routeRegex =
    /(?:method|path):\s*['"](GET|POST|PUT|DELETE|PATCH|get|post|put|delete|patch)['"]|path:\s*['"]([^'"]+)['"]/gi;
  let match;
  let currentMethod = 'GET';
  let currentPath = '';

  while ((match = routeRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split('\n').length;
    if (match[1]) {
      currentMethod = match[1].toUpperCase();
    } else if (match[2]) {
      currentPath = match[2];
      endpoints.push({
        method: currentMethod,
        path: currentPath,
        file,
        line,
        source: 'hapi',
      });
    }
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
  const rbFiles = await listFiles(cwd, { glob: '**/*.rb' });
  const phpFiles = await listFiles(cwd, { glob: '**/*.php' });
  const javaFiles = await listFiles(cwd, { glob: '**/*.java' });
  const goFiles = await listFiles(cwd, { glob: '**/*.go' });
  const rsFiles = await listFiles(cwd, { glob: '**/*.rs' });
  const csFiles = await listFiles(cwd, { glob: '**/*.cs' });

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
    } catch {
      // Skip invalid OpenAPI specs
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
    } catch {
      // Skip invalid OpenAPI specs
    }
  }

  // Express/NestJS routes - be less restrictive with file filtering
  // Check all TypeScript files, not just those matching route patterns
  // Many projects organize routes differently
  const routeFiles = tsFiles.filter(
    (f) =>
      /routes?|controllers?|api|endpoints?|handlers?/i.test(f) || 
      /\.route\.(ts|js)$/i.test(f) || 
      /_routes?\.(ts|js)$/i.test(f) ||
      /index\.(ts|js)$/i.test(f), // Also check index files which often aggregate routes
  );
  const otherTsFiles = tsFiles.filter((f) => !routeFiles.includes(f));

  // Check route files first (more likely to contain routes)
  // Increased limit from 500 to 2000 to handle large projects
  // Process all files, not just route files, to catch routes defined anywhere
  for (const f of [...routeFiles, ...otherTsFiles].slice(0, 2000)) {
    try {
      const content = await readFile(path.join(cwd, f), 'utf-8');

      // Enhanced Express detection - check for multiple patterns
      // Also check for named Router variables (e.g., export const studentSectorPriorityRoute = express.Router())
      if (
        /(?:app|router|express\.Router)\.(get|post|put|delete|patch|all|use|route)\s*\(/i.test(content) ||
        /express\.Router\(\)/i.test(content) ||
        /from\s+['"]express['"]/i.test(content) ||
        /require\s*\(['"]express['"]\)/i.test(content) ||
        /(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*express\.Router\(\)/i.test(content)
      ) {
        const eps = parseExpressRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('express');
        }
      }

      // Also check for aggregator files with route arrays
      // Matches: const defaultRoutes = [{ path: '/jobDescriptions', route: jobDescRoutes }]
      if (/const\s+\w+Routes\s*=\s*\[[\s\S]*?\{[\s\S]*?path:[\s\S]*?route:/i.test(content)) {
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

      // Koa detection
      if (/from\s+['"]koa['"]|require\s*\(['"]koa['"]/.test(content) || /router\.(get|post|put|delete)/.test(content)) {
        const eps = parseKoaRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('koa');
        }
      }

      // Fastify detection
      if (
        /from\s+['"]fastify['"]|require\s*\(['"]fastify['"]/.test(content) ||
        /fastify\.(get|post|put|delete)/.test(content)
      ) {
        const eps = parseFastifyRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('fastify');
        }
      }

      // Hapi detection
      if (/from\s+['"]@hapi\/hapi['"]|require\s*\(['"]@hapi\/hapi['"]/.test(content) || /server\.route/.test(content)) {
        const eps = parseHapiRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('hapi');
        }
      }
    } catch (error) {
      logger.debug(`Failed to parse possible route file: ${f}`, { error });
    }
  }

  // Python frameworks: FastAPI, Flask, Django
  for (const f of pyFiles.slice(0, 300)) {
    try {
      const content = await readFile(path.join(cwd, f), 'utf-8');

      // FastAPI routes
      if (/@(?:app|router)\.(get|post|put|delete)/.test(content) || /from\s+fastapi/.test(content)) {
        const eps = parseFastAPIRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('fastapi');
        }
      }

      // Flask routes
      if (
        /@(?:app|blueprint|router)\.(route|get|post|put|delete|patch)/.test(content) ||
        /from\s+flask/.test(content)
      ) {
        const eps = parseFlaskRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('flask');
        }
      }

      // Django REST Framework
      if (/from\s+rest_framework/.test(content) || /class\s+\w+ViewSet/.test(content)) {
        const eps = parseDjangoRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('django');
        }
      }
    } catch (error) {
      logger.debug(`Failed to parse possible Python route file: ${f}`, { error });
    }
  }

  // Ruby frameworks: Rails, Sinatra
  const railsRouteFiles = rbFiles.filter((f) => /routes\.rb|config\/routes/.test(f));
  const otherRbFiles = rbFiles.filter((f) => !railsRouteFiles.includes(f));

  for (const f of [...railsRouteFiles, ...otherRbFiles].slice(0, 100)) {
    try {
      const content = await readFile(path.join(cwd, f), 'utf-8');

      // Rails routes
      if (/Rails\.application\.routes\.draw|resources?|get\s+['"]/.test(content)) {
        const eps = parseRailsRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('rails');
        }
      }

      // Sinatra routes
      if (/require\s+['"]sinatra['"]|class\s+\w+\s*<\s*Sinatra/.test(content)) {
        const eps = parseSinatraRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('sinatra');
        }
      }
    } catch (error) {
      logger.debug(`Failed to parse possible Ruby route file: ${f}`, { error });
    }
  }

  // PHP frameworks: Laravel
  for (const f of phpFiles.filter((f) => /routes|Route::/.test(f)).slice(0, 50)) {
    try {
      const content = await readFile(path.join(cwd, f), 'utf-8');
      if (/Route::(get|post|put|delete|resource)/.test(content)) {
        const eps = parseLaravelRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('laravel');
        }
      }
    } catch (error) {
      logger.debug(`Failed to parse possible Laravel route file: ${f}`, { error });
    }
  }

  // Java frameworks: Spring Boot, JAX-RS
  for (const f of javaFiles.filter((f) => /controller|Controller|RestController|@Path/.test(f)).slice(0, 200)) {
    try {
      const content = await readFile(path.join(cwd, f), 'utf-8');

      // Spring Boot
      if (/@(?:RestController|Controller)/.test(content)) {
        const eps = parseSpringRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('spring');
        }
      }

      // JAX-RS
      if (/@Path/.test(content) && /javax\.ws\.rs|jakarta\.ws\.rs/.test(content)) {
        const eps = parseJAXRSRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('jaxrs');
        }
      }
    } catch (error) {
      logger.debug(`Failed to parse possible Java route file: ${f}`, { error });
    }
  }

  // Go frameworks: Gin, Echo, Fiber, Chi
  for (const f of goFiles.filter((f) => /routes?|handlers?|api/.test(f) || !/test/.test(f)).slice(0, 200)) {
    try {
      const content = await readFile(path.join(cwd, f), 'utf-8');

      // Gin
      if (/github\.com\/gin-gonic\/gin/.test(content) || /router\.(GET|POST|PUT|DELETE)/.test(content)) {
        const eps = parseGinRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('gin');
        }
      }

      // Echo
      if (/github\.com\/labstack\/echo/.test(content) || /e\.(GET|POST|PUT|DELETE)/.test(content)) {
        const eps = parseEchoRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('echo');
        }
      }

      // Fiber
      if (/github\.com\/gofiber\/fiber/.test(content) || /app\.(Get|Post|Put|Delete)/.test(content)) {
        const eps = parseFiberRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('fiber');
        }
      }

      // Chi
      if (/github\.com\/go-chi\/chi/.test(content) || /r\.(Get|Post|Put|Delete)/.test(content)) {
        const eps = parseChiRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('chi');
        }
      }
    } catch (error) {
      logger.debug(`Failed to parse possible Go route file: ${f}`, { error });
    }
  }

  // Rust frameworks: Actix-web, Rocket, Axum
  for (const f of rsFiles.filter((f) => /routes?|handlers?|api|main/.test(f) || !/test/.test(f)).slice(0, 200)) {
    try {
      const content = await readFile(path.join(cwd, f), 'utf-8');

      // Actix-web
      if (/actix_web/.test(content) || /\.route\(/.test(content)) {
        const eps = parseActixRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('actix');
        }
      }

      // Rocket
      if (/rocket/.test(content) || /#\[(get|post|put|delete)/.test(content)) {
        const eps = parseRocketRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('rocket');
        }
      }

      // Axum
      if (/axum/.test(content) || /Router::new/.test(content)) {
        const eps = parseAxumRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('axum');
        }
      }
    } catch (error) {
      logger.debug(`Failed to parse possible Rust route file: ${f}`, { error });
    }
  }

  // C# frameworks: ASP.NET Core
  for (const f of csFiles.filter((f) => /controller|Controller/.test(f)).slice(0, 200)) {
    try {
      const content = await readFile(path.join(cwd, f), 'utf-8');
      if (/\[ApiController\]|class\s+\w+Controller/.test(content)) {
        const eps = parseAspNetRoutes(content, f);
        if (eps.length > 0) {
          allEndpoints.push(...eps);
          specFiles.push(f);
          sources.add('aspnet');
        }
      }
    } catch (error) {
      logger.debug(`Failed to parse possible C# route file: ${f}`, { error });
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
    } catch {
      // Skip invalid OpenAPI specs
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
    '**/*.{ts,tsx,js,jsx} (Express/NestJS/Koa/Fastify/Hapi routes)',
    '**/*.py (FastAPI/Flask/Django REST Framework routes)',
    '**/*.rb (Rails routes.rb, Sinatra routes)',
    '**/*.php (Laravel Route::get/post/resource)',
    '**/*.java (Spring Boot @RequestMapping, JAX-RS @Path)',
    '**/*.go (Gin/Echo/Fiber/Chi routes)',
    '**/*.rs (Actix-web/Rocket/Axum routes)',
    '**/*.cs (ASP.NET Core [ApiController])',
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
