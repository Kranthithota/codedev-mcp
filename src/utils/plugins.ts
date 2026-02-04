/**
 * Plugin architecture for codedev-mcp.
 * Users extend the server with custom analyzers without forking.
 *
 * Plugin locations (in priority order):
 *   1. ./.codedev-mcp/plugins/           (project-local)
 *   2. ~/.codedev-mcp/plugins/           (user-global)
 *   3. npm packages: codedev-plugin-*    (marketplace)
 *
 * Plugin format:
 *   Each plugin is a directory with a plugin.json manifest and an index.js entry point.
 *   npm marketplace plugins follow the same format but are installed via npm.
 */

import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  tools?: PluginToolDef[];
  patterns?: PluginPatternDef[];
  languages?: PluginLanguageDef[];
}

export interface PluginToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface PluginPatternDef {
  name: string;
  pattern: string;
  severity: string;
  description: string;
  recommendation: string;
}

export interface PluginLanguageDef {
  name: string;
  extensions: string[];
  commentSingle?: string;
  commentMultiStart?: string;
  commentMultiEnd?: string;
  functionPatterns?: string[];
  classPatterns?: string[];
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  pluginPath: string;
  module?: any;
}

/**
 * Discover and load plugins from standard locations + npm marketplace.
 * @param cwd
 */
export async function loadPlugins(cwd: string): Promise<LoadedPlugin[]> {
  const plugins: LoadedPlugin[] = [];

  // 1. Local and global plugin directories
  const pluginDirs = [
    path.join(cwd, '.codedev-mcp', 'plugins'),
    path.join(process.env.HOME || '', '.codedev-mcp', 'plugins'),
  ];

  for (const dir of pluginDirs) {
    try {
      await access(dir);
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pluginPath = path.join(dir, entry.name);
        const manifestPath = path.join(pluginPath, 'plugin.json');

        try {
          const manifestContent = await readFile(manifestPath, 'utf-8');
          const manifest: PluginManifest = JSON.parse(manifestContent);

          // Validate manifest
          if (!manifest.name || !manifest.version) {
            logger.error(`Plugin ${entry.name}: Invalid manifest (missing name or version)`);
            continue;
          }

          // Try loading the module
          let module: any;
          const entryPoint = path.join(pluginPath, 'index.js');
          try {
            await access(entryPoint);
            module = await import(entryPoint);
          } catch {
            // Plugin might not have code (pattern-only or language-only plugins)
          }

          plugins.push({ manifest, pluginPath, module });
        } catch {
          // Skip directories without valid plugin.json
        }
      }
    } catch {
      // Plugin directory doesn't exist
    }
  }

  // 2. npm marketplace: auto-discover codedev-plugin-* packages
  const npmPlugins = await discoverNpmPlugins(cwd);
  plugins.push(...npmPlugins);

  return plugins;
}

/**
 * Discover npm packages matching the `codedev-plugin-*` naming convention.
 * Searches node_modules in the project and globally.
 * @param cwd
 */
