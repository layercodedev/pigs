import { describe, it, expect } from 'vitest';
import { buildPRTree, renderPRTree, findStalePRs } from '../pr-chain.ts';
import type { PRInfo } from '../pr-chain.ts';

function makePR(overrides: Partial<PRInfo> & Pick<PRInfo, 'number' | 'headRefName' | 'baseRefName'>): PRInfo {
  return {
    title: overrides.headRefName,
    state: 'OPEN',
    isDraft: false,
    url: `https://github.com/test/repo/pull/${overrides.number}`,
    ...overrides,
  };
}

describe('buildPRTree', () => {
  it('should create a root node with no children when no PRs exist', () => {
    const tree = buildPRTree([], 'main');
    expect(tree.branch).toBe('main');
    expect(tree.children).toEqual([]);
    expect(tree.pr).toBeUndefined();
  });

  it('should group PRs that target root branch as direct children', () => {
    const prs = [
      makePR({ number: 1, headRefName: 'feat-a', baseRefName: 'main' }),
      makePR({ number: 2, headRefName: 'feat-b', baseRefName: 'main' }),
    ];
    const tree = buildPRTree(prs, 'main');
    expect(tree.children).toHaveLength(2);
    expect(tree.children[0].branch).toBe('feat-a');
    expect(tree.children[0].pr?.number).toBe(1);
    expect(tree.children[1].branch).toBe('feat-b');
    expect(tree.children[1].pr?.number).toBe(2);
  });

  it('should build nested chains based on baseRefName', () => {
    const prs = [
      makePR({ number: 12, headRefName: 'add-auth', baseRefName: 'main' }),
      makePR({ number: 13, headRefName: 'api-routes', baseRefName: 'add-auth' }),
      makePR({ number: 14, headRefName: 'add-tests', baseRefName: 'api-routes' }),
    ];
    const tree = buildPRTree(prs, 'main');
    expect(tree.children).toHaveLength(1);
    const authNode = tree.children[0];
    expect(authNode.branch).toBe('add-auth');
    expect(authNode.children).toHaveLength(1);
    const routesNode = authNode.children[0];
    expect(routesNode.branch).toBe('api-routes');
    expect(routesNode.children).toHaveLength(1);
    const testsNode = routesNode.children[0];
    expect(testsNode.branch).toBe('add-tests');
    expect(testsNode.children).toHaveLength(0);
  });

  it('should sort children by PR number', () => {
    const prs = [
      makePR({ number: 16, headRefName: 'fix-typo', baseRefName: 'main' }),
      makePR({ number: 12, headRefName: 'add-auth', baseRefName: 'main' }),
      makePR({ number: 14, headRefName: 'feat-c', baseRefName: 'main' }),
    ];
    const tree = buildPRTree(prs, 'main');
    expect(tree.children.map(c => c.pr?.number)).toEqual([12, 14, 16]);
  });

  it('should handle multiple branches in a chain with siblings', () => {
    const prs = [
      makePR({ number: 12, headRefName: 'add-auth', baseRefName: 'main' }),
      makePR({ number: 13, headRefName: 'api-routes', baseRefName: 'add-auth' }),
      makePR({ number: 14, headRefName: 'add-tests', baseRefName: 'api-routes' }),
      makePR({ number: 16, headRefName: 'fix-typo', baseRefName: 'main' }),
    ];
    const tree = buildPRTree(prs, 'main');
    expect(tree.children).toHaveLength(2);
    expect(tree.children[0].branch).toBe('add-auth');
    expect(tree.children[0].children).toHaveLength(1);
    expect(tree.children[1].branch).toBe('fix-typo');
    expect(tree.children[1].children).toHaveLength(0);
  });

  it('should ignore PRs with unknown base branches (orphans)', () => {
    const prs = [
      makePR({ number: 1, headRefName: 'feat-a', baseRefName: 'main' }),
      makePR({ number: 2, headRefName: 'feat-b', baseRefName: 'nonexistent-branch' }),
    ];
    const tree = buildPRTree(prs, 'main');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].branch).toBe('feat-a');
  });
});

