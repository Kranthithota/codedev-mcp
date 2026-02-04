/**
 * Code Generation Templates / Scaffolding
 * Generates boilerplate code from symbol signatures.
 * Supports: React components, Express routes, test files, API handlers,
 * class stubs, and module scaffolds based on project conventions.
 */

import { listFiles } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface ScaffoldTemplate {
  name: string;
  description: string;
  language: string;
  category: 'component' | 'route' | 'test' | 'model' | 'service' | 'util' | 'hook';
}

export interface ScaffoldResult {
  template: string;
  generatedCode: string;
  fileName: string;
  language: string;
  /** Detected project conventions applied */
  conventions: string[];
}

export interface ConventionResult {
  templates: ScaffoldTemplate[];
  detectedPatterns: string[];
  projectType: string;
}

/**
 * Detect project conventions from existing files.
 * @param cwd - The working directory
 * @returns Detected project type and convention patterns
 */
async function detectConventions(cwd: string): Promise<{ projectType: string; patterns: string[] }> {
  const patterns: string[] = [];
  let projectType = 'generic';

  try {
    const pkgContent = await readFile(path.join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgContent);
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

    if (allDeps.react || allDeps['react-dom']) {
      projectType = allDeps.next ? 'nextjs' : 'react';
      patterns.push('React project detected');
    }
    if (allDeps.express) {
      projectType = projectType === 'generic' ? 'express' : projectType;
      patterns.push('Express backend');
    }
    if (allDeps['@nestjs/core']) {
      projectType = 'nestjs';
      patterns.push('NestJS project');
    }
    if (allDeps.vue) {
      projectType = 'vue';
      patterns.push('Vue project');
    }
    if (allDeps.vitest) patterns.push('Vitest testing');
    if (allDeps.jest) patterns.push('Jest testing');
    if (allDeps.mocha) patterns.push('Mocha testing');
    if (allDeps.cypress) patterns.push('Cypress E2E testing');
    if (allDeps.playwright) patterns.push('Playwright testing');
    if (allDeps.typescript) patterns.push('TypeScript');
    if (allDeps.tailwindcss) patterns.push('Tailwind CSS');
    if (allDeps['@emotion/react'] || allDeps['styled-components']) patterns.push('CSS-in-JS');
    if (allDeps.prisma || allDeps['@prisma/client']) patterns.push('Prisma ORM');
    if (allDeps['drizzle-orm']) patterns.push('Drizzle ORM');
    if (allDeps.typeorm) patterns.push('TypeORM');
    if (allDeps.sequelize) patterns.push('Sequelize');
    if (allDeps.zod) patterns.push('Zod validation');
    if (allDeps.yup) patterns.push('Yup validation');
    if (allDeps['class-validator']) patterns.push('Class Validator');
    if (allDeps.next) patterns.push('Next.js framework');
    if (allDeps.nuxt || allDeps['@nuxt/core']) patterns.push('Nuxt.js framework');
    if (allDeps.sveltekit || allDeps['@sveltejs/kit']) patterns.push('SvelteKit framework');
    if (allDeps.remix || allDeps['@remix-run/node']) patterns.push('Remix framework');
    if (allDeps['@nestjs/core']) patterns.push('NestJS framework');
    if (allDeps.fastify) patterns.push('Fastify framework');
    if (allDeps.koa) patterns.push('Koa framework');
    if (allDeps.hapi) patterns.push('Hapi framework');
    if (allDeps.graphql || allDeps['apollo-server']) patterns.push('GraphQL');
    if (allDeps['@trpc/server']) patterns.push('tRPC');
    if (allDeps.redux || allDeps['@reduxjs/toolkit']) patterns.push('Redux state management');
    if (allDeps.mobx) patterns.push('MobX state management');
    if (allDeps.zustand) patterns.push('Zustand state management');
    if (allDeps.recoil) patterns.push('Recoil state management');
    if (allDeps['react-query'] || allDeps['@tanstack/react-query']) patterns.push('React Query');
    if (allDeps.swr) patterns.push('SWR data fetching');
    if (allDeps.i18next) patterns.push('i18next internationalization');
    if (allDeps['react-i18next']) patterns.push('React i18n');
    if (allDeps['next-intl']) patterns.push('Next.js i18n');
    if (allDeps.sentry) patterns.push('Sentry error tracking');
    if (allDeps['@sentry/react']) patterns.push('Sentry React integration');
    if (allDeps.winston) patterns.push('Winston logging');
    if (allDeps.pino) patterns.push('Pino logging');
    if (allDeps.morgan) patterns.push('Morgan HTTP logging');
    if (allDeps.helmet) patterns.push('Helmet security headers');
    if (allDeps.cors) patterns.push('CORS middleware');
    if (allDeps['express-rate-limit']) patterns.push('Rate limiting');
    if (allDeps.bcrypt || allDeps['bcryptjs']) patterns.push('Bcrypt password hashing');
    if (allDeps.jsonwebtoken || allDeps['@auth/core']) patterns.push('JWT authentication');
    if (allDeps.passport) patterns.push('Passport authentication');
    if (allDeps['next-auth'] || allDeps['@auth/core']) patterns.push('NextAuth.js');
    if (allDeps['@clerk/clerk-sdk-node']) patterns.push('Clerk authentication');
    if (allDeps['@supabase/supabase-js']) patterns.push('Supabase');
    if (allDeps.firebase || allDeps['firebase-admin']) patterns.push('Firebase');
    if (allDeps['aws-sdk'] || allDeps['@aws-sdk/client-s3']) patterns.push('AWS SDK');
    if (allDeps['@google-cloud/storage']) patterns.push('Google Cloud');
    if (allDeps.stripe) patterns.push('Stripe payments');
    if (allDeps['@sendgrid/mail'] || allDeps.nodemailer) patterns.push('Email service');
    if (allDeps['socket.io']) patterns.push('Socket.io WebSockets');
    if (allDeps.ws) patterns.push('WebSocket support');
    if (allDeps['@apollo/client']) patterns.push('Apollo Client');
    if (allDeps['react-relay']) patterns.push('React Relay');
    if (allDeps['react-router'] || allDeps['@remix-run/react']) patterns.push('React Router');
    if (allDeps['@tanstack/react-router']) patterns.push('TanStack Router');
    if (allDeps['react-hook-form']) patterns.push('React Hook Form');
    if (allDeps.formik) patterns.push('Formik forms');
    if (allDeps['@headlessui/react']) patterns.push('Headless UI');
    if (allDeps['@radix-ui/react-dialog']) patterns.push('Radix UI');
    if (allDeps['@mui/material']) patterns.push('Material-UI');
    if (allDeps['@chakra-ui/react']) patterns.push('Chakra UI');
    if (allDeps['antd']) patterns.push('Ant Design');
    if (allDeps['react-bootstrap']) patterns.push('React Bootstrap');
    if (allDeps['framer-motion']) patterns.push('Framer Motion animations');
    if (allDeps['react-spring']) patterns.push('React Spring animations');
    if (allDeps['date-fns'] || allDeps.moment || allDeps.dayjs) patterns.push('Date manipulation library');
    if (allDeps.lodash || allDeps['lodash-es']) patterns.push('Lodash utilities');
    if (allDeps.ramda) patterns.push('Ramda functional utilities');
    if (allDeps.axios) patterns.push('Axios HTTP client');
    if (allDeps['node-fetch']) patterns.push('Fetch API');
    if (allDeps['@tanstack/react-table']) patterns.push('TanStack Table');
    if (allDeps['ag-grid-react']) patterns.push('AG Grid');
    if (allDeps['react-window'] || allDeps['react-virtualized']) patterns.push('Virtual scrolling');
    if (allDeps['react-dnd'] || allDeps['@dnd-kit/core']) patterns.push('Drag and drop');
    if (allDeps['react-beautiful-dnd']) patterns.push('Beautiful DnD');
    if (allDeps['react-select']) patterns.push('React Select');
    if (allDeps['react-datepicker']) patterns.push('React DatePicker');
    if (allDeps['recharts'] || allDeps['@nivo/core']) patterns.push('Charting library');
    if (allDeps['d3']) patterns.push('D3.js data visualization');
    if (allDeps['three'] || allDeps['@react-three/fiber']) patterns.push('Three.js 3D graphics');
    if (allDeps['@monaco-editor/react']) patterns.push('Monaco Editor');
    if (allDeps['react-markdown']) patterns.push('Markdown rendering');
    if (allDeps['remark'] || allDeps['rehype']) patterns.push('Markdown processing');
    if (allDeps['gray-matter']) patterns.push('Front matter parsing');
    if (allDeps['sharp']) patterns.push('Sharp image processing');
    if (allDeps['jimp']) patterns.push('Jimp image manipulation');
    if (allDeps['pdf-lib']) patterns.push('PDF generation');
    if (allDeps['puppeteer'] || allDeps['playwright']) patterns.push('Browser automation');
    if (allDeps['cheerio']) patterns.push('Cheerio HTML parsing');
    if (allDeps['jsdom']) patterns.push('jsdom DOM simulation');
    if (allDeps['csv-parse'] || allDeps['papaparse']) patterns.push('CSV parsing');
    if (allDeps['exceljs']) patterns.push('Excel file handling');
    if (allDeps['multer']) patterns.push('Multer file upload');
    if (allDeps['formidable']) patterns.push('Formidable form parsing');
    if (allDeps['compression']) patterns.push('Compression middleware');
    if (allDeps['express-validator']) patterns.push('Express Validator');
    if (allDeps['joi']) patterns.push('Joi validation');
    if (allDeps['ajv']) patterns.push('Ajv JSON schema validation');
    if (allDeps['class-transformer']) patterns.push('Class Transformer');
    if (allDeps['reflect-metadata']) patterns.push('Reflect Metadata');
    if (allDeps['tsyringe'] || allDeps['inversify']) patterns.push('Dependency injection');
    if (allDeps['rxjs']) patterns.push('RxJS reactive programming');
    if (allDeps['eventemitter3']) patterns.push('Event Emitter');
    if (allDeps['bull'] || allDeps['bullmq']) patterns.push('Bull job queue');
    if (allDeps['agenda']) patterns.push('Agenda job scheduling');
    if (allDeps['node-cron']) patterns.push('Cron job scheduling');
    if (allDeps['ioredis'] || allDeps.redis) patterns.push('Redis client');
    if (allDeps['mongoose']) patterns.push('Mongoose MongoDB ODM');
    if (allDeps['typegoose']) patterns.push('Typegoose MongoDB ODM');
    if (allDeps['@elastic/elasticsearch']) patterns.push('Elasticsearch client');
    if (allDeps['@opensearch-project/opensearch']) patterns.push('OpenSearch client');
    if (allDeps['@prisma/client']) patterns.push('Prisma Client');
    if (allDeps['pg'] || allDeps['mysql2'] || allDeps['sqlite3']) patterns.push('SQL database driver');
    if (allDeps['@databases/pg'] || allDeps['@databases/mysql']) patterns.push('@databases SQL client');
    if (allDeps['better-sqlite3']) patterns.push('Better SQLite3');
    if (allDeps['sql.js']) patterns.push('SQL.js WASM SQLite');
    if (allDeps['@aws-sdk/client-dynamodb']) patterns.push('AWS DynamoDB');
    if (allDeps['@google-cloud/firestore']) patterns.push('Google Firestore');
    if (allDeps['@azure/cosmos']) patterns.push('Azure Cosmos DB');
    if (allDeps['@sanity/client']) patterns.push('Sanity CMS');
    if (allDeps['contentful']) patterns.push('Contentful CMS');
    if (allDeps['strapi']) patterns.push('Strapi CMS');
    if (allDeps['ghost-sdk']) patterns.push('Ghost CMS');
    if (allDeps['@storybook/react']) patterns.push('Storybook component development');
    if (allDeps['@testing-library/react']) patterns.push('React Testing Library');
    if (allDeps['@testing-library/jest-dom']) patterns.push('Jest DOM matchers');
    if (allDeps['@testing-library/user-event']) patterns.push('User Event testing');
    if (allDeps['msw']) patterns.push('Mock Service Worker');
    if (allDeps['nock']) patterns.push('Nock HTTP mocking');
    if (allDeps['sinon']) patterns.push('Sinon mocking/spying');
    if (allDeps['@faker-js/faker']) patterns.push('Faker test data');
    if (allDeps['factory-girl'] || allDeps['@faker-js/faker']) patterns.push('Test data factories');
    if (allDeps['eslint']) patterns.push('ESLint linting');
    if (allDeps['prettier']) patterns.push('Prettier formatting');
    if (allDeps['husky']) patterns.push('Husky git hooks');
    if (allDeps['lint-staged']) patterns.push('Lint-staged pre-commit');
    if (allDeps['commitlint']) patterns.push('Commitlint commit messages');
    if (allDeps['@commitlint/cli']) patterns.push('Commitlint CLI');
    if (allDeps['semantic-release']) patterns.push('Semantic Release');
    if (allDeps['@semantic-release/changelog']) patterns.push('Semantic Release Changelog');
    if (allDeps['@semantic-release/git']) patterns.push('Semantic Release Git');
    if (allDeps['@semantic-release/npm']) patterns.push('Semantic Release NPM');
    if (allDeps['@semantic-release/github']) patterns.push('Semantic Release GitHub');
    if (allDeps['standard-version']) patterns.push('Standard Version');
    if (allDeps['conventional-changelog']) patterns.push('Conventional Changelog');
    if (allDeps['@changesets/cli']) patterns.push('Changesets versioning');
    if (allDeps['lerna']) patterns.push('Lerna monorepo');
    if (allDeps['nx']) patterns.push('Nx monorepo');
    if (allDeps['turborepo']) patterns.push('Turborepo monorepo');
    if (allDeps['@changesets/cli']) patterns.push('Changesets');
    if (allDeps['pnpm']) patterns.push('pnpm package manager');
    if (allDeps['yarn']) patterns.push('Yarn package manager');
    if (allDeps['npm']) patterns.push('npm package manager');
    if (allDeps['@swc/core'] || allDeps['@swc/cli']) patterns.push('SWC compiler');
    if (allDeps['esbuild']) patterns.push('esbuild bundler');
    if (allDeps['vite']) patterns.push('Vite build tool');
    if (allDeps['webpack']) patterns.push('Webpack bundler');
    if (allDeps['rollup']) patterns.push('Rollup bundler');
    if (allDeps['parcel']) patterns.push('Parcel bundler');
    if (allDeps['@babel/core']) patterns.push('Babel transpiler');
    if (allDeps['ts-node']) patterns.push('ts-node TypeScript execution');
    if (allDeps['tsx']) patterns.push('tsx TypeScript execution');
    if (allDeps['tsup']) patterns.push('tsup TypeScript bundler');
    if (allDeps['@vercel/ncc']) patterns.push('ncc bundler');
    if (allDeps['microbundle']) patterns.push('Microbundle bundler');
    if (allDeps['@rollup/plugin-typescript']) patterns.push('Rollup TypeScript plugin');
    if (allDeps['@rollup/plugin-node-resolve']) patterns.push('Rollup Node resolve plugin');
    if (allDeps['@rollup/plugin-commonjs']) patterns.push('Rollup CommonJS plugin');
    if (allDeps['rollup-plugin-dts']) patterns.push('Rollup DTS plugin');
    if (allDeps['@types/node']) patterns.push('Node.js TypeScript types');
    if (allDeps['@types/react']) patterns.push('React TypeScript types');
    if (allDeps['@types/react-dom']) patterns.push('React DOM TypeScript types');
    if (allDeps['@types/express']) patterns.push('Express TypeScript types');
    if (allDeps['@types/jest']) patterns.push('Jest TypeScript types');
    if (allDeps['@typescript-eslint/parser']) patterns.push('TypeScript ESLint parser');
    if (allDeps['@typescript-eslint/eslint-plugin']) patterns.push('TypeScript ESLint plugin');
    if (allDeps['tsconfig-paths']) patterns.push('TypeScript path mapping');
    if (allDeps['path-alias']) patterns.push('Path alias resolution');
    if (allDeps['module-alias']) patterns.push('Module alias resolution');
    if (allDeps['@rollup/plugin-alias']) patterns.push('Rollup alias plugin');
    if (allDeps['resolve']) patterns.push('Module resolution');
    if (allDeps['enhanced-resolve']) patterns.push('Enhanced module resolution');
    if (allDeps['resolve-from']) patterns.push('Resolve from path');
    if (allDeps['import-from']) patterns.push('Import from path');
    if (allDeps['import-meta-resolve']) patterns.push('Import meta resolve');
    if (allDeps['@swc/helpers']) patterns.push('SWC helpers');
    if (allDeps['regenerator-runtime']) patterns.push('Regenerator runtime');
    if (allDeps['core-js']) patterns.push('Core-js polyfills');
    if (allDeps['@babel/polyfill']) patterns.push('Babel polyfills');
    if (allDeps['@babel/runtime']) patterns.push('Babel runtime');
    if (allDeps['@babel/plugin-transform-runtime']) patterns.push('Babel transform runtime');
    if (allDeps['@babel/preset-env']) patterns.push('Babel preset env');
    if (allDeps['@babel/preset-react']) patterns.push('Babel preset React');
    if (allDeps['@babel/preset-typescript']) patterns.push('Babel preset TypeScript');
    if (allDeps['babel-plugin-styled-components']) patterns.push('Babel styled-components plugin');
    if (allDeps['babel-plugin-module-resolver']) patterns.push('Babel module resolver');
    if (allDeps['babel-plugin-transform-imports']) patterns.push('Babel transform imports');
    if (allDeps['babel-plugin-import']) patterns.push('Babel import plugin');
    if (allDeps['@babel/plugin-proposal-decorators']) patterns.push('Babel decorators plugin');
    if (allDeps['@babel/plugin-proposal-class-properties']) patterns.push('Babel class properties plugin');
    if (allDeps['@babel/plugin-proposal-object-rest-spread']) patterns.push('Babel object rest spread');
    if (allDeps['@babel/plugin-proposal-optional-chaining']) patterns.push('Babel optional chaining');
    if (allDeps['@babel/plugin-proposal-nullish-coalescing-operator']) patterns.push('Babel nullish coalescing');
    if (allDeps['@babel/plugin-syntax-dynamic-import']) patterns.push('Babel dynamic import');
    if (allDeps['@babel/plugin-syntax-import-meta']) patterns.push('Babel import meta');
    if (allDeps['@babel/plugin-transform-modules-commonjs']) patterns.push('Babel CommonJS transform');
    if (allDeps['@babel/plugin-transform-modules-amd']) patterns.push('Babel AMD transform');
    if (allDeps['@babel/plugin-transform-modules-systemjs']) patterns.push('Babel SystemJS transform');
    if (allDeps['@babel/plugin-transform-modules-umd']) patterns.push('Babel UMD transform');
    if (allDeps['@babel/plugin-transform-modules-es2015']) patterns.push('Babel ES2015 modules');
    if (allDeps['@babel/plugin-transform-modules-es6']) patterns.push('Babel ES6 modules');
    if (allDeps['@babel/plugin-transform-strict-mode']) patterns.push('Babel strict mode');
    if (allDeps['@babel/plugin-transform-arrow-functions']) patterns.push('Babel arrow functions');
    if (allDeps['@babel/plugin-transform-classes']) patterns.push('Babel classes');
    if (allDeps['@babel/plugin-transform-computed-properties']) patterns.push('Babel computed properties');
    if (allDeps['@babel/plugin-transform-destructuring']) patterns.push('Babel destructuring');
    if (allDeps['@babel/plugin-transform-for-of']) patterns.push('Babel for-of');
    if (allDeps['@babel/plugin-transform-function-name']) patterns.push('Babel function name');
    if (allDeps['@babel/plugin-transform-literals']) patterns.push('Babel literals');
    if (allDeps['@babel/plugin-transform-object-super']) patterns.push('Babel object super');
    if (allDeps['@babel/plugin-transform-parameters']) patterns.push('Babel parameters');
    if (allDeps['@babel/plugin-transform-shorthand-properties']) patterns.push('Babel shorthand properties');
    if (allDeps['@babel/plugin-transform-spread']) patterns.push('Babel spread');
    if (allDeps['@babel/plugin-transform-template-literals']) patterns.push('Babel template literals');
    if (allDeps['@babel/plugin-transform-exponentiation-operator']) patterns.push('Babel exponentiation');
    if (allDeps['@babel/plugin-transform-async-to-generator']) patterns.push('Babel async to generator');
    if (allDeps['@babel/plugin-transform-regenerator']) patterns.push('Babel regenerator');
    if (allDeps['@babel/plugin-proposal-async-generator-functions']) patterns.push('Babel async generators');
    if (allDeps['@babel/plugin-proposal-function-bind']) patterns.push('Babel function bind');
    if (allDeps['@babel/plugin-proposal-function-sent']) patterns.push('Babel function sent');
    if (allDeps['@babel/plugin-proposal-logical-assignment-operators']) patterns.push('Babel logical assignment');
    if (allDeps['@babel/plugin-proposal-numeric-separator']) patterns.push('Babel numeric separator');
    if (allDeps['@babel/plugin-proposal-optional-catch-binding']) patterns.push('Babel optional catch');
    if (allDeps['@babel/plugin-proposal-pipeline-operator']) patterns.push('Babel pipeline operator');
    if (allDeps['@babel/plugin-proposal-private-methods']) patterns.push('Babel private methods');
    if (allDeps['@babel/plugin-proposal-private-property-in-object']) patterns.push('Babel private property');
    if (allDeps['@babel/plugin-proposal-throw-expressions']) patterns.push('Babel throw expressions');
    if (allDeps['@babel/plugin-proposal-top-level-await']) patterns.push('Babel top-level await');
    if (allDeps['@babel/plugin-proposal-unicode-property-regex']) patterns.push('Babel unicode regex');
    if (allDeps['@babel/plugin-transform-block-scoping']) patterns.push('Babel block scoping');
    if (allDeps['@babel/plugin-transform-new-target']) patterns.push('Babel new target');
    if (allDeps['@babel/plugin-transform-typeof-symbol']) patterns.push('Babel typeof symbol');
    if (allDeps['@babel/plugin-transform-unicode-escapes']) patterns.push('Babel unicode escapes');
    if (allDeps['@babel/plugin-transform-unicode-regex']) patterns.push('Babel unicode regex');
    if (allDeps['@babel/plugin-transform-member-expression-literals']) patterns.push('Babel member literals');
    if (allDeps['@babel/plugin-transform-property-literals']) patterns.push('Babel property literals');
    if (allDeps['@babel/plugin-transform-reserved-words']) patterns.push('Babel reserved words');
    if (allDeps['@babel/plugin-transform-sticky-regex']) patterns.push('Babel sticky regex');
    if (allDeps['@babel/plugin-transform-unicode-escapes']) patterns.push('Babel unicode escapes');
    if (allDeps['@babel/plugin-transform-unicode-regex']) patterns.push('Babel unicode regex');
    if (allDeps['@babel/plugin-transform-unicode-escapes']) patterns.push('Babel unicode escapes');
    if (allDeps['@babel/plugin-transform-unicode-regex']) patterns.push('Babel unicode regex');
  } catch {
    /* no package.json */
  }

  // Check for Python
  try {
    await readFile(path.join(cwd, 'pyproject.toml'), 'utf-8');
    projectType = 'python';
    patterns.push('Python project');
  } catch {
    /* skip */
  }

  try {
    await readFile(path.join(cwd, 'Cargo.toml'), 'utf-8');
    projectType = 'rust';
    patterns.push('Rust project');
  } catch {
    /* skip */
  }

  // Check file naming conventions
  const tsFiles = await listFiles(cwd, { glob: 'src/**/*.{ts,tsx}' });
  const hasPascalCase = tsFiles.some((f) => /[A-Z][a-z]+[A-Z]/.test(path.basename(f, path.extname(f))));
  const hasKebabCase = tsFiles.some((f) => /[a-z]+-[a-z]+/.test(path.basename(f, path.extname(f))));
  if (hasPascalCase) patterns.push('PascalCase file naming');
  if (hasKebabCase) patterns.push('kebab-case file naming');

  return { projectType, patterns };
}

