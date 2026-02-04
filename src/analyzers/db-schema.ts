/**
 * Database Schema Analysis
 * Parses SQL migrations, Prisma schemas, Drizzle definitions,
 * SQLAlchemy models, TypeORM entities, and Sequelize models.
 */

import { listFiles, searchCode } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface DBColumn {
  name: string;
  type: string;
  nullable?: boolean;
  primary?: boolean;
  unique?: boolean;
  default?: string;
  references?: string; // FK target
}

export interface DBTable {
  name: string;
  columns: DBColumn[];
  indexes?: string[];
  source: string; // file where defined
  orm?: string;
}

export interface DBSchemaResult {
  tables: DBTable[];
  relationships: { from: string; to: string; type: 'one-to-one' | 'one-to-many' | 'many-to-many'; through?: string }[];
  migrations: { file: string; timestamp?: string; description?: string }[];
  summary: { totalTables: number; totalColumns: number; totalRelationships: number; orms: string[] };
  scannedPatterns: string[];
}

function parseSQLCreateTable(sql: string, file: string): DBTable[] {
  const tables: DBTable[] = [];
  const createMatches = sql.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?\s*\(([\s\S]*?)\)\s*;/gi,
  );

  for (const match of createMatches) {
    const tableName = match[1];
    const columnsBlock = match[2];
    const columns: DBColumn[] = [];

    for (const line of columnsBlock.split('\n')) {
      const trimmed = line.trim().replace(/,$/, '');
      if (!trimmed || /^(PRIMARY|UNIQUE|INDEX|KEY|CONSTRAINT|CHECK|FOREIGN)/i.test(trimmed)) continue;

      const colMatch = trimmed.match(/^[`"']?(\w+)[`"']?\s+(\w+(?:\([^)]+\))?)/i);
      if (colMatch) {
        const col: DBColumn = { name: colMatch[1], type: colMatch[2] };
        if (/NOT\s+NULL/i.test(trimmed)) col.nullable = false;
        if (/\bNULL\b/i.test(trimmed) && !/NOT\s+NULL/i.test(trimmed)) col.nullable = true;
        if (/PRIMARY\s+KEY/i.test(trimmed)) col.primary = true;
        if (/UNIQUE/i.test(trimmed)) col.unique = true;
        if (/DEFAULT\s+(.+?)(?:,|$)/i.test(trimmed)) col.default = trimmed.match(/DEFAULT\s+(.+?)(?:,|$)/i)?.[1];
        if (/REFERENCES\s+[`"']?(\w+)/i.test(trimmed)) col.references = trimmed.match(/REFERENCES\s+[`"']?(\w+)/i)?.[1];
        columns.push(col);
      }
    }
    tables.push({ name: tableName, columns, source: file, orm: 'sql' });
  }
  return tables;
}

function parsePrismaSchema(content: string, file: string): DBTable[] {
  const tables: DBTable[] = [];
  const modelMatches = content.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\}/g);

  for (const match of modelMatches) {
    const tableName = match[1];
    const body = match[2];
    const columns: DBColumn[] = [];

    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;

      const fieldMatch = trimmed.match(/^(\w+)\s+(\w+)(\?|\[\])?/);
      if (fieldMatch) {
        const col: DBColumn = {
          name: fieldMatch[1],
          type: fieldMatch[2] + (fieldMatch[3] || ''),
          nullable: fieldMatch[3] === '?',
        };
        if (/@id/.test(trimmed)) col.primary = true;
        if (/@unique/.test(trimmed)) col.unique = true;
        if (/@default\((.+?)\)/.test(trimmed)) col.default = trimmed.match(/@default\((.+?)\)/)?.[1];
        if (/@relation/.test(trimmed)) {
          const refMatch = trimmed.match(/references:\s*\[(\w+)\]/);
          if (refMatch) col.references = fieldMatch[2];
        }
        columns.push(col);
      }
    }
    tables.push({ name: tableName, columns, source: file, orm: 'prisma' });
  }
  return tables;
}

