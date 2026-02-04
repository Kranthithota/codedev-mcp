/**
 * CI/CD Configuration Parser
 * Parses GitHub Actions, GitLab CI, Jenkins, CircleCI pipelines.
 * Extracts jobs, triggers, dependencies, and potential issues.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { listFiles } from '../search/fast-search.js';
import path from 'node:path';

export interface CICDJob {
  name: string;
  triggers: string[];
  steps: string[];
  runsOn?: string;
  dependsOn?: string[];
  env?: Record<string, string>;
  secrets?: string[];
  timeout?: string;
}

export interface CICDPipeline {
  platform: 'github-actions' | 'gitlab-ci' | 'jenkins' | 'circleci' | 'unknown';
  file: string;
  name?: string;
  triggers: string[];
  jobs: CICDJob[];
  issues: { severity: 'warning' | 'error'; message: string; line?: number }[];
}

export interface CICDResult {
  pipelines: CICDPipeline[];
  summary: { totalPipelines: number; totalJobs: number; totalIssues: number };
}

function parseGitHubActions(content: string, file: string): CICDPipeline {
  const jobs: CICDJob[] = [];
  const triggers: string[] = [];
  const issues: CICDPipeline['issues'] = [];
  let pipelineName = '';
  const lines = content.split('\n');

  // Extract name
  const nameMatch = content.match(/^name:\s*(.+)/m);
  if (nameMatch) pipelineName = nameMatch[1].trim().replace(/['"]/g, '');

  // Extract triggers (on: section)
  const onMatch = content.match(/^on:\s*\n((?:\s+.+\n)*)/m);
  if (onMatch) {
    const triggerLines = onMatch[1].split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    for (const tl of triggerLines) {
      const trigger = tl.trim().replace(/:$/, '');
      if (trigger && !trigger.startsWith('-') && !trigger.startsWith('#')) {
        triggers.push(trigger);
      }
    }
  }
  // Single-line triggers: on: [push, pull_request]
  const onSingleMatch = content.match(/^on:\s*\[([^\]]+)\]/m);
  if (onSingleMatch) {
    triggers.push(...onSingleMatch[1].split(',').map((t) => t.trim()));
  }
  const onSimpleMatch = content.match(/^on:\s+(\w+)/m);
  if (onSimpleMatch && triggers.length === 0) triggers.push(onSimpleMatch[1]);

  // Extract jobs
  const jobsSection = content.indexOf('\njobs:');
  if (jobsSection >= 0) {
    const jobContent = content.slice(jobsSection);
    const jobMatches = jobContent.matchAll(/^ {2}(\w[\w-]*):/gm);
    for (const match of jobMatches) {
      const jobName = match[1];
      if (jobName === 'jobs') continue;

      const job: CICDJob = { name: jobName, triggers: [], steps: [] };

      // Find job block
      const jobStart = jobContent.indexOf(`  ${jobName}:`);
      const nextJob = jobContent.slice(jobStart + 1).search(/^\s{2}\w/m);
      const jobBlock = nextJob > 0 ? jobContent.slice(jobStart, jobStart + 1 + nextJob) : jobContent.slice(jobStart);

      // runs-on
      const runsOn = jobBlock.match(/runs-on:\s*(.+)/);
      if (runsOn) job.runsOn = runsOn[1].trim();

      // needs (dependencies)
      const needs = jobBlock.match(/needs:\s*\[?([^\]\n]+)/);
      if (needs) job.dependsOn = needs[1].split(',').map((n) => n.trim().replace(/['"]/g, ''));

      // steps
      const stepMatches = jobBlock.matchAll(/- (?:name:\s*(.+)|uses:\s*(.+)|run:\s*(.+))/g);
      for (const step of stepMatches) {
        job.steps.push(step[1] || step[2] || step[3] || 'unnamed step');
      }

      // secrets
      const secretMatches = jobBlock.matchAll(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g);
      const secrets = new Set<string>();
      for (const s of secretMatches) secrets.add(s[1]);
      if (secrets.size > 0) job.secrets = [...secrets];

      jobs.push(job);
    }
  }

  // Common issues
  if (triggers.length === 0)
    issues.push({ severity: 'warning', message: 'No triggers defined — workflow will never run automatically' });
  for (const job of jobs) {
    if (!job.runsOn) issues.push({ severity: 'warning', message: `Job "${job.name}" has no runs-on defined` });
    for (const step of job.steps) {
      if (step.includes('@master') || step.includes('@main')) {
        issues.push({ severity: 'warning', message: `Job "${job.name}" uses unpinned action ref: ${step}` });
      }
    }
  }

  // Check for hardcoded secrets
  for (let i = 0; i < lines.length; i++) {
    if (
      /password|secret|token|api[_-]?key/i.test(lines[i]) &&
      !lines[i].includes('secrets.') &&
      !lines[i].includes('${{')
    ) {
      if (lines[i].includes(':') && !lines[i].trim().startsWith('#')) {
        issues.push({ severity: 'error', message: `Possible hardcoded secret at line ${i + 1}`, line: i + 1 });
      }
    }
  }

  return { platform: 'github-actions', file, name: pipelineName, triggers, jobs, issues };
}

function parseGitLabCI(content: string, file: string): CICDPipeline {
  const jobs: CICDJob[] = [];
  const issues: CICDPipeline['issues'] = [];
  const lines = content.split('\n');

  // GitLab CI: top-level keys that aren't reserved are jobs
  const reserved = new Set([
    'image',
    'services',
    'stages',
    'variables',
    'before_script',
    'after_script',
    'cache',
    'include',
    'workflow',
    'default',
    'pages',
  ]);
  let currentJobName = '';
  let currentJob: CICDJob | null = null;

  for (const line of lines) {
    // Top-level key (no indentation, ends with colon)
    const topLevel = line.match(/^(\w[\w-]*):/);
    if (topLevel && !reserved.has(topLevel[1])) {
      if (currentJob) jobs.push(currentJob);
      currentJobName = topLevel[1];
      currentJob = { name: currentJobName, triggers: [], steps: [] };
      continue;
    }

    if (currentJob) {
      const trimmed = line.trim();
      if (/^stage:\s*(.+)/.test(trimmed)) {
        currentJob.triggers.push(trimmed.match(/^stage:\s*(.+)/)![1]);
      }
      if (/^script:/.test(trimmed) || /^-\s+(.+)/.test(trimmed)) {
        const cmd = trimmed.replace(/^-\s+/, '').replace(/^script:\s*/, '');
        if (cmd && cmd !== 'script:') currentJob.steps.push(cmd);
      }
      if (/^needs:/.test(trimmed)) {
        const depsMatch = line.match(/needs:\s*\[([^\]]+)\]/);
        if (depsMatch) currentJob.dependsOn = depsMatch[1].split(',').map((d) => d.trim().replace(/['"]/g, ''));
      }
    }
  }
  if (currentJob) jobs.push(currentJob);

  // Extract stages for triggers
  const stagesMatch = content.match(/^stages:\s*\n((?:\s+- .+\n)*)/m);
  const stages = stagesMatch
    ? stagesMatch[1]
        .split('\n')
        .map((l) => l.trim().replace(/^- /, ''))
        .filter(Boolean)
    : [];

  return { platform: 'gitlab-ci', file, triggers: stages, jobs, issues };
}

