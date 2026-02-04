import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseCoverage, getFileCoverage, getUntestedFiles, findTestFiles } from '../../../src/analyzers/coverage.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Coverage Analyzer', () => {
  const tempDir = join(tmpdir(), `coverage-test-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(join(tempDir, 'coverage'), { recursive: true });
    await mkdir(join(tempDir, 'src'), { recursive: true });
    await mkdir(join(tempDir, 'tests'), { recursive: true });

    // Create an LCOV coverage file
    await writeFile(
      join(tempDir, 'coverage/lcov.info'),
      `SF:src/index.ts
DA:1,1
DA:2,1
DA:3,0
DA:4,1
DA:5,0
LH:3
LF:5
FN:1,main
FNDA:1,main
FNF:1
FNH:1
BRF:2
BRH:1
end_of_record
SF:src/utils.ts
DA:1,1
DA:2,1
DA:3,1
LH:3
LF:3
FN:1,helper
FNDA:1,helper
FNF:1
FNH:1
BRF:0
BRH:0
end_of_record
`,
    );

    // Create source files
    await writeFile(join(tempDir, 'src/index.ts'), 'export function main() { return 1; }\n');
    await writeFile(join(tempDir, 'src/utils.ts'), 'export function helper() { return 2; }\n');
    await writeFile(join(tempDir, 'src/uncovered.ts'), 'export function unused() { return 3; }\n');

    // Create test files
    await writeFile(join(tempDir, 'tests/index.test.ts'), 'import { main } from "../src/index";\n');
    await writeFile(join(tempDir, 'tests/utils.test.ts'), 'import { helper } from "../src/utils";\n');
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should parse LCOV format', async () => {
    const result = await parseCoverage(tempDir);

    expect(result).not.toBeNull();
    expect(result!.format).toBe('lcov');
    expect(result!.totalFiles).toBe(2);
    expect(result!.files.length).toBe(2);
  });

  it('should calculate line coverage correctly', async () => {
    const result = await parseCoverage(tempDir);

    expect(result!.lines.total).toBe(8);
    expect(result!.lines.covered).toBe(6);
    expect(result!.lines.percentage).toBeGreaterThan(0);
  });

  it('should calculate function coverage', async () => {
    const result = await parseCoverage(tempDir);

    expect(result!.functions.total).toBe(2);
    expect(result!.functions.covered).toBe(2);
    expect(result!.functions.percentage).toBe(100);
  });

  it('should track uncovered lines', async () => {
    const result = await parseCoverage(tempDir);

    const indexFile = result!.files.find((f) => f.file.includes('index.ts'));
    expect(indexFile).toBeDefined();
    expect(indexFile!.uncoveredLines).toContain(3);
    expect(indexFile!.uncoveredLines).toContain(5);
  });

  it('should handle missing coverage data', async () => {
    const emptyDir = join(tmpdir(), `cov-empty-${Date.now()}`);
    await mkdir(emptyDir, { recursive: true });

    try {
      const result = await parseCoverage(emptyDir);
      expect(result).toBeNull();
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('should get coverage for specific file', async () => {
    const coverage = await parseCoverage(tempDir);
    if (coverage) {
      const fileCov = getFileCoverage(coverage, 'src/utils.ts');
      if (fileCov) {
        expect(fileCov.lines.percentage).toBe(100);
      }
    }
  });

  it('should find test files', async () => {
    const testFiles = await findTestFiles(tempDir);

    expect(testFiles.length).toBeGreaterThan(0);
    expect(testFiles.some((f) => f.includes('.test.ts'))).toBe(true);
  });

  it('should find untested source files', async () => {
    const coverage = await parseCoverage(tempDir);
    if (coverage) {
      const untested = getUntestedFiles(coverage, ['src/index.ts', 'src/utils.ts', 'src/uncovered.ts']);
      // uncovered.ts is not in coverage data
      expect(untested.some((f) => f.includes('uncovered.ts'))).toBe(true);
    }
  });

  it('should handle Istanbul JSON format', async () => {
    const istanbulDir = join(tmpdir(), `cov-istanbul-${Date.now()}`);
    await mkdir(join(istanbulDir, 'coverage'), { recursive: true });

    await writeFile(
      join(istanbulDir, 'coverage/coverage-final.json'),
      JSON.stringify({
        'src/app.ts': {
          path: 'src/app.ts',
          statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } } },
          s: { 0: 1 },
          fnMap: { 0: { name: 'run', decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } } } },
          f: { 0: 1 },
          branchMap: {},
          b: {},
        },
      }),
    );

    try {
      const result = await parseCoverage(istanbulDir);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.format).toBe('istanbul');
        expect(result.totalFiles).toBe(1);
      }
    } finally {
      await rm(istanbulDir, { recursive: true, force: true });
    }
  });
});
