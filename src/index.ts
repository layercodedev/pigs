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
import { loadSettings, provisionVM, reprovisionVM } from './provisioner.js';
import { startMonitor, stopMonitor, clearAttention } from './notification-monitor.js';
import { mountVM, unmountVM, unmountAll, isMounted } from './mount-session.js';
import { loadHistory, addToHistory } from './prompt-history.js';
import { appendOutput, getOutput, clearOutput } from './output-buffer.js';
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

  // Load prompt history
  await loadHistory();

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
   * Idempotent — only adds listeners once per VM.
   */
  const connectedVMs = new Set<string>();
  function connectSessionOutput(vmName: string) {
    if (connectedVMs.has(vmName)) return;
    connectedVMs.add(vmName);
    const session = getSession(vmName);
    if (!session) return;

    session.command.stdout.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      appendOutput(vmName, data);
      // Only write to terminal if this VM is the active one
      const activeVm = state.vms[state.activeVmIndex];
      if (activeVm && activeVm.name === vmName) {
        app.writeToTerminal(data);
      }
    });

    session.command.stderr.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      appendOutput(vmName, data);
      const activeVm = state.vms[state.activeVmIndex];
      if (activeVm && activeVm.name === vmName) {
        app.writeToTerminal(data);
      }
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

    app.setStatusMessage(`Connecting to ${vm.name}...`);
    try {
      const { cols, rows } = app.getTerminalSize();
      await attachConsole(client, vm.name, cols, rows);
      connectSessionOutput(vm.name);
      // Restore buffered output for this VM
      const buffered = getOutput(vm.name);
      if (buffered.length > 0) {
        app.restoreTerminal(buffered);
      } else {
        app.clearTerminal();
      }
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

  // Bulk create VMs handler
  app.onKey('bulk-create', async (count: number) => {
    state.mode = 'creating';
    app.setStatusMessage(`Creating ${count} agent VMs...`);

    let created = 0;
    let failed = 0;

    // Create all VMs in parallel
    const createPromises = Array.from({ length: count }, async () => {
      try {
        const vm = await createVM(client);
        vm.provisioningStatus = 'pending';
        state.vms.push(vm);
        created++;
        app.setStatusMessage(`Created ${created}/${count} VMs...`);
        app.render();
        return vm;
      } catch {
        failed++;
        return null;
      }
    });

    const results = await Promise.all(createPromises);
    const newVMs = results.filter((vm): vm is NonNullable<typeof vm> => vm !== null);

    // Select the first new VM
    if (newVMs.length > 0) {
      state.sidebarSelectedIndex = state.vms.indexOf(newVMs[0]);
      state.activeVmIndex = state.sidebarSelectedIndex;
    }
    state.mode = 'normal';

    const failMsg = failed > 0 ? ` (${failed} failed)` : '';
    app.setStatusMessage(`Created ${created} VMs${failMsg}, provisioning...`);
    app.render();

    // Provision all new VMs in parallel
    let provisioned = 0;
    let provFailed = 0;
    const provisionPromises = newVMs.map(async (vm) => {
      vm.provisioningStatus = 'provisioning';
      app.render();
      try {
        await provisionVM(client, vm.name, state.settings ?? undefined, () => {});
        vm.provisioningStatus = 'done';
        provisioned++;
        app.setStatusMessage(`Provisioned ${provisioned}/${newVMs.length}${provFailed > 0 ? ` (${provFailed} failed)` : ''}...`);
        app.render();
      } catch {
        vm.provisioningStatus = 'failed';
        provFailed++;
        app.render();
      }
    });

    await Promise.all(provisionPromises);
    const provFailMsg = provFailed > 0 ? ` (${provFailed} failed)` : '';
    app.setStatusMessage(`${provisioned} VMs provisioned${provFailMsg}`);
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
      clearOutput(vm.name);
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

  // Delete all VMs handler
  app.onKey('delete-all', async () => {
    if (state.vms.length === 0) return;

    const total = state.vms.length;
    app.setStatusMessage(`Deleting all ${total} VMs...`);

    const deletedNames = new Set<string>();
    let failed = 0;

    // Delete all VMs in parallel
    const deletePromises = [...state.vms].map(async (vm) => {
      try {
        if (isMounted(vm.name)) {
          await unmountVM(vm.name);
          vm.mountPath = undefined;
        }
        destroyConsole(vm.name);
        clearOutput(vm.name);
        await deleteVM(client, vm.name);
        deletedNames.add(vm.name);
        app.setStatusMessage(`Deleted ${deletedNames.size}/${total} VMs...`);
        app.render();
      } catch {
        failed++;
      }
    });

    await Promise.all(deletePromises);

    // Remove successfully deleted VMs from state
    state.vms = state.vms.filter((vm) => !deletedNames.has(vm.name));
    state.sidebarSelectedIndex = 0;
    state.activeVmIndex = state.vms.length > 0 ? 0 : -1;

    const failMsg = failed > 0 ? ` (${failed} failed)` : '';
    app.setStatusMessage(`Deleted ${deletedNames.size} VMs${failMsg}`);
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Re-provision selected VM handler
  app.onKey('reprovision', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm || vm.provisioningStatus !== 'done') return;

    app.setStatusMessage(`Re-provisioning ${vm.displayLabel ?? vm.name}...`);
    try {
      // Reload settings from disk
      state.settings = await loadSettings();
      await reprovisionVM(client, vm.name, (msg) => {
        app.setStatusMessage(`${vm.displayLabel ?? vm.name}: ${msg}`);
      });
      app.setStatusMessage(`${vm.displayLabel ?? vm.name} re-provisioned`);
    } catch (err: any) {
      app.setStatusMessage(`Re-provision failed: ${err.message}`);
    }
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Re-provision all VMs handler
  app.onKey('reprovision-all', async () => {
    const targets = state.vms.filter(vm => vm.provisioningStatus === 'done');
    if (targets.length === 0) return;

    app.setStatusMessage(`Re-provisioning ${targets.length} VMs...`);

    // Reload settings from disk once
    try {
      state.settings = await loadSettings();
    } catch (err: any) {
      app.setStatusMessage(`Failed to load settings: ${err.message}`);
      setTimeout(() => app.resetStatus(), 3000);
      return;
    }

    let done = 0;
    let failed = 0;

    const promises = targets.map(async (vm) => {
      try {
        await reprovisionVM(client, vm.name);
        done++;
        app.setStatusMessage(`Re-provisioned ${done}/${targets.length}${failed > 0 ? ` (${failed} failed)` : ''}...`);
        app.render();
      } catch {
        failed++;
      }
    });

    await Promise.all(promises);
    const failMsg = failed > 0 ? ` (${failed} failed)` : '';
    app.setStatusMessage(`${done} VMs re-provisioned${failMsg}`);
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Rename VM handler - set custom displayLabel
  app.onKey('rename-submit', (label: string) => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;

    if (label) {
      vm.displayLabel = label;
      vm.customLabel = true;
      app.setStatusMessage(`Renamed to "${label}"`);
    } else {
      // Empty label resets to auto-detected label (will be updated by monitor)
      vm.displayLabel = undefined;
      vm.customLabel = false;
      app.setStatusMessage('Label reset (will auto-detect)');
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

    await addToHistory(prompt);

    if (vm.provisioningStatus !== 'done') {
      app.setStatusMessage(`${vm.displayLabel ?? vm.name} is not provisioned yet`);
      setTimeout(() => app.resetStatus(), 3000);
      return;
    }

    app.setStatusMessage(`Sending prompt to ${vm.displayLabel ?? vm.name}...`);
    try {
      const { cols, rows } = app.getTerminalSize();
      await attachConsole(client, vm.name, cols, rows);
      state.activeVmIndex = state.sidebarSelectedIndex;
      // Clear buffer for fresh prompt output
      clearOutput(vm.name);
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
    await addToHistory(prompt);

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
