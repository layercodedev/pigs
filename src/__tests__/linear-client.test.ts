import { describe, it, expect } from 'bun:test';
import { renderLinearIssues } from '../linear-client.ts';
import type { LinearIssue } from '../linear-client.ts';

function makeIssue(overrides: Partial<LinearIssue> & Pick<LinearIssue, 'identifier' | 'title'>): LinearIssue {
  return {
    id: 'test-id',
    description: null,
    branchName: 'feat/test',
    url: 'https://linear.app/test',
    priority: 0,
    state: { name: 'Todo', type: 'unstarted' },
    labels: { nodes: [] },
    ...overrides,
  };
}

describe('renderLinearIssues', () => {
  it('should show empty message when no issues', () => {
    const lines = renderLinearIssues([], 0, 80);
    expect(lines.some(l => l.includes('No assigned issues found'))).toBe(true);
  });

  it('should render a single issue with identifier and title', () => {
    const issues = [makeIssue({ identifier: 'ENG-123', title: 'Fix login bug' })];
    const lines = renderLinearIssues(issues, 0, 80);
    expect(lines.some(l => l.includes('ENG-123'))).toBe(true);
    expect(lines.some(l => l.includes('Fix login bug'))).toBe(true);
  });

  it('should show state name in brackets', () => {
    const issues = [makeIssue({ identifier: 'ENG-1', title: 'Test', state: { name: 'In Progress', type: 'started' } })];
    const lines = renderLinearIssues(issues, 0, 80);
    expect(lines.some(l => l.includes('[In Progress]'))).toBe(true);
  });

  it('should highlight selected issue with > marker', () => {
    const issues = [
      makeIssue({ identifier: 'ENG-1', title: 'First' }),
      makeIssue({ identifier: 'ENG-2', title: 'Second' }),
    ];
    const lines = renderLinearIssues(issues, 0, 80);
    const firstLine = lines.find(l => l.includes('ENG-1'));
    const secondLine = lines.find(l => l.includes('ENG-2'));
    expect(firstLine).toContain('>');
    expect(secondLine).not.toContain('>');
  });

  it('should highlight second issue when selectedIndex is 1', () => {
    const issues = [
      makeIssue({ identifier: 'ENG-1', title: 'First' }),
      makeIssue({ identifier: 'ENG-2', title: 'Second' }),
    ];
    const lines = renderLinearIssues(issues, 1, 80);
    const firstLine = lines.find(l => l.includes('ENG-1'));
    const secondLine = lines.find(l => l.includes('ENG-2'));
    expect(firstLine).not.toContain('>');
    expect(secondLine).toContain('>');
  });

  it('should show priority labels for urgent and high', () => {
    const issues = [
      makeIssue({ identifier: 'ENG-1', title: 'Urgent task', priority: 1 }),
      makeIssue({ identifier: 'ENG-2', title: 'High task', priority: 2 }),
    ];
    const lines = renderLinearIssues(issues, 0, 80);
    expect(lines.some(l => l.includes('Urgent'))).toBe(true);
    expect(lines.some(l => l.includes('High'))).toBe(true);
  });

  it('should not show priority label for no-priority (0)', () => {
    const issues = [makeIssue({ identifier: 'ENG-1', title: 'No priority', priority: 0 })];
    const lines = renderLinearIssues(issues, 0, 80);
    // Should not contain any priority label keywords
    const issueLine = lines.find(l => l.includes('ENG-1'))!;
    expect(issueLine).not.toContain('Urgent');
    expect(issueLine).not.toContain('High');
    expect(issueLine).not.toContain('Medium');
    expect(issueLine).not.toContain('Low');
  });

  it('should show labels', () => {
    const issues = [makeIssue({
      identifier: 'ENG-1',
      title: 'Labeled',
      labels: { nodes: [{ name: 'bug' }, { name: 'frontend' }] },
    })];
    const lines = renderLinearIssues(issues, 0, 80);
    expect(lines.some(l => l.includes('bug'))).toBe(true);
    expect(lines.some(l => l.includes('frontend'))).toBe(true);
  });

  it('should show issue count in footer', () => {
    const issues = [
      makeIssue({ identifier: 'ENG-1', title: 'First' }),
      makeIssue({ identifier: 'ENG-2', title: 'Second' }),
      makeIssue({ identifier: 'ENG-3', title: 'Third' }),
    ];
    const lines = renderLinearIssues(issues, 0, 80);
    expect(lines.some(l => l.includes('3 issues'))).toBe(true);
  });

  it('should show singular "issue" for single issue', () => {
    const issues = [makeIssue({ identifier: 'ENG-1', title: 'Only one' })];
    const lines = renderLinearIssues(issues, 0, 80);
    expect(lines.some(l => l.includes('1 issue') && !l.includes('1 issues'))).toBe(true);
  });

  it('should truncate long titles', () => {
    const longTitle = 'A'.repeat(100);
    const issues = [makeIssue({ identifier: 'ENG-1', title: longTitle })];
    const lines = renderLinearIssues(issues, 0, 60);
    const issueLine = lines.find(l => l.includes('ENG-1'))!;
    expect(issueLine).toContain('...');
    // Should not contain the full title
    expect(issueLine).not.toContain(longTitle);
  });
});
