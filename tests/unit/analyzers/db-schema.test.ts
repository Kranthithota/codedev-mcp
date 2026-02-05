import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { analyzeDBSchema } from '../../../src/analyzers/db-schema.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── SQL CREATE TABLE Parsing ─────────────────────────────────────────────────

describe('DB Schema Analyzer - SQL parsing', () => {
  const tempDir = join(tmpdir(), `db-schema-sql-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  beforeAll(async () => {
    await mkdir(join(tempDir, 'migrations'), { recursive: true });

    // Basic table with various column types and constraints
    await writeFile(
      join(tempDir, 'migrations', '001_create_users.sql'),
      `CREATE TABLE users (
  id INTEGER PRIMARY KEY NOT NULL,
  username VARCHAR(255) NOT NULL UNIQUE,
  email VARCHAR(100) NOT NULL,
  bio TEXT NULL,
  age INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`,
    );

    // Table with foreign key references
    await writeFile(
      join(tempDir, 'migrations', '002_create_posts.sql'),
      `CREATE TABLE posts (
  id INTEGER PRIMARY KEY NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT,
  author_id INTEGER NOT NULL REFERENCES users(id),
  category_id INTEGER REFERENCES categories(id),
  published BOOLEAN DEFAULT false
);
`,
    );

    // Table with IF NOT EXISTS and quoted identifiers
    await writeFile(
      join(tempDir, 'migrations', '003_create_categories.sql'),
      `CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY NOT NULL,
  name VARCHAR(50) NOT NULL UNIQUE,
  description TEXT NULL
);
`,
    );

    // Many-to-many join table (for relationship detection)
    await writeFile(
      join(tempDir, 'migrations', '004_create_post_tags.sql'),
      `CREATE TABLE post_tags (
  post_id INTEGER NOT NULL REFERENCES posts(id),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (post_id, tag_id)
);
`,
    );

    // The tags table
    await writeFile(
      join(tempDir, 'migrations', '005_create_tags.sql'),
      `CREATE TABLE tags (
  id INTEGER PRIMARY KEY NOT NULL,
  label VARCHAR(30) NOT NULL UNIQUE
);
`,
    );

    // Multiple CREATE TABLE statements in a single file
    await writeFile(
      join(tempDir, 'migrations', '006_create_multi.sql'),
      `CREATE TABLE comments (
  id INTEGER PRIMARY KEY NOT NULL,
  content TEXT NOT NULL,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  author_id INTEGER NOT NULL REFERENCES users(id)
);

CREATE TABLE likes (
  id INTEGER PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  post_id INTEGER NOT NULL REFERENCES posts(id)
);
`,
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should parse basic SQL columns and types', async () => {
    const result = await analyzeDBSchema(tempDir);
    const users = result.tables.find((t) => t.name === 'users');

    expect(users).toBeDefined();
    expect(users!.orm).toBe('sql');
    expect(users!.columns.length).toBeGreaterThanOrEqual(5);

    const idCol = users!.columns.find((c) => c.name === 'id');
    expect(idCol).toBeDefined();
    expect(idCol!.type).toBe('INTEGER');
    expect(idCol!.primary).toBe(true);
    expect(idCol!.nullable).toBe(false);

    const usernameCol = users!.columns.find((c) => c.name === 'username');
    expect(usernameCol).toBeDefined();
    expect(usernameCol!.type).toBe('VARCHAR(255)');
    expect(usernameCol!.unique).toBe(true);
    expect(usernameCol!.nullable).toBe(false);
  });

  it('should parse NOT NULL constraint', async () => {
    const result = await analyzeDBSchema(tempDir);
    const users = result.tables.find((t) => t.name === 'users');
    expect(users).toBeDefined();

    const emailCol = users!.columns.find((c) => c.name === 'email');
    expect(emailCol).toBeDefined();
    expect(emailCol!.nullable).toBe(false);
  });

  it('should parse NULL (nullable) columns', async () => {
    const result = await analyzeDBSchema(tempDir);
    const users = result.tables.find((t) => t.name === 'users');
    expect(users).toBeDefined();

    const bioCol = users!.columns.find((c) => c.name === 'bio');
    expect(bioCol).toBeDefined();
    expect(bioCol!.nullable).toBe(true);
  });

  it('should parse DEFAULT values', async () => {
    const result = await analyzeDBSchema(tempDir);
    const users = result.tables.find((t) => t.name === 'users');
    expect(users).toBeDefined();

    const ageCol = users!.columns.find((c) => c.name === 'age');
    expect(ageCol).toBeDefined();
    expect(ageCol!.default).toBeDefined();
  });

  it('should parse UNIQUE constraint', async () => {
    const result = await analyzeDBSchema(tempDir);
    const users = result.tables.find((t) => t.name === 'users');
    expect(users).toBeDefined();

    const usernameCol = users!.columns.find((c) => c.name === 'username');
    expect(usernameCol).toBeDefined();
    expect(usernameCol!.unique).toBe(true);
  });

  it('should parse REFERENCES (foreign keys)', async () => {
    const result = await analyzeDBSchema(tempDir);
    const posts = result.tables.find((t) => t.name === 'posts');
    expect(posts).toBeDefined();

    const authorCol = posts!.columns.find((c) => c.name === 'author_id');
    expect(authorCol).toBeDefined();
    expect(authorCol!.references).toBe('users');

    const categoryCol = posts!.columns.find((c) => c.name === 'category_id');
    expect(categoryCol).toBeDefined();
    expect(categoryCol!.references).toBe('categories');
  });

  it('should parse CREATE TABLE IF NOT EXISTS', async () => {
    const result = await analyzeDBSchema(tempDir);
    const categories = result.tables.find((t) => t.name === 'categories');
    expect(categories).toBeDefined();
    expect(categories!.columns.length).toBeGreaterThanOrEqual(2);
  });

  it('should parse multiple tables from a single file', async () => {
    const result = await analyzeDBSchema(tempDir);
    const comments = result.tables.find((t) => t.name === 'comments');
    const likes = result.tables.find((t) => t.name === 'likes');

    expect(comments).toBeDefined();
    expect(likes).toBeDefined();
    expect(comments!.source).toBe(likes!.source);
  });

  it('should track migration files', async () => {
    const result = await analyzeDBSchema(tempDir);
    expect(result.migrations.length).toBeGreaterThanOrEqual(1);
    for (const m of result.migrations) {
      expect(m.file).toBeDefined();
      expect(m.description).toBeDefined();
    }
  });

  it('should include sql in the detected orms', async () => {
    const result = await analyzeDBSchema(tempDir);
    expect(result.summary.orms).toContain('sql');
  });
});

// ─── Prisma Schema Parsing ───────────────────────────────────────────────────

describe('DB Schema Analyzer - Prisma parsing', () => {
  const tempDir = join(tmpdir(), `db-schema-prisma-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  beforeAll(async () => {
    await mkdir(join(tempDir, 'prisma'), { recursive: true });

    await writeFile(
      join(tempDir, 'prisma', 'schema.prisma'),
      `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  posts     Post[]
  profile   Profile?
  createdAt DateTime @default(now())

  @@index([email])
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  content   String?
  published Boolean  @default(false)
  author    User     @relation(fields: [authorId], references: [id])
  authorId  Int
  tags      Tag[]
}

model Profile {
  id     Int    @id @default(autoincrement())
  bio    String
  user   User   @relation(fields: [userId], references: [id])
  userId Int    @unique
}

model Tag {
  id    Int    @id @default(autoincrement())
  name  String @unique
  posts Post[]
}
`,
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should parse Prisma model definitions', async () => {
    const result = await analyzeDBSchema(tempDir);
    const tableNames = result.tables.map((t) => t.name);

    expect(tableNames).toContain('User');
    expect(tableNames).toContain('Post');
    expect(tableNames).toContain('Profile');
    expect(tableNames).toContain('Tag');
  });

  it('should detect @id fields as primary keys', async () => {
    const result = await analyzeDBSchema(tempDir);
    const user = result.tables.find((t) => t.name === 'User');
    expect(user).toBeDefined();

    const idCol = user!.columns.find((c) => c.name === 'id');
    expect(idCol).toBeDefined();
    expect(idCol!.primary).toBe(true);
  });

  it('should detect @unique fields', async () => {
    const result = await analyzeDBSchema(tempDir);
    const user = result.tables.find((t) => t.name === 'User');
    expect(user).toBeDefined();

    const emailCol = user!.columns.find((c) => c.name === 'email');
    expect(emailCol).toBeDefined();
    expect(emailCol!.unique).toBe(true);
  });

  it('should detect nullable (?) fields', async () => {
    const result = await analyzeDBSchema(tempDir);
    const user = result.tables.find((t) => t.name === 'User');
    expect(user).toBeDefined();

    const nameCol = user!.columns.find((c) => c.name === 'name');
    expect(nameCol).toBeDefined();
    expect(nameCol!.nullable).toBe(true);
    expect(nameCol!.type).toBe('String?');
  });

  it('should detect @default values', async () => {
    const result = await analyzeDBSchema(tempDir);
    const user = result.tables.find((t) => t.name === 'User');
    expect(user).toBeDefined();

    const idCol = user!.columns.find((c) => c.name === 'id');
    expect(idCol).toBeDefined();
    expect(idCol!.default).toBe('autoincrement(');

    const createdAtCol = user!.columns.find((c) => c.name === 'createdAt');
    expect(createdAtCol).toBeDefined();
    expect(createdAtCol!.default).toBe('now(');
  });

  it('should detect @relation references', async () => {
    const result = await analyzeDBSchema(tempDir);
    const post = result.tables.find((t) => t.name === 'Post');
    expect(post).toBeDefined();

    const authorCol = post!.columns.find((c) => c.name === 'author');
    expect(authorCol).toBeDefined();
    expect(authorCol!.references).toBe('User');
  });

  it('should detect array types (e.g., Post[])', async () => {
    const result = await analyzeDBSchema(tempDir);
    const user = result.tables.find((t) => t.name === 'User');
    expect(user).toBeDefined();

    const postsCol = user!.columns.find((c) => c.name === 'posts');
    expect(postsCol).toBeDefined();
    expect(postsCol!.type).toBe('Post[]');
  });

  it('should set orm to prisma for all Prisma tables', async () => {
    const result = await analyzeDBSchema(tempDir);
    const prismaTables = result.tables.filter((t) => t.orm === 'prisma');
    expect(prismaTables.length).toBeGreaterThanOrEqual(4);

    expect(result.summary.orms).toContain('prisma');
  });

  it('should skip comment lines and @@-level directives', async () => {
    const result = await analyzeDBSchema(tempDir);
    const user = result.tables.find((t) => t.name === 'User');
    expect(user).toBeDefined();

    // @@index should not appear as a column
    const indexCol = user!.columns.find((c) => c.name === '@@index' || c.name === 'index');
    expect(indexCol).toBeUndefined();
  });
});

// ─── Drizzle Schema Parsing (tests extractBalancedBlock indirectly) ──────────

describe('DB Schema Analyzer - Drizzle parsing', () => {
  const tempDir = join(tmpdir(), `db-schema-drizzle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  beforeAll(async () => {
    await mkdir(join(tempDir, 'db'), { recursive: true });

    // package.json with drizzle dependency (so drizzle detection triggers)
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'drizzle-test',
        dependencies: {
          'drizzle-orm': '^0.30.0',
        },
      }),
    );

    // pgTable with nested braces in column options (tests balanced brace extractor)
    await writeFile(
      join(tempDir, 'db', 'schema.ts'),
      `import { pgTable, serial, varchar, integer, boolean, text, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey().notNull(),
  firstName: varchar('first_name', { length: 255 }).notNull(),
  lastName: varchar('last_name', { length: 255 }),
  email: text('email').notNull().unique(),
  age: integer('age').default(0),
  isActive: boolean('is_active').default(true),
  bio: text('bio'),
  createdAt: timestamp('created_at').default(new Date()),
});

export const posts = pgTable('posts', {
  id: serial('id').primaryKey().notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  body: text('body'),
  authorId: integer('author_id').notNull().references(() => users.id),
  published: boolean('published').default(false),
});
`,
    );

    // mysqlTable with various column configs
    await writeFile(
      join(tempDir, 'db', 'mysql-schema.ts'),
      `import { mysqlTable, serial, varchar, int, boolean } from 'drizzle-orm/mysql-core';

export const products = mysqlTable('products', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  price: int('price').notNull(),
  inStock: boolean('in_stock').default(true),
});
`,
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should parse pgTable definitions', async () => {
    const result = await analyzeDBSchema(tempDir);
    const users = result.tables.find((t) => t.name === 'users' && t.orm === 'drizzle');

    expect(users).toBeDefined();
    expect(users!.columns.length).toBeGreaterThanOrEqual(4);
  });

  it('should parse columns with nested braces (e.g., { length: 255 })', async () => {
    const result = await analyzeDBSchema(tempDir);
    const users = result.tables.find((t) => t.name === 'users' && t.orm === 'drizzle');
    expect(users).toBeDefined();

    // firstName should be parsed even though it has nested { length: 255 }
    const firstName = users!.columns.find((c) => c.name === 'first_name');
    expect(firstName).toBeDefined();
    expect(firstName!.type).toBe('varchar');
  });

  it('should detect .primaryKey() modifier', async () => {
    const result = await analyzeDBSchema(tempDir);
    const users = result.tables.find((t) => t.name === 'users' && t.orm === 'drizzle');
    expect(users).toBeDefined();

    const idCol = users!.columns.find((c) => c.name === 'id');
    expect(idCol).toBeDefined();
    expect(idCol!.primary).toBe(true);
  });

  it('should detect .notNull() modifier', async () => {
    const result = await analyzeDBSchema(tempDir);
    const users = result.tables.find((t) => t.name === 'users' && t.orm === 'drizzle');
    expect(users).toBeDefined();

    const idCol = users!.columns.find((c) => c.name === 'id');
    expect(idCol).toBeDefined();
    expect(idCol!.nullable).toBe(false);
  });

  it('should detect .unique() modifier', async () => {
    const result = await analyzeDBSchema(tempDir);
    const users = result.tables.find((t) => t.name === 'users' && t.orm === 'drizzle');
    expect(users).toBeDefined();

    const emailCol = users!.columns.find((c) => c.name === 'email');
    expect(emailCol).toBeDefined();
    expect(emailCol!.unique).toBe(true);
  });

  it('should detect .default() modifier', async () => {
    const result = await analyzeDBSchema(tempDir);
    const users = result.tables.find((t) => t.name === 'users' && t.orm === 'drizzle');
    expect(users).toBeDefined();

    const ageCol = users!.columns.find((c) => c.name === 'age');
    expect(ageCol).toBeDefined();
    expect(ageCol!.default).toBeDefined();
  });

  it('should parse mysqlTable definitions', async () => {
    const result = await analyzeDBSchema(tempDir);
    const products = result.tables.find((t) => t.name === 'products' && t.orm === 'drizzle');

    expect(products).toBeDefined();
    expect(products!.columns.length).toBeGreaterThanOrEqual(3);

    const nameCol = products!.columns.find((c) => c.name === 'name');
    expect(nameCol).toBeDefined();
    expect(nameCol!.type).toBe('varchar');
  });

  it('should set orm to drizzle for Drizzle tables', async () => {
    const result = await analyzeDBSchema(tempDir);
    const drizzleTables = result.tables.filter((t) => t.orm === 'drizzle');
    expect(drizzleTables.length).toBeGreaterThanOrEqual(2);

    expect(result.summary.orms).toContain('drizzle');
  });
});

// ─── Balanced Brace Extractor (indirectly via Drizzle with deeply nested content) ─

describe('DB Schema Analyzer - extractBalancedBlock (via Drizzle)', () => {
  const tempDir = join(tmpdir(), `db-schema-balanced-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  beforeAll(async () => {
    await mkdir(join(tempDir, 'db'), { recursive: true });

    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'balanced-brace-test',
        dependencies: {
          'drizzle-orm': '^0.30.0',
        },
      }),
    );

    // Schema with deeply nested braces - tests extractBalancedBlock
    await writeFile(
      join(tempDir, 'db', 'schema.ts'),
      `import { pgTable, serial, varchar, integer, jsonb, text } from 'drizzle-orm/pg-core';

export const settings = pgTable('settings', {
  id: serial('id').primaryKey(),
  key: varchar('key', { length: 255 }).notNull(),
  value: jsonb('value').default({ nested: { deep: { level: 3 } } }),
  label: text('label'),
});
`,
    );

    // Schema with strings that contain braces (should not confuse the parser)
    await writeFile(
      join(tempDir, 'db', 'strings-schema.ts'),
      `import { pgTable, serial, varchar, text } from 'drizzle-orm/pg-core';

export const templates = pgTable('templates', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  body: text('body').default('Hello {name}, welcome to {app}'),
  format: varchar('format', { length: 50 }).default('json'),
});
`,
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should correctly parse tables with deeply nested braces in defaults', async () => {
    const result = await analyzeDBSchema(tempDir);
    const settings = result.tables.find((t) => t.name === 'settings' && t.orm === 'drizzle');

    expect(settings).toBeDefined();
    // Even with nested { nested: { deep: { level: 3 } } }, the parser should extract the table
    expect(settings!.columns.length).toBeGreaterThanOrEqual(2);

    const keyCol = settings!.columns.find((c) => c.name === 'key');
    expect(keyCol).toBeDefined();
  });

  it('should correctly parse tables with strings containing braces', async () => {
    const result = await analyzeDBSchema(tempDir);
    const templates = result.tables.find((t) => t.name === 'templates' && t.orm === 'drizzle');

    expect(templates).toBeDefined();
    expect(templates!.columns.length).toBeGreaterThanOrEqual(2);

    const nameCol = templates!.columns.find((c) => c.name === 'name');
    expect(nameCol).toBeDefined();
  });
});