/**
 * Generate a React component scaffold.
 * @param name - Component name
 * @param conventions - Detected project conventions
 * @returns Generated component code
 */
function reactComponent(name: string, conventions: string[]): string {
  const hasTs = conventions.includes('TypeScript');
  const hasTailwind = conventions.includes('Tailwind CSS');

  const propsType = hasTs ? `\ninterface ${name}Props {\n  // TODO: define props\n}\n` : '';
  const propsParam = hasTs ? `{ }: ${name}Props` : '{ }';
  const className = hasTailwind ? ' className="flex items-center gap-2"' : '';

  return `${propsType}
export default function ${name}(${propsParam}) {
  return (
    <div${className}>
      <h2>${name}</h2>
      {/* TODO: implement component */}
    </div>
  );
}
`;
}

/**
 * Generate a test file scaffold.
 * @param name - Module or function name to test
 * @param conventions - Detected project conventions
 * @param targetFile - Path to the file being tested
 * @returns Generated test file code
 */
function testFile(name: string, conventions: string[], targetFile: string): string {
  const isVitest = conventions.includes('Vitest testing');
  const importFrom = isVitest ? 'vitest' : '@jest/globals';

  return `import { describe, it, expect } from '${importFrom}';
import { ${name} } from '${targetFile.replace(/\.(ts|tsx|js|jsx)$/, '')}';

describe('${name}', () => {
  it('should exist', () => {
    expect(${name}).toBeDefined();
  });

  it('should work correctly', () => {
    // TODO: add test cases
    const result = ${name}();
    expect(result).toBeTruthy();
  });

  it('should handle edge cases', () => {
    // TODO: add edge case tests
  });
});
`;
}

