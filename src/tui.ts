import blessed from 'blessed';
import type { AppState, SortMode, VM } from './types.ts';
import { historyUp, historyDown, resetCursor } from './prompt-history.ts';
import { getOutput } from './output-buffer.ts';
import { queueSize, getQueue } from './prompt-queue.ts';
import { stripAnsi } from './ansi.ts';
import { zoomPane, isZoomed, focusRightPane, setLeftPaneWidth } from './tmux.ts';

/**
 * Find the index of the next VM that needs attention, starting after currentIndex.
 * Wraps around the list. Returns -1 if no VM needs attention.
 */
export function findNextAttentionIndex(vms: VM[], currentIndex: number): number {
  if (vms.length === 0) return -1;
  for (let offset = 1; offset <= vms.length; offset++) {
    const idx = (currentIndex + offset) % vms.length;
    if (vms[idx].needsAttention) return idx;
  }
  return -1;
}

/**
 * Build a summary string for the sidebar label from a list of VMs.
 * Returns empty string when there are no VMs.
 */
export function buildVmSummary(vms: VM[]): string {
  if (vms.length === 0) return '';

  const total = vms.length;
  const ready = vms.filter(vm => vm.provisioningStatus === 'done').length;
  const setup = vms.filter(vm => vm.provisioningStatus === 'provisioning' || vm.provisioningStatus === 'pending').length;
  const attention = vms.filter(vm => vm.needsAttention).length;
  const failed = vms.filter(vm => vm.provisioningStatus === 'failed').length;

  const parts: string[] = [`${total}`];
  if (ready > 0) parts.push(`${ready} ready`);
  if (setup > 0) parts.push(`${setup} setup`);
  if (attention > 0) parts.push(`${attention} !`);
  if (failed > 0) parts.push(`${failed} fail`);

  return parts.join(', ');
}

/**
 * Filter VMs by a search term. Matches against displayLabel, name, status,
 * and provisioningStatus (case-insensitive).
 */
export function filterVMs(vms: VM[], filter: string): VM[] {
  if (!filter) return vms;
  const term = filter.toLowerCase();
  return vms.filter(vm => {
    const label = (vm.displayLabel ?? vm.name).toLowerCase();
    const status = vm.status.toLowerCase();
    const provStatus = (vm.provisioningStatus ?? '').toLowerCase();
    return label.includes(term) || status.includes(term) || provStatus.includes(term) || vm.name.toLowerCase().includes(term);
  });
}

const SORT_ORDER: SortMode[] = ['default', 'name', 'status', 'attention', 'elapsed'];

/**
 * Cycle to the next sort mode.
 */
export function nextSortMode(current: SortMode): SortMode {
  const idx = SORT_ORDER.indexOf(current);
  return SORT_ORDER[(idx + 1) % SORT_ORDER.length];
}

/**
 * Sort VMs by the given sort mode. Returns a new array (does not mutate input).
 * - default: creation order (no sort)
 * - name: alphabetical by displayLabel/name
 * - status: running first, then stopped, then cold
 * - attention: VMs needing attention first
 * - elapsed: VMs with active tasks first, sorted by longest running
 */
export function sortVMs(vms: VM[], mode: SortMode): VM[] {
  if (mode === 'default') return vms;
  const sorted = [...vms];
  switch (mode) {
    case 'name':
      sorted.sort((a, b) => {
        const aLabel = (a.displayLabel ?? a.name).toLowerCase();
        const bLabel = (b.displayLabel ?? b.name).toLowerCase();
        return aLabel.localeCompare(bLabel);
      });
      break;
    case 'status': {
      const statusOrder: Record<string, number> = { active: 0, idle: 1 };
      sorted.sort((a, b) => (statusOrder[a.status] ?? 2) - (statusOrder[b.status] ?? 2));
      break;
    }
    case 'attention':
      sorted.sort((a, b) => {
        if (a.needsAttention && !b.needsAttention) return -1;
        if (!a.needsAttention && b.needsAttention) return 1;
        return 0;
      });
      break;
    case 'elapsed':
      sorted.sort((a, b) => {
        const aTime = a.taskStartedAt ?? Infinity;
        const bTime = b.taskStartedAt ?? Infinity;
        // Lower start time = running longer = should come first
        return aTime - bTime;
      });
      break;
  }
  return sorted;
}

/**
 * Format an elapsed time from a start timestamp to a compact human-readable string.
 * Returns '' if startTime is undefined/null.
 * Examples: "5s", "1m30s", "1h05m", "2h30m"
 */
