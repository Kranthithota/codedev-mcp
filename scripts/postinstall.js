#!/usr/bin/env node

/**
 * Postinstall script to help users configure codedev-mcp
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));

console.log('\n✨ codedev-mcp installed successfully!\n');
console.log('📝 Next step: Add to your MCP configuration file:\n');

console.log('For Cursor (~/.cursor/mcp.json or .cursor/mcp.json):');
console.log(JSON.stringify({
  mcpServers: {
    codedev: {
      command: 'npx',
      args: ['-y', 'codedev-mcp'],
    },
  },
}, null, 2));

console.log('\nFor Claude Desktop (claude_desktop_config.json):');
console.log(JSON.stringify({
  mcpServers: {
    codedev: {
      command: 'npx',
      args: ['-y', 'codedev-mcp'],
    },
  },
}, null, 2));

console.log('\n💡 Tip: Using `npx` works for both local and global installations.');
console.log('📚 Full documentation: https://github.com/Kranthithota/codedev-mcp\n');
