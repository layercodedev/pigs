#!/usr/bin/env node

import { createApp } from './tui.js';
import { createSpritesClient, listVMs, createVM, deleteVM } from './sprites-client.js';
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

  // Create VM handler
  app.onKey('create', async () => {
    state.mode = 'creating';
    app.setStatusMessage('Creating new agent VM...');
    try {
      const vm = await createVM(client);
      state.vms.push(vm);
      state.sidebarSelectedIndex = state.vms.length - 1;
      state.activeVmIndex = state.vms.length - 1;
      app.setStatusMessage(`Created VM: ${vm.name}`);
    } catch (err: any) {
      app.setStatusMessage(`Error creating VM: ${err.message}`);
    }
    state.mode = 'normal';
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Delete VM handler
  app.onKey('delete', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    app.setStatusMessage(`Deleting VM: ${vm.name}...`);
    try {
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

  // Activate VM handler (switch active console)
  app.onKey('activate', () => {
    const vm = state.vms[state.activeVmIndex];
    if (vm) {
      app.setStatusMessage(`Switched to VM: ${vm.name}`);
      setTimeout(() => app.resetStatus(), 2000);
    }
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
