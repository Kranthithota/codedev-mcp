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
    if (allDeps.typescript) patterns.push('TypeScript');
    if (allDeps.tailwindcss) patterns.push('Tailwind CSS');
    if (allDeps.prisma || allDeps['@prisma/client']) patterns.push('Prisma ORM');
    if (allDeps.zod) patterns.push('Zod validation');
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