async function discoverNpmPlugins(cwd: string): Promise<LoadedPlugin[]> {
  const plugins: LoadedPlugin[] = [];
  const PREFIX = 'codedev-plugin-';

  const searchDirs = [
    path.join(cwd, 'node_modules'),
    path.join(process.env.HOME || '', '.codedev-mcp', 'node_modules'),
  ];

  // Also check global node_modules
  const globalPrefix = process.env.npm_config_prefix || '/usr/local';
  searchDirs.push(path.join(globalPrefix, 'lib', 'node_modules'));

  for (const nodeModulesDir of searchDirs) {
    try {
      await access(nodeModulesDir);
      const entries = await readdir(nodeModulesDir, { withFileTypes: true });

      for (const entry of entries) {
        // Match codedev-plugin-* or @scope/codedev-plugin-*
        if (entry.isDirectory() && entry.name.startsWith(PREFIX)) {
          const plugin = await loadNpmPlugin(path.join(nodeModulesDir, entry.name));
          if (plugin) plugins.push(plugin);
        }
        // Check scoped packages (@scope/codedev-plugin-*)
        if (entry.isDirectory() && entry.name.startsWith('@')) {
          try {
            const scopedEntries = await readdir(path.join(nodeModulesDir, entry.name), { withFileTypes: true });
            for (const scopedEntry of scopedEntries) {
              if (scopedEntry.isDirectory() && scopedEntry.name.startsWith(PREFIX)) {
                const plugin = await loadNpmPlugin(path.join(nodeModulesDir, entry.name, scopedEntry.name));
                if (plugin) plugins.push(plugin);
              }
            }
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* node_modules doesn't exist */
    }
  }

  return plugins;
}

/**
 * Load a single npm marketplace plugin from its package directory.
 * @param pkgDir
 */
async function loadNpmPlugin(pkgDir: string): Promise<LoadedPlugin | null> {
  try {
    // Try plugin.json first (codedev-mcp native format)
    const manifestPath = path.join(pkgDir, 'plugin.json');
    let manifest: PluginManifest;

    try {
      const content = await readFile(manifestPath, 'utf-8');
      manifest = JSON.parse(content);
    } catch {
      // Fallback: read package.json and extract codedev config
      const pkgJsonPath = path.join(pkgDir, 'package.json');
      const pkgContent = await readFile(pkgJsonPath, 'utf-8');
      const pkgJson = JSON.parse(pkgContent);

      // Plugin must have a "codedev" key in package.json
      if (!pkgJson.codedev) return null;

      manifest = {
        name: pkgJson.name,
        version: pkgJson.version,
        description: pkgJson.description || '',
        author: pkgJson.author,
        tools: pkgJson.codedev.tools,
        patterns: pkgJson.codedev.patterns,
        languages: pkgJson.codedev.languages,
      };
    }

    if (!manifest.name || !manifest.version) return null;

    // Try loading the module
    let module: any;
    try {
      const entryPoint = path.join(pkgDir, 'index.js');
      await access(entryPoint);
      module = await import(entryPoint);
    } catch {
      // Try package.json main field
      try {
        const pkgContent = await readFile(path.join(pkgDir, 'package.json'), 'utf-8');
        const pkgJson = JSON.parse(pkgContent);
        if (pkgJson.main) {
          module = await import(path.join(pkgDir, pkgJson.main));
        }
      } catch {
        /* no module */
      }
    }

    return { manifest, pluginPath: pkgDir, module };
  } catch {
    return null;
  }
}

/**
 * Get all custom patterns from loaded plugins.
 * @param plugins
 */
export function getPluginPatterns(plugins: LoadedPlugin[]): PluginPatternDef[] {
  return plugins.flatMap((p) => p.manifest.patterns || []);
}

/**
 * Get all custom language definitions from plugins.
 * @param plugins
 */
export function getPluginLanguages(plugins: LoadedPlugin[]): PluginLanguageDef[] {
  return plugins.flatMap((p) => p.manifest.languages || []);
}

/**
 * Get all custom tool definitions from plugins.
 * @param plugins
 */
export function getPluginTools(plugins: LoadedPlugin[]): { plugin: string; tool: PluginToolDef }[] {
  return plugins.flatMap((p) => (p.manifest.tools || []).map((t) => ({ plugin: p.manifest.name, tool: t })));
}

/**
 * Execute a plugin tool handler.
 * @param plugin
 * @param toolName
 * @param params
 * @param context
 * @param context.cwd
 */
export async function executePluginTool(
  plugin: LoadedPlugin,
  toolName: string,
  params: Record<string, any>,
  context: { cwd: string },
): Promise<string> {
  if (!plugin.module?.tools?.[toolName]) {
    throw new Error(`Tool "${toolName}" not found in plugin "${plugin.manifest.name}"`);
  }

  return plugin.module.tools[toolName](params, context);
}

/**
 * Generate a plugin scaffold for users.
 * Produces both plugin.json (native) and package.json (npm marketplace) formats.
 * @param name
 */
export function generatePluginScaffold(name: string): {
  manifest: string;
  packageJson: string;
  indexJs: string;
  readme: string;
} {
  const manifest = JSON.stringify(
    {
      name,
      version: '1.0.0',
      description: `Custom codedev-mcp plugin: ${name}`,
      tools: [
        {
          name: `${name}_analyze`,
          description: `Run ${name} analysis`,
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File or directory to analyze' },
            },
          },
        },
      ],
      patterns: [
        {
          name: `${name}_check`,
          pattern: 'TODO',
          severity: 'info',
          description: `Custom ${name} pattern check`,
          recommendation: 'Review and address this pattern.',
        },
      ],
    },
    null,
    2,
  );

  const packageJson = JSON.stringify(
    {
      name: `codedev-plugin-${name}`,
      version: '1.0.0',
      description: `codedev-mcp marketplace plugin: ${name}`,
      main: 'index.js',
      keywords: ['codedev-mcp', 'mcp', 'code-analysis', 'plugin'],
      codedev: {
        tools: [
          {
            name: `${name}_analyze`,
            description: `Run ${name} analysis`,
            inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
        patterns: [
          {
            name: `${name}_check`,
            pattern: 'TODO',
            severity: 'info',
            description: `Custom ${name} pattern check`,
            recommendation: 'Review and address this pattern.',
          },
        ],
      },
    },
    null,
    2,
  );

  const indexJs = `
// ${name} plugin for codedev-mcp
// Exports tool handlers that the server will call

export const tools = {
  async ${name}_analyze(params, context) {
    const { cwd } = context;
    const targetPath = params.path || cwd;

    // Your custom analysis logic here
    return \`${name} analysis complete for \${targetPath}\`;
  },
};
`.trim();

  const readme = `# codedev-plugin-${name}

Custom plugin for codedev-mcp.

## Installation

### npm marketplace (recommended)
\`\`\`bash
npm install -g codedev-plugin-${name}
\`\`\`

### Manual
1. Copy this folder to \`~/.codedev-mcp/plugins/${name}/\`
2. Restart codedev-mcp

## Tools
- \`${name}_analyze\`: Run custom analysis

## Patterns
- \`${name}_check\`: Custom pattern detection

## Publishing
\`\`\`bash
npm publish
\`\`\`
The \`codedev-plugin-\` prefix is automatically discovered by codedev-mcp.
`;

  return { manifest, packageJson, indexJs, readme };
}