describe('renderPRTree', () => {
  it('should render empty tree with no-PRs message', () => {
    const tree = buildPRTree([], 'main');
    const lines = renderPRTree(tree, 'main', 80);
    expect(lines[0]).toContain('main');
    expect(lines.some(l => l.includes('no pull requests found'))).toBe(true);
  });

  it('should render a simple chain with proper box drawing characters', () => {
    const prs = [
      makePR({ number: 12, headRefName: 'add-auth', baseRefName: 'main', state: 'MERGED' }),
      makePR({ number: 16, headRefName: 'fix-typo', baseRefName: 'main', state: 'OPEN' }),
    ];
    const tree = buildPRTree(prs, 'main');
    const lines = renderPRTree(tree, '', 80);
    expect(lines[0]).toContain('main');
    expect(lines.some(l => l.includes('#12') && l.includes('add-auth') && l.includes('MERGED'))).toBe(true);
    expect(lines.some(l => l.includes('#16') && l.includes('fix-typo') && l.includes('OPEN'))).toBe(true);
    // First child uses ├─, last child uses └─
    expect(lines.some(l => l.includes('├─'))).toBe(true);
    expect(lines.some(l => l.includes('└─'))).toBe(true);
  });

  it('should highlight current branch with ← current', () => {
    const prs = [
      makePR({ number: 13, headRefName: 'api-routes', baseRefName: 'main', state: 'OPEN' }),
    ];
    const tree = buildPRTree(prs, 'main');
    const lines = renderPRTree(tree, 'api-routes', 80);
    expect(lines.some(l => l.includes('← current'))).toBe(true);
  });

  it('should not highlight branches that are not current', () => {
    const prs = [
      makePR({ number: 13, headRefName: 'api-routes', baseRefName: 'main', state: 'OPEN' }),
    ];
    const tree = buildPRTree(prs, 'main');
    const lines = renderPRTree(tree, 'other-branch', 80);
    // The inline ← current marker should not appear on any PR line
    const prLines = lines.filter(l => l.includes('#13'));
    expect(prLines.some(l => l.includes('← current'))).toBe(false);
    // But the footer should still show current branch
    expect(lines.some(l => l.includes('current branch: other-branch'))).toBe(true);
  });

  it('should show current branch footer', () => {
    const prs = [
      makePR({ number: 1, headRefName: 'feat-a', baseRefName: 'main' }),
    ];
    const tree = buildPRTree(prs, 'main');
    const lines = renderPRTree(tree, 'feat-a', 80);
    expect(lines.some(l => l.includes('current branch: feat-a'))).toBe(true);
  });

  it('should show DRAFT label for draft PRs', () => {
    const prs = [
      makePR({ number: 14, headRefName: 'add-tests', baseRefName: 'main', state: 'OPEN', isDraft: true }),
    ];
    const tree = buildPRTree(prs, 'main');
    const lines = renderPRTree(tree, '', 80);
    expect(lines.some(l => l.includes('DRAFT'))).toBe(true);
    expect(lines.some(l => l.includes('OPEN'))).toBe(false);
  });

  it('should render nested chain with proper indentation', () => {
    const prs = [
      makePR({ number: 12, headRefName: 'add-auth', baseRefName: 'main', state: 'MERGED' }),
      makePR({ number: 13, headRefName: 'api-routes', baseRefName: 'add-auth', state: 'OPEN' }),
      makePR({ number: 14, headRefName: 'add-tests', baseRefName: 'api-routes', state: 'OPEN', isDraft: true }),
      makePR({ number: 16, headRefName: 'fix-typo', baseRefName: 'main', state: 'OPEN' }),
    ];
    const tree = buildPRTree(prs, 'main');
    const lines = renderPRTree(tree, 'api-routes', 80);
    // Should have all 4 PRs rendered
    expect(lines.some(l => l.includes('#12'))).toBe(true);
    expect(lines.some(l => l.includes('#13'))).toBe(true);
    expect(lines.some(l => l.includes('#14'))).toBe(true);
    expect(lines.some(l => l.includes('#16'))).toBe(true);
  });

  it('should show STALE indicator for PRs whose parent branch is merged', () => {
    const prs = [
      makePR({ number: 12, headRefName: 'add-auth', baseRefName: 'main', state: 'MERGED' }),
      makePR({ number: 13, headRefName: 'api-routes', baseRefName: 'add-auth', state: 'OPEN' }),
      makePR({ number: 14, headRefName: 'add-tests', baseRefName: 'api-routes', state: 'OPEN', isDraft: true }),
      makePR({ number: 16, headRefName: 'fix-typo', baseRefName: 'main', state: 'OPEN' }),
    ];
    const tree = buildPRTree(prs, 'main');
    const lines = renderPRTree(tree, 'api-routes', 80);
    // #13 targets add-auth which is MERGED → should be stale
    const line13 = lines.find(l => l.includes('#13'));
    expect(line13).toContain('STALE');
    // #14 targets api-routes which is NOT merged → should not be stale
    const line14 = lines.find(l => l.includes('#14'));
    expect(line14).not.toContain('STALE');
    // #12 is MERGED itself → should not be stale
    const line12 = lines.find(l => l.includes('#12'));
    expect(line12).not.toContain('STALE');
    // #16 targets main → should not be stale
    const line16 = lines.find(l => l.includes('#16'));
    expect(line16).not.toContain('STALE');
  });

  it('should not show STALE for closed or merged PRs even if parent is merged', () => {
    const prs = [
      makePR({ number: 12, headRefName: 'add-auth', baseRefName: 'main', state: 'MERGED' }),
      makePR({ number: 13, headRefName: 'api-routes', baseRefName: 'add-auth', state: 'MERGED' }),
      makePR({ number: 14, headRefName: 'add-tests', baseRefName: 'add-auth', state: 'CLOSED' }),
    ];
    const tree = buildPRTree(prs, 'main');
    const lines = renderPRTree(tree, '', 80);
    // #13 is MERGED → should not be stale even though parent is merged
    const line13 = lines.find(l => l.includes('#13'));
    expect(line13).not.toContain('STALE');
    // #14 is CLOSED → should not be stale
    const line14 = lines.find(l => l.includes('#14'));
    expect(line14).not.toContain('STALE');
  });
});