export function formatElapsed(startTime: number | undefined, now: number): string {
  if (startTime == null) return '';
  const elapsed = Math.max(0, Math.floor((now - startTime) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h${mins.toString().padStart(2, '0')}m`;
}

/**
 * Build a compact text cell for a single VM in the dashboard grid.
 * Returns an array of lines for display. Width is the max char width.
 */
export function buildDashboardCell(vm: VM, lastLine: string, width: number): string[] {
  const label = vm.displayLabel ?? vm.name;
  const truncLabel = label.length > width - 2 ? label.slice(0, width - 5) + '...' : label;

  // Status line: icon + status + provisioning + attention + elapsed
  const statusIcon = vm.status === 'active' ? '{green-fg}*{/green-fg}' : '{gray-fg}-{/gray-fg}';
  const attention = vm.needsAttention ? ' {red-fg}{bold}!{/bold}{/red-fg}' : '';
  const provLabel = vm.provisioningStatus === 'provisioning' ? ' {yellow-fg}[setup]{/yellow-fg}'
    : vm.provisioningStatus === 'failed' ? ' {red-fg}[fail]{/red-fg}'
    : vm.provisioningStatus === 'pending' ? ' {gray-fg}[wait]{/gray-fg}'
    : '';
  const elapsed = vm.taskStartedAt ? ` {cyan-fg}${formatElapsed(vm.taskStartedAt, Date.now())}{/cyan-fg}` : '';
  const qCount = queueSize(vm.name);
  const queue = qCount > 0 ? ` {magenta-fg}[q:${qCount}]{/magenta-fg}` : '';

  const statusLine = `${statusIcon} ${vm.status}${provLabel}${queue}${elapsed}${attention}`;

  // Last output line - strip ANSI escapes and blessed tags, truncate to fit width
  const cleanLast = stripAnsi(lastLine).replace(/\{[^}]*\}/g, '').trim();
  const truncLast = cleanLast.length > width - 2 ? cleanLast.slice(0, width - 5) + '...' : cleanLast;
  const outputLine = truncLast || '{gray-fg}(no output){/gray-fg}';

  return [truncLabel, statusLine, outputLine];
}

export function createApp() {
  // Override TERM for blessed only — ghostty's RGB underline terminfo causes parse errors
  const originalTerm = process.env.TERM;
  if (process.env.TERM?.includes('ghostty')) {
    process.env.TERM = 'xterm-256color';
  }

  const screen = blessed.screen({
    smartCSR: true,
    title: 'pigs - Claude Agent Branch Manager',
    fullUnicode: true,
  });

  // Restore original TERM so child processes inherit the real terminal type
  process.env.TERM = originalTerm;

  const state: AppState = {
    vms: [],
    activeVmIndex: -1,
    sidebarSelectedIndex: 0,
    mode: 'normal',
    settings: null,
    searchFilter: '',
    sortMode: 'default',
    rightPaneVmName: null,
    sidebarHidden: false,
    repoRoot: '',
  };

  // Sidebar: list of branches on the left (fills entire left pane in tmux split)
  const sidebar = blessed.box({
    parent: screen,
    label: ' Branches ',
    left: 0,
    top: 0,
    width: '100%',
    height: '100%-1',
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'white', bold: true },
    },
    scrollable: true,
    keys: true,
  });

  // Main view: hidden — replaced by the live tmux right pane
  const mainView = blessed.box({
    parent: screen,
    label: ' Console ',
    left: 0,
    top: 0,
    width: 1,
    height: 1,
    hidden: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'green' },
      label: { fg: 'white', bold: true },
    },
    scrollable: true,
    keys: true,
  });

  const noVmMessage = blessed.text({
    parent: mainView,
    content: 'No active branch. Press {bold}c{/bold} to create a new branch.',
    tags: true,
    top: 'center',
    left: 'center',
    style: { fg: 'gray' },
  });

  // Preview text area inside main view (for showing captured output from tmux windows)
  const previewBox = blessed.box({
    parent: mainView,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      style: { bg: 'gray' },
    },
    mouse: true,
    keys: true,
    tags: false,
    hidden: true,
    content: '',
  });

  // Pending action display (shown at top of main view when action in progress)
  const pendingActionDisplay = blessed.text({
    parent: mainView,
    top: 0,
    left: 1,
    right: 1,
    height: 1,
    hidden: true,
    style: { fg: 'yellow', bg: 'black' },
    tags: true,
  });

  // Error display (shown at top of main view when there's an error)
  const errorDisplay = blessed.box({
    parent: mainView,
    top: 0,
    left: 1,
    right: 1,
    height: 3,
    hidden: true,
    style: { fg: 'red', bg: 'black' },
    tags: true,
    content: '',
  });

  const normalStatusText = ' c:create  C:bulk  d:del  D:del-all  r:reprov  l:rename  Enter:open  Tab:toggle  p:prompt  b:bcast  f:ralph  Q:queue  B:bq  x:stop  a:attn  g:prs  L:linear  i:dash  s:sort  /:search  ?:help  q:quit';

  // Status bar at the bottom
  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    style: { bg: 'blue', fg: 'white' },
    content: normalStatusText,
  });

  // Confirm dialog (hidden by default)
  const confirmDialog = blessed.box({
    parent: screen,
    hidden: true,
    top: 'center',
    left: 'center',
    width: 50,
    height: 7,
    border: { type: 'line' },
    style: {
      border: { fg: 'red' },
      bg: 'black',
    },
    label: ' Confirm Delete Branch ',
    content: '',
    tags: true,
  });

  // Prompt input dialog (hidden by default)
  const promptDialog = blessed.box({
    parent: screen,
    hidden: true,
    top: 'center',
    left: 'center',
    width: '80%',
    height: 5,
    border: { type: 'line' },
    style: {
      border: { fg: 'magenta' },
      bg: 'black',
    },
    label: ' Send Prompt to Agent ',
    tags: true,
  });

  const promptInput = blessed.textbox({
    parent: promptDialog,
    top: 0,
    left: 1,
    right: 1,
    height: 1,
    inputOnFocus: true,
    style: {
      fg: 'white',
      bg: 'black',
    },
  });

  const promptHint = blessed.text({
    parent: promptDialog,
    top: 2,
    left: 1,
    content: 'Enter:submit  Escape:cancel',
    style: { fg: 'gray' },
  });

  // Broadcast prompt dialog (hidden by default)
  const broadcastDialog = blessed.box({
    parent: screen,
    hidden: true,
    top: 'center',
    left: 'center',
    width: '80%',
    height: 5,
    border: { type: 'line' },
    style: {
      border: { fg: 'yellow' },
      bg: 'black',
    },
    label: ' Broadcast Prompt to All Agents ',
    tags: true,
  });

  const broadcastInput = blessed.textbox({
    parent: broadcastDialog,
    top: 0,
    left: 1,
    right: 1,
    height: 1,
    inputOnFocus: true,
    style: {
      fg: 'white',
      bg: 'black',
    },
  });

  const broadcastHint = blessed.text({
    parent: broadcastDialog,
    top: 2,
    left: 1,
    content: 'Enter:broadcast to all  Escape:cancel',
    style: { fg: 'gray' },
  });

  // Bulk create dialog (hidden by default)
  const bulkCreateDialog = blessed.box({
    parent: screen,
    hidden: true,
    top: 'center',
    left: 'center',
    width: 50,
    height: 5,
    border: { type: 'line' },
    style: {
      border: { fg: 'green' },
      bg: 'black',
    },
    label: ' Create Multiple Branches ',
    tags: true,
  });

  const bulkCreateInput = blessed.textbox({
    parent: bulkCreateDialog,
    top: 0,
    left: 1,
    right: 1,
    height: 1,
    inputOnFocus: true,
    style: {
      fg: 'white',
      bg: 'black',
    },
  });

  const bulkCreateHint = blessed.text({
    parent: bulkCreateDialog,
    top: 2,
    left: 1,
    content: 'Enter number (1-20)  Escape:cancel',
    style: { fg: 'gray' },
  });

  // Confirm delete all dialog (hidden by default)
  const confirmDeleteAllDialog = blessed.box({
    parent: screen,
    hidden: true,
    top: 'center',
    left: 'center',
    width: 50,
    height: 7,
    border: { type: 'line' },
    style: {
      border: { fg: 'red' },
      bg: 'black',
    },
    label: ' Confirm Delete All Branches ',
    content: '',
    tags: true,
  });

  // Confirm reprovision all dialog (hidden by default)
  const confirmReprovisionAllDialog = blessed.box({
    parent: screen,
    hidden: true,
    top: 'center',
    left: 'center',
    width: 50,
    height: 7,
    border: { type: 'line' },
    style: {
      border: { fg: 'yellow' },
      bg: 'black',
    },
    label: ' Confirm Re-provision All ',
    content: '',
    tags: true,
  });

  // Help screen dialog (hidden by default)
  const helpDialog = blessed.box({
    parent: screen,
    hidden: true,
    top: 'center',
    left: 'center',
    width: '100%-2',
    height: 44,
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
      bg: 'black',
    },
    label: ' Help — Keybindings ',
    tags: true,
    content: [
      '',
      '  {bold}Navigation{/bold}',
      '  j / ↓         Move selection down',
      '  k / ↑         Move selection up',
      '  a             Jump to next branch needing attention',
      '  Enter         Open branch in right pane',
      '  Tab           Toggle sidebar (zoom right pane)',
      '  Ctrl-b ←/→    Switch focus between panes',
      '',
      '  {bold}Branch Management{/bold}',
      '  c             Create a new branch (git worktree)',
      '  C (shift)     Create multiple branches at once',
      '  d             Delete selected branch',
      '  D (shift)     Delete ALL branches at once',
      '  r             Re-provision selected branch (update config)',
      '  R (shift)     Re-provision ALL branches at once',
      '  l             Rename/label selected branch',
      '  t             Retry provisioning on failed branch',
      '',
      '  {bold}Prompts{/bold}',
      '  p             Send prompt to selected branch',
      '  b             Broadcast prompt to all branches',
      '  Q (shift)     Queue prompt for selected branch (auto-sends)',
      '  B (shift)     Queue prompt to ALL branches (broadcast queue)',
      '  x             Stop/cancel running agent (kills tmux window)',
      '  o             Export console log to ~/.pigs/logs/',
      '  v             View/manage prompt queue for selected branch',
      '  ↑ / ↓         Cycle prompt history (in dialog)',
      '',
      '  {bold}Other{/bold}',
      '  L (shift)     View Linear tasks (Space:select  Enter:claim)',
      '  g             View PR chain for selected branch',
      '  i             Toggle fleet dashboard overview',
      '  s             Cycle sort: default/name/status/attention/elapsed',
      '  /             Search/filter branches in sidebar',
      '  E (shift)     Copy error to clipboard',
      '  Escape        Clear search filter (in normal mode)',
      '  ?             Toggle this help screen',
      '  q             Quit',
      '  Ctrl-C        Force quit',
      '',
      '  {bold}Info{/bold}',
      '  Right pane shows active branch terminal (live)',
      '  Elapsed time shown in sidebar when task is running',
      '  Queued prompts [q:N] auto-send when current task finishes',
      '',
      '  {gray-fg}Press ? or Escape to close{/gray-fg}',
    ].join('\n'),
  });

  // Dashboard overlay (hidden by default)
  const dashboardOverlay = blessed.box({
    parent: screen,
    hidden: true,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%-1',
    border: { type: 'line' },
    style: {
      border: { fg: 'magenta' },
      bg: 'black',
      label: { fg: 'white', bold: true },
    },
    label: ' Dashboard — All Agents ',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      style: { bg: 'gray' },
    },
    mouse: true,
    keys: true,
  });

  // Rename dialog (hidden by default)
  const renameDialog = blessed.box({
    parent: screen,
    hidden: true,
    top: 'center',
    left: 'center',
    width: '60%',
    height: 5,
    border: { type: 'line' },
    style: {
      border: { fg: 'green' },
      bg: 'black',
    },
    label: ' Rename Branch ',
    tags: true,
  });

  const renameInput = blessed.textbox({
    parent: renameDialog,
    top: 0,
    left: 1,
    right: 1,
    height: 1,
    inputOnFocus: true,
    style: {
      fg: 'white',
      bg: 'black',
    },
  });

  const renameHint = blessed.text({
    parent: renameDialog,
    top: 2,
    left: 1,
    content: 'Enter:save  Escape:cancel  (empty to reset)',
    style: { fg: 'gray' },
  });

  // Queue prompt dialog (hidden by default)
  const queueDialog = blessed.box({
    parent: screen,
    hidden: true,
    top: 'center',
    left: 'center',
    width: '70%',
    height: 5,
    border: { type: 'line' },
    style: {
      border: { fg: 'magenta' },
      bg: 'black',
    },
    label: ' Queue Prompt ',
    tags: true,
  });

  const queueInput = blessed.textbox({
    parent: queueDialog,
    top: 0,
    left: 1,
    right: 1,
    height: 1,
    inputOnFocus: true,
    style: {
      fg: 'white',
      bg: 'black',
    },
  });

  const queueHint = blessed.text({
    parent: queueDialog,
    top: 2,
    left: 1,
    content: 'Enter:add to queue  Escape:cancel  (auto-sends when current task finishes)',
    style: { fg: 'gray' },
  });

  // Broadcast queue dialog (hidden by default)
  const broadcastQueueDialog = blessed.box({
    parent: screen,
    hidden: true,
    top: 'center',
    left: 'center',
    width: '70%',
    height: 5,
    border: { type: 'line' },
    style: {
      border: { fg: 'yellow' },
      bg: 'black',
    },
    label: ' Broadcast Queue Prompt ',
    tags: true,
  });

  const broadcastQueueInput = blessed.textbox({
    parent: broadcastQueueDialog,
    top: 0,
    left: 1,
    right: 1,
    height: 1,
    inputOnFocus: true,
    style: {
      fg: 'white',
      bg: 'black',
    },
  });

  const broadcastQueueHint = blessed.text({
    parent: broadcastQueueDialog,
    top: 2,
    left: 1,
    content: 'Enter:queue to all VMs  Escape:cancel  (auto-sends when each VM finishes)',
    style: { fg: 'gray' },
  });

  // Ralph iterations dialog (hidden by default) - step 1: ask for iteration count
  const ralphIterationsDialog = blessed.box({
    parent: screen,
    hidden: true,
    top: 'center',
    left: 'center',
    width: 50,
    height: 5,
    border: { type: 'line' },
    style: {
      border: { fg: 'red' },
      bg: 'black',
    },
    label: ' Ralph: Number of Iterations ',
    tags: true,
  });

  const ralphIterationsInput = blessed.textbox({
    parent: ralphIterationsDialog,
    top: 0,
    left: 1,
    right: 1,
    height: 1,
    inputOnFocus: true,
    style: {
      fg: 'white',
      bg: 'black',
    },
  });

  const ralphIterationsHint = blessed.text({
    parent: ralphIterationsDialog,
    top: 2,
    left: 1,
    content: 'Enter number (1-100)  Escape:cancel',
    style: { fg: 'gray' },
  });

  // Ralph prompt dialog (hidden by default) - step 2: ask for prompt text
  const ralphPromptDialog = blessed.box({
    parent: screen,
    hidden: true,
    top: 'center',
    left: 'center',
    width: '80%',
    height: 5,
    border: { type: 'line' },
    style: {
      border: { fg: 'red' },
      bg: 'black',
    },
    label: ' Ralph: Enter Prompt ',
    tags: true,
  });

  const ralphPromptInput = blessed.textbox({
    parent: ralphPromptDialog,
    top: 0,
    left: 1,
    right: 1,
    height: 1,
    inputOnFocus: true,
    style: {
      fg: 'white',
      bg: 'black',
    },
  });

  const ralphPromptHint = blessed.text({
    parent: ralphPromptDialog,
    top: 2,
    left: 1,
    content: 'Enter:run ralph  Escape:cancel  (iterates with --dangerously-skip-permissions)',
    style: { fg: 'gray' },
  });

  let ralphIterationsValue = 5;  // default iterations, stored between steps

  // PR chain overlay (hidden by default)
  const prChainOverlay = blessed.box({
    parent: screen,
    hidden: true,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%-1',
    border: { type: 'line' },
    style: {
      border: { fg: 'green' },
      bg: 'black',
      label: { fg: 'white', bold: true },
    },
    label: ' PR Chain ',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      style: { bg: 'gray' },
    },
    mouse: true,
    keys: true,
  });

  // Linear tasks overlay (hidden by default)
  const linearOverlay = blessed.box({
    parent: screen,
    hidden: true,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%-1',
    border: { type: 'line' },
    style: {
      border: { fg: 'blue' },
      bg: 'black',
      label: { fg: 'white', bold: true },
    },
    label: ' Linear Tasks ',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      style: { bg: 'gray' },
    },
    mouse: true,
    keys: true,
  });

  let linearSelectedIndex = 0;
  let linearIssues: import('./linear-client.ts').LinearIssue[] = [];
  let linearCheckedIds: Set<string> = new Set();

  // Queue viewer overlay (hidden by default)
  const queueViewerOverlay = blessed.box({
    parent: screen,
    hidden: true,
    top: 'center',
    left: 'center',
    width: '70%',
    height: '60%',
    border: { type: 'line' },
    style: {
      border: { fg: 'magenta' },
      bg: 'black',
      label: { fg: 'white', bold: true },
    },
    label: ' Queue Viewer ',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      style: { bg: 'gray' },
    },
    mouse: true,
    keys: true,
  });

  let queueViewerSelectedIndex = 0;

  // Search dialog (hidden by default)
  const searchDialog = blessed.box({
    parent: screen,
    hidden: true,
    bottom: 1,
    left: 0,
    width: 30,
    height: 3,
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
      bg: 'black',
    },
    label: ' Search Branches ',
    tags: true,
  });

  const searchInput = blessed.textbox({
    parent: searchDialog,
    top: 0,
    left: 1,
    right: 1,
    height: 1,
    inputOnFocus: true,
    style: {
      fg: 'white',
      bg: 'black',
    },
  });

  function getFilteredVMs(): VM[] {
    return sortVMs(filterVMs(state.vms, state.searchFilter), state.sortMode);
  }

  function renderSidebar() {
    sidebar.children.forEach((child) => {
      if (child !== sidebar) child.detach();
    });

    // Update sidebar label with branch status summary
    const summary = buildVmSummary(state.vms);
    const filterLabel = state.searchFilter ? ` filter:"${state.searchFilter}"` : '';
    const sortLabel = state.sortMode !== 'default' ? ` sort:${state.sortMode}` : '';
    if (summary) {
      sidebar.setLabel(` Branches (${summary})${filterLabel}${sortLabel} `);
    } else {
      sidebar.setLabel(` Branches${filterLabel}${sortLabel} `);
    }

    const displayed = getFilteredVMs();

    if (displayed.length === 0) {
      blessed.text({
        parent: sidebar,
        content: state.searchFilter ? `No branches matching "${state.searchFilter}"` : 'No branches',
        top: 1,
        left: 1,
        style: { fg: 'gray' },
      });
    } else {
      let currentTop = 0;
      displayed.forEach((vm, i) => {
        const realIndex = state.vms.indexOf(vm);
        const isActive = realIndex === state.activeVmIndex;
        const isSelected = realIndex === state.sidebarSelectedIndex;
        const attention = vm.needsAttention ? ' {red-fg}{bold}!{/bold}{/red-fg}' : '';
        const statusIcon = vm.status === 'active' ? '*' : '-';
        const prefix = isActive ? '>' : ' ';
        const provLabel = vm.provisioningStatus === 'provisioning' ? ' [setup]'
          : vm.provisioningStatus === 'failed' ? ' [fail]'
          : vm.provisioningStatus === 'pending' ? ' [wait]'
          : '';
        const elapsed = vm.taskStartedAt ? ` ${formatElapsed(vm.taskStartedAt, Date.now())}` : '';
        const qCount = queueSize(vm.name);
        const queueLabel = qCount > 0 ? ` {magenta-fg}[q:${qCount}]{/magenta-fg}` : '';

        // Selected cards need extra height to fit both lines inside the border
        const cardHeight = isSelected ? 4 : 3;

        blessed.box({
          parent: sidebar,
          top: currentTop,
          left: 1,
          right: 1,
          height: cardHeight,
          border: isSelected ? { type: 'line' } : undefined,
          style: {
            border: { fg: vm.needsAttention ? 'red' : isSelected ? 'yellow' : 'cyan' },
            bg: isSelected ? 'black' : undefined,
          },
          content: `${prefix} ${statusIcon} ${vm.displayLabel ?? vm.name}${attention}\n  ${vm.pendingAction ? `{yellow-fg}${vm.pendingAction}{/yellow-fg}` : vm.status}${provLabel}${queueLabel}{cyan-fg}${elapsed}{/cyan-fg}`,
          tags: true,
        });

        currentTop += cardHeight;
      });
    }
    screen.render();
  }

  function renderMainView() {
    // No-op: main view is replaced by the live tmux right pane
  }

  function updatePendingAndErrorDisplay(vm: VM) {
    if (vm.lastError) {
      // Error takes priority — show error, hide pending, push preview down
      const errorLines = vm.lastError.split('\n').slice(0, 2);
      const truncated = errorLines.join('\n') + (vm.lastError.split('\n').length > 2 ? '...' : '');
      errorDisplay.setContent(`{red-fg}{bold}Error:{/bold}{/red-fg} ${truncated}\n{gray-fg}Press E to copy full error to clipboard{/gray-fg}`);
      errorDisplay.show();
      pendingActionDisplay.hide();
      previewBox.top = 3;
    } else if (vm.pendingAction) {
      // Pending action — show pending, hide error, push preview down
      pendingActionDisplay.setContent(`{yellow-fg}⏳ ${vm.pendingAction}{/yellow-fg}`);
      pendingActionDisplay.show();
      errorDisplay.hide();
      previewBox.top = 1;
    } else {
      // Nothing to show — hide both, restore preview position
      pendingActionDisplay.hide();
      errorDisplay.hide();
      previewBox.top = 0;
    }
  }

  function showConfirmDelete(vm: VM) {
    state.mode = 'confirm-delete';
    confirmDialog.setContent(
      `\n  Delete branch "${vm.name}"?\n\n  Press {bold}y{/bold} to confirm, {bold}n{/bold} to cancel`
    );
    confirmDialog.show();
    confirmDialog.focus();
    screen.render();
  }

  function hideConfirmDelete() {
    state.mode = 'normal';
    confirmDialog.hide();
    screen.render();
  }

  function showConfirmDeleteAll(count: number) {
    state.mode = 'confirm-delete-all';
    confirmDeleteAllDialog.setContent(
      `\n  Delete ALL ${count} branches?\n\n  Press {bold}y{/bold} to confirm, {bold}n{/bold} to cancel`
    );
    confirmDeleteAllDialog.show();
    confirmDeleteAllDialog.focus();
    screen.render();
  }

  function hideConfirmDeleteAll() {
    state.mode = 'normal';
    confirmDeleteAllDialog.hide();
    screen.render();
  }

  function showConfirmReprovisionAll(count: number) {
    state.mode = 'confirm-reprovision-all';
    confirmReprovisionAllDialog.setContent(
      `\n  Re-provision ALL ${count} branches?\n  (reloads CLAUDE.md + hooks)\n\n  Press {bold}y{/bold} to confirm, {bold}n{/bold} to cancel`
    );
    confirmReprovisionAllDialog.show();
    confirmReprovisionAllDialog.focus();
    screen.render();
  }

  function hideConfirmReprovisionAll() {
    state.mode = 'normal';
    confirmReprovisionAllDialog.hide();
    screen.render();
  }

  function render() {
    renderSidebar();
    renderMainView();
  }

  // Key bindings
  const handlers: Record<string, (...args: any[]) => void> = {};

  function onKey(key: string, handler: (...args: any[]) => void) {
    handlers[key] = handler;
  }

  // Note: Console mode input is now handled by blessed.terminal's handler option
  // This provides proper terminal emulation including support for escape sequences,
  // arrow keys, backspace, Ctrl+C, etc.

  let quitting = false;

  async function gracefulQuit() {
    if (quitting) return;
    quitting = true;
    try {
      await handlers['quit']?.();
    } catch {
      // Best-effort cleanup
    }
    screen.destroy();
    process.exit(0);
  }

  screen.key(['q'], () => {
    if (state.mode === 'confirm-delete') {
      hideConfirmDelete();
      return;
    }
    if (state.mode === 'confirm-delete-all') {
      hideConfirmDeleteAll();
      return;
    }
    if (state.mode === 'confirm-reprovision-all') {
      hideConfirmReprovisionAll();
      return;
    }
    if (state.mode === 'help') {
      hideHelp();
      return;
    }
    if (state.mode === 'dashboard') {
      hideDashboard();
      return;
    }
    if (state.mode === 'queue-viewer') {
      hideQueueViewer();
      return;
    }
    if (state.mode === 'pr-chain') {
      hidePRChain();
      return;
    }
    if (state.mode === 'linear') {
      hideLinear();
      return;
    }
    if (state.mode === 'prompt' || state.mode === 'broadcast' || state.mode === 'bulk-create' || state.mode === 'search' || state.mode === 'rename' || state.mode === 'queue' || state.mode === 'broadcast-queue' || state.mode === 'ralph-iterations' || state.mode === 'ralph-prompt') {
      // In prompt/broadcast/bulk-create/search/queue mode, q goes to the input
      return;
    }
    gracefulQuit();
  });

  screen.key(['C-c'], () => {
    if (state.mode === 'confirm-delete') {
      hideConfirmDelete();
      return;
    }
    if (state.mode === 'confirm-delete-all') {
      hideConfirmDeleteAll();
      return;
    }
    if (state.mode === 'confirm-reprovision-all') {
      hideConfirmReprovisionAll();
      return;
    }
    // Ctrl-C always quits
    gracefulQuit();
  });

  screen.key(['j', 'down'], () => {
    if (state.mode === 'linear') {
      if (linearIssues.length > 0 && linearSelectedIndex < linearIssues.length - 1) {
        linearSelectedIndex++;
        handlers['linear-rerender']?.();
      }
      return;
    }
    if (state.mode === 'pr-chain') {
      prChainOverlay.scroll(1);
      screen.render();
      return;
    }
    if (state.mode === 'queue-viewer') {
      const vm = state.vms[state.sidebarSelectedIndex];
      if (!vm) return;
      const queue = getQueue(vm.name);
      if (queueViewerSelectedIndex < queue.length - 1) {
        queueViewerSelectedIndex++;
        renderQueueViewer(vm);
        screen.render();
      }
      return;
    }
    if (state.mode !== 'normal') return;
    const displayed = getFilteredVMs();
    if (displayed.length > 0) {
      // Find current position in filtered list
      const currentVM = state.vms[state.sidebarSelectedIndex];
      const filteredIdx = displayed.indexOf(currentVM);
      const nextFilteredIdx = Math.min(filteredIdx + 1, displayed.length - 1);
      const nextVM = displayed[nextFilteredIdx];
      state.sidebarSelectedIndex = state.vms.indexOf(nextVM);
      render();
      handlers['selection-changed']?.();
    }
  });

  screen.key(['k', 'up'], () => {
    if (state.mode === 'linear') {
      if (linearIssues.length > 0 && linearSelectedIndex > 0) {
        linearSelectedIndex--;
        handlers['linear-rerender']?.();
      }
      return;
    }
    if (state.mode === 'pr-chain') {
      prChainOverlay.scroll(-1);
      screen.render();
      return;
    }
    if (state.mode === 'queue-viewer') {
      const vm = state.vms[state.sidebarSelectedIndex];
      if (!vm) return;
      if (queueViewerSelectedIndex > 0) {
        queueViewerSelectedIndex--;
        renderQueueViewer(vm);
        screen.render();
      }
      return;
    }
    if (state.mode !== 'normal') return;
    const displayed = getFilteredVMs();
    if (displayed.length > 0) {
      // Find current position in filtered list
      const currentVM = state.vms[state.sidebarSelectedIndex];
      const filteredIdx = displayed.indexOf(currentVM);
      const prevFilteredIdx = Math.max(filteredIdx - 1, 0);
      const prevVM = displayed[prevFilteredIdx];
      state.sidebarSelectedIndex = state.vms.indexOf(prevVM);
      render();
      handlers['selection-changed']?.();
    }
  });

  screen.key(['space'], () => {
    if (state.mode === 'linear') {
      if (linearIssues.length > 0 && linearIssues[linearSelectedIndex]) {
        const id = linearIssues[linearSelectedIndex].id;
        if (linearCheckedIds.has(id)) {
          linearCheckedIds.delete(id);
        } else {
          linearCheckedIds.add(id);
        }
        handlers['linear-rerender']?.();
      }
      return;
    }
  });

  screen.key(['enter'], () => {
    if (state.mode === 'linear') {
      if (linearIssues.length === 0) return;
      // If any checked, claim all checked; otherwise claim the cursor issue
      const selected = linearCheckedIds.size > 0
        ? linearIssues.filter(i => linearCheckedIds.has(i.id))
        : linearIssues[linearSelectedIndex] ? [linearIssues[linearSelectedIndex]] : [];
      if (selected.length > 0) {
        handlers['linear-claim']?.(selected);
        hideLinear();
      }
      return;
    }
    if (state.mode !== 'normal') return;
    if (state.vms.length > 0 && state.sidebarSelectedIndex >= 0) {
      state.activeVmIndex = state.sidebarSelectedIndex;
      render();
      handlers['activate']?.();
    }
  });

  screen.key(['c'], () => {
    if (state.mode !== 'normal') return;
    handlers['create']?.();
  });

  screen.key(['d'], () => {
    if (state.mode === 'queue-viewer') {
      const vm = state.vms[state.sidebarSelectedIndex];
      if (!vm) return;
      handlers['queue-remove']?.(queueViewerSelectedIndex);
      renderQueueViewer(vm);
      screen.render();
      return;
    }
    if (state.mode !== 'normal') return;
    if (state.vms.length > 0) {
      const vm = state.vms[state.sidebarSelectedIndex];
      if (vm) showConfirmDelete(vm);
    }
  });

  screen.key(['y'], () => {
    if (state.mode === 'confirm-delete') {
      hideConfirmDelete();
      handlers['delete']?.();
    } else if (state.mode === 'confirm-delete-all') {
      hideConfirmDeleteAll();
      handlers['delete-all']?.();
    } else if (state.mode === 'confirm-reprovision-all') {
      hideConfirmReprovisionAll();
      handlers['reprovision-all']?.();
    }
  });

  screen.key(['n'], () => {
    if (state.mode === 'confirm-delete') {
      hideConfirmDelete();
    } else if (state.mode === 'confirm-delete-all') {
      hideConfirmDeleteAll();
    } else if (state.mode === 'confirm-reprovision-all') {
      hideConfirmReprovisionAll();
    }
  });

  screen.key(['p'], () => {
    if (state.mode !== 'normal') return;
    if (state.vms.length === 0) return;
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    showPromptInput(vm);
  });

  screen.key(['b'], () => {
    if (state.mode !== 'normal') return;
    if (state.vms.length === 0) return;
    showBroadcastInput();
  });

  screen.key(['S-q'], () => {
    if (state.mode !== 'normal') return;
    if (state.vms.length === 0) return;
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    showQueueInput(vm);
  });

  screen.key(['S-b'], () => {
    if (state.mode !== 'normal') return;
    if (state.vms.length === 0) return;
    showBroadcastQueueInput();
  });

  screen.key(['f'], () => {
    if (state.mode !== 'normal') return;
    if (state.vms.length === 0) return;
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    showRalphIterationsInput(vm);
  });

  screen.key(['S-c'], () => {
    if (state.mode !== 'normal') return;
    showBulkCreate();
  });

  screen.key(['S-d'], () => {
    if (state.mode !== 'normal') return;
    if (state.vms.length === 0) return;
    showConfirmDeleteAll(state.vms.length);
  });

  screen.key(['a'], () => {
    if (state.mode !== 'normal') return;
    const nextIdx = findNextAttentionIndex(state.vms, state.sidebarSelectedIndex);
    if (nextIdx >= 0) {
      state.sidebarSelectedIndex = nextIdx;
      render();
      handlers['selection-changed']?.();
    }
  });

  screen.key(['r'], () => {
    if (state.mode === 'linear') {
      handlers['linear-refresh']?.();
      return;
    }
    if (state.mode === 'pr-chain') {
      handlers['pr-chain-refresh']?.();
      return;
    }
    if (state.mode !== 'normal') return;
    if (state.vms.length === 0) return;
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm || vm.provisioningStatus !== 'done') return;
    handlers['reprovision']?.();
  });

  screen.key(['S-r'], () => {
    if (state.mode !== 'normal') return;
    const provisioned = state.vms.filter(vm => vm.provisioningStatus === 'done');
    if (provisioned.length === 0) return;
    showConfirmReprovisionAll(provisioned.length);
  });

  screen.key(['l'], () => {
    if (state.mode !== 'normal') return;
    if (state.vms.length === 0) return;
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    showRename(vm);
  });

  screen.key(['x'], () => {
    if (state.mode !== 'normal') return;
    if (state.vms.length === 0) return;
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    handlers['stop-agent']?.();
  });

  screen.key(['S-x'], () => {
    if (state.mode === 'queue-viewer') {
      const vm = state.vms[state.sidebarSelectedIndex];
      if (!vm) return;
      handlers['queue-clear']?.();
      queueViewerSelectedIndex = 0;
      renderQueueViewer(vm);
      screen.render();
      return;
    }
  });

  screen.key(['t'], () => {
    if (state.mode !== 'normal') return;
    if (state.vms.length === 0) return;
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm || vm.provisioningStatus !== 'failed') return;
    handlers['retry-provision']?.();
  });

  screen.key(['o'], () => {
    if (state.mode !== 'normal') return;
    if (state.vms.length === 0) return;
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    handlers['export-log']?.();
  });

  screen.key(['S-e'], () => {
    if (state.mode !== 'normal') return;
    if (state.vms.length === 0) return;
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm || !vm.lastError) return;
    handlers['copy-error']?.();
  });

  screen.key(['v'], () => {
    if (state.mode !== 'normal') return;
    if (state.vms.length === 0) return;
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    showQueueViewer(vm);
  });

  screen.key(['g'], () => {
    if (state.mode === 'pr-chain') {
      hidePRChain();
      return;
    }
    if (state.mode !== 'normal') return;
    if (state.vms.length === 0) return;
    showPRChain();
  });

  screen.key(['S-l'], () => {
    if (state.mode === 'linear') {
      hideLinear();
      return;
    }
    if (state.mode !== 'normal') return;
    showLinear();
  });

  screen.key(['s'], () => {
    if (state.mode === 'pr-chain') {
      handlers['pr-chain-sync']?.();
      return;
    }
    if (state.mode !== 'normal') return;
    state.sortMode = nextSortMode(state.sortMode);
    render();
  });

  screen.key(['i'], () => {
    if (state.mode === 'dashboard') {
      hideDashboard();
      return;
    }
    if (state.mode !== 'normal') return;
    showDashboard();
  });

  screen.key(['tab'], () => {
    if (state.mode !== 'normal') return;
    handlers['toggle-sidebar']?.();
  });

  screen.key(['?'], () => {
    if (state.mode === 'help') {
      hideHelp();
      return;
    }
    if (state.mode !== 'normal') return;
    showHelp();
  });

  screen.key(['/'], () => {
    if (state.mode !== 'normal') return;
    showSearch();
  });

  screen.key(['escape'], () => {
    if (state.mode === 'help') {
      hideHelp();
    }
    if (state.mode === 'dashboard') {
      hideDashboard();
    }
    if (state.mode === 'pr-chain') {
      hidePRChain();
    }
    if (state.mode === 'linear') {
      hideLinear();
    }
    if (state.mode === 'queue-viewer') {
      hideQueueViewer();
    }
    if (state.mode === 'normal' && state.searchFilter) {
      clearSearch();
    }
  });

  // Handle screen resize — maintain left pane width and track zoom state
  screen.on('resize', () => {
    if (state.mode === 'normal') {
      try {
        if (!isZoomed('0.0')) {
          setLeftPaneWidth(34);
        }
      } catch {}
      // If sidebar was hidden (right pane zoomed) and user unzoomed via Ctrl-b z
      if (state.sidebarHidden) {
        try {
          if (!isZoomed('0.1')) {
            state.sidebarHidden = false;
          }
        } catch {}
      }
    }
    render();
  });

  /**
   * Get the dimensions of the main view area (inside borders).
   */
  function getTerminalSize(): { cols: number; rows: number } {
    const cols = (mainView.width as number) - 2;
    const rows = (mainView.height as number) - 2;
    return { cols: Math.max(cols, 1), rows: Math.max(rows, 1) };
  }

  function showPromptInput(vm: VM) {
    state.mode = 'prompt';
    resetCursor();
    promptDialog.setLabel(` Send Prompt to ${vm.displayLabel ?? vm.name} `);
    promptDialog.show();
    promptInput.setValue('');
    promptInput.focus();
    promptInput.readInput();
    screen.render();
  }

  function hidePromptInput() {
    state.mode = 'normal';
    promptDialog.hide();
    promptInput.cancel();
    statusBar.setContent(normalStatusText);
    screen.render();
  }

  function showHelp() {
    state.mode = 'help';
    try { zoomPane('0.0'); } catch {}
    helpDialog.show();
    helpDialog.focus();
    screen.render();
  }

  function hideHelp() {
    state.mode = 'normal';
    helpDialog.hide();
    try { if (isZoomed('0.0')) zoomPane('0.0'); } catch {}
    screen.render();
  }

  function showBroadcastInput() {
    const provisionedCount = state.vms.filter(vm => vm.provisioningStatus === 'done').length;
    state.mode = 'broadcast';
    resetCursor();
    broadcastDialog.setLabel(` Broadcast Prompt to All Agents (${provisionedCount} ready) `);
    broadcastDialog.show();
    broadcastInput.setValue('');
    broadcastInput.focus();
    broadcastInput.readInput();
    screen.render();
  }

  function hideBroadcastInput() {
    state.mode = 'normal';
    broadcastDialog.hide();
    broadcastInput.cancel();
    statusBar.setContent(normalStatusText);
    screen.render();
  }

  function showQueueInput(vm: VM) {
    state.mode = 'queue';
    resetCursor();
    const qCount = queueSize(vm.name);
    const countLabel = qCount > 0 ? ` (${qCount} queued)` : '';
    queueDialog.setLabel(` Queue Prompt for ${vm.displayLabel ?? vm.name}${countLabel} `);
    queueDialog.show();
    queueInput.setValue('');
    queueInput.focus();
    queueInput.readInput();
    screen.render();
  }

  function hideQueueInput() {
    state.mode = 'normal';
    queueDialog.hide();
    queueInput.cancel();
    statusBar.setContent(normalStatusText);
    screen.render();
  }

  function showBroadcastQueueInput() {
    const provisionedCount = state.vms.filter(vm => vm.provisioningStatus === 'done').length;
    state.mode = 'broadcast-queue';
    resetCursor();
    broadcastQueueDialog.setLabel(` Broadcast Queue Prompt to All Agents (${provisionedCount} ready) `);
    broadcastQueueDialog.show();
    broadcastQueueInput.setValue('');
    broadcastQueueInput.focus();
    broadcastQueueInput.readInput();
    screen.render();
  }

  function hideBroadcastQueueInput() {
    state.mode = 'normal';
    broadcastQueueDialog.hide();
    broadcastQueueInput.cancel();
    statusBar.setContent(normalStatusText);
    screen.render();
  }

  function showRalphIterationsInput(vm: VM) {
    state.mode = 'ralph-iterations';
    ralphIterationsDialog.setLabel(` Ralph: Iterations for ${vm.displayLabel ?? vm.name} `);
    ralphIterationsDialog.show();
    ralphIterationsInput.setValue('5');
    ralphIterationsInput.focus();
    ralphIterationsInput.readInput();
    screen.render();
  }

  function hideRalphIterationsInput() {
    state.mode = 'normal';
    ralphIterationsDialog.hide();
    ralphIterationsInput.cancel();
    statusBar.setContent(normalStatusText);
    screen.render();
  }

  function showRalphPromptInput(vm: VM, iterations: number) {
    ralphIterationsValue = iterations;
    state.mode = 'ralph-prompt';
    resetCursor();
    ralphPromptDialog.setLabel(` Ralph: Prompt for ${vm.displayLabel ?? vm.name} (${iterations} iterations) `);
    ralphPromptDialog.show();
    ralphPromptInput.setValue('');
    ralphPromptInput.focus();
    ralphPromptInput.readInput();
    screen.render();
  }

  function hideRalphPromptInput() {
    state.mode = 'normal';
    ralphPromptDialog.hide();
    ralphPromptInput.cancel();
    statusBar.setContent(normalStatusText);
    screen.render();
  }

  function showBulkCreate() {
    state.mode = 'bulk-create';
    bulkCreateDialog.show();
    bulkCreateInput.setValue('');
    bulkCreateInput.focus();
    bulkCreateInput.readInput();
    screen.render();
  }

  function hideBulkCreate() {
    state.mode = 'normal';
    bulkCreateDialog.hide();
    bulkCreateInput.cancel();
    statusBar.setContent(normalStatusText);
    screen.render();
  }

  function showRename(vm: VM) {
    state.mode = 'rename';
    renameDialog.setLabel(` Rename ${vm.displayLabel ?? vm.name} `);
    renameDialog.show();
    renameInput.setValue(vm.displayLabel ?? '');
    renameInput.focus();
    renameInput.readInput();
    screen.render();
  }

  function hideRename() {
    state.mode = 'normal';
    renameDialog.hide();
    renameInput.cancel();
    screen.render();
  }

  function showSearch() {
    state.mode = 'search';
    searchDialog.show();
    searchInput.setValue(state.searchFilter);
    searchInput.focus();
    searchInput.readInput();
    screen.render();
  }

  function hideSearch() {
    state.mode = 'normal';
    searchDialog.hide();
    searchInput.cancel();
    // Ensure selection is valid within filtered results
    const displayed = getFilteredVMs();
    if (displayed.length > 0) {
      const currentVM = state.vms[state.sidebarSelectedIndex];
      if (!displayed.includes(currentVM)) {
        state.sidebarSelectedIndex = state.vms.indexOf(displayed[0]);
      }
    }
    screen.render();
  }

  function clearSearch() {
    state.searchFilter = '';
    render();
  }

  function showQueueViewer(vm: VM) {
    state.mode = 'queue-viewer';
    queueViewerSelectedIndex = 0;
    renderQueueViewer(vm);
    queueViewerOverlay.show();
    queueViewerOverlay.focus();
    statusBar.setContent(' j/k:navigate  d:remove  X:clear all  Escape:close');
    screen.render();
  }

  function hideQueueViewer() {
    state.mode = 'normal';
    queueViewerOverlay.hide();
    statusBar.setContent(normalStatusText);
    render();
  }

  function renderQueueViewer(vm: VM) {
    const queue = getQueue(vm.name);
    const label = vm.displayLabel ?? vm.name;
    queueViewerOverlay.setLabel(` Queue: ${label} (${queue.length} prompt${queue.length !== 1 ? 's' : ''}) `);

    if (queue.length === 0) {
      queueViewerOverlay.setContent('\n  {gray-fg}Queue is empty{/gray-fg}\n\n  Press {bold}Q{/bold} (Shift-Q) to add prompts to the queue.');
      return;
    }

    // Clamp selection
    if (queueViewerSelectedIndex >= queue.length) {
      queueViewerSelectedIndex = Math.max(0, queue.length - 1);
    }

    const lines: string[] = [''];
    queue.forEach((prompt, i) => {
      const isSelected = i === queueViewerSelectedIndex;
      const marker = isSelected ? '{yellow-fg}>{/yellow-fg}' : ' ';
      const num = `${i + 1}.`.padEnd(4);
      const truncated = prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt;
      const highlight = isSelected ? '{bold}' : '{gray-fg}';
      const highlightEnd = isSelected ? '{/bold}' : '{/gray-fg}';
      lines.push(`  ${marker} ${highlight}${num}${truncated}${highlightEnd}`);
    });
    lines.push('');
    lines.push('  {gray-fg}d:remove selected  X:clear all  Escape:close{/gray-fg}');

    queueViewerOverlay.setContent(lines.join('\n'));
  }

  function showPRChain() {
    state.mode = 'pr-chain';
    try { zoomPane('0.0'); } catch {}
    prChainOverlay.setContent('\n  {yellow-fg}Fetching PR data...{/yellow-fg}');
    prChainOverlay.setLabel(' PR Chain ');
    prChainOverlay.show();
    prChainOverlay.focus();
    statusBar.setContent(' g:close  r:refresh  s:sync(rebase)  j/k:scroll  Escape:close');
    screen.render();
    handlers['pr-chain-open']?.();
  }

  function hidePRChain() {
    state.mode = 'normal';
    prChainOverlay.hide();
    try { if (isZoomed('0.0')) zoomPane('0.0'); } catch {}
    statusBar.setContent(normalStatusText);
    render();
  }

  function renderPRChainContent(content: string, label: string) {
    prChainOverlay.setLabel(` ${label} `);
    prChainOverlay.setContent(content);
    prChainOverlay.setScrollPerc(0);
    screen.render();
  }

  function showLinear() {
    state.mode = 'linear';
    linearSelectedIndex = 0;
    linearCheckedIds = new Set();
    try { zoomPane('0.0'); } catch {}
    linearOverlay.setContent('\n  {yellow-fg}Fetching Linear tasks...{/yellow-fg}');
    linearOverlay.setLabel(' Linear Tasks ');
    linearOverlay.show();
    linearOverlay.focus();
    statusBar.setContent(' Space:select  Enter:claim selected  L:close  r:refresh  j/k:navigate  Escape:close');
    screen.render();
    handlers['linear-open']?.();
  }

  function hideLinear() {
    state.mode = 'normal';
    linearOverlay.hide();
    try { if (isZoomed('0.0')) zoomPane('0.0'); } catch {}
    statusBar.setContent(normalStatusText);
    render();
  }

  function renderLinearContent(content: string, label: string) {
    linearOverlay.setLabel(` ${label} `);
    linearOverlay.setContent(content);
    linearOverlay.setScrollPerc(0);
    screen.render();
  }

  function showDashboard() {
    state.mode = 'dashboard';
    try { zoomPane('0.0'); } catch {}
    renderDashboard();
    dashboardOverlay.show();
    dashboardOverlay.focus();
    statusBar.setContent(' i:close dashboard  j/k:scroll  ?:help  q:quit');
    screen.render();
  }

  function hideDashboard() {
    state.mode = 'normal';
    dashboardOverlay.hide();
    try { if (isZoomed('0.0')) zoomPane('0.0'); } catch {}
    statusBar.setContent(normalStatusText);
    render();
  }

  function renderDashboard() {
    const displayed = getFilteredVMs();
    const availWidth = (screen.width as number) - 4; // borders + padding
    // Calculate grid: 2 columns if wide enough, else 1
    const cols = availWidth >= 80 ? 2 : 1;
    const cellWidth = Math.floor(availWidth / cols) - 2;

    if (displayed.length === 0) {
      dashboardOverlay.setContent('\n  {gray-fg}No branches to display{/gray-fg}');
      return;
    }

    const lines: string[] = [''];
    for (let i = 0; i < displayed.length; i += cols) {
      const rowCells: string[][] = [];
      for (let c = 0; c < cols && i + c < displayed.length; c++) {
        const vm = displayed[i + c];
        const outputLines = getOutput(vm.name);
        const lastLine = outputLines.length > 0 ? outputLines[outputLines.length - 1] : '';
        rowCells.push(buildDashboardCell(vm, lastLine, cellWidth));
      }

      // Render cells side by side (3 lines per cell + 1 separator)
      const maxLines = 3;
      for (let line = 0; line < maxLines; line++) {
        const parts: string[] = [];
        for (let c = 0; c < rowCells.length; c++) {
          const cellLine = rowCells[c][line] ?? '';
          parts.push(`  ${cellLine}`);
        }
        lines.push(parts.join('  │  '));
      }
      lines.push('  ' + '─'.repeat(Math.min(availWidth - 2, cellWidth * cols + (cols - 1) * 5)));
    }

    // Summary footer
    const summary = buildVmSummary(displayed);
    if (summary) {
      lines.push(`  Fleet: ${summary}`);
    }

    dashboardOverlay.setContent(lines.join('\n'));
  }

  // Search input submission
  searchInput.on('submit', (value: string) => {
    state.searchFilter = value?.trim() ?? '';
    hideSearch();
    render();
    handlers['selection-changed']?.();
  });

  // Search input cancel
  searchInput.on('cancel', () => {
    hideSearch();
    render();
  });

  // Rename input submission
  renameInput.on('submit', (value: string) => {
    const text = value?.trim() ?? '';
    hideRename();
    handlers['rename-submit']?.(text);
    render();
  });

  // Rename input cancel
  renameInput.on('cancel', () => {
    hideRename();
    render();
  });

  // Bulk create input submission
  bulkCreateInput.on('submit', (value: string) => {
    const text = value?.trim();
    hideBulkCreate();
    if (text) {
      const count = parseInt(text, 10);
      if (count > 0 && count <= 20) {
        handlers['bulk-create']?.(count);
      }
    }
  });

  // Bulk create input cancel
  bulkCreateInput.on('cancel', () => {
    hideBulkCreate();
  });

  // History navigation for prompt input
  promptInput.on('keypress', (_ch: string, key: { name: string }) => {
    if (key.name === 'up') {
      const entry = historyUp(promptInput.getValue());
      if (entry !== null) {
        promptInput.setValue(entry);
        screen.render();
      }
    } else if (key.name === 'down') {
      const entry = historyDown();
      if (entry !== null) {
        promptInput.setValue(entry);
        screen.render();
      }
    }
  });

  // History navigation for broadcast input
  broadcastInput.on('keypress', (_ch: string, key: { name: string }) => {
    if (key.name === 'up') {
      const entry = historyUp(broadcastInput.getValue());
      if (entry !== null) {
        broadcastInput.setValue(entry);
        screen.render();
      }
    } else if (key.name === 'down') {
      const entry = historyDown();
      if (entry !== null) {
        broadcastInput.setValue(entry);
        screen.render();
      }
    }
  });

  // Prompt input submission
  promptInput.on('submit', (value: string) => {
    const text = value?.trim();
    hidePromptInput();
    if (text) {
      handlers['prompt-submit']?.(text);
    }
  });

  // Prompt input cancel
  promptInput.on('cancel', () => {
    hidePromptInput();
  });

  // Broadcast input submission
  broadcastInput.on('submit', (value: string) => {
    const text = value?.trim();
    hideBroadcastInput();
    if (text) {
      handlers['broadcast-submit']?.(text);
    }
  });

  // Broadcast input cancel
  broadcastInput.on('cancel', () => {
    hideBroadcastInput();
  });

  // Queue input submission
  queueInput.on('submit', (value: string) => {
    const text = value?.trim();
    hideQueueInput();
    if (text) {
      handlers['queue-submit']?.(text);
    }
  });

  // Queue input cancel
  queueInput.on('cancel', () => {
    hideQueueInput();
  });

  // Broadcast queue input submission
  broadcastQueueInput.on('submit', (value: string) => {
    const text = value?.trim();
    hideBroadcastQueueInput();
    if (text) {
      handlers['broadcast-queue-submit']?.(text);
    }
  });

  // Broadcast queue input cancel
  broadcastQueueInput.on('cancel', () => {
    hideBroadcastQueueInput();
  });

  // History navigation for broadcast queue input
  broadcastQueueInput.on('keypress', (_ch: string, key: { name: string }) => {
    if (key.name === 'up') {
      const entry = historyUp(broadcastQueueInput.getValue());
      if (entry !== null) {
        broadcastQueueInput.setValue(entry);
        screen.render();
      }
    } else if (key.name === 'down') {
      const entry = historyDown();
      if (entry !== null) {
        broadcastQueueInput.setValue(entry);
        screen.render();
      }
    }
  });

  // History navigation for queue input
  queueInput.on('keypress', (_ch: string, key: { name: string }) => {
    if (key.name === 'up') {
      const entry = historyUp(queueInput.getValue());
      if (entry !== null) {
        queueInput.setValue(entry);
        screen.render();
      }
    } else if (key.name === 'down') {
      const entry = historyDown();
      if (entry !== null) {
        queueInput.setValue(entry);
        screen.render();
      }
    }
  });

  // Ralph iterations input submission - step 1: validate, then show prompt dialog
  ralphIterationsInput.on('submit', (value: string) => {
    const text = value?.trim();
    ralphIterationsDialog.hide();
    ralphIterationsInput.cancel();
    if (text) {
      const count = parseInt(text, 10);
      if (count > 0 && count <= 100) {
        const vm = state.vms[state.sidebarSelectedIndex];
        if (vm) {
          showRalphPromptInput(vm, count);
          return;
        }
      }
    }
    // Invalid or cancelled — return to normal
    state.mode = 'normal';
    statusBar.setContent(normalStatusText);
    screen.render();
  });

  // Ralph iterations input cancel
  ralphIterationsInput.on('cancel', () => {
    hideRalphIterationsInput();
  });

  // Ralph prompt input submission - step 2: emit ralph-submit with prompt + iterations
  ralphPromptInput.on('submit', (value: string) => {
    const text = value?.trim();
    hideRalphPromptInput();
    if (text) {
      handlers['ralph-submit']?.(text, ralphIterationsValue);
    }
  });

  // Ralph prompt input cancel
  ralphPromptInput.on('cancel', () => {
    hideRalphPromptInput();
  });

  // History navigation for ralph prompt input
  ralphPromptInput.on('keypress', (_ch: string, key: { name: string }) => {
    if (key.name === 'up') {
      const entry = historyUp(ralphPromptInput.getValue());
      if (entry !== null) {
        ralphPromptInput.setValue(entry);
        screen.render();
      }
    } else if (key.name === 'down') {
      const entry = historyDown();
      if (entry !== null) {
        ralphPromptInput.setValue(entry);
        screen.render();
      }
    }
  });

  // Spinner state
  const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let spinnerFrameIdx = 0;
  let spinnerText = '';

  function startSpinner(text: string) {
    spinnerText = text;
    spinnerFrameIdx = 0;
    if (spinnerTimer) clearInterval(spinnerTimer);
    statusBar.setContent(` ${SPINNER_FRAMES[0]} ${text}`);
    screen.render();
    spinnerTimer = setInterval(() => {
      spinnerFrameIdx = (spinnerFrameIdx + 1) % SPINNER_FRAMES.length;
      statusBar.setContent(` ${SPINNER_FRAMES[spinnerFrameIdx]} ${spinnerText}`);
      screen.render();
    }, 80);
  }

  function updateSpinner(text: string) {
    spinnerText = text;
    if (spinnerTimer) {
      statusBar.setContent(` ${SPINNER_FRAMES[spinnerFrameIdx]} ${text}`);
      screen.render();
    }
  }

  function stopSpinner() {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  }

  // Refresh sidebar/dashboard every second so elapsed timers update live
  const elapsedTimer = setInterval(() => {
    if (state.vms.some(vm => vm.taskStartedAt != null)) {
      if (state.mode === 'dashboard') {
        renderDashboard();
        screen.render();
      } else {
        renderSidebar();
      }
    }
  }, 1000);

  // Clean up timers when screen is destroyed
  screen.on('destroy', () => {
    clearInterval(elapsedTimer);
    if (spinnerTimer) clearInterval(spinnerTimer);
  });

  /**
   * Show preview — no-op since the right pane is the live preview.
   */
  function showPreview(_lines: string[]) {
    // No-op: the live tmux right pane replaces the preview
  }

  return {
    screen,
    state,
    sidebar,
    mainView,
    statusBar,
    render,
    onKey,
    getTerminalSize,
    showPreview,
    setStatusMessage(msg: string) {
      statusBar.setContent(` ${msg}`);
      screen.render();
    },
    renderDashboard() {
      if (state.mode === 'dashboard') {
        renderDashboard();
        screen.render();
      }
    },
    renderQueueViewer(vm: VM) {
      if (state.mode === 'queue-viewer') {
        renderQueueViewer(vm);
        screen.render();
      }
    },
    renderPRChain(content: string, label: string) {
      if (state.mode === 'pr-chain') {
        renderPRChainContent(content, label);
      }
    },
    renderLinear(content: string, label: string) {
      if (state.mode === 'linear') {
        renderLinearContent(content, label);
      }
    },
    setLinearIssues(issues: import('./linear-client.ts').LinearIssue[]) {
      linearIssues = issues;
    },
    getLinearSelectedIndex() {
      return linearSelectedIndex;
    },
    getLinearCheckedIds() {
      return linearCheckedIds;
    },
    resetStatus() {
      statusBar.setContent(normalStatusText);
      screen.render();
    },
    getSelectedVMError(): string | undefined {
      const vm = state.vms[state.sidebarSelectedIndex];
      return vm?.lastError;
    },
    clearSelectedVMError() {
      const vm = state.vms[state.sidebarSelectedIndex];
      if (vm) {
        vm.lastError = undefined;
        renderMainView();
      }
    },
    startSpinner,
    updateSpinner,
    stopSpinner,
  };
}