/**
 * Generate an Express route scaffold.
 * @param name - Route name
 * @param conventions - Detected project conventions
 * @returns Generated Express route code
 */
function expressRoute(name: string, conventions: string[]): string {
  const hasTs = conventions.includes('TypeScript');
  const hasZod = conventions.includes('Zod validation');
  const types = hasTs ? ': Router' : '';
  const importLine = hasTs
    ? "import { Router, Request, Response } from 'express';\n"
    : "const { Router } = require('express');\n";
  const zodLine = hasZod
    ? "import { z } from 'zod';\n\nconst createSchema = z.object({\n  // TODO: define validation schema\n});\n"
    : '';

  return `${importLine}${zodLine}
const router${types} = Router();

router.get('/${name.toLowerCase()}', async (req${hasTs ? ': Request' : ''}, res${hasTs ? ': Response' : ''}) => {
  try {
    // TODO: implement GET handler
    res.json({ message: 'GET /${name.toLowerCase()}' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/${name.toLowerCase()}', async (req${hasTs ? ': Request' : ''}, res${hasTs ? ': Response' : ''}) => {
  try {
    ${hasZod ? 'const body = createSchema.parse(req.body);\n    ' : ''}// TODO: implement POST handler
    res.status(201).json({ message: 'Created' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
`;
}

