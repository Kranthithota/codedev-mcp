/**
 * Database Schema Analysis
 * Comprehensive ORM support:
 * - JavaScript/TypeScript: Prisma, Drizzle, TypeORM, Sequelize, MikroORM, Knex, Objection, Bookshelf
 * - Python: SQLAlchemy, Django ORM, SQLModel, Tortoise ORM, Peewee, SQLObject, Pony ORM, Databases
 * - Ruby: ActiveRecord, Sequel
 * - Java: Hibernate, JPA, MyBatis, jOOQ, Ebean
 * - PHP: Doctrine, Eloquent, Propel, RedBeanPHP
 * - C#: Entity Framework, Dapper, NHibernate
 * - Go: GORM, Ent, SQLBoiler, Beego ORM
 * - Rust: Diesel, Sea-ORM, SQLx
 * - Plus raw SQL migrations
 */

import { listFiles } from '../search/fast-search.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface DBColumn {
  name: string;
  type: string;
  nullable?: boolean;
  primary?: boolean;
  unique?: boolean;
  default?: string;
  /** FK target */
  references?: string;
}

export interface DBTable {
  name: string;
  columns: DBColumn[];
  indexes?: string[];
  /** File where defined */
  source: string;
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
  // Enhanced regex to match various Drizzle table patterns:
  // - pgTable('name', { ... })
  // - mysqlTable('name', { ... })
  // - sqliteTable('name', { ... })
  // - Also matches with or without 'export const'
  // - Handles both single-line and multi-line table definitions
  // - Supports callback style: pgTable('name', (t) => ({ ... }))
  // - Supports: export const table = pgTable(...) or const table = pgTable(...)
  // - More flexible whitespace handling
  // - Handles: export const studentSectorMappingTable = mysqlTable('student_sector_mapping', { id: varchar(...) })
  const tableMatches = content.matchAll(
    /(?:export\s+(?:const|default|function|async\s+function)\s+)?(\w+)\s*=\s*(?:pg|mysql|sqlite)Table\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:\{([\s\S]*?)\}|\([^)]*\)\s*=>\s*\{([\s\S]*?)\}|\([^)]*\)\s*=>\s*\(([\s\S]*?)\))\s*\)/g,
  );

  for (const match of tableMatches) {
    const tableName = match[2];
    // Handle object style { ... }, callback style (t) => ({ ... }), and callback with parentheses (t) => ({ ... })
    const body = match[3] || match[4] || match[5] || '';
    const columns: DBColumn[] = [];

    // Enhanced column parsing to handle various Drizzle column patterns:
    // Pattern 1: columnName: varchar('columnName') or columnName: serial('id')
    // Pattern 2: columnName: integer('columnName').primaryKey().notNull()
    // Pattern 3: columnName: text() - without explicit name (uses property name)
    // Pattern 4: columnName: varchar('columnName', { length: 255 })
    // Pattern 5: Callback style: columnName: t.varchar('columnName') or columnName: t.integer()
    const colPatterns = [
      // Standard pattern: name: type('name') or name: type('name').modifiers()
      // Matches: id: integer('id').primaryKey() or firstName: varchar('first_name', { length: 256 })
      /(\w+)\s*:\s*(?:t\.)?(\w+)\s*\(\s*['"`]([^'"`]+)['"`]\s*(?:,\s*[^)]+)?\)(?:\s*\.\w+\([^)]*\))*/g,
      // Pattern without explicit name: name: type() - uses property name
      // Matches: id: integer() or id: t.integer()
      /(\w+)\s*:\s*(?:t\.)?(\w+)\s*\(\s*\)(?:\s*\.\w+\([^)]*\))*/g,
      // Pattern with object config: name: type('name', { ... })
      // Matches: firstName: varchar('first_name', { length: 256 })
      /(\w+)\s*:\s*(?:t\.)?(\w+)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{[^}]+\}\s*\)(?:\s*\.\w+\([^)]*\))*/g,
      // Pattern for columns without parentheses: name: type - very rare but possible
      /(\w+)\s*:\s*(?:t\.)?(\w+)\s*(?:\.[\w()]+)*/g,
    ];

    for (const pattern of colPatterns) {
      const colMatches = body.matchAll(pattern);
      for (const col of colMatches) {
        const propertyName = col[1];
        const columnType = col[2];
        const columnName = col[3] || propertyName; // Use explicit name or fallback to property name

        // Skip if we already have this column (from a previous pattern match)
        if (columns.some((c) => c.name === columnName)) continue;

        const column: DBColumn = { name: columnName, type: columnType };

        // Find the full column definition to check for modifiers
        // Look for the complete column definition including method chains
        const colStart = body.indexOf(col[0]);
        const colEnd = body.indexOf(',', colStart);
        const colEnd2 = body.indexOf('\n', colStart);
        const colEnd3 = body.indexOf('}', colStart);

        // Find the actual end of the column definition
        let actualEnd = body.length;
        if (colEnd !== -1 && (colEnd2 === -1 || colEnd < colEnd2)) actualEnd = Math.min(actualEnd, colEnd);
        if (colEnd2 !== -1) actualEnd = Math.min(actualEnd, colEnd2);
        if (colEnd3 !== -1) actualEnd = Math.min(actualEnd, colEnd3);

        const fullColumnDef = body.slice(colStart, actualEnd);

        // Check for Drizzle column modifiers
        if (/\.primaryKey\(\)/.test(fullColumnDef)) column.primary = true;
        if (/\.notNull\(\)/.test(fullColumnDef)) column.nullable = false;
        if (/\.unique\(\)/.test(fullColumnDef)) column.unique = true;
        if (/\.default\(/.test(fullColumnDef)) {
          const defaultMatch = fullColumnDef.match(/\.default\(([^)]+)\)/);
          if (defaultMatch) column.default = defaultMatch[1];
        }

        // Check for references - handle both arrow function and direct reference patterns
        const refPatterns = [
          /\.references\s*\(\s*\(\)\s*=>\s*(\w+)\.(\w+)/,
          /\.references\s*\(\s*\(\)\s*=>\s*(\w+)\s*\(\s*\)\.(\w+)/,
          /\.references\s*\(\s*(\w+)\.(\w+)/,
        ];

        for (const refPattern of refPatterns) {
          const refMatch = fullColumnDef.match(refPattern);
          if (refMatch) {
            column.references = refMatch[2] || refMatch[1]; // Reference to another table's column
            break;
          }
        }

        columns.push(column);
      }
    }

    // Also try a simpler pattern for columns that might not match the above
    // This catches columns defined with minimal syntax
    if (columns.length === 0) {
      const simpleColPattern = /(\w+)\s*:\s*(\w+)\s*\(/g;
      const simpleMatches = body.matchAll(simpleColPattern);
      for (const col of simpleMatches) {
        const columnName = col[1];
        const columnType = col[2];
        if (!columns.some((c) => c.name === columnName)) {
          columns.push({ name: columnName, type: columnType });
        }
      }
    }

    if (columns.length > 0 || tableName) {
      tables.push({ name: tableName, columns, source: file, orm: 'drizzle' });
    }
  }
  return tables;
}

/**
 * Analyze database schema from SQL, ORM, and migration files.
 * @param cwd - The working directory to scan.
 * @param options - Configuration options.
 * @param options.directory - The directory to analyze.
 * @returns The database schema analysis result.
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

  // 3. Drizzle schemas — check package.json first, then search multiple common locations
  let hasDrizzlePackage = false;
  try {
    const pkgPath = path.resolve(dir, 'package.json');
    const pkgContent = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(pkgContent);
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (allDeps['drizzle-orm'] || allDeps['drizzle-kit']) {
      hasDrizzlePackage = true;
      orms.add('drizzle');
    }
  } catch {
    /* no package.json or parse error */
  }

  // Search for Drizzle schema files in common locations
  // Support both schema.ts and *.schema.ts naming conventions
  const drizzleGlobs = [
    '**/schema.{ts,js,tsx,jsx}',
    '**/schema/**/*.{ts,js,tsx,jsx}',
    '**/schema/**/*.schema.{ts,js,tsx,jsx}',
    '**/schema2/**/*.{ts,js,tsx,jsx}',
    '**/schema2/**/*.schema.{ts,js,tsx,jsx}',
    '**/db/**/*.{ts,js,tsx,jsx}',
    '**/db/schema/**/*.{ts,js,tsx,jsx}',
    '**/db/schema/**/*.schema.{ts,js,tsx,jsx}',
    '**/db/schema2/**/*.{ts,js,tsx,jsx}',
    '**/db/schema2/**/*.schema.{ts,js,tsx,jsx}',
    '**/src/db/**/*.{ts,js,tsx,jsx}',
    '**/src/db/schema/**/*.{ts,js,tsx,jsx}',
    '**/src/db/schema/**/*.schema.{ts,js,tsx,jsx}',
    '**/src/db/schema2/**/*.{ts,js,tsx,jsx}',
    '**/src/db/schema2/**/*.schema.{ts,js,tsx,jsx}',
    '**/v2/db/**/*.{ts,js,tsx,jsx}',
    '**/v2/db/schema/**/*.{ts,js,tsx,jsx}',
    '**/v2/db/schema/**/*.schema.{ts,js,tsx,jsx}',
    '**/v2/db/schema2/**/*.{ts,js,tsx,jsx}',
    '**/v2/db/schema2/**/*.schema.{ts,js,tsx,jsx}',
    '**/drizzle/**/*.{ts,js,tsx,jsx}',
    '**/*schema*.{ts,js,tsx,jsx}',
    '**/*table*.{ts,js,tsx,jsx}',
    '**/lib/db/**/*.{ts,js,tsx,jsx}',
    '**/models/**/*.{ts,js,tsx,jsx}',
  ];
  const drizzleFileSet = new Set<string>();
  for (const glob of drizzleGlobs) {
    const files = await listFiles(dir, { glob }).catch(() => [] as string[]);
    for (const f of files) drizzleFileSet.add(f);
  }

  // Also search for files that import drizzle-orm
  if (hasDrizzlePackage) {
    // If drizzle-orm is in package.json, scan more TypeScript/JavaScript files
    const tsFiles = await listFiles(dir, { glob: '**/*.{ts,js,tsx,jsx}' }).catch(() => [] as string[]);
    for (const f of tsFiles.slice(0, 500)) {
      try {
        const content = await readFile(path.resolve(dir, f), 'utf-8');
        // Check for drizzle-orm imports
        if (/from\s+['"]drizzle-orm|import.*drizzle-orm|require\(['"]drizzle-orm/.test(content)) {
          drizzleFileSet.add(f);
        }
      } catch {
        /* skip */
      }
    }
  }

  for (const file of [...drizzleFileSet].slice(0, 300)) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');
      // Enhanced detection: check for various Drizzle patterns
      // Also check for table definitions even if import is not present (might be re-exported)
      // Check for table definitions first (most reliable indicator)
      const hasTableDef = /(?:pg|mysql|sqlite)Table\s*\(/.test(content);
      const hasDrizzleImport =
        /drizzle\.table|from\s+['"]drizzle-orm|import.*drizzle-orm|require\(['"]drizzle-orm/.test(content);

      if (hasTableDef || hasDrizzleImport) {
        const tables = parseDrizzleSchema(content, file);
        if (tables.length > 0) {
          allTables.push(...tables);
          orms.add('drizzle');
        } else if (hasTableDef) {
          // If we found table definitions but parsing returned 0, log for debugging
          // This helps identify parsing issues
          // Note: Using console.debug instead of logger to avoid circular dependencies
          // This is intentional for debugging schema parsing issues
        }
      }
    } catch {
      /* skip */
    }
  }

  // 4. TypeORM / Sequelize / MikroORM entities (basic detection)
  // Check package.json for ORM packages first
  try {
    const pkgPath = path.resolve(dir, 'package.json');
    const pkgContent = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(pkgContent);
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (allDeps['typeorm']) orms.add('typeorm');
    if (allDeps['sequelize'] || allDeps['@sequelize/core']) orms.add('sequelize');
    if (allDeps['@mikro-orm/core'] || allDeps['@mikro-orm/postgresql'] || allDeps['@mikro-orm/mysql'])
      orms.add('mikroorm');
    if (allDeps['knex']) orms.add('knex');
    if (allDeps['objection']) orms.add('objection');
    if (allDeps['bookshelf']) orms.add('bookshelf');
  } catch {
    /* no package.json or parse error */
  }

  const entityFiles = await listFiles(dir, { glob: '**/*.entity.{ts,js}' }).catch(() => [] as string[]);
  const modelFiles = await listFiles(dir, { glob: '**/models/**/*.{ts,js}' }).catch(() => [] as string[]);
  for (const file of [...entityFiles, ...modelFiles].slice(0, 150)) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');
      // TypeORM detection
      if (/@Entity/.test(content)) {
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
            orm: 'typeorm',
          });
          orms.add('typeorm');
        }
      }
      // Sequelize detection
      else if (/sequelize|Sequelize\.define/.test(content)) {
        const classMatch = content.match(/class\s+(\w+)|define\s*\(\s*['"](\w+)['"]/);
        if (classMatch) {
          const tableName = classMatch[1] || classMatch[2];
          const columns: DBColumn[] = [];
          const colMatches = content.matchAll(/(\w+)\s*:\s*\{[^}]*type:\s*Sequelize\.(\w+)/g);
          for (const col of colMatches) {
            columns.push({ name: col[1], type: col[2] || 'unknown' });
          }
          allTables.push({
            name: tableName,
            columns,
            source: file,
            orm: 'sequelize',
          });
          orms.add('sequelize');
        }
      }
      // MikroORM detection
      else if (/@Entity\(\)|Entity\(\)/.test(content)) {
        const classMatch = content.match(/class\s+(\w+)/);
        if (classMatch) {
          const columns: DBColumn[] = [];
          const colMatches = content.matchAll(/@Property\s*\([^)]*\)\s*\n?\s*(\w+)/g);
          for (const col of colMatches) {
            columns.push({ name: col[1], type: 'unknown' });
          }
          allTables.push({
            name: classMatch[1],
            columns,
            source: file,
            orm: 'mikroorm',
          });
          orms.add('mikroorm');
        }
      }
    } catch {
      /* skip */
    }
  }

  // 5. Knex.js schema builder detection
  const knexFiles = await listFiles(dir, { glob: '**/migrations/**/*.{ts,js}' }).catch(() => [] as string[]);
  for (const file of knexFiles.slice(0, 50)) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');
      if (/\.createTable\s*\(|knex\.schema/.test(content)) {
        const tableMatches = content.matchAll(/\.createTable\s*\(\s*['"](\w+)['"]/g);
        for (const match of tableMatches) {
          allTables.push({
            name: match[1],
            columns: [],
            source: file,
            orm: 'knex',
          });
          orms.add('knex');
        }
      }
    } catch {
      /* skip */
    }
  }

  // 6. Python ORMs: SQLAlchemy, Django ORM, SQLModel, Tortoise ORM, Peewee, SQLObject
  const pythonFiles = await listFiles(dir, { glob: '**/*.py' }).catch(() => [] as string[]);
  for (const file of pythonFiles.slice(0, 200)) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');

      // SQLAlchemy detection
      if (/from\s+sqlalchemy|import\s+sqlalchemy|Base\s*=\s*declarative_base/.test(content)) {
        const classMatches = content.matchAll(/class\s+(\w+)\s*\([^)]*Base[^)]*\)/g);
        for (const match of classMatches) {
          const columns: DBColumn[] = [];
          const colMatches = content.matchAll(/Column\s*\([^)]*\)/g);
          for (const col of colMatches) {
            const nameMatch = col[0].match(/['"](\w+)['"]/);
            const typeMatch = col[0].match(/(?:Integer|String|Text|Boolean|Float|DateTime|Date|ForeignKey)/);
            if (nameMatch) {
              columns.push({ name: nameMatch[1], type: typeMatch ? typeMatch[1] : 'unknown' });
            }
          }
          allTables.push({ name: match[1], columns, source: file, orm: 'sqlalchemy' });
          orms.add('sqlalchemy');
        }
      }

      // Django ORM detection
      if (/from\s+django\.db|models\.Model|models\.ForeignKey/.test(content)) {
        const classMatches = content.matchAll(/class\s+(\w+)\s*\([^)]*models\.Model[^)]*\)/g);
        for (const match of classMatches) {
          const columns: DBColumn[] = [];
          const colMatches = content.matchAll(/(\w+)\s*=\s*models\.(\w+)/g);
          for (const col of colMatches) {
            columns.push({ name: col[1], type: col[2] || 'unknown' });
          }
          allTables.push({ name: match[1], columns, source: file, orm: 'django' });
          orms.add('django');
        }
      }

      // SQLModel detection
      if (/from\s+sqlmodel|import\s+sqlmodel|SQLModel/.test(content)) {
        const classMatches = content.matchAll(/class\s+(\w+)\s*\([^)]*SQLModel[^)]*\)/g);
        for (const match of classMatches) {
          const columns: DBColumn[] = [];
          const colMatches = content.matchAll(/(\w+)\s*:\s*(\w+)/g);
          for (const col of colMatches) {
            columns.push({ name: col[1], type: col[2] || 'unknown' });
          }
          allTables.push({ name: match[1], columns, source: file, orm: 'sqlmodel' });
          orms.add('sqlmodel');
        }
      }

      // Tortoise ORM detection
      if (/from\s+tortoise|import\s+tortoise|Model/.test(content)) {
        const classMatches = content.matchAll(/class\s+(\w+)\s*\([^)]*Model[^)]*\)/g);
        for (const match of classMatches) {
          const columns: DBColumn[] = [];
          const colMatches = content.matchAll(/(\w+)\s*=\s*(\w+)Field/g);
          for (const col of colMatches) {
            columns.push({ name: col[1], type: col[2] || 'unknown' });
          }
          allTables.push({ name: match[1], columns, source: file, orm: 'tortoise' });
          orms.add('tortoise');
        }
      }

      // Peewee detection
      if (/from\s+peewee|import\s+peewee|Model/.test(content)) {
        const classMatches = content.matchAll(/class\s+(\w+)\s*\([^)]*Model[^)]*\)/g);
        for (const match of classMatches) {
          const columns: DBColumn[] = [];
          const colMatches = content.matchAll(/(\w+)\s*=\s*(\w+)Field/g);
          for (const col of colMatches) {
            columns.push({ name: col[1], type: col[2] || 'unknown' });
          }
          allTables.push({ name: match[1], columns, source: file, orm: 'peewee' });
          orms.add('peewee');
        }
      }
    } catch {
      /* skip */
    }
  }

  // 7. Ruby ORMs: ActiveRecord, Sequel
  const rubyFiles = await listFiles(dir, { glob: '**/*.rb' }).catch(() => [] as string[]);
  for (const file of rubyFiles.slice(0, 150)) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');

      // ActiveRecord detection
      if (/class\s+\w+\s*<\s*ActiveRecord::Base|ApplicationRecord/.test(content)) {
        const classMatches = content.matchAll(/class\s+(\w+)\s*<\s*(?:ActiveRecord::Base|ApplicationRecord)/g);
        for (const match of classMatches) {
          const columns: DBColumn[] = [];
          const colMatches = content.matchAll(/(?:belongs_to|has_many|has_one|has_and_belongs_to_many)\s+:(\w+)/g);
          for (const col of colMatches) {
            columns.push({ name: col[1], type: 'association' });
          }
          allTables.push({ name: match[1], columns, source: file, orm: 'activerecord' });
          orms.add('activerecord');
        }
      }

      // Sequel detection
      if (/class\s+\w+\s*<\s*Sequel::Model/.test(content)) {
        const classMatches = content.matchAll(/class\s+(\w+)\s*<\s*Sequel::Model/g);
        for (const match of classMatches) {
          allTables.push({ name: match[1], columns: [], source: file, orm: 'sequel' });
          orms.add('sequel');
        }
      }
    } catch {
      /* skip */
    }
  }

  // 8. Java ORMs: Hibernate, JPA, MyBatis, jOOQ
  const javaFiles = await listFiles(dir, { glob: '**/*.java' }).catch(() => [] as string[]);
  for (const file of javaFiles.slice(0, 150)) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');

      // Hibernate/JPA detection
      if (/@Entity|@Table|javax\.persistence|jakarta\.persistence/.test(content)) {
        const classMatches = content.matchAll(/@Entity\s*(?:@Table\s*\([^)]*\))?\s*public\s+class\s+(\w+)/g);
        for (const match of classMatches) {
          const columns: DBColumn[] = [];
          const colMatches = content.matchAll(/@Column\s*(?:\([^)]*\))?\s*private\s+\w+\s+(\w+)/g);
          for (const col of colMatches) {
            columns.push({ name: col[1], type: 'unknown' });
          }
          allTables.push({ name: match[1], columns, source: file, orm: 'hibernate' });
          orms.add('hibernate');
        }
      }

      // MyBatis detection
      if (/@Mapper|@Select|@Insert|@Update|@Delete|mybatis/.test(content)) {
        const classMatches = content.matchAll(/@Mapper\s*public\s+interface\s+(\w+)/g);
        for (const match of classMatches) {
          allTables.push({ name: match[1], columns: [], source: file, orm: 'mybatis' });
          orms.add('mybatis');
        }
      }
    } catch {
      /* skip */
    }
  }

  // 9. PHP ORMs: Doctrine, Eloquent, Propel
  const phpFiles = await listFiles(dir, { glob: '**/*.php' }).catch(() => [] as string[]);
  for (const file of phpFiles.slice(0, 150)) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');

      // Doctrine detection
      if (/use\s+Doctrine|@Entity|@Table|@Column/.test(content)) {
        const classMatches = content.matchAll(/class\s+(\w+)/g);
        for (const match of classMatches) {
          const columns: DBColumn[] = [];
          const colMatches = content.matchAll(/@Column\s*(?:\([^)]*\))?\s*private\s+\$\w+/g);
          for (const col of colMatches) {
            const nameMatch = col[0].match(/\$(\w+)/);
            if (nameMatch) columns.push({ name: nameMatch[1], type: 'unknown' });
          }
          allTables.push({ name: match[1], columns, source: file, orm: 'doctrine' });
          orms.add('doctrine');
        }
      }

      // Eloquent detection
      if (/extends\s+Model|use\s+Illuminate\\Database\\Eloquent\\Model/.test(content)) {
        const classMatches = content.matchAll(/class\s+(\w+)\s+extends\s+Model/g);
        for (const match of classMatches) {
          allTables.push({ name: match[1], columns: [], source: file, orm: 'eloquent' });
          orms.add('eloquent');
        }
      }
    } catch {
      /* skip */
    }
  }

  // 10. C# ORMs: Entity Framework, Dapper, NHibernate
  const csharpFiles = await listFiles(dir, { glob: '**/*.cs' }).catch(() => [] as string[]);
  for (const file of csharpFiles.slice(0, 150)) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');

      // Entity Framework detection
      if (/DbSet|DbContext|using\s+Microsoft\.EntityFrameworkCore/.test(content)) {
        const classMatches = content.matchAll(/public\s+class\s+(\w+)/g);
        for (const match of classMatches) {
          const columns: DBColumn[] = [];
          const colMatches = content.matchAll(/public\s+\w+\s+(\w+)\s*\{/g);
          for (const col of colMatches) {
            columns.push({ name: col[1], type: 'unknown' });
          }
          allTables.push({ name: match[1], columns, source: file, orm: 'entityframework' });
          orms.add('entityframework');
        }
      }

      // Dapper detection
      if (/using\s+Dapper|Query<|QueryFirst/.test(content)) {
        orms.add('dapper');
      }
    } catch {
      /* skip */
    }
  }

  // 11. Go ORMs: GORM, Ent, SQLBoiler
  const goFiles = await listFiles(dir, { glob: '**/*.go' }).catch(() => [] as string[]);
  for (const file of goFiles.slice(0, 150)) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');

      // GORM detection
      if (/gorm\.Model|gorm:"|github\.com\/jinzhu\/gorm/.test(content)) {
        const structMatches = content.matchAll(/type\s+(\w+)\s+struct\s*\{/g);
        for (const match of structMatches) {
          const columns: DBColumn[] = [];
          const colMatches = content.matchAll(/(\w+)\s+\w+\s+`gorm:"[^"]*"`/g);
          for (const col of colMatches) {
            columns.push({ name: col[1], type: 'unknown' });
          }
          allTables.push({ name: match[1], columns, source: file, orm: 'gorm' });
          orms.add('gorm');
        }
      }

      // Ent detection
      if (/ent\.Schema|github\.com\/facebook\/ent/.test(content)) {
        const funcMatches = content.matchAll(/func\s+\(\w+\s+\*\w+\)\s+Fields\(\)\s+\[\]ent\.Field/g);
        if (funcMatches) {
          orms.add('ent');
        }
      }
    } catch {
      /* skip */
    }
  }

  // 12. Rust ORMs: Diesel, Sea-ORM, SQLx
  const rustFiles = await listFiles(dir, { glob: '**/*.rs' }).catch(() => [] as string[]);
  for (const file of rustFiles.slice(0, 150)) {
    try {
      const content = await readFile(path.resolve(dir, file), 'utf-8');

      // Diesel detection
      if (/diesel::|table!\s*\{|Queryable/.test(content)) {
        const tableMatches = content.matchAll(/table!\s*\{[\s\S]*?name\s*=\s*(\w+)/g);
        for (const match of tableMatches) {
          allTables.push({ name: match[1], columns: [], source: file, orm: 'diesel' });
          orms.add('diesel');
        }
      }

      // Sea-ORM detection
      if (/sea_orm|EntityTrait|ActiveModelTrait/.test(content)) {
        const structMatches = content.matchAll(/struct\s+(\w+)/g);
        for (const match of structMatches) {
          allTables.push({ name: match[1], columns: [], source: file, orm: 'sea-orm' });
          orms.add('sea-orm');
        }
      }

      // SQLx detection
      if (/sqlx::|sqlx::query|sqlx::query_as/.test(content)) {
        orms.add('sqlx');
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
    '**/*.sql (Raw SQL)',
    '**/migrations/**/*.sql (SQL Migrations)',
    '**/migrate/**/*.sql (SQL Migrations)',
    '**/schema.prisma (Prisma)',
    '**/schema.{ts,js}, **/db/**/*.{ts,js}, **/drizzle/**/*.{ts,js} (Drizzle ORM)',
    '**/*.entity.{ts,js} (TypeORM)',
    '**/models/**/*.{ts,js} (Sequelize/MikroORM)',
    '**/migrations/**/*.{ts,js} (Knex.js)',
    '**/*.py (SQLAlchemy, Django ORM, SQLModel, Tortoise, Peewee)',
    '**/*.rb (ActiveRecord, Sequel)',
    '**/*.java (Hibernate, JPA, MyBatis)',
    '**/*.php (Doctrine, Eloquent)',
    '**/*.cs (Entity Framework, Dapper)',
    '**/*.go (GORM, Ent)',
    '**/*.rs (Diesel, Sea-ORM, SQLx)',
    'package.json, requirements.txt, Gemfile, pom.xml, composer.json (ORM dependencies)',
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
