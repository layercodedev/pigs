#!/usr/bin/env bun

import { createApp } from './tui.ts';
import { createSpritesClient, listVMs, createVM, deleteVM } from './sprites-client.ts';
import {
  attachConsole,
  detachConsole,
  destroyConsole,
  cleanupLocalSession,
  resizeConsole,
  writeToConsole,
  detachAll,
  getSession,
} from './console-session.ts';
import { loadSettings, provisionVM, reprovisionVM } from './provisioner.ts';
import { startMonitor, stopMonitor, clearAttention } from './notification-monitor.ts';
import { mountVM, unmountVM, unmountAll, isMounted } from './mount-session.ts';
import { loadHistory, addToHistory } from './prompt-history.ts';
import { appendOutput, getOutput, clearOutput } from './output-buffer.ts';
import { exportLog } from './log-export.ts';
import { copyToClipboard, Osc52Parser } from './clipboard.ts';
import { enqueue, dequeue, queueSize, clearQueue, clearAllQueues, removeFromQueue } from './prompt-queue.ts';
import { fetchPRChain, getCurrentBranch, getDefaultBranch, buildPRTree, renderPRTree, clearPRCache, findStalePRs } from './pr-chain.ts';
import { fetchMyIssues, renderLinearIssues, clearLinearCache, startIssue } from './linear-client.ts';
import type { LinearIssue } from './linear-client.ts';
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

  // Show preview for initially selected VM
  if (state.vms.length > 0) {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (vm) {
      app.showPreview(getOutput(vm.name));
    }
  }

  /**
   * Process prompt queues: when a VM finishes a task and has queued prompts,
   * automatically send the next prompt.
   */
  async function processQueues() {
    for (const vm of state.vms) {
      if (vm.needsAttention && queueSize(vm.name) > 0) {
        const nextPrompt = dequeue(vm.name);
        if (!nextPrompt) continue;

        // Clear attention — we're sending the next task
        clearAttention(vm);

        try {
          const { cols, rows } = app.getTerminalSize();
          await attachConsole(client, vm.name, cols, rows);
          clearOutput(vm.name);
          connectSessionOutput(vm.name);
          vm.taskStartedAt = Date.now();
          const escapedPrompt = nextPrompt.replace(/'/g, "'\\''");
          writeToConsole(vm.name, `claude -p '${escapedPrompt}'\n`);
          app.setStatusMessage(`Auto-sent queued prompt to ${vm.displayLabel ?? vm.name} (${queueSize(vm.name)} remaining)`);
          app.render();
          setTimeout(() => app.resetStatus(), 3000);
        } catch (err: any) {
          app.setStatusMessage(`Queue auto-send failed for ${vm.displayLabel ?? vm.name}: ${err.message}`);
          setTimeout(() => app.resetStatus(), 3000);
        }
      }
    }
  }

  // Start polling VMs for Claude Code finish notifications
  startMonitor(client, state.vms, () => {
    app.render();
    processQueues();
  });

  /**
   * Connect stdout/stderr from a console session to the terminal display.
   * Idempotent — only adds listeners once per VM.
   */
  const connectedVMs = new Set<string>();
  const osc52Parsers = new Map<string, Osc52Parser>();
  function connectSessionOutput(vmName: string) {
    if (connectedVMs.has(vmName)) return;
    connectedVMs.add(vmName);
    if (!osc52Parsers.has(vmName)) {
      osc52Parsers.set(vmName, new Osc52Parser());
    }
    const parser = osc52Parsers.get(vmName)!;
    const session = getSession(vmName);
    if (!session) return;

    function handleOutput(chunk: Buffer) {
      const { cleanedData: data, clipboardTexts } = parser.process(chunk.toString());
      for (const text of clipboardTexts) {
        copyToClipboard(text);
      }
      if (data.length === 0) return;
      appendOutput(vmName, data);
      if (state.mode === 'console') {
        const activeVm = state.vms[state.activeVmIndex];
        if (activeVm && activeVm.name === vmName) {
          app.writeToTerminal(data);
        }
      } else if (state.mode === 'dashboard') {
        app.renderDashboard();
      } else {
        const selectedVm = state.vms[state.sidebarSelectedIndex];
        if (selectedVm && selectedVm.name === vmName) {
          app.showPreview(getOutput(vmName));
        }
      }
    }

    session.command.stdout.on('data', handleOutput);
    session.command.stderr.on('data', handleOutput);

    session.command.on('exit', () => {
      // Clean up local connection but preserve remote session ID for reattach
      cleanupLocalSession(vmName);
      connectedVMs.delete(vmName);
      osc52Parsers.delete(vmName);

      if (state.mode === 'console') {
        const activeVm = state.vms[state.activeVmIndex];
        if (activeVm && activeVm.name === vmName) {
          state.mode = 'normal';
          app.setStatusMessage(`Console session ended for ${vmName}`);
          app.render();
          setTimeout(() => app.resetStatus(), 3000);
        }
      }
    });
  }

  // Selection changed handler - show preview of selected VM's output buffer
  app.onKey('selection-changed', () => {
    if (state.mode !== 'normal') return;
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    const lines = getOutput(vm.name);
    app.showPreview(lines);
  });

  // Activate VM handler - attach console session
  app.onKey('activate', async () => {
    const vm = state.vms[state.activeVmIndex];
    if (!vm) return;

    // Lock to this VM while connecting — prevents navigation
    state.mode = 'connecting';

    // Clear attention indicator when user activates this VM
    clearAttention(vm);

    app.setStatusMessage(`Connecting to ${vm.name}... (Escape to cancel)`);
    vm.pendingAction = 'connecting...';
    vm.lastError = undefined;
    app.render();
    try {
      const { cols, rows } = app.getTerminalSize();
      await attachConsole(client, vm.name, cols, rows);

      // Check if user cancelled during the await
      if (state.mode !== 'connecting') {
        vm.pendingAction = undefined;
        app.render();
        return;
      }

      vm.pendingAction = undefined;
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
      vm.pendingAction = undefined;
      if (state.mode === 'connecting') {
        state.mode = 'normal';
        vm.lastError = err.message || String(err);
        app.setStatusMessage(`Error connecting: ${err.message}`);
        setTimeout(() => app.resetStatus(), 3000);
      }
    }
    app.render();
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
    app.startSpinner('Creating VM...');
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
      app.updateSpinner(`${vm.name}: Provisioning...`);
      app.render();
      try {
        await provisionVM(client, vm.name, state.settings ?? undefined, (msg) => {
          app.updateSpinner(`${vm.name}: ${msg}`);
          appendOutput(vm.name, `${msg}\n`);
          const selectedVm = state.vms[state.sidebarSelectedIndex];
          if (selectedVm && selectedVm.name === vm.name) {
            app.showPreview(getOutput(vm.name));
          }
        });
        vm.provisioningStatus = 'done';
        app.stopSpinner();
        app.setStatusMessage(`✓ ${vm.name} provisioned`);
      } catch (err: any) {
        vm.provisioningStatus = 'failed';
        app.stopSpinner();
        app.setStatusMessage(`Provisioning failed: ${err.message}`);
      }
    } catch (err: any) {
      app.stopSpinner();
      app.setStatusMessage(`Error creating VM: ${err.message}`);
      state.mode = 'normal';
    }
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Bulk create VMs handler
  app.onKey('bulk-create', async (count: number) => {
    state.mode = 'creating';
    app.startSpinner(`Creating ${count} VMs...`);

    let created = 0;
    let failed = 0;

    // Create all VMs in parallel
    const createPromises = Array.from({ length: count }, async () => {
      try {
        const vm = await createVM(client);
        vm.provisioningStatus = 'pending';
        state.vms.push(vm);
        created++;
        app.updateSpinner(`Created ${created}/${count} VMs...`);
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
    app.updateSpinner(`Created ${created} VMs${failMsg}, provisioning...`);
    app.render();

    // Provision all new VMs in parallel
    let provisioned = 0;
    let provFailed = 0;
    const provisionPromises = newVMs.map(async (vm) => {
      vm.provisioningStatus = 'provisioning';
      app.render();
      try {
        await provisionVM(client, vm.name, state.settings ?? undefined, (msg) => {
          app.updateSpinner(`${vm.name}: ${msg}`);
          appendOutput(vm.name, `${msg}\n`);
          const selectedVm = state.vms[state.sidebarSelectedIndex];
          if (selectedVm && selectedVm.name === vm.name) {
            app.showPreview(getOutput(vm.name));
          }
        });
        vm.provisioningStatus = 'done';
        provisioned++;
        app.updateSpinner(`Provisioned ${provisioned}/${newVMs.length}${provFailed > 0 ? ` (${provFailed} failed)` : ''}...`);
        app.render();
      } catch {
        vm.provisioningStatus = 'failed';
        provFailed++;
        app.render();
      }
    });

    await Promise.all(provisionPromises);
    app.stopSpinner();
    const provFailMsg = provFailed > 0 ? ` (${provFailed} failed)` : '';
    app.setStatusMessage(`✓ ${provisioned} VMs provisioned${provFailMsg}`);
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Delete VM handler
  app.onKey('delete', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    app.setStatusMessage(`Deleting VM: ${vm.name}...`);
    vm.pendingAction = 'deleting...';
    vm.lastError = undefined;
    app.render();
    try {
      if (isMounted(vm.name)) {
        await unmountVM(vm.name);
      }
      destroyConsole(vm.name);
      clearOutput(vm.name);
      clearQueue(vm.name);
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
      vm.pendingAction = undefined;
      vm.lastError = err.message || String(err);
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
      vm.pendingAction = 'deleting...';
      vm.lastError = undefined;
      app.render();
      try {
        if (isMounted(vm.name)) {
          await unmountVM(vm.name);
          vm.mountPath = undefined;
        }
        destroyConsole(vm.name);
        clearOutput(vm.name);
        clearQueue(vm.name);
        await deleteVM(client, vm.name);
        deletedNames.add(vm.name);
        app.setStatusMessage(`Deleted ${deletedNames.size}/${total} VMs...`);
        app.render();
      } catch (err: any) {
        vm.pendingAction = undefined;
        vm.lastError = err.message || String(err);
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
    vm.pendingAction = 're-provisioning...';
    vm.lastError = undefined;
    app.render();
    try {
      // Reload settings from disk
      state.settings = await loadSettings();
      await reprovisionVM(client, vm.name, (msg) => {
        app.setStatusMessage(`${vm.displayLabel ?? vm.name}: ${msg}`);
      });
      vm.pendingAction = undefined;
      app.setStatusMessage(`${vm.displayLabel ?? vm.name} re-provisioned`);
    } catch (err: any) {
      vm.pendingAction = undefined;
      vm.lastError = err.message || String(err);
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
      vm.pendingAction = 're-provisioning...';
      vm.lastError = undefined;
      app.render();
      try {
        await reprovisionVM(client, vm.name);
        vm.pendingAction = undefined;
        done++;
        app.setStatusMessage(`Re-provisioned ${done}/${targets.length}${failed > 0 ? ` (${failed} failed)` : ''}...`);
        app.render();
      } catch (err: any) {
        vm.pendingAction = undefined;
        vm.lastError = err.message || String(err);
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

  // Stop/cancel running agent handler - send Ctrl-C to the VM's console
  app.onKey('stop-agent', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;

    // Must have an active console session to send Ctrl-C
    const session = getSession(vm.name);
    if (!session?.started) {
      // Try to attach first so we can send Ctrl-C
      try {
        const { cols, rows } = app.getTerminalSize();
        await attachConsole(client, vm.name, cols, rows);
        connectSessionOutput(vm.name);
      } catch (err: any) {
        app.setStatusMessage(`Cannot stop ${vm.displayLabel ?? vm.name}: ${err.message}`);
        setTimeout(() => app.resetStatus(), 3000);
        return;
      }
    }

    // Send Ctrl-C (ETX character) to interrupt the running process
    writeToConsole(vm.name, '\x03');
    vm.taskStartedAt = undefined;
    app.setStatusMessage(`Sent stop signal to ${vm.displayLabel ?? vm.name}`);
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Retry provisioning for failed VMs
  app.onKey('retry-provision', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm || vm.provisioningStatus !== 'failed') return;

    vm.provisioningStatus = 'provisioning';
    vm.lastError = undefined;
    app.startSpinner(`${vm.displayLabel ?? vm.name}: Retrying provisioning...`);
    app.render();
    try {
      await provisionVM(client, vm.name, state.settings ?? undefined, (msg) => {
        app.updateSpinner(`${vm.displayLabel ?? vm.name}: ${msg}`);
        appendOutput(vm.name, `${msg}\n`);
        const selectedVm = state.vms[state.sidebarSelectedIndex];
        if (selectedVm && selectedVm.name === vm.name) {
          app.showPreview(getOutput(vm.name));
        }
      });
      vm.provisioningStatus = 'done';
      app.stopSpinner();
      app.setStatusMessage(`✓ ${vm.displayLabel ?? vm.name} provisioned`);
    } catch (err: any) {
      vm.provisioningStatus = 'failed';
      app.stopSpinner();
      app.setStatusMessage(`Provisioning failed: ${err.message}`);
    }
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Export VM console log handler
  app.onKey('export-log', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;

    const lines = getOutput(vm.name);
    if (lines.length === 0) {
      app.setStatusMessage(`No output to export for ${vm.displayLabel ?? vm.name}`);
      setTimeout(() => app.resetStatus(), 3000);
      return;
    }

    try {
      const label = vm.displayLabel ?? vm.name;
      const logPath = await exportLog(label, lines);
      app.setStatusMessage(`Exported ${lines.length} lines to ${logPath}`);
    } catch (err: any) {
      app.setStatusMessage(`Export failed: ${err.message}`);
    }
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Queue remove handler - remove a single prompt from the queue at a given index
  app.onKey('queue-remove', (index: number) => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    const removed = removeFromQueue(vm.name, index);
    if (removed) {
      app.renderQueueViewer(vm);
      app.render();
    }
  });

  // Queue clear handler - clear all prompts from the selected VM's queue
  app.onKey('queue-clear', () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    clearQueue(vm.name);
    app.renderQueueViewer(vm);
    app.render();
  });

  // Fetch and render PR chain for a VM
  async function fetchAndRenderPRChain() {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;

    if (vm.provisioningStatus !== 'done') {
      app.renderPRChain('\n  {yellow-fg}VM is not provisioned yet{/yellow-fg}', 'PR Chain');
      return;
    }

    try {
      const [prs, currentBranch, defaultBranch] = await Promise.all([
        fetchPRChain(client, vm.name),
        getCurrentBranch(client, vm.name),
        getDefaultBranch(client, vm.name),
      ]);

      if (prs.length === 0) {
        app.renderPRChain(
          '\n  {gray-fg}No pull requests found{/gray-fg}\n\n  Hint: create a PR with {bold}gh pr create{/bold}',
          `PR Chain — ${vm.displayLabel ?? vm.name}`,
        );
        return;
      }

      const tree = buildPRTree(prs, defaultBranch);
      const width = (app.screen.width as number) - 4;
      const lines = renderPRTree(tree, currentBranch, width);
      app.renderPRChain('\n' + lines.join('\n'), `PR Chain — ${vm.displayLabel ?? vm.name}`);
    } catch (err: any) {
      const msg = String(err.message || err);
      if (msg.includes('gh') && (msg.includes('not found') || msg.includes('command not found'))) {
        app.renderPRChain('\n  {red-fg}GitHub CLI (gh) not available on this VM{/red-fg}', 'PR Chain');
      } else if (msg.includes('not a git repository')) {
        app.renderPRChain('\n  {red-fg}No git repository found on this VM{/red-fg}', 'PR Chain');
      } else {
        app.renderPRChain(`\n  {red-fg}Error: ${msg}{/red-fg}`, 'PR Chain');
      }
    }
  }

  // PR chain open handler
  app.onKey('pr-chain-open', fetchAndRenderPRChain);

  // PR chain refresh handler - clear cache and re-fetch
  app.onKey('pr-chain-refresh', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;

    clearPRCache(vm.name);
    app.renderPRChain('\n  {yellow-fg}Refreshing PR data...{/yellow-fg}', 'PR Chain');
    await fetchAndRenderPRChain();
  });

  // PR chain sync handler - send rebase prompt to the selected VM's agent
  app.onKey('pr-chain-sync', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;

    if (vm.provisioningStatus !== 'done') {
      app.setStatusMessage(`${vm.displayLabel ?? vm.name} is not provisioned yet`);
      setTimeout(() => app.resetStatus(), 3000);
      return;
    }

    app.setStatusMessage(`Syncing ${vm.displayLabel ?? vm.name}...`);

    try {
      const [prs, currentBranch, defaultBranch] = await Promise.all([
        fetchPRChain(client, vm.name),
        getCurrentBranch(client, vm.name),
        getDefaultBranch(client, vm.name),
      ]);

      // Find the PR for this VM's current branch
      const currentPR = prs.find(pr => pr.headRefName === currentBranch);
      if (!currentPR) {
        app.setStatusMessage(`No PR found for branch "${currentBranch}"`);
        setTimeout(() => app.resetStatus(), 3000);
        return;
      }

      // Check if this PR is stale
      const stalePRs = findStalePRs(prs, defaultBranch);
      const isStale = stalePRs.some(pr => pr.number === currentPR.number);
      if (!isStale) {
        app.setStatusMessage(`PR #${currentPR.number} is not stale — no sync needed`);
        setTimeout(() => app.resetStatus(), 3000);
        return;
      }

      // Send rebase prompt to the agent
      const { cols, rows } = app.getTerminalSize();
      await attachConsole(client, vm.name, cols, rows);
      state.activeVmIndex = state.sidebarSelectedIndex;
      clearOutput(vm.name);
      app.clearTerminal();
      connectSessionOutput(vm.name);
      vm.taskStartedAt = Date.now();

      const rebasePrompt = `Your PR #${currentPR.number} (branch "${currentBranch}") targets "${currentPR.baseRefName}" which has been merged into ${defaultBranch}. Please: 1) git fetch origin, 2) retarget your PR to ${defaultBranch} with \`gh pr edit ${currentPR.number} --base ${defaultBranch}\`, 3) rebase your branch onto origin/${defaultBranch}, 4) resolve any conflicts, 5) force-push with \`git push --force-with-lease\`.`;
      const escapedPrompt = rebasePrompt.replace(/'/g, "'\\''");
      writeToConsole(vm.name, `claude -p '${escapedPrompt}'\n`);

      app.enterConsoleMode();
    } catch (err: any) {
      app.setStatusMessage(`Sync failed: ${err.message}`);
      setTimeout(() => app.resetStatus(), 3000);
    }
  });

  // Linear tasks open handler
  app.onKey('linear-open', async () => {
    try {
      const issues = await fetchMyIssues();
      app.setLinearIssues(issues);
      const width = (app.screen.width as number) - 4;
      const checkedIds = app.getLinearCheckedIds();
      const lines = renderLinearIssues(issues, 0, width, checkedIds);
      app.renderLinear('\n' + lines.join('\n'), `Linear Tasks — ${issues.length} issue${issues.length !== 1 ? 's' : ''}`);
    } catch (err: any) {
      const msg = String(err.message || err);
      if (msg.includes('LINEAR_API_KEY')) {
        app.renderLinear('\n  {red-fg}LINEAR_API_KEY environment variable is not set{/red-fg}\n\n  Get your API key from Linear Settings > API > Personal API keys', 'Linear Tasks');
      } else {
        app.renderLinear(`\n  {red-fg}Error: ${msg}{/red-fg}`, 'Linear Tasks');
      }
    }
  });

  // Linear tasks refresh handler
  app.onKey('linear-refresh', async () => {
    clearLinearCache();
    app.renderLinear('\n  {yellow-fg}Refreshing Linear tasks...{/yellow-fg}', 'Linear Tasks');
    try {
      const issues = await fetchMyIssues();
      app.setLinearIssues(issues);
      const width = (app.screen.width as number) - 4;
      const checkedIds = app.getLinearCheckedIds();
      const lines = renderLinearIssues(issues, 0, width, checkedIds);
      app.renderLinear('\n' + lines.join('\n'), `Linear Tasks — ${issues.length} issue${issues.length !== 1 ? 's' : ''}`);
    } catch (err: any) {
      app.renderLinear(`\n  {red-fg}Error: ${String(err.message || err)}{/red-fg}`, 'Linear Tasks');
    }
  });

  // Linear re-render handler (when selection changes with j/k or space toggle)
  app.onKey('linear-rerender', async () => {
    try {
      const issues = await fetchMyIssues(); // returns cached data
      const width = (app.screen.width as number) - 4;
      const idx = app.getLinearSelectedIndex();
      const checkedIds = app.getLinearCheckedIds();
      const lines = renderLinearIssues(issues, idx, width, checkedIds);
      app.renderLinear('\n' + lines.join('\n'), `Linear Tasks — ${issues.length} issue${issues.length !== 1 ? 's' : ''}`);
    } catch { /* ignore */ }
  });

  // Linear claim handler - create VMs, set issues to In Progress, send as prompts in parallel
  app.onKey('linear-claim', async (issues: LinearIssue[]) => {
    const count = issues.length;
    const label = count === 1 ? issues[0].identifier : `${count} tasks`;
    app.startSpinner(`Claiming ${label}...`);

    async function claimSingleIssue(issue: LinearIssue): Promise<{ ok: boolean; identifier: string }> {
      // Set issue to In Progress in Linear
      try {
        await startIssue(issue.id);
      } catch (err: any) {
        return { ok: false, identifier: issue.identifier };
      }

      // Create a new VM
      try {
        app.updateSpinner(`${issue.identifier}: Creating VM...`);
        const vm = await createVM(client);
        vm.provisioningStatus = 'pending';
        vm.displayLabel = issue.identifier;
        vm.customLabel = true;
        state.vms.push(vm);
        app.render();

        // Provision VM
        vm.provisioningStatus = 'provisioning';
        app.render();
        try {
          await provisionVM(client, vm.name, state.settings ?? undefined, (msg) => {
            app.updateSpinner(`${issue.identifier}: ${msg}`);
            appendOutput(vm.name, `${msg}\n`);
            const selectedVm = state.vms[state.sidebarSelectedIndex];
            if (selectedVm && selectedVm.name === vm.name) {
              app.showPreview(getOutput(vm.name));
            }
          });
          vm.provisioningStatus = 'done';
        } catch {
          vm.provisioningStatus = 'failed';
          app.render();
          return { ok: false, identifier: issue.identifier };
        }

        // Send the task as a prompt using the Linear branch name
        const { cols, rows } = app.getTerminalSize();
        await attachConsole(client, vm.name, cols, rows);
        clearOutput(vm.name);
        connectSessionOutput(vm.name);
        vm.taskStartedAt = Date.now();

        const desc = issue.description ? `\n\nDescription:\n${issue.description}` : '';
        const prompt = `You are working on Linear issue ${issue.identifier}: "${issue.title}"${desc}\n\nIMPORTANT: Use the git branch name "${issue.branchName}" for your work so that PRs automatically link to this Linear issue. Create this branch with: git checkout -b ${issue.branchName}\n\nPlease implement this task.`;
        const escapedPrompt = prompt.replace(/'/g, "'\\''");
        writeToConsole(vm.name, `claude -p '${escapedPrompt}'\n`);

        app.render();
        return { ok: true, identifier: issue.identifier };
      } catch {
        return { ok: false, identifier: issue.identifier };
      }
    }

    const results = await Promise.all(issues.map(claimSingleIssue));
    const succeeded = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);

    // Select the last created VM
    if (state.vms.length > 0) {
      state.sidebarSelectedIndex = state.vms.length - 1;
      state.activeVmIndex = state.vms.length - 1;
    }

    app.stopSpinner();
    if (failed.length === 0) {
      app.setStatusMessage(`✓ ${succeeded.length} task${succeeded.length !== 1 ? 's' : ''} claimed and sent to agents`);
    } else {
      app.setStatusMessage(`${succeeded.length} claimed, ${failed.length} failed (${failed.map(f => f.identifier).join(', ')})`);
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
    vm.pendingAction = 'mounting...';
    vm.lastError = undefined;
    app.render();
    try {
      const mountPath = await mountVM(client, vm.name, (msg) => {
        app.setStatusMessage(`${vm.name}: ${msg}`);
      });
      vm.pendingAction = undefined;
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
      vm.pendingAction = undefined;
      vm.lastError = err.message || String(err);
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
      vm.taskStartedAt = Date.now();
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
        clearOutput(vm.name);
        connectSessionOutput(vm.name);
        vm.taskStartedAt = Date.now();
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

  // Queue prompt handler - add prompt to VM's queue for sequential execution
  app.onKey('queue-submit', async (prompt: string) => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;

    await addToHistory(prompt);

    if (vm.provisioningStatus !== 'done') {
      app.setStatusMessage(`${vm.displayLabel ?? vm.name} is not provisioned yet`);
      setTimeout(() => app.resetStatus(), 3000);
      return;
    }

    enqueue(vm.name, prompt);
    const count = queueSize(vm.name);
    app.setStatusMessage(`Queued prompt for ${vm.displayLabel ?? vm.name} (${count} in queue)`);
    app.render();
    setTimeout(() => app.resetStatus(), 3000);

    // If VM is idle (needs attention or no task running), send immediately
    if (vm.needsAttention || !vm.taskStartedAt) {
      const nextPrompt = dequeue(vm.name);
      if (!nextPrompt) return;

      if (vm.needsAttention) clearAttention(vm);

      try {
        const { cols, rows } = app.getTerminalSize();
        await attachConsole(client, vm.name, cols, rows);
        clearOutput(vm.name);
        connectSessionOutput(vm.name);
        vm.taskStartedAt = Date.now();
        const escapedPrompt = nextPrompt.replace(/'/g, "'\\''");
        writeToConsole(vm.name, `claude -p '${escapedPrompt}'\n`);
        app.setStatusMessage(`Sent queued prompt to ${vm.displayLabel ?? vm.name} (${queueSize(vm.name)} remaining)`);
        app.render();
      } catch (err: any) {
        app.setStatusMessage(`Error sending queued prompt: ${err.message}`);
      }
      setTimeout(() => app.resetStatus(), 3000);
    }
  });

  // Broadcast queue prompt handler - add prompt to all provisioned VMs' queues
  app.onKey('broadcast-queue-submit', async (prompt: string) => {
    await addToHistory(prompt);

    const targets = state.vms.filter(vm => vm.provisioningStatus === 'done');
    if (targets.length === 0) {
      app.setStatusMessage('No provisioned VMs to broadcast queue to');
      setTimeout(() => app.resetStatus(), 3000);
      return;
    }

    let queued = 0;
    let sent = 0;

    for (const vm of targets) {
      // If VM is idle, send immediately
      if (vm.needsAttention || !vm.taskStartedAt) {
        if (vm.needsAttention) clearAttention(vm);
        try {
          const { cols, rows } = app.getTerminalSize();
          await attachConsole(client, vm.name, cols, rows);
          clearOutput(vm.name);
          connectSessionOutput(vm.name);
          vm.taskStartedAt = Date.now();
          const escapedPrompt = prompt.replace(/'/g, "'\\''");
          writeToConsole(vm.name, `claude -p '${escapedPrompt}'\n`);
          sent++;
        } catch {
          // If immediate send fails, enqueue instead
          enqueue(vm.name, prompt);
          queued++;
        }
      } else {
        enqueue(vm.name, prompt);
        queued++;
      }
    }

    const parts: string[] = [];
    if (sent > 0) parts.push(`sent to ${sent}`);
    if (queued > 0) parts.push(`queued on ${queued}`);
    app.setStatusMessage(`Broadcast queue: ${parts.join(', ')} agent(s)`);
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Ralph prompt handler - run iterative claude loop on the VM
  app.onKey('ralph-submit', async (prompt: string, iterations: number) => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;

    await addToHistory(prompt);

    if (vm.provisioningStatus !== 'done') {
      app.setStatusMessage(`${vm.displayLabel ?? vm.name} is not provisioned yet`);
      setTimeout(() => app.resetStatus(), 3000);
      return;
    }

    app.setStatusMessage(`Starting Ralph on ${vm.displayLabel ?? vm.name} (${iterations} iterations)...`);
    try {
      const { cols, rows } = app.getTerminalSize();
      await attachConsole(client, vm.name, cols, rows);
      state.activeVmIndex = state.sidebarSelectedIndex;
      clearOutput(vm.name);
      app.clearTerminal();
      connectSessionOutput(vm.name);

      vm.taskStartedAt = Date.now();

      // Build the ralph loop as an inline bash script.
      // Suppress intermediate done-signals so the monitor only fires once at the end.
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      const ralphScript = [
        `rm -f /tmp/claude-done-signal`,
        `for i in $(seq 1 ${iterations}); do`,
        `  echo "=== Ralph iteration $i/${iterations} ==="`,
        `  tmpfile=$(mktemp)`,
        `  claude --dangerously-skip-permissions -p '${escapedPrompt}' 2>&1 | tee "$tmpfile"`,
        `  rm -f /tmp/claude-done-signal`,
        `  if grep -q '<promise>COMPLETE</promise>' "$tmpfile"; then`,
        `    echo "Ralph complete after $i iterations."`,
        `    rm -f "$tmpfile"`,
        `    break`,
        `  fi`,
        `  rm -f "$tmpfile"`,
        `done`,
        `touch /tmp/claude-done-signal`,
      ].join('\n');

      writeToConsole(vm.name, ralphScript + '\n');

      app.enterConsoleMode();
    } catch (err: any) {
      app.setStatusMessage(`Error: ${err.message}`);
      setTimeout(() => app.resetStatus(), 3000);
    }
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
    vm.pendingAction = 'unmounting...';
    vm.lastError = undefined;
    app.render();
    try {
      await unmountVM(vm.name);
      vm.pendingAction = undefined;
      vm.mountPath = undefined;
      app.setStatusMessage(`Unmounted ${vm.name}`);
    } catch (err: any) {
      vm.pendingAction = undefined;
      vm.lastError = err.message || String(err);
      app.setStatusMessage(`Unmount failed: ${err.message}`);
    }
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Copy error to clipboard handler
  app.onKey('copy-error', async () => {
    const error = app.getSelectedVMError();
    if (!error) return;

    const ok = await copyToClipboard(error);
    if (ok) {
      app.setStatusMessage('Error copied to clipboard');
      setTimeout(() => app.resetStatus(), 2000);
    } else {
      app.setStatusMessage('Failed to copy error: no clipboard command available');
      setTimeout(() => app.resetStatus(), 3000);
    }
  });

  // Quit handler - detach all sessions gracefully
  app.onKey('quit', async () => {
    stopMonitor();
    clearAllQueues();
    detachAll();
    await unmountAll();
  });

  // Handle OS signals for graceful shutdown
  const signalHandler = async () => {
    stopMonitor();
    clearAllQueues();
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