/**
 * Generate a service/module scaffold.
 * @param name - Service name
 * @param conventions - Detected project conventions
 * @returns Generated service class code
 */
function serviceModule(name: string, conventions: string[]): string {
  const hasTs = conventions.includes('TypeScript');
  const iface = hasTs ? `\nexport interface ${name}Options {\n  // TODO: define options\n}\n` : '';

  return `${iface}
export class ${name}Service {
  ${hasTs ? 'private initialized = false;\n' : ''}
  constructor(${hasTs ? `options?: ${name}Options` : 'options'}) {
    // TODO: initialize service
  }

  async init()${hasTs ? ': Promise<void>' : ''} {
    // TODO: setup
    this.initialized = true;
  }

  async execute(input${hasTs ? ': unknown' : ''})${hasTs ? ': Promise<unknown>' : ''} {
    if (!this.initialized) throw new Error('${name}Service not initialized');
    // TODO: implement core logic
    return input;
  }

  async dispose()${hasTs ? ': Promise<void>' : ''} {
    // TODO: cleanup resources
  }
}

export function create${name}(${hasTs ? `options?: ${name}Options` : 'options'}) {
  return new ${name}Service(options);
}
`;
}

/**
 * List available scaffold templates based on project conventions.
 * @param cwd - The working directory
 * @returns Available templates, detected patterns, and project type
 */
