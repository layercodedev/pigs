import blessed from 'blessed';
import type { AppState, VM } from './types.js';

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
    content: ' c:create  d:delete  j/k:navigate  Enter:activate  q:quit',
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

  const normalStatusText = ' c:create  d:delete  j/k:navigate  Enter:activate  q:quit';
  const consoleStatusText = ' Escape:detach  (input forwarded to VM)';

  function renderSidebar() {
    sidebar.children.forEach((child) => {
      if (child !== sidebar) child.detach();
    });

    if (state.vms.length === 0) {
      blessed.text({
        parent: sidebar,
        content: 'No VMs running',
        top: 1,
        left: 1,
        style: { fg: 'gray' },
      });
    } else {
      state.vms.forEach((vm, i) => {
        const isActive = i === state.activeVmIndex;
        const isSelected = i === state.sidebarSelectedIndex;
        const attention = vm.needsAttention ? ' !' : '';
        const statusIcon = vm.status === 'running' ? '*' : '-';
        const prefix = isActive ? '>' : ' ';
        const provLabel = vm.provisioningStatus === 'provisioning' ? ' [setup]'
          : vm.provisioningStatus === 'failed' ? ' [fail]'
          : vm.provisioningStatus === 'pending' ? ' [wait]'
          : '';

        blessed.box({
          parent: sidebar,
          top: i * 3,
          left: 1,
          right: 1,
          height: 3,
          border: isSelected ? { type: 'line' } : undefined,
          style: {
            border: { fg: isSelected ? 'yellow' : 'cyan' },
            bg: isSelected ? 'black' : undefined,
          },
          content: `${prefix} ${statusIcon} ${vm.name}${attention}\n  ${vm.status}${provLabel}`,
          tags: true,
        });
      });
    }
    screen.render();
  }

  function renderMainView() {
    if (state.mode === 'console' && state.activeVmIndex >= 0 && state.vms[state.activeVmIndex]) {
      const vm = state.vms[state.activeVmIndex];
      mainView.setLabel(` Console: ${vm.name} (attached) `);
      mainView.style.border = { fg: 'yellow' };
      noVmMessage.hide();
      terminal.show();
    } else if (state.activeVmIndex >= 0 && state.vms[state.activeVmIndex]) {
      const vm = state.vms[state.activeVmIndex];
      mainView.setLabel(` Console: ${vm.name} `);
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

  screen.key(['q', 'C-c'], () => {
    if (state.mode === 'confirm-delete') {
      hideConfirmDelete();
      return;
    }
    if (state.mode === 'console') {
      // In console mode, q/Ctrl-C go to the VM
      return;
    }
    handlers['quit']?.();
    screen.destroy();
    process.exit(0);
  });

  screen.key(['j', 'down'], () => {
    if (state.mode !== 'normal') return;
    if (state.vms.length > 0) {
      state.sidebarSelectedIndex = Math.min(
        state.sidebarSelectedIndex + 1,
        state.vms.length - 1
      );
      render();
    }
  });

  screen.key(['k', 'up'], () => {
    if (state.mode !== 'normal') return;
    if (state.vms.length > 0) {
      state.sidebarSelectedIndex = Math.max(
        state.sidebarSelectedIndex - 1,
        0
      );
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
    }
  });

  screen.key(['n'], () => {
    if (state.mode === 'confirm-delete') {
      hideConfirmDelete();
    }
  });

  screen.key(['m'], () => {
    if (state.mode !== 'normal') return;
    handlers['mount']?.();
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
   * Enter console mode for the active VM.
   */
  function enterConsoleMode() {
    state.mode = 'console';
    statusBar.setContent(consoleStatusText);
    render();
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
    writeToTerminal,
    clearTerminal,
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
