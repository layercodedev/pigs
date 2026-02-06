#!/usr/bin/env node

import { createApp } from './tui.js';
import { createSpritesClient, listVMs, createVM, deleteVM } from './sprites-client.js';
import {
  attachConsole,
  detachConsole,
  destroyConsole,
  resizeConsole,
  writeToConsole,
  detachAll,
  getSession,
} from './console-session.js';
import { loadSettings, provisionVM } from './provisioner.js';
import { startMonitor, stopMonitor, clearAttention } from './notification-monitor.js';
import { mountVM, unmountVM, unmountAll, isMounted } from './mount-session.js';
import { execFile } from 'node:child_process';
import type { SpritesClient } from '@fly/sprites';

async function main() {
  let client: SpritesClient;
  try {
    client = createSpritesClient();
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }

  const app = createApp();
  const { state } = app;

  // Load settings on first run (creates ~/.pigs/settings.json if missing)
  try {
    state.settings = await loadSettings();
  } catch (err: any) {
    app.setStatusMessage(`Warning: Could not load settings: ${err.message}`);
  }

  // Load existing VMs
  app.setStatusMessage('Loading VMs...');
  try {
    state.vms = await listVMs(client);
    if (state.vms.length > 0) {
      state.activeVmIndex = 0;
      state.sidebarSelectedIndex = 0;
    }
  } catch (err: any) {
    app.setStatusMessage(`Error loading VMs: ${err.message}`);
  }

  app.render();
  app.resetStatus();

  // Start polling VMs for Claude Code finish notifications
  startMonitor(client, state.vms, () => {
    app.render();
  });

  /**
   * Connect stdout/stderr from a console session to the terminal display.
   */
  function connectSessionOutput(vmName: string) {
    const session = getSession(vmName);
    if (!session) return;

    session.command.stdout.on('data', (chunk: Buffer) => {
      app.writeToTerminal(chunk.toString());
    });

    session.command.stderr.on('data', (chunk: Buffer) => {
      app.writeToTerminal(chunk.toString());
    });

    session.command.on('exit', () => {
      if (state.mode === 'console') {
        state.mode = 'normal';
        app.setStatusMessage(`Console session ended for ${vmName}`);
        app.render();
        setTimeout(() => app.resetStatus(), 3000);
      }
    });
  }

  // Activate VM handler - attach console session
  app.onKey('activate', async () => {
    const vm = state.vms[state.activeVmIndex];
    if (!vm) return;

    // Clear attention indicator when user activates this VM
    clearAttention(vm);

    // Detach from any previously active session's output listeners
    for (const v of state.vms) {
      if (v.name !== vm.name && getSession(v.name)) {
        detachConsole(v.name);
      }
    }

    app.setStatusMessage(`Connecting to ${vm.name}...`);
    try {
      const { cols, rows } = app.getTerminalSize();
      await attachConsole(client, vm.name, cols, rows);
      app.clearTerminal();
      connectSessionOutput(vm.name);
      app.enterConsoleMode();
    } catch (err: any) {
      app.setStatusMessage(`Error connecting: ${err.message}`);
      setTimeout(() => app.resetStatus(), 3000);
    }
  });

  // Console input handler - forward keystrokes to VM stdin
  app.onKey('console-input', (data: string) => {
    const vm = state.vms[state.activeVmIndex];
    if (vm) {
      writeToConsole(vm.name, data);
    }
  });

  // Console detach handler
  app.onKey('console-detach', () => {
    const vm = state.vms[state.activeVmIndex];
    if (vm) {
      detachConsole(vm.name);
      app.setStatusMessage(`Detached from ${vm.name}`);
      setTimeout(() => app.resetStatus(), 2000);
    }
  });

  // Console resize handler
  app.onKey('console-resize', (cols: number, rows: number) => {
    const vm = state.vms[state.activeVmIndex];
    if (vm) {
      resizeConsole(vm.name, cols, rows);
    }
  });

  // Create VM handler
  app.onKey('create', async () => {
    state.mode = 'creating';
    app.setStatusMessage('Creating new agent VM...');
    try {
      const vm = await createVM(client);
      vm.provisioningStatus = 'pending';
      state.vms.push(vm);
      state.sidebarSelectedIndex = state.vms.length - 1;
      state.activeVmIndex = state.vms.length - 1;
      state.mode = 'normal';
      app.render();

      // Provision in background
      vm.provisioningStatus = 'provisioning';
      app.setStatusMessage(`Provisioning ${vm.name}...`);
      app.render();
      try {
        await provisionVM(client, vm.name, state.settings ?? undefined, (msg) => {
          app.setStatusMessage(`${vm.name}: ${msg}`);
        });
        vm.provisioningStatus = 'done';
        app.setStatusMessage(`${vm.name} provisioned`);
      } catch (err: any) {
        vm.provisioningStatus = 'failed';
        app.setStatusMessage(`Provisioning failed: ${err.message}`);
      }
    } catch (err: any) {
      app.setStatusMessage(`Error creating VM: ${err.message}`);
      state.mode = 'normal';
    }
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Delete VM handler
  app.onKey('delete', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    app.setStatusMessage(`Deleting VM: ${vm.name}...`);
    try {
      if (isMounted(vm.name)) {
        await unmountVM(vm.name);
      }
      destroyConsole(vm.name);
      await deleteVM(client, vm.name);
      state.vms.splice(state.sidebarSelectedIndex, 1);
      if (state.sidebarSelectedIndex >= state.vms.length) {
        state.sidebarSelectedIndex = Math.max(0, state.vms.length - 1);
      }
      if (state.activeVmIndex >= state.vms.length) {
        state.activeVmIndex = Math.max(-1, state.vms.length - 1);
      }
      app.setStatusMessage('VM deleted');
    } catch (err: any) {
      app.setStatusMessage(`Error deleting VM: ${err.message}`);
    }
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Mount VM filesystem handler
  app.onKey('mount', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    if (isMounted(vm.name)) {
      app.setStatusMessage(`${vm.name} is already mounted at ${vm.mountPath}`);
      setTimeout(() => app.resetStatus(), 3000);
      return;
    }
    app.setStatusMessage(`Mounting ${vm.name}...`);
    try {
      const mountPath = await mountVM(client, vm.name, (msg) => {
        app.setStatusMessage(`${vm.name}: ${msg}`);
      });
      vm.mountPath = mountPath;
      app.setStatusMessage(`Mounted ${vm.name} at ${mountPath}`);

      // Auto-open in VS Code if enabled (defaults to true)
      if (state.settings?.openInVscode !== false) {
        execFile('code', [mountPath], (err) => {
          if (err) {
            app.setStatusMessage(`Mounted ${vm.name} (VS Code open failed: ${err.message})`);
            app.render();
            setTimeout(() => app.resetStatus(), 3000);
          }
        });
      }
    } catch (err: any) {
      app.setStatusMessage(`Mount failed: ${err.message}`);
    }
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Prompt submit handler - run claude -p on the VM
  app.onKey('prompt-submit', async (prompt: string) => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;

    if (vm.provisioningStatus !== 'done') {
      app.setStatusMessage(`${vm.displayLabel ?? vm.name} is not provisioned yet`);
      setTimeout(() => app.resetStatus(), 3000);
      return;
    }

    // Detach from any previously active session's output listeners
    for (const v of state.vms) {
      if (v.name !== vm.name && getSession(v.name)) {
        detachConsole(v.name);
      }
    }

    app.setStatusMessage(`Sending prompt to ${vm.displayLabel ?? vm.name}...`);
    try {
      const { cols, rows } = app.getTerminalSize();
      await attachConsole(client, vm.name, cols, rows);
      state.activeVmIndex = state.sidebarSelectedIndex;
      app.clearTerminal();
      connectSessionOutput(vm.name);

      // Send the claude command with the prompt
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      writeToConsole(vm.name, `claude -p '${escapedPrompt}'\n`);

      app.enterConsoleMode();
    } catch (err: any) {
      app.setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => app.resetStatus(), 3000);
    }
  });

  // Broadcast prompt handler - send claude -p to all provisioned VMs
  app.onKey('broadcast-submit', async (prompt: string) => {
    const targets = state.vms.filter(vm => vm.provisioningStatus === 'done');
    if (targets.length === 0) {
      app.setStatusMessage('No provisioned VMs to broadcast to');
      setTimeout(() => app.resetStatus(), 3000);
      return;
    }

    app.setStatusMessage(`Broadcasting prompt to ${targets.length} agent(s)...`);

    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const command = `claude -p '${escapedPrompt}'\n`;

    let sent = 0;
    let failed = 0;

    for (const vm of targets) {
      try {
        const { cols, rows } = app.getTerminalSize();
        await attachConsole(client, vm.name, cols, rows);
        writeToConsole(vm.name, command);
        sent++;
      } catch {
        failed++;
      }
    }

    const failMsg = failed > 0 ? ` (${failed} failed)` : '';
    app.setStatusMessage(`Broadcast sent to ${sent} agent(s)${failMsg}`);
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Unmount VM filesystem handler
  app.onKey('unmount', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    if (!isMounted(vm.name)) {
      app.setStatusMessage(`${vm.name} is not mounted`);
      setTimeout(() => app.resetStatus(), 3000);
      return;
    }
    app.setStatusMessage(`Unmounting ${vm.name}...`);
    try {
      await unmountVM(vm.name);
      vm.mountPath = undefined;
      app.setStatusMessage(`Unmounted ${vm.name}`);
    } catch (err: any) {
      app.setStatusMessage(`Unmount failed: ${err.message}`);
    }
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Quit handler - detach all sessions gracefully
  app.onKey('quit', async () => {
    stopMonitor();
    detachAll();
    await unmountAll();
  });

  // Handle OS signals for graceful shutdown
  const signalHandler = async () => {
    stopMonitor();
    detachAll();
    await unmountAll();
    process.exit(0);
  };
  process.on('SIGTERM', signalHandler);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