export async function listTemplates(cwd: string): Promise<ConventionResult> {
  const { projectType, patterns } = await detectConventions(cwd);
  const templates: ScaffoldTemplate[] = [];

  // Universal templates
  templates.push({
    name: 'test',
    description: 'Test file for a module/function',
    language: 'typescript',
    category: 'test',
  });
  templates.push({
    name: 'service',
    description: 'Service class with init/execute/dispose lifecycle',
    language: 'typescript',
    category: 'service',
  });
  templates.push({
    name: 'util',
    description: 'Utility module with exported functions',
    language: 'typescript',
    category: 'util',
  });

  // React templates
  if (['react', 'nextjs', 'vue'].includes(projectType)) {
    templates.push({
      name: 'component',
      description: 'React functional component',
      language: 'tsx',
      category: 'component',
    });
    templates.push({ name: 'hook', description: 'Custom React hook', language: 'typescript', category: 'hook' });
  }

  // Backend templates
  if (['express', 'nestjs'].includes(projectType) || patterns.includes('Express backend')) {
    templates.push({
      name: 'route',
      description: 'Express route with GET/POST handlers',
      language: 'typescript',
      category: 'route',
    });
    templates.push({ name: 'model', description: 'Data model/entity', language: 'typescript', category: 'model' });
  }

  return { templates, detectedPatterns: patterns, projectType };
}