function parseDrizzleSchema(content: string, file: string): DBTable[] {
  const tables: DBTable[] = [];
  const tableMatches = content.matchAll(
    /(?:export\s+const\s+)?(\w+)\s*=\s*(?:pg|mysql|sqlite)Table\s*\(\s*['"](\w+)['"]\s*,\s*\{([\s\S]*?)\}\s*\)/g,
  );

  for (const match of tableMatches) {
    const varName = match[1];
    const tableName = match[2];
    const body = match[3];
    const columns: DBColumn[] = [];

    const colMatches = body.matchAll(/(\w+)\s*:\s*(\w+)\s*\(\s*['"]?(\w+)['"]?\s*\)/g);
    for (const col of colMatches) {
      const column: DBColumn = { name: col[3] || col[1], type: col[2] };
      const fullLine = body.slice(body.indexOf(col[0]));
      if (/\.primaryKey\(\)/.test(fullLine)) column.primary = true;
      if (/\.notNull\(\)/.test(fullLine)) column.nullable = false;
      if (/\.unique\(\)/.test(fullLine)) column.unique = true;
      if (/\.references\(\)/.test(fullLine)) column.references = 'foreign_key';
      columns.push(column);
    }
    tables.push({ name: tableName, columns, source: file, orm: 'drizzle' });
  }
  return tables;
}

/**
 *
 * @param cwd
 * @param options
 * @param options.directory
 */
export async function analyzeDBSchema(cwd: string, options?: { directory?: string }): Promise<DBSchemaResult> {
  const dir = path.resolve(cwd, options?.directory || '.');
  const allTables: DBTable[] = [];
  const migrations: DBSchemaResult['migrations'] = [];
  const orms = new Set<string>();

  // 1. SQL migration files
  const sqlGlobs = ['**/*.sql', '**/migrations/**/*.sql', '**/migrate/**/*.sql'];
  for (const glob of sqlGlobs) {
    const files = await listFiles(dir, { glob }).catch(() => [] as string[]);
    for (const file of files.slice(0, 100)) {
      try {
        const content = await readFile(path.resolve(dir, file), 'utf-8');
        const tables = parseSQLCreateTable(content, file);
        allTables.push(...tables);
        if (tables.length > 0) orms.add('sql');
        // Track as migration
        const tsMatch = file.match(/(\d{10,14})/);
        migrations.push({ file, timestamp: tsMatch?.[1], description: path.basename(file) });
      } catch {
        /* skip */
      }
    }
  }

  // 2. Prisma schema
  const prismaFiles = await listFiles(dir, { glob: '**/schema.prisma' }).catch(() => [] as string[]);
  for (const file of prismaFiles) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');
      const tables = parsePrismaSchema(content, file);
      allTables.push(...tables);
      if (tables.length > 0) orms.add('prisma');
    } catch {
      /* skip */
    }
  }

  // 3. Drizzle schemas
  const drizzleFiles = await listFiles(dir, { glob: '**/schema.{ts,js}' }).catch(() => [] as string[]);
  for (const file of drizzleFiles) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');
      if (/pgTable|mysqlTable|sqliteTable/.test(content)) {
        const tables = parseDrizzleSchema(content, file);
        allTables.push(...tables);
        if (tables.length > 0) orms.add('drizzle');
      }
    } catch {
      /* skip */
    }
  }

  // 4. TypeORM / Sequelize entities (basic detection)
  const entityFiles = await listFiles(dir, { glob: '**/*.entity.{ts,js}' }).catch(() => [] as string[]);
  const modelFiles = await listFiles(dir, { glob: '**/models/**/*.{ts,js}' }).catch(() => [] as string[]);
  for (const file of [...entityFiles, ...modelFiles].slice(0, 100)) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');
      if (/@Entity/.test(content) || /sequelize/.test(content)) {
        const classMatch = content.match(/class\s+(\w+)/);
        if (classMatch) {
          const columns: DBColumn[] = [];
          const colMatches = content.matchAll(
            /@Column\s*\(?\s*(?:\{[^}]*type:\s*['"]?(\w+)['"]?)?[^)]*\)?\s*\n?\s*(\w+)/g,
          );
          for (const col of colMatches) {
            columns.push({ name: col[2], type: col[1] || 'unknown' });
          }
          allTables.push({
            name: classMatch[1],
            columns,
            source: file,
            orm: /@Entity/.test(content) ? 'typeorm' : 'sequelize',
          });
          orms.add(/@Entity/.test(content) ? 'typeorm' : 'sequelize');
        }
      }
    } catch {
      /* skip */
    }
  }

  // Detect relationships from foreign keys / references
  const relationships: DBSchemaResult['relationships'] = [];
  for (const table of allTables) {
    for (const col of table.columns) {
      if (col.references) {
        relationships.push({ from: table.name, to: col.references, type: 'one-to-many' });
      }
    }
  }

  // Detect many-to-many join tables
  for (const table of allTables) {
    const fkCols = table.columns.filter((c) => c.references);
    if (fkCols.length >= 2 && table.columns.length <= fkCols.length + 2) {
      relationships.push({
        from: fkCols[0].references!,
        to: fkCols[1].references!,
        type: 'many-to-many',
        through: table.name,
      });
    }
  }

  const totalColumns = allTables.reduce((sum, t) => sum + t.columns.length, 0);

  const scannedPatterns = [
    '**/*.sql',
    '**/migrations/**/*.sql',
    '**/migrate/**/*.sql',
    '**/schema.prisma',
    '**/schema.{ts,js} (Drizzle)',
    '**/*.entity.{ts,js} (TypeORM)',
    '**/models/**/*.{ts,js} (Sequelize)',
  ];

  return {
    tables: allTables,
    relationships,
    migrations: migrations.slice(0, 50),
    summary: {
      totalTables: allTables.length,
      totalColumns,
      totalRelationships: relationships.length,
      orms: [...orms],
    },
    scannedPatterns,
  };
}
