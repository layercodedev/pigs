export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  branchName: string;
  url: string;
  priority: number;
  state: { name: string; type: string };
  labels: { nodes: { name: string }[] };
}

interface CacheEntry {
  data: LinearIssue[];
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 30_000;

export function clearLinearCache(): void {
  cache = null;
}

export async function fetchMyIssues(): Promise<LinearIssue[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error('LINEAR_API_KEY environment variable is not set');
  }

  const query = `query {
    viewer {
      assignedIssues(
        filter: { state: { type: { nin: ["completed", "canceled"] } } }
        first: 50
        orderBy: updatedAt
      ) {
        nodes {
          id
          identifier
          title
          description
          branchName
          url
          priority
          state { name type }
          labels { nodes { name } }
        }
      }
    }
  }`;

  const resp = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
    },
    body: JSON.stringify({ query }),
  });

  if (!resp.ok) {
    throw new Error(`Linear API error: ${resp.status} ${resp.statusText}`);
  }

  const json = await resp.json() as any;
  if (json.errors?.length) {
    throw new Error(`Linear API: ${json.errors[0].message}`);
  }

  const issues: LinearIssue[] = json.data.viewer.assignedIssues.nodes;
  cache = { data: issues, fetchedAt: Date.now() };
  return issues;
}

const PRIORITY_LABELS: Record<number, string> = {
  0: '',
  1: '{red-fg}Urgent{/red-fg}',
  2: '{yellow-fg}High{/yellow-fg}',
  3: '{cyan-fg}Medium{/cyan-fg}',
  4: '{gray-fg}Low{/gray-fg}',
};

export function renderLinearIssues(issues: LinearIssue[], selectedIndex: number, width: number): string[] {
  if (issues.length === 0) {
    return [
      '',
      '  {gray-fg}No assigned issues found{/gray-fg}',
      '',
      '  Showing non-completed issues assigned to you.',
    ];
  }

  const lines: string[] = [''];
  issues.forEach((issue, i) => {
    const isSelected = i === selectedIndex;
    const marker = isSelected ? '{yellow-fg}>{/yellow-fg}' : ' ';
    const highlight = isSelected ? '{bold}' : '';
    const highlightEnd = isSelected ? '{/bold}' : '';

    const priority = PRIORITY_LABELS[issue.priority] ?? '';
    const priorityStr = priority ? ` ${priority}` : '';
    const stateStr = ` {green-fg}[${issue.state.name}]{/green-fg}`;
    const labelNames = issue.labels.nodes.map(l => l.name);
    const labelsStr = labelNames.length > 0 ? ` {magenta-fg}${labelNames.join(', ')}{/magenta-fg}` : '';

    const maxTitleLen = width - 30;
    const truncTitle = issue.title.length > maxTitleLen ? issue.title.slice(0, maxTitleLen - 3) + '...' : issue.title;

    lines.push(`  ${marker} ${highlight}{cyan-fg}${issue.identifier}{/cyan-fg} ${truncTitle}${highlightEnd}${stateStr}${priorityStr}${labelsStr}`);
  });

  lines.push('');
  lines.push(`  {gray-fg}${issues.length} issue${issues.length !== 1 ? 's' : ''}{/gray-fg}`);

  return lines;
}
