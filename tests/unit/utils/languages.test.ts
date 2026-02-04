import { describe, it, expect } from 'vitest';
import { detectLanguage, getSymbolPatterns, getImportPatterns, getCommentStyle } from '../../../src/utils/languages.js';

describe('Language Detection', () => {
  it('should detect TypeScript', () => {
    expect(detectLanguage('src/app.ts')).toBe('typescript');
    expect(detectLanguage('src/component.tsx')).toBe('typescript');
    expect(detectLanguage('utils.mts')).toBe('typescript');
  });

  it('should detect JavaScript', () => {
    expect(detectLanguage('src/app.js')).toBe('javascript');
    expect(detectLanguage('src/component.jsx')).toBe('javascript');
    expect(detectLanguage('utils.mjs')).toBe('javascript');
    expect(detectLanguage('config.cjs')).toBe('javascript');
  });

  it('should detect Python', () => {
    expect(detectLanguage('app.py')).toBe('python');
    expect(detectLanguage('types.pyi')).toBe('python');
  });

  it('should detect Go', () => {
    expect(detectLanguage('main.go')).toBe('go');
  });

  it('should detect Rust', () => {
    expect(detectLanguage('lib.rs')).toBe('rust');
  });

  it('should detect Java', () => {
    expect(detectLanguage('App.java')).toBe('java');
  });

  it('should detect Ruby', () => {
    expect(detectLanguage('app.rb')).toBe('ruby');
  });

  it('should detect C/C++', () => {
    expect(detectLanguage('main.c')).toBe('c');
    expect(detectLanguage('main.cpp')).toBe('cpp');
    expect(detectLanguage('header.h')).toBe('c');
    expect(detectLanguage('header.hpp')).toBe('cpp');
  });

  it('should detect C#', () => {
    expect(detectLanguage('Program.cs')).toBe('csharp');
  });

  it('should detect PHP', () => {
    expect(detectLanguage('index.php')).toBe('php');
  });

  it('should detect Swift', () => {
    expect(detectLanguage('app.swift')).toBe('swift');
  });

  it('should detect Kotlin', () => {
    expect(detectLanguage('App.kt')).toBe('kotlin');
  });

  it('should detect web languages', () => {
    expect(detectLanguage('index.html')).toBe('html');
    expect(detectLanguage('styles.css')).toBe('css');
    expect(detectLanguage('styles.scss')).toBe('scss');
    expect(detectLanguage('component.vue')).toBe('vue');
    expect(detectLanguage('component.svelte')).toBe('svelte');
  });

  it('should detect config formats', () => {
    expect(detectLanguage('config.json')).toBe('json');
    expect(detectLanguage('config.yaml')).toBe('yaml');
    expect(detectLanguage('config.yml')).toBe('yaml');
    expect(detectLanguage('config.toml')).toBe('toml');
  });

  it('should detect shell scripts', () => {
    expect(detectLanguage('deploy.sh')).toBe('shell');
    expect(detectLanguage('setup.bash')).toBe('shell');
  });

  it('should detect SQL', () => {
    expect(detectLanguage('migration.sql')).toBe('sql');
  });

  it('should handle unknown extensions', () => {
    const result = detectLanguage('file.xyz123');
    expect(typeof result).toBe('string');
  });

  it('should handle files with full paths', () => {
    expect(detectLanguage('/home/user/project/src/app.ts')).toBe('typescript');
    expect(detectLanguage('C:\\Users\\dev\\app.py')).toBe('python');
  });
});

describe('Symbol Patterns', () => {
  it('should return patterns for TypeScript', () => {
    const patterns = getSymbolPatterns('typescript');

    expect(patterns).toHaveProperty('functions');
    expect(patterns).toHaveProperty('classes');
    expect(patterns).toHaveProperty('interfaces');
    expect(patterns).toHaveProperty('types');
    expect(patterns).toHaveProperty('constants');
    expect(patterns).toHaveProperty('exports');
    expect(patterns.functions.length).toBeGreaterThan(0);
    expect(patterns.classes.length).toBeGreaterThan(0);
  });

  it('should return patterns for Python', () => {
    const patterns = getSymbolPatterns('python');

    expect(patterns.functions.length).toBeGreaterThan(0);
    expect(patterns.classes.length).toBeGreaterThan(0);
  });

  it('should return patterns for Go', () => {
    const patterns = getSymbolPatterns('go');

    expect(patterns.functions.length).toBeGreaterThan(0);
  });

  it('should return patterns for Java', () => {
    const patterns = getSymbolPatterns('java');

    expect(patterns.functions.length).toBeGreaterThan(0);
    expect(patterns.classes.length).toBeGreaterThan(0);
  });

  it('should match TypeScript function declarations', () => {
    const patterns = getSymbolPatterns('typescript');
    const code = 'export async function fetchData(url: string): Promise<void> {';

    const match = patterns.functions.some((p) => p.test(code));
    expect(match).toBe(true);
  });

  it('should match TypeScript class declarations', () => {
    const patterns = getSymbolPatterns('typescript');
    const code = 'export class UserService {';

    const match = patterns.classes.some((p) => p.test(code));
    expect(match).toBe(true);
  });
});

describe('Import Patterns', () => {
  it('should return import patterns for TypeScript', () => {
    const patterns = getImportPatterns('typescript');

    expect(patterns.length).toBeGreaterThan(0);
  });

  it('should match ES6 imports', () => {
    const patterns = getImportPatterns('typescript');
    const code = "import { foo } from './bar';";

    const match = patterns.some((p) => p.test(code));
    expect(match).toBe(true);
  });

  it('should return import patterns for Python', () => {
    const patterns = getImportPatterns('python');

    expect(patterns.length).toBeGreaterThan(0);
  });

  it('should match Python imports', () => {
    const patterns = getImportPatterns('python');
    const code = 'from os import path';

    const match = patterns.some((p) => p.test(code));
    expect(match).toBe(true);
  });
});

describe('Comment Styles', () => {
  it('should return C-style comments for TypeScript', () => {
    const style = getCommentStyle('typescript');

    expect(style.single).toBe('//');
    expect(style.multiStart).toBe('/*');
    expect(style.multiEnd).toBe('*/');
  });

  it('should return Python-style comments', () => {
    const style = getCommentStyle('python');

    expect(style.single).toBe('#');
  });

  it('should return shell-style comments', () => {
    const style = getCommentStyle('shell');

    expect(style.single).toBe('#');
  });

  it('should return HTML-style comments', () => {
    const style = getCommentStyle('html');

    expect(style.multiStart).toBe('<!--');
    expect(style.multiEnd).toBe('-->');
  });

  it('should handle unknown languages', () => {
    const style = getCommentStyle('unknown');

    expect(style).toBeDefined();
    expect(typeof style).toBe('object');
  });
});
