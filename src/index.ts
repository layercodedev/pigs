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
import { provisionVM } from './provisioner.js';
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
        await provisionVM(client, vm.name, (msg) => {
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

  // Quit handler - detach all sessions gracefully
  app.onKey('quit', () => {
    detachAll();
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