/**
 *
 * @param cwd
 */
export async function parseCICD(cwd: string): Promise<CICDResult> {
  const pipelines: CICDPipeline[] = [];

  // GitHub Actions
  try {
    const ghDir = path.join(cwd, '.github', 'workflows');
    const ghFiles = await listFiles(ghDir, { glob: '*.{yml,yaml}' }).catch(() => [] as string[]);
    for (const file of ghFiles) {
      try {
        const content = await readFile(path.resolve(ghDir, file), 'utf-8');
        pipelines.push(parseGitHubActions(content, `.github/workflows/${file}`));
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no github actions */
  }

  // GitLab CI
  const gitlabFile = path.join(cwd, '.gitlab-ci.yml');
  if (existsSync(gitlabFile)) {
    try {
      const content = await readFile(gitlabFile, 'utf-8');
      pipelines.push(parseGitLabCI(content, '.gitlab-ci.yml'));
    } catch {
      /* skip */
    }
  }

  // Jenkinsfile
  const jenkinsFile = path.join(cwd, 'Jenkinsfile');
  if (existsSync(jenkinsFile)) {
    try {
      const content = await readFile(jenkinsFile, 'utf-8');
      const stages = [...content.matchAll(/stage\s*\(\s*['"](.+?)['"]\s*\)/g)].map((m) => m[1]);
      pipelines.push({
        platform: 'jenkins',
        file: 'Jenkinsfile',
        triggers: [],
        jobs: stages.map((s) => ({ name: s, triggers: [], steps: [] })),
        issues: [],
      });
    } catch {
      /* skip */
    }
  }

  // CircleCI
  const circleFile = path.join(cwd, '.circleci', 'config.yml');
  if (existsSync(circleFile)) {
    try {
      const content = await readFile(circleFile, 'utf-8');
      const jobMatches = [...content.matchAll(/^ {2}(\w[\w-]*):/gm)];
      pipelines.push({
        platform: 'circleci',
        file: '.circleci/config.yml',
        triggers: [],
        jobs: jobMatches.map((m) => ({ name: m[1], triggers: [], steps: [] })),
        issues: [],
      });
    } catch {
      /* skip */
    }
  }

  const totalJobs = pipelines.reduce((sum, p) => sum + p.jobs.length, 0);
  const totalIssues = pipelines.reduce((sum, p) => sum + p.issues.length, 0);

  return {
    pipelines,
    summary: { totalPipelines: pipelines.length, totalJobs, totalIssues },
  };
}