/**
 * Generate scaffold code for a given template and name.
 * @param cwd - The working directory
 * @param options - Scaffold options
 * @param options.template - Template type to generate
 * @param options.name - Name for the generated code
 * @param options.targetFile - Optional target file path
 * @returns Generated scaffold result with code and metadata
 */
export async function generateScaffold(
  cwd: string,
  options: { template: string; name: string; targetFile?: string },
): Promise<ScaffoldResult> {
  const { patterns } = await detectConventions(cwd);
  const { template, name, targetFile } = options;

  let generatedCode: string;
  let fileName: string;
  let language = 'typescript';

  switch (template) {
    case 'component':
      generatedCode = reactComponent(name, patterns);
      fileName = `${name}.tsx`;
      language = 'tsx';
      break;
    case 'test':
      generatedCode = testFile(name, patterns, targetFile || `./${name}`);
      fileName = `${name}.test.ts`;
      break;
    case 'route':
      generatedCode = expressRoute(name, patterns);
      fileName = `${name}.routes.ts`;
      break;
    case 'service':
      generatedCode = serviceModule(name, patterns);
      fileName = `${name}.service.ts`;
      break;
    case 'hook':
      generatedCode = `import { useState, useEffect } from 'react';\n\nexport function use${name}() {\n  const [state, setState] = useState(null);\n\n  useEffect(() => {\n    // TODO: implement hook logic\n  }, []);\n\n  return { state };\n}\n`;
      fileName = `use${name}.ts`;
      break;
    case 'util':
      generatedCode = `/**\n * ${name} utilities\n */\n\nexport function ${name.charAt(0).toLowerCase() + name.slice(1)}() {\n  // TODO: implement\n}\n`;
      fileName = `${name.toLowerCase()}.ts`;
      break;
    default:
      generatedCode = `// Template '${template}' not recognized. Available: component, test, route, service, hook, util`;
      fileName = `${name}.ts`;
  }

  return {
    template,
    generatedCode,
    fileName,
    language,
    conventions: patterns,
  };
}