describe('findStalePRs', () => {
  it('should return empty array when no PRs are stale', () => {
    const prs = [
      makePR({ number: 1, headRefName: 'feat-a', baseRefName: 'main', state: 'OPEN' }),
      makePR({ number: 2, headRefName: 'feat-b', baseRefName: 'main', state: 'OPEN' }),
    ];
    expect(findStalePRs(prs, 'main')).toEqual([]);
  });

  it('should detect PRs whose base branch has a merged PR', () => {
    const prs = [
      makePR({ number: 12, headRefName: 'add-auth', baseRefName: 'main', state: 'MERGED' }),
      makePR({ number: 13, headRefName: 'api-routes', baseRefName: 'add-auth', state: 'OPEN' }),
      makePR({ number: 14, headRefName: 'add-tests', baseRefName: 'api-routes', state: 'OPEN', isDraft: true }),
      makePR({ number: 16, headRefName: 'fix-typo', baseRefName: 'main', state: 'OPEN' }),
    ];
    const stale = findStalePRs(prs, 'main');
    expect(stale).toHaveLength(1);
    expect(stale[0].number).toBe(13);
  });

  it('should not include merged or closed PRs in stale results', () => {
    const prs = [
      makePR({ number: 12, headRefName: 'add-auth', baseRefName: 'main', state: 'MERGED' }),
      makePR({ number: 13, headRefName: 'api-routes', baseRefName: 'add-auth', state: 'MERGED' }),
      makePR({ number: 14, headRefName: 'add-tests', baseRefName: 'add-auth', state: 'CLOSED' }),
    ];
    const stale = findStalePRs(prs, 'main');
    expect(stale).toHaveLength(0);
  });

  it('should detect multiple stale PRs in a chain', () => {
    const prs = [
      makePR({ number: 10, headRefName: 'feat-a', baseRefName: 'main', state: 'MERGED' }),
      makePR({ number: 11, headRefName: 'feat-b', baseRefName: 'feat-a', state: 'MERGED' }),
      makePR({ number: 12, headRefName: 'feat-c', baseRefName: 'feat-a', state: 'OPEN' }),
      makePR({ number: 13, headRefName: 'feat-d', baseRefName: 'feat-b', state: 'OPEN' }),
    ];
    const stale = findStalePRs(prs, 'main');
    expect(stale).toHaveLength(2);
    expect(stale.map(p => p.number).sort()).toEqual([12, 13]);
  });

  it('should return empty array for no PRs', () => {
    expect(findStalePRs([], 'main')).toEqual([]);
  });
});
