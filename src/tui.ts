import blessed from 'blessed';
import type { AppState, VM } from './types.js';
import { historyUp, historyDown, resetCursor } from './prompt-history.js';

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

export function createApp() {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'pigs - Claude Agent VM Manager',
    fullUnicode: true,
  });

  const state: AppState = {
    vms: [],
    activeVmIndex: -1,
    sidebarSelectedIndex: 0,
    mode: 'normal',
    settings: null,
    searchFilter: '',
  };

  // Sidebar: list of VMs on the left
  const sidebar = blessed.box({
    parent: screen,
    label: ' VMs ',
    left: 0,
    top: 0,
    width: 30,
    height: '100%-1',
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'white', bold: true },
    },
    scrollable: true,
    keys: true,
  });

  // Main view: active VM console area
  const mainView = blessed.box({
    parent: screen,
    label: ' Console ',
    left: 30,
    top: 0,
    width: '100%-30',
    height: '100%-1',
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
    content: 'No active VM. Press {bold}c{/bold} to create a new agent VM.',
    tags: true,
    top: 'center',
    left: 'center',
    style: { fg: 'gray' },
  });

  // Terminal output area inside main view (for console sessions)
  const terminal = blessed.box({
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
    keys: false,
    tags: false,
    hidden: true,
  });

  // Status bar at the bottom
  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    style: { bg: 'blue', fg: 'white' },
    content: ' c:create  C:bulk-create  d:delete  D:delete-all  r:reprov  R:reprov-all  l:rename  p:prompt  b:broadcast  a:next-attn  m:mount  u:unmount  /:search  ?:help  q:quit',
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
    label: ' Confirm Delete ',
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
    label: ' Create Multiple Agent VMs ',
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
    label: ' Confirm Delete All ',
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
    width: 60,
    height: 28,
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
      '  a             Jump to next VM needing attention',
      '  Enter         Attach console to selected VM',
      '  Escape        Detach from console',
      '',
      '  {bold}VM Management{/bold}',
      '  c             Create a new agent VM',
      '  C (shift)     Create multiple VMs at once',
      '  d             Delete selected VM',
      '  D (shift)     Delete ALL VMs at once',
      '  r             Re-provision selected VM (update config)',
      '  R (shift)     Re-provision ALL VMs at once',
      '  l             Rename/label selected VM',
      '  m             Mount VM filesystem (sshfs)',
      '  u             Unmount VM filesystem',
      '',
      '  {bold}Prompts{/bold}',
      '  p             Send prompt to selected VM',
      '  b             Broadcast prompt to all VMs',
      '  ↑ / ↓         Cycle prompt history (in dialog)',
      '',
      '  {bold}Other{/bold}',
      '  /             Search/filter VMs in sidebar',
      '  Escape        Clear search filter (in normal mode)',
      '  ?             Toggle this help screen',
      '  q             Quit',
      '  Ctrl-C        Force quit',
      '',
      '  {gray-fg}Press ? or Escape to close{/gray-fg}',
    ].join('\n'),
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
    label: ' Rename VM ',
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
    label: ' Search VMs ',
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

  const normalStatusText = ' c:create  C:bulk-create  d:delete  D:delete-all  r:reprov  R:reprov-all  l:rename  p:prompt  b:broadcast  a:next-attn  m:mount  u:unmount  /:search  ?:help  q:quit';
  const consoleStatusText = ' Escape:detach  (input forwarded to VM)';

  function getFilteredVMs(): VM[] {
    return filterVMs(state.vms, state.searchFilter);
  }

  function renderSidebar() {
    sidebar.children.forEach((child) => {
      if (child !== sidebar) child.detach();
    });

    // Update sidebar label with VM status summary
    const summary = buildVmSummary(state.vms);
    const filterLabel = state.searchFilter ? ` filter:"${state.searchFilter}"` : '';
    if (summary) {
      sidebar.setLabel(` VMs (${summary})${filterLabel} `);
    } else {
      sidebar.setLabel(` VMs${filterLabel} `);
    }

    const displayed = getFilteredVMs();

    if (displayed.length === 0) {
      blessed.text({
        parent: sidebar,
        content: state.searchFilter ? `No VMs matching "${state.searchFilter}"` : 'No VMs running',
        top: 1,
        left: 1,
        style: { fg: 'gray' },
      });
    } else {
      displayed.forEach((vm, i) => {
        const realIndex = state.vms.indexOf(vm);
        const isActive = realIndex === state.activeVmIndex;
        const isSelected = realIndex === state.sidebarSelectedIndex;
        const attention = vm.needsAttention ? ' {red-fg}{bold}!{/bold}{/red-fg}' : '';
        const statusIcon = vm.status === 'running' ? '*' : '-';
        const prefix = isActive ? '>' : ' ';
        const provLabel = vm.provisioningStatus === 'provisioning' ? ' [setup]'
          : vm.provisioningStatus === 'failed' ? ' [fail]'
          : vm.provisioningStatus === 'pending' ? ' [wait]'
          : '';
        const mountLabel = vm.mountPath ? ' [mnt]' : '';

        blessed.box({
          parent: sidebar,
          top: i * 3,
          left: 1,
          right: 1,
          height: 3,
          border: isSelected ? { type: 'line' } : undefined,
          style: {
            border: { fg: vm.needsAttention ? 'red' : isSelected ? 'yellow' : 'cyan' },
            bg: isSelected ? 'black' : undefined,
          },
          content: `${prefix} ${statusIcon} ${vm.displayLabel ?? vm.name}${attention}\n  ${vm.status}${provLabel}${mountLabel}`,
          tags: true,
        });
      });
    }
    screen.render();
  }

  function renderMainView() {
    if (state.mode === 'console' && state.activeVmIndex >= 0 && state.vms[state.activeVmIndex]) {
      const vm = state.vms[state.activeVmIndex];
      mainView.setLabel(` Console: ${vm.displayLabel ?? vm.name} (attached) `);
      mainView.style.border = { fg: 'yellow' };
      noVmMessage.hide();
      terminal.show();
    } else if (state.activeVmIndex >= 0 && state.vms[state.activeVmIndex]) {
      const vm = state.vms[state.activeVmIndex];
      mainView.setLabel(` Console: ${vm.displayLabel ?? vm.name} `);
      mainView.style.border = { fg: 'green' };
      noVmMessage.hide();
      terminal.show();
    } else {
      mainView.setLabel(' Console ');
      mainView.style.border = { fg: 'green' };
      noVmMessage.show();
      terminal.hide();
    }
    screen.render();
  }

  function showConfirmDelete(vm: VM) {
    state.mode = 'confirm-delete';
    confirmDialog.setContent(
      `\n  Delete VM "${vm.name}"?\n\n  Press {bold}y{/bold} to confirm, {bold}n{/bold} to cancel`
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
      `\n  Delete ALL ${count} VMs?\n\n  Press {bold}y{/bold} to confirm, {bold}n{/bold} to cancel`
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
      `\n  Re-provision ALL ${count} VMs?\n  (reloads CLAUDE.md + hooks)\n\n  Press {bold}y{/bold} to confirm, {bold}n{/bold} to cancel`
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

  // Handle console mode input - forward raw data to the VM
  screen.program.on('data', (data: string) => {
    if (state.mode !== 'console') return;

    // Escape key detaches from console
    if (data === '\x1b' || data === '\x1b\x1b') {
      state.mode = 'normal';
      statusBar.setContent(normalStatusText);
      render();
      handlers['console-detach']?.();
      return;
    }

    handlers['console-input']?.(data);
  });

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
    if (state.mode === 'console' || state.mode === 'prompt' || state.mode === 'broadcast' || state.mode === 'bulk-create' || state.mode === 'search' || state.mode === 'rename') {
      // In console/prompt/broadcast/bulk-create/search mode, q goes to the input
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
    // Ctrl-C always quits, even from console mode
    gracefulQuit();
  });

  screen.key(['j', 'down'], () => {
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
    }
  });

  screen.key(['k', 'up'], () => {
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
    }
  });

  screen.key(['enter'], () => {
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

  screen.key(['m'], () => {
    if (state.mode !== 'normal') return;
    handlers['mount']?.();
  });

  screen.key(['u'], () => {
    if (state.mode !== 'normal') return;
    handlers['unmount']?.();
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
    }
  });

  screen.key(['r'], () => {
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

  screen.key(['?'], () => {
    if (state.mode === 'console') return;
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
    if (state.mode === 'normal' && state.searchFilter) {
      clearSearch();
    }
  });

  // Handle screen resize for console sessions
  screen.on('resize', () => {
    const cols = (mainView.width as number) - 2; // subtract border
    const rows = (mainView.height as number) - 2;
    handlers['console-resize']?.(cols, rows);
  });

  /**
   * Get the dimensions of the terminal area (inside borders).
   */
  function getTerminalSize(): { cols: number; rows: number } {
    const cols = (mainView.width as number) - 2;
    const rows = (mainView.height as number) - 2;
    return { cols: Math.max(cols, 1), rows: Math.max(rows, 1) };
  }

  /**
   * Write output data to the terminal display.
   */
  function writeToTerminal(data: string) {
    terminal.pushLine(data.replace(/\r?\n/g, '\n').replace(/\n$/, ''));
    terminal.setScrollPerc(100);
    screen.render();
  }

  /**
   * Clear the terminal display.
   */
  function clearTerminal() {
    terminal.setContent('');
    screen.render();
  }

  /**
   * Restore terminal display from an array of buffered output lines.
   */
  function restoreTerminal(lines: string[]) {
    terminal.setContent(lines.join('\n'));
    terminal.setScrollPerc(100);
    screen.render();
  }

  /**
   * Enter console mode for the active VM.
   */
  function enterConsoleMode() {
    state.mode = 'console';
    statusBar.setContent(consoleStatusText);
    render();
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
    helpDialog.show();
    helpDialog.focus();
    screen.render();
  }

  function hideHelp() {
    state.mode = 'normal';
    helpDialog.hide();
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

  // Search input submission
  searchInput.on('submit', (value: string) => {
    state.searchFilter = value?.trim() ?? '';
    hideSearch();
    render();
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

  return {
    screen,
    state,
    sidebar,
    mainView,
    statusBar,
    render,
    onKey,
    getTerminalSize,
    writeToTerminal,
    clearTerminal,
    restoreTerminal,
    enterConsoleMode,
    setStatusMessage(msg: string) {
      statusBar.setContent(` ${msg}`);
      screen.render();
    },
    resetStatus() {
      if (state.mode === 'console') {
        statusBar.setContent(consoleStatusText);
      } else {
        statusBar.setContent(normalStatusText);
      }
      screen.render();
    },
  };
}
