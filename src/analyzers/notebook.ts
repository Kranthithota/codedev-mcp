/**
 * Jupyter Notebook (.ipynb) parser.
 * Extracts code cells, markdown cells, outputs, and dependencies.
 */

import { readFile } from 'node:fs/promises';
import { glob } from 'glob';

export interface NotebookCell {
  cellType: 'code' | 'markdown' | 'raw';
  source: string;
  index: number;
  executionCount?: number;
  outputs?: string[];
  hasError?: boolean;
}

export interface NotebookInfo {
  file: string;
  kernelLanguage: string;
  kernelDisplayName: string;
  totalCells: number;
  codeCells: number;
  markdownCells: number;
  cells: NotebookCell[];
  imports: string[];
  functions: string[];
  executedInOrder: boolean;
  hasUnexecutedCells: boolean;
}

/**
 * Parse a Jupyter notebook file.
 * @param filePath - Path to the .ipynb file
 * @returns Parsed notebook information including cells, imports, and execution state
 */
export async function parseNotebook(filePath: string): Promise<NotebookInfo> {
  const content = await readFile(filePath, 'utf-8');
  const notebook = JSON.parse(content);

  const kernelSpec = notebook.metadata?.kernelspec || {};
  const kernelLanguage = kernelSpec.language || notebook.metadata?.language_info?.name || 'unknown';
  const kernelDisplayName = kernelSpec.display_name || kernelLanguage;

  const cells: NotebookCell[] = [];
  const imports: string[] = [];
  const functions: string[] = [];
  let lastExecCount = 0;
  let executedInOrder = true;
  let hasUnexecutedCells = false;

  for (let i = 0; i < (notebook.cells || []).length; i++) {
    const cell = notebook.cells[i];
    const cellType = cell.cell_type as 'code' | 'markdown' | 'raw';
    const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source || '';

    const outputs: string[] = [];
    let hasError = false;

    if (cell.outputs) {
      for (const output of cell.outputs) {
        if (output.output_type === 'error') {
          hasError = true;
          outputs.push(`Error: ${output.ename}: ${output.evalue}`);
        } else if (output.output_type === 'stream') {
          const text = Array.isArray(output.text) ? output.text.join('') : output.text || '';
          if (text.trim()) outputs.push(text.trim().slice(0, 200));
        } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
          const textData = output.data?.['text/plain'];
          if (textData) {
            const text = Array.isArray(textData) ? textData.join('') : textData;
            outputs.push(text.slice(0, 200));
          }
        }
      }
    }

    const execCount = cell.execution_count;
    if (cellType === 'code') {
      if (execCount === null || execCount === undefined) {
        hasUnexecutedCells = true;
      } else if (execCount <= lastExecCount) {
        executedInOrder = false;
      }
      lastExecCount = execCount || lastExecCount;

      // Extract imports
      const importLines = source
        .split('\n')
        .filter((l: string) => /^(?:import |from |require\(|const .+ = require)/.test(l.trim()));
      imports.push(...importLines.map((l: string) => l.trim()));

      // Extract function definitions
      const funcLines = source
        .split('\n')
        .filter((l: string) => /^(?:def |async def |function |class )/.test(l.trim()));
      functions.push(...funcLines.map((l: string) => l.trim()));
    }

    cells.push({
      cellType,
      source,
      index: i,
      executionCount: execCount,
      outputs: outputs.length > 0 ? outputs : undefined,
      hasError,
    });
  }

  return {
    file: filePath,
    kernelLanguage,
    kernelDisplayName,
    totalCells: cells.length,
    codeCells: cells.filter((c) => c.cellType === 'code').length,
    markdownCells: cells.filter((c) => c.cellType === 'markdown').length,
    cells,
    imports: [...new Set(imports)],
    functions,
    executedInOrder,
    hasUnexecutedCells,
  };
}

/**
 * Find all notebooks in a directory.
 * @param cwd - The working directory to search
 * @returns Array of notebook file paths
 */
export async function findNotebooks(cwd: string): Promise<string[]> {
  return glob('**/*.ipynb', {
    cwd,
    ignore: ['node_modules/**', '.ipynb_checkpoints/**', 'dist/**', 'build/**'],
  });
}

/**
 * Extract just the code from a notebook (for analysis).
 * @param notebook - Parsed notebook information
 * @returns Concatenated code from all code cells
 */
export function extractCode(notebook: NotebookInfo): string {
  return notebook.cells
    .filter((c) => c.cellType === 'code')
    .map((c) => `# Cell ${c.index} [${c.executionCount || '?'}]\n${c.source}`)
    .join('\n\n');
}

/**
 * Get notebook health summary.
 * @param notebook - Parsed notebook information
 * @returns Health issues and overall score
 */
export function notebookHealth(notebook: NotebookInfo): {
  issues: string[];
  score: number;
} {
  const issues: string[] = [];
  let score = 100;

  if (notebook.hasUnexecutedCells) {
    issues.push('Has unexecuted code cells');
    score -= 10;
  }
  if (!notebook.executedInOrder) {
    issues.push('Cells not executed in order (may have hidden state)');
    score -= 20;
  }
  if (notebook.cells.some((c) => c.hasError)) {
    issues.push('Contains cells with execution errors');
    score -= 15;
  }
  if (notebook.markdownCells === 0) {
    issues.push('No markdown documentation cells');
    score -= 10;
  }
  if (notebook.codeCells > 30) {
    issues.push(`Large notebook (${notebook.codeCells} code cells) — consider splitting`);
    score -= 10;
  }
  if (notebook.imports.length === 0 && notebook.codeCells > 3) {
    issues.push('No imports found — may be missing dependencies');
    score -= 5;
  }

  return { issues, score: Math.max(0, score) };
}
