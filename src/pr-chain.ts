import type { SpritesClient } from '@fly/sprites';
import { shellExec } from './shell-exec.ts';

export interface PRInfo {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  isDraft: boolean;
  url: string;
}

export interface PRTreeNode {
  branch: string;
  pr?: PRInfo;
  children: PRTreeNode[];
}

interface CacheEntry {
  data: PRInfo[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

export function clearPRCache(vmName?: string): void {
  if (vmName) {
    cache.delete(vmName);
  } else {
    cache.clear();
  }
}

export async function fetchPRChain(client: SpritesClient, vmName: string): Promise<PRInfo[]> {
  const cached = cache.get(vmName);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const sprite = client.sprite(vmName);
  const { stdout } = await shellExec(sprite,
    'cd /root && gh pr list --state all --json number,title,headRefName,baseRefName,state,isDraft,url --limit 100 2>&1',
  );
  const raw = String(stdout).trim();

  if (!raw.startsWith('[')) {
    throw new Error(raw || 'No output from gh pr list');
  }

  const prs: PRInfo[] = JSON.parse(raw);
  cache.set(vmName, { data: prs, fetchedAt: Date.now() });
  return prs;
}

export async function getCurrentBranch(client: SpritesClient, vmName: string): Promise<string> {
  const sprite = client.sprite(vmName);
  const { stdout } = await shellExec(sprite,
    'cd /root && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""',
  );
  return String(stdout).trim();
}

export async function getDefaultBranch(client: SpritesClient, vmName: string): Promise<string> {
  const sprite = client.sprite(vmName);
  const { stdout } = await shellExec(sprite,
    'cd /root && git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed "s@^refs/remotes/origin/@@" || echo "main"',
  );
  return String(stdout).trim() || 'main';
}

export function buildPRTree(prs: PRInfo[], rootBranch: string): PRTreeNode {
  const byBase = new Map<string, PRInfo[]>();
  for (const pr of prs) {
    const list = byBase.get(pr.baseRefName) ?? [];
    list.push(pr);
    byBase.set(pr.baseRefName, list);
  }

  function buildChildren(branch: string): PRTreeNode[] {
    const children = byBase.get(branch) ?? [];
    children.sort((a, b) => a.number - b.number);
    return children.map(pr => ({
      branch: pr.headRefName,
      pr,
      children: buildChildren(pr.headRefName),
    }));
  }

  return {
    branch: rootBranch,
    children: buildChildren(rootBranch),
  };
}

function statusColor(state: string, isDraft: boolean): string {
  if (isDraft) return 'yellow';
  switch (state) {
    case 'MERGED': return 'green';
    case 'OPEN': return 'cyan';
    case 'CLOSED': return 'red';
    default: return 'white';
  }
}

function statusLabel(state: string, isDraft: boolean): string {
  if (isDraft) return 'DRAFT';
  return state;
}

export function renderPRTree(tree: PRTreeNode, currentBranch: string, width: number): string[] {
  const lines: string[] = [];

  // Build set of branch names that have a MERGED PR (for stale detection)
  const mergedBranches = new Set<string>();
  function collectMerged(node: PRTreeNode) {
    if (node.pr?.state === 'MERGED') {
      mergedBranches.add(node.branch);
    }
    for (const child of node.children) {
      collectMerged(child);
    }
  }
  collectMerged(tree);

  lines.push(`  ${tree.branch}`);

  function renderNode(node: PRTreeNode, prefix: string, isLast: boolean) {
    const connector = isLast ? '└─' : '├─';
    const pr = node.pr;
    if (pr) {
      const color = statusColor(pr.state, pr.isDraft);
      const label = statusLabel(pr.state, pr.isDraft);
      const current = node.branch === currentBranch ? '  {bold}← current{/bold}' : '';
      // Stale: PR's base branch has a merged PR (parent was merged)
      const stale = pr.state !== 'MERGED' && pr.state !== 'CLOSED' && mergedBranches.has(pr.baseRefName)
        ? '  {red-fg}⚠ STALE{/red-fg}' : '';
      const prLine = `  ${prefix}${connector} {${color}-fg}#${pr.number}{/${color}-fg} ${pr.headRefName} {${color}-fg}${label}{/${color}-fg}${stale}${current}`;
      lines.push(prLine);
    }

    const childPrefix = prefix + (isLast ? '   ' : '│  ');
    node.children.forEach((child, i) => {
      renderNode(child, childPrefix, i === node.children.length - 1);
    });
  }

  tree.children.forEach((child, i) => {
    renderNode(child, '', i === tree.children.length - 1);
  });

  if (tree.children.length === 0) {
    lines.push('  {gray-fg}(no pull requests found){/gray-fg}');
  }

  lines.push('');
  const currentMarker = currentBranch
    ? `  {bold}← current branch: ${currentBranch}{/bold}`
    : '';
  if (currentMarker) {
    lines.push(currentMarker);
  }

  return lines;
}

/**
 * Find PRs that are stale — their base branch has a merged PR,
 * meaning the parent was merged and the child needs rebasing/retargeting.
 */
export function findStalePRs(prs: PRInfo[], defaultBranch: string): PRInfo[] {
  const mergedHeadBranches = new Set<string>();
  for (const pr of prs) {
    if (pr.state === 'MERGED') {
      mergedHeadBranches.add(pr.headRefName);
    }
  }

  return prs.filter(pr =>
    pr.state !== 'MERGED' &&
    pr.state !== 'CLOSED' &&
    mergedHeadBranches.has(pr.baseRefName),
  );
}