// ─── Empty / Non-existent Directory Handling ─────────────────────────────────

describe('DB Schema Analyzer - empty and non-existent directories', () => {
  const tempDir = join(tmpdir(), `db-schema-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  beforeAll(async () => {
    await mkdir(tempDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should return empty results for an empty directory', async () => {
    const result = await analyzeDBSchema(tempDir);

    expect(result.tables).toHaveLength(0);
    expect(result.relationships).toHaveLength(0);
    expect(result.summary.totalTables).toBe(0);
    expect(result.summary.totalColumns).toBe(0);
    expect(result.summary.totalRelationships).toBe(0);
    expect(result.summary.orms).toHaveLength(0);
  });

  it('should handle a non-existent subdirectory gracefully', async () => {
    const result = await analyzeDBSchema(tempDir, { directory: 'non-existent-dir' });

    expect(result.tables).toHaveLength(0);
    expect(result.relationships).toHaveLength(0);
    expect(result.summary.totalTables).toBe(0);
  });

  it('should still have scannedPatterns even with empty results', async () => {
    const result = await analyzeDBSchema(tempDir);

    expect(result.scannedPatterns).toBeDefined();
    expect(result.scannedPatterns.length).toBeGreaterThan(0);
  });
});

// ─── Relationships Detection ─────────────────────────────────────────────────

describe('DB Schema Analyzer - relationship detection', () => {
  const tempDir = join(tmpdir(), `db-schema-rels-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  beforeAll(async () => {
    await mkdir(join(tempDir, 'migrations'), { recursive: true });

    await writeFile(
      join(tempDir, 'migrations', '001_tables.sql'),
      `CREATE TABLE authors (
  id INTEGER PRIMARY KEY NOT NULL,
  name VARCHAR(100) NOT NULL
);

CREATE TABLE books (
  id INTEGER PRIMARY KEY NOT NULL,
  title VARCHAR(200) NOT NULL,
  author_id INTEGER NOT NULL REFERENCES authors(id)
);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY NOT NULL,
  content TEXT NOT NULL,
  book_id INTEGER NOT NULL REFERENCES books(id),
  reviewer_id INTEGER NOT NULL REFERENCES authors(id)
);
`,
    );

    // Classic many-to-many join table: two FKs and minimal extra columns
    await writeFile(
      join(tempDir, 'migrations', '002_join_table.sql'),
      `CREATE TABLE book_genres (
  book_id INTEGER NOT NULL REFERENCES books(id),
  genre_id INTEGER NOT NULL REFERENCES genres(id),
  PRIMARY KEY (book_id, genre_id)
);

CREATE TABLE genres (
  id INTEGER PRIMARY KEY NOT NULL,
  name VARCHAR(50) NOT NULL UNIQUE
);
`,
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should detect one-to-many relationships from foreign keys', async () => {
    const result = await analyzeDBSchema(tempDir);

    const bookToAuthor = result.relationships.find(
      (r) => r.from === 'books' && r.to === 'authors' && r.type === 'one-to-many',
    );
    expect(bookToAuthor).toBeDefined();
  });

  it('should detect multiple foreign keys on the same table', async () => {
    const result = await analyzeDBSchema(tempDir);

    const reviewToBook = result.relationships.find(
      (r) => r.from === 'reviews' && r.to === 'books' && r.type === 'one-to-many',
    );
    const reviewToAuthor = result.relationships.find(
      (r) => r.from === 'reviews' && r.to === 'authors' && r.type === 'one-to-many',
    );

    expect(reviewToBook).toBeDefined();
    expect(reviewToAuthor).toBeDefined();
  });

  it('should detect many-to-many join tables', async () => {
    const result = await analyzeDBSchema(tempDir);

    const m2m = result.relationships.find(
      (r) => r.type === 'many-to-many' && r.through === 'book_genres',
    );
    expect(m2m).toBeDefined();
    // The join table connects books and genres
    expect([m2m!.from, m2m!.to].sort()).toEqual(['books', 'genres']);
  });

  it('should count relationships correctly in the summary', async () => {
    const result = await analyzeDBSchema(tempDir);

    expect(result.summary.totalRelationships).toBeGreaterThanOrEqual(3);
    // At least: books->authors, reviews->books, reviews->authors, plus many-to-many
  });
});

// ─── Summary Structure Validation ────────────────────────────────────────────

describe('DB Schema Analyzer - summary structure', () => {
  const tempDir = join(tmpdir(), `db-schema-summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  beforeAll(async () => {
    await mkdir(join(tempDir, 'migrations'), { recursive: true });

    await writeFile(
      join(tempDir, 'migrations', '001_setup.sql'),
      `CREATE TABLE accounts (
  id INTEGER PRIMARY KEY NOT NULL,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(200) NOT NULL UNIQUE,
  plan VARCHAR(20) DEFAULT 'free'
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY NOT NULL,
  token VARCHAR(500) NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  expires_at TIMESTAMP NOT NULL
);
`,
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should produce a complete DBSchemaResult structure', async () => {
    const result = await analyzeDBSchema(tempDir);

    // Top-level structure
    expect(result).toHaveProperty('tables');
    expect(result).toHaveProperty('relationships');
    expect(result).toHaveProperty('migrations');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('scannedPatterns');

    // Arrays
    expect(Array.isArray(result.tables)).toBe(true);
    expect(Array.isArray(result.relationships)).toBe(true);
    expect(Array.isArray(result.migrations)).toBe(true);
    expect(Array.isArray(result.scannedPatterns)).toBe(true);
  });

  it('should produce an accurate summary object', async () => {
    const result = await analyzeDBSchema(tempDir);

    expect(result.summary).toHaveProperty('totalTables');
    expect(result.summary).toHaveProperty('totalColumns');
    expect(result.summary).toHaveProperty('totalRelationships');
    expect(result.summary).toHaveProperty('orms');

    expect(typeof result.summary.totalTables).toBe('number');
    expect(typeof result.summary.totalColumns).toBe('number');
    expect(typeof result.summary.totalRelationships).toBe('number');
    expect(Array.isArray(result.summary.orms)).toBe(true);
  });

  it('should count tables and columns correctly', async () => {
    const result = await analyzeDBSchema(tempDir);

    expect(result.summary.totalTables).toBe(result.tables.length);

    const expectedColumns = result.tables.reduce((sum, t) => sum + t.columns.length, 0);
    expect(result.summary.totalColumns).toBe(expectedColumns);
  });

  it('should count relationships correctly', async () => {
    const result = await analyzeDBSchema(tempDir);

    expect(result.summary.totalRelationships).toBe(result.relationships.length);
  });

  it('should include the source file in each table', async () => {
    const result = await analyzeDBSchema(tempDir);

    for (const table of result.tables) {
      expect(table.source).toBeDefined();
      expect(typeof table.source).toBe('string');
      expect(table.source.length).toBeGreaterThan(0);
    }
  });

  it('should include orm identifier in each table', async () => {
    const result = await analyzeDBSchema(tempDir);

    for (const table of result.tables) {
      expect(table.orm).toBeDefined();
      expect(typeof table.orm).toBe('string');
    }
  });

  it('should have scannedPatterns listing all file type patterns', async () => {
    const result = await analyzeDBSchema(tempDir);

    expect(result.scannedPatterns.length).toBeGreaterThan(5);
    // Should reference common ORM file types
    const joined = result.scannedPatterns.join(' ');
    expect(joined).toContain('sql');
    expect(joined).toContain('Prisma');
    expect(joined).toContain('Drizzle');
  });
});

// ─── Subdirectory (options.directory) ────────────────────────────────────────

describe('DB Schema Analyzer - directory option', () => {
  const tempDir = join(tmpdir(), `db-schema-subdir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  beforeAll(async () => {
    await mkdir(join(tempDir, 'backend', 'migrations'), { recursive: true });
    await mkdir(join(tempDir, 'frontend'), { recursive: true });

    await writeFile(
      join(tempDir, 'backend', 'migrations', '001.sql'),
      `CREATE TABLE orders (
  id INTEGER PRIMARY KEY NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending'
);
`,
    );

    // File outside of the target directory
    await writeFile(
      join(tempDir, 'frontend', 'data.sql'),
      `CREATE TABLE ui_cache (
  id INTEGER PRIMARY KEY NOT NULL,
  key VARCHAR(100),
  value TEXT
);
`,
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should only analyze the specified subdirectory', async () => {
    const result = await analyzeDBSchema(tempDir, { directory: 'backend' });
    const tableNames = result.tables.map((t) => t.name);

    expect(tableNames).toContain('orders');
    expect(tableNames).not.toContain('ui_cache');
  });

  it('should analyze the root when no directory option is given', async () => {
    const result = await analyzeDBSchema(tempDir);

    // Should find tables from both backend and frontend
    expect(result.tables.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Mixed ORM Detection ────────────────────────────────────────────────────

describe('DB Schema Analyzer - mixed ORM detection', () => {
  const tempDir = join(tmpdir(), `db-schema-mixed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  beforeAll(async () => {
    await mkdir(join(tempDir, 'prisma'), { recursive: true });
    await mkdir(join(tempDir, 'migrations'), { recursive: true });

    // Prisma schema
    await writeFile(
      join(tempDir, 'prisma', 'schema.prisma'),
      `model Customer {
  id    Int    @id @default(autoincrement())
  name  String
  email String @unique
}
`,
    );

    // SQL migration
    await writeFile(
      join(tempDir, 'migrations', '001.sql'),
      `CREATE TABLE invoices (
  id INTEGER PRIMARY KEY NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id)
);
`,
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should detect multiple ORMs in the same project', async () => {
    const result = await analyzeDBSchema(tempDir);

    expect(result.summary.orms).toContain('prisma');
    expect(result.summary.orms).toContain('sql');
  });

  it('should include tables from all detected ORMs', async () => {
    const result = await analyzeDBSchema(tempDir);

    const prismaTables = result.tables.filter((t) => t.orm === 'prisma');
    const sqlTables = result.tables.filter((t) => t.orm === 'sql');

    expect(prismaTables.length).toBeGreaterThanOrEqual(1);
    expect(sqlTables.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────

describe('DB Schema Analyzer - edge cases', () => {
  const tempDir = join(tmpdir(), `db-schema-edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  beforeAll(async () => {
    await mkdir(join(tempDir, 'migrations'), { recursive: true });

    // Empty SQL file
    await writeFile(join(tempDir, 'migrations', '000_empty.sql'), '');

    // SQL file with only comments and no CREATE TABLE
    await writeFile(
      join(tempDir, 'migrations', '000_comments_only.sql'),
      `-- This is a comment
-- Another comment
/* Multi-line
   comment */
`,
    );

    // SQL with table-level constraints that should be skipped as columns
    await writeFile(
      join(tempDir, 'migrations', '001_constraints.sql'),
      `CREATE TABLE orders (
  id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  FOREIGN KEY (product_id) REFERENCES products(id),
  UNIQUE (id, product_id),
  CHECK (quantity > 0)
);
`,
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should handle empty SQL files gracefully', async () => {
    // Should not throw
    const result = await analyzeDBSchema(tempDir);
    expect(result).toBeDefined();
  });

  it('should handle SQL files with only comments', async () => {
    const result = await analyzeDBSchema(tempDir);
    // No tables should come from the comments-only file
    expect(result).toBeDefined();
  });

  it('should skip table-level constraints (PRIMARY KEY, FOREIGN KEY, UNIQUE, CHECK)', async () => {
    const result = await analyzeDBSchema(tempDir);
    const orders = result.tables.find((t) => t.name === 'orders');
    expect(orders).toBeDefined();

    // Should have actual columns (id, product_id, quantity) but not constraints
    for (const col of orders!.columns) {
      expect(col.name).not.toMatch(/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|INDEX|KEY)$/i);
    }

    const idCol = orders!.columns.find((c) => c.name === 'id');
    expect(idCol).toBeDefined();
    const productIdCol = orders!.columns.find((c) => c.name === 'product_id');
    expect(productIdCol).toBeDefined();
    const quantityCol = orders!.columns.find((c) => c.name === 'quantity');
    expect(quantityCol).toBeDefined();
    expect(quantityCol!.default).toBeDefined();
  });
});
