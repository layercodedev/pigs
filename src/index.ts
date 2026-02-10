#!/usr/bin/env bun

import { createApp } from './tui.ts';
import { listBranches, createBranch, deleteBranch, generateBranchName, getRepoRoot, getRepoName, copyConfigFiles } from './worktree-client.ts';
import { findOpenPort } from './port-finder.ts';
import { loadSettings, provisionBranch, reprovisionBranch } from './provisioner.ts';
import { startMonitor, stopMonitor, clearAttention } from './notification-monitor.ts';
import { loadHistory, addToHistory } from './prompt-history.ts';
import { appendOutput, getOutput, clearOutput } from './output-buffer.ts';
import { exportLog } from './log-export.ts';
import { enqueue, dequeue, queueSize, clearQueue, clearAllQueues, removeFromQueue } from './prompt-queue.ts';
import { fetchPRChain, getCurrentBranch, getDefaultBranch, buildPRTree, renderPRTree, clearPRCache, findStalePRs } from './pr-chain.ts';
import { fetchMyIssues, renderLinearIssues, clearLinearCache, startIssue } from './linear-client.ts';
import type { LinearIssue } from './linear-client.ts';
import {
  insideTmux,
  sessionExists,
  createSession,
  attachSession,
  createWindow,
  killWindow,
  killSession,
  getSessionName,
  createRightPane,
  setLeftPaneWidth,
  respawnRightPane,
  focusRightPane,
  rightPaneExists,
  zoomPane,
  createGridWindow,
  killGridWindow,
  switchToControlPane,
} from './tmux.ts';

async function main() {
  // Ensure we're inside a tmux session.
  if (!insideTmux()) {
    const name = getSessionName();
    if (!sessionExists(name)) {
      const cmd = process.argv.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      createSession(name, cmd);
    }
    attachSession(name);
    process.exit(0);
  }

  // Verify we're in a git repo
  let repoRoot: string;
  try {
    repoRoot = getRepoRoot();
  } catch {
    console.error('Error: pigs must be run inside a git repository');
    process.exit(1);
  }

  const app = createApp();
  const { state } = app;
  state.repoRoot = repoRoot;

  // Load settings
  try {
    state.settings = await loadSettings();
  } catch (err: any) {
    app.setStatusMessage(`Warning: Could not load settings: ${err.message}`);
  }

  // Load prompt history
  await loadHistory();

  // Load existing worktree branches
  app.setStatusMessage('Loading branches...');
  try {
    state.vms = listBranches(repoRoot);
    if (state.vms.length > 0) {
      state.activeVmIndex = 0;
      state.sidebarSelectedIndex = 0;
    }
  } catch (err: any) {
    app.setStatusMessage(`Error loading branches: ${err.message}`);
  }

  app.render();
  app.resetStatus();

  // Create the right pane and set sidebar width
  createRightPane();
  setLeftPaneWidth(34);

  /**
   * Process prompt queues: when a branch finishes a task and has queued prompts,
   * automatically send the next prompt.
   */
  async function processQueues() {
    for (const vm of state.vms) {
      if (vm.needsAttention && queueSize(vm.name) > 0) {
        const nextPrompt = dequeue(vm.name);
        if (!nextPrompt) continue;

        clearAttention(vm);
        vm.taskStartedAt = Date.now();
        const escapedPrompt = nextPrompt.replace(/'/g, "'\\''");
        const command = `cd '${vm.worktreePath.replace(/'/g, "'\\''")}' && claude -p '${escapedPrompt}'`;

        if (vm.name === state.rightPaneVmName) {
          ensureRightPane();
          respawnRightPane(command);
        } else {
          killWindow(vm.name);
          createWindow(vm.name, command);
        }
        app.setStatusMessage(`Auto-sent queued prompt to ${vm.displayLabel ?? vm.name} (${queueSize(vm.name)} remaining)`);
        app.render();
        setTimeout(() => app.resetStatus(), 3000);
      }
    }
  }

  // Start polling for Claude Code finish notifications
  startMonitor(state.vms, () => {
    app.render();
    processQueues();
  });

  // Selection changed handler
  app.onKey('selection-changed', () => {});

  // Toggle sidebar handler (Tab key)
  app.onKey('toggle-sidebar', () => {
    ensureRightPane();
    try {
      zoomPane('0.1');
      state.sidebarHidden = true;
      focusRightPane();
    } catch {}
  });

  function ensureRightPane() {
    if (!rightPaneExists()) {
      createRightPane();
      setLeftPaneWidth(34);
    }
  }

  function openVmInRightPane(vmName: string, command: string) {
    ensureRightPane();
    respawnRightPane(command);
    state.rightPaneVmName = vmName;
    focusRightPane();
  }

  // Activate branch handler - open shell in worktree in right pane
  app.onKey('activate', async () => {
    const vm = state.vms[state.activeVmIndex];
    if (!vm) return;

    clearAttention(vm);
    app.render();

    openVmInRightPane(vm.name, `cd '${vm.worktreePath.replace(/'/g, "'\\''")}' && bash`);
  });

  // Create branch handler
  app.onKey('create', async () => {
    state.mode = 'creating';
    app.startSpinner('Creating branch...');
    try {
      const branchName = generateBranchName();
      const vm = createBranch(repoRoot, branchName, state.settings ?? undefined);
      state.vms.push(vm);
      state.sidebarSelectedIndex = state.vms.length - 1;
      state.activeVmIndex = state.vms.length - 1;
      state.mode = 'normal';

      // Provision (write hooks config)
      vm.provisioningStatus = 'provisioning';
      app.updateSpinner(`${vm.name}: Provisioning...`);
      app.render();
      try {
        await provisionBranch(vm.worktreePath, state.settings ?? undefined, (msg) => {
          app.updateSpinner(`${vm.name}: ${msg}`);
          appendOutput(vm.name, `${msg}\n`);
        });
        vm.provisioningStatus = 'done';
        app.stopSpinner();
        app.setStatusMessage(`✓ ${vm.name} created`);
      } catch (err: any) {
        vm.provisioningStatus = 'failed';
        app.stopSpinner();
        app.setStatusMessage(`Provisioning failed: ${err.message}`);
      }
    } catch (err: any) {
      app.stopSpinner();
      app.setStatusMessage(`Error creating branch: ${err.message}`);
      state.mode = 'normal';
    }
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Bulk create branches handler
  app.onKey('bulk-create', async (count: number) => {
    state.mode = 'creating';
    app.startSpinner(`Creating ${count} branches...`);

    let created = 0;
    let failed = 0;

    for (let i = 0; i < count; i++) {
      try {
        const branchName = generateBranchName();
        const vm = createBranch(repoRoot, branchName, state.settings ?? undefined);
        state.vms.push(vm);
        created++;
        app.updateSpinner(`Created ${created}/${count} branches...`);
        app.render();

        // Provision
        vm.provisioningStatus = 'provisioning';
        try {
          await provisionBranch(vm.worktreePath, state.settings ?? undefined);
          vm.provisioningStatus = 'done';
        } catch {
          vm.provisioningStatus = 'failed';
        }
      } catch {
        failed++;
      }
    }

    if (state.vms.length > 0) {
      state.sidebarSelectedIndex = state.vms.length - 1;
      state.activeVmIndex = state.vms.length - 1;
    }
    state.mode = 'normal';

    const failMsg = failed > 0 ? ` (${failed} failed)` : '';
    app.stopSpinner();
    app.setStatusMessage(`✓ ${created} branches created${failMsg}`);
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Delete branch handler
  app.onKey('delete', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    app.setStatusMessage(`Deleting branch: ${vm.name}...`);
    vm.pendingAction = 'deleting...';
    vm.lastError = undefined;
    app.render();
    try {
      killWindow(vm.name);
      clearOutput(vm.name);
      clearQueue(vm.name);
      if (state.rightPaneVmName === vm.name) {
        state.rightPaneVmName = null;
        try { ensureRightPane(); respawnRightPane('bash'); } catch {}
      }
      deleteBranch(repoRoot, vm.name, vm.worktreePath);
      state.vms.splice(state.sidebarSelectedIndex, 1);
      if (state.sidebarSelectedIndex >= state.vms.length) {
        state.sidebarSelectedIndex = Math.max(0, state.vms.length - 1);
      }
      if (state.activeVmIndex >= state.vms.length) {
        state.activeVmIndex = Math.max(-1, state.vms.length - 1);
      }
      app.setStatusMessage('Branch deleted');
    } catch (err: any) {
      vm.pendingAction = undefined;
      vm.lastError = err.message || String(err);
      app.setStatusMessage(`Error deleting branch: ${err.message}`);
    }
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Delete all branches handler
  app.onKey('delete-all', async () => {
    if (state.vms.length === 0) return;

    const total = state.vms.length;
    app.setStatusMessage(`Deleting all ${total} branches...`);

    const deletedNames = new Set<string>();
    let failed = 0;

    for (const vm of [...state.vms]) {
      vm.pendingAction = 'deleting...';
      vm.lastError = undefined;
      app.render();
      try {
        killWindow(vm.name);
        clearOutput(vm.name);
        clearQueue(vm.name);
        deleteBranch(repoRoot, vm.name, vm.worktreePath);
        deletedNames.add(vm.name);
        app.setStatusMessage(`Deleted ${deletedNames.size}/${total} branches...`);
        app.render();
      } catch (err: any) {
        vm.pendingAction = undefined;
        vm.lastError = err.message || String(err);
        failed++;
      }
    }

    state.vms = state.vms.filter((vm) => !deletedNames.has(vm.name));
    state.sidebarSelectedIndex = 0;
    state.activeVmIndex = state.vms.length > 0 ? 0 : -1;

    state.rightPaneVmName = null;
    try { ensureRightPane(); respawnRightPane('bash'); } catch {}

    const failMsg = failed > 0 ? ` (${failed} failed)` : '';
    app.setStatusMessage(`Deleted ${deletedNames.size} branches${failMsg}`);
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Re-provision selected branch handler
  app.onKey('reprovision', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm || vm.provisioningStatus !== 'done') return;

    app.setStatusMessage(`Re-provisioning ${vm.displayLabel ?? vm.name}...`);
    vm.pendingAction = 're-provisioning...';
    vm.lastError = undefined;
    app.render();
    try {
      state.settings = await loadSettings();
      copyConfigFiles(repoRoot, vm.worktreePath, state.settings ?? undefined);
      await reprovisionBranch(vm.worktreePath, (msg) => {
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

  // Re-provision all branches handler
  app.onKey('reprovision-all', async () => {
    const targets = state.vms.filter(vm => vm.provisioningStatus === 'done');
    if (targets.length === 0) return;

    app.setStatusMessage(`Re-provisioning ${targets.length} branches...`);

    try {
      state.settings = await loadSettings();
    } catch (err: any) {
      app.setStatusMessage(`Failed to load settings: ${err.message}`);
      setTimeout(() => app.resetStatus(), 3000);
      return;
    }

    let done = 0;
    let failed = 0;

    for (const vm of targets) {
      vm.pendingAction = 're-provisioning...';
      vm.lastError = undefined;
      app.render();
      try {
        copyConfigFiles(repoRoot, vm.worktreePath, state.settings ?? undefined);
        await reprovisionBranch(vm.worktreePath);
        vm.pendingAction = undefined;
        done++;
        app.setStatusMessage(`Re-provisioned ${done}/${targets.length}${failed > 0 ? ` (${failed} failed)` : ''}...`);
        app.render();
      } catch (err: any) {
        vm.pendingAction = undefined;
        vm.lastError = err.message || String(err);
        failed++;
      }
    }

    const failMsg = failed > 0 ? ` (${failed} failed)` : '';
    app.setStatusMessage(`${done} branches re-provisioned${failMsg}`);
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Rename branch handler
  app.onKey('rename-submit', (label: string) => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;

    if (label) {
      vm.displayLabel = label;
      vm.customLabel = true;
      app.setStatusMessage(`Renamed to "${label}"`);
    } else {
      vm.displayLabel = undefined;
      vm.customLabel = false;
      app.setStatusMessage('Label reset (will auto-detect)');
    }
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Stop/cancel running agent handler
  app.onKey('stop-agent', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;

    killWindow(vm.name);
    if (state.rightPaneVmName === vm.name) {
      try { ensureRightPane(); respawnRightPane('bash'); } catch {}
      state.rightPaneVmName = null;
    }
    vm.taskStartedAt = undefined;
    app.setStatusMessage(`Stopped ${vm.displayLabel ?? vm.name}`);
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Retry provisioning for failed branches
  app.onKey('retry-provision', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm || vm.provisioningStatus !== 'failed') return;

    vm.provisioningStatus = 'provisioning';
    vm.lastError = undefined;
    app.startSpinner(`${vm.displayLabel ?? vm.name}: Retrying provisioning...`);
    app.render();
    try {
      await provisionBranch(vm.worktreePath, state.settings ?? undefined, (msg) => {
        app.updateSpinner(`${vm.displayLabel ?? vm.name}: ${msg}`);
        appendOutput(vm.name, `${msg}\n`);
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

  // Export log handler
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

  // Open app handler - start dev server and open browser
  app.onKey('open-app', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;

    if (vm.provisioningStatus !== 'done') {
      app.setStatusMessage(`${vm.displayLabel ?? vm.name} is not provisioned yet`);
      setTimeout(() => app.resetStatus(), 3000);
      return;
    }

    app.setStatusMessage(`Finding open port for ${vm.displayLabel ?? vm.name}...`);

    try {
      const port = await findOpenPort(3000);
      vm.devServerPort = port;

      const repoName = getRepoName();
      const branchName = vm.name;
      const host = `${branchName}-${repoName}.localhost`;
      const url = `http://${host}:${port}`;

      // Start dev server with PORT env var in the right pane
      const escapedPath = vm.worktreePath.replace(/'/g, "'\\''");
      const command = `cd '${escapedPath}' && PORT=${port} npm run dev`;

      state.activeVmIndex = state.sidebarSelectedIndex;
      openVmInRightPane(vm.name, command);
      app.render();

      // Open browser after a short delay to let the server start
      setTimeout(async () => {
        try {
          const { execSync: exec } = await import('node:child_process');
          const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
          exec(`${openCmd} '${url}'`, { stdio: 'pipe' });
        } catch {
          // Browser open failed silently
        }
      }, 2000);

      app.setStatusMessage(`Dev server starting on ${url}`);
      setTimeout(() => app.resetStatus(), 5000);
    } catch (err: any) {
      app.setStatusMessage(`Failed to start dev server: ${err.message}`);
      setTimeout(() => app.resetStatus(), 3000);
    }
  });

  // Queue remove handler
  app.onKey('queue-remove', (index: number) => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    const removed = removeFromQueue(vm.name, index);
    if (removed) {
      app.renderQueueViewer(vm);
      app.render();
    }
  });

  // Queue clear handler
  app.onKey('queue-clear', () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    clearQueue(vm.name);
    app.renderQueueViewer(vm);
    app.render();
  });

  // Fetch and render PR chain for a branch
  async function fetchAndRenderPRChain() {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;

    if (vm.provisioningStatus !== 'done') {
      app.renderPRChain('\n  {yellow-fg}Branch is not provisioned yet{/yellow-fg}', 'PR Chain');
      return;
    }

    try {
      const [prs, currentBr, defaultBr] = await Promise.all([
        fetchPRChain(vm.worktreePath, vm.name),
        getCurrentBranch(vm.worktreePath),
        getDefaultBranch(vm.worktreePath),
      ]);

      if (prs.length === 0) {
        app.renderPRChain(
          '\n  {gray-fg}No pull requests found{/gray-fg}\n\n  Hint: create a PR with {bold}gh pr create{/bold}',
          `PR Chain — ${vm.displayLabel ?? vm.name}`,
        );
        return;
      }

      const tree = buildPRTree(prs, defaultBr);
      const width = (app.screen.width as number) - 4;
      const lines = renderPRTree(tree, currentBr, width);
      app.renderPRChain('\n' + lines.join('\n'), `PR Chain — ${vm.displayLabel ?? vm.name}`);
    } catch (err: any) {
      const msg = String(err.message || err);
      if (msg.includes('gh') && (msg.includes('not found') || msg.includes('command not found'))) {
        app.renderPRChain('\n  {red-fg}GitHub CLI (gh) not available{/red-fg}', 'PR Chain');
      } else if (msg.includes('not a git repository')) {
        app.renderPRChain('\n  {red-fg}No git repository found{/red-fg}', 'PR Chain');
      } else {
        app.renderPRChain(`\n  {red-fg}Error: ${msg}{/red-fg}`, 'PR Chain');
      }
    }
  }

  app.onKey('pr-chain-open', fetchAndRenderPRChain);

  app.onKey('pr-chain-refresh', async () => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;
    clearPRCache(vm.name);
    app.renderPRChain('\n  {yellow-fg}Refreshing PR data...{/yellow-fg}', 'PR Chain');
    await fetchAndRenderPRChain();
  });

  // PR chain sync handler
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
      const [prs, currentBr, defaultBr] = await Promise.all([
        fetchPRChain(vm.worktreePath, vm.name),
        getCurrentBranch(vm.worktreePath),
        getDefaultBranch(vm.worktreePath),
      ]);

      const currentPR = prs.find(pr => pr.headRefName === currentBr);
      if (!currentPR) {
        app.setStatusMessage(`No PR found for branch "${currentBr}"`);
        setTimeout(() => app.resetStatus(), 3000);
        return;
      }

      const stalePRs = findStalePRs(prs, defaultBr);
      const isStale = stalePRs.some(pr => pr.number === currentPR.number);
      if (!isStale) {
        app.setStatusMessage(`PR #${currentPR.number} is not stale — no sync needed`);
        setTimeout(() => app.resetStatus(), 3000);
        return;
      }

      state.activeVmIndex = state.sidebarSelectedIndex;
      vm.taskStartedAt = Date.now();
      app.render();

      const rebasePrompt = `Your PR #${currentPR.number} (branch "${currentBr}") targets "${currentPR.baseRefName}" which has been merged into ${defaultBr}. Please: 1) git fetch origin, 2) retarget your PR to ${defaultBr} with \`gh pr edit ${currentPR.number} --base ${defaultBr}\`, 3) rebase your branch onto origin/${defaultBr}, 4) resolve any conflicts, 5) force-push with \`git push --force-with-lease\`.`;
      const escapedPrompt = rebasePrompt.replace(/'/g, "'\\''");
      const command = `cd '${vm.worktreePath.replace(/'/g, "'\\''")}' && claude -p '${escapedPrompt}'`;
      killWindow(vm.name);
      openVmInRightPane(vm.name, command);
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

  app.onKey('linear-rerender', async () => {
    try {
      const issues = await fetchMyIssues();
      const width = (app.screen.width as number) - 4;
      const idx = app.getLinearSelectedIndex();
      const checkedIds = app.getLinearCheckedIds();
      const lines = renderLinearIssues(issues, idx, width, checkedIds);
      app.renderLinear('\n' + lines.join('\n'), `Linear Tasks — ${issues.length} issue${issues.length !== 1 ? 's' : ''}`);
    } catch { /* ignore */ }
  });

  // Linear claim handler - create branches, set issues to In Progress, send prompts
  app.onKey('linear-claim', async (issues: LinearIssue[]) => {
    const count = issues.length;
    const label = count === 1 ? issues[0].identifier : `${count} tasks`;
    app.startSpinner(`Claiming ${label}...`);

    async function claimSingleIssue(issue: LinearIssue): Promise<{ ok: boolean; identifier: string }> {
      try {
        await startIssue(issue.id);
      } catch {
        return { ok: false, identifier: issue.identifier };
      }

      try {
        app.updateSpinner(`${issue.identifier}: Creating branch...`);
        const branchName = issue.branchName || `${issue.identifier.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
        const vm = createBranch(repoRoot, branchName, state.settings ?? undefined);
        vm.displayLabel = issue.identifier;
        vm.customLabel = true;
        state.vms.push(vm);
        app.render();

        // Provision
        vm.provisioningStatus = 'provisioning';
        app.render();
        try {
          await provisionBranch(vm.worktreePath, state.settings ?? undefined, (msg) => {
            app.updateSpinner(`${issue.identifier}: ${msg}`);
            appendOutput(vm.name, `${msg}\n`);
          });
          vm.provisioningStatus = 'done';
        } catch {
          vm.provisioningStatus = 'failed';
          app.render();
          return { ok: false, identifier: issue.identifier };
        }

        // Send the task as a prompt via docker sandbox
        vm.taskStartedAt = Date.now();
        const prompt = `Do linear task ${issue.identifier}`;
        const escapedPrompt = prompt.replace(/"/g, '\\"');
        const command = `cd '${vm.worktreePath.replace(/'/g, "'\\''")}' && docker sandbox run claude "${escapedPrompt}"`;
        killWindow(vm.name);
        createWindow(vm.name, command);

        app.render();
        return { ok: true, identifier: issue.identifier };
      } catch {
        return { ok: false, identifier: issue.identifier };
      }
    }

    const results = await Promise.all(issues.map(claimSingleIssue));
    const succeeded = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);

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

  // Grid open handler - create tmux grid of all agent terminals
  app.onKey('grid-open', () => {
    // Only include branches that have a tmux window (i.e., running a task)
    const activeBranches = state.vms.filter(vm => vm.taskStartedAt != null);
    if (activeBranches.length === 0) {
      app.setStatusMessage('No active agent terminals to show in grid');
      state.mode = 'normal';
      app.resetStatus();
      return;
    }
    try {
      killGridWindow(); // Clean up any existing grid
      createGridWindow(activeBranches);
    } catch (err: any) {
      app.setStatusMessage(`Grid failed: ${err.message}`);
      state.mode = 'normal';
      setTimeout(() => app.resetStatus(), 3000);
    }
  });

  // Grid close handler - kill grid window, return to control pane
  app.onKey('grid-close', () => {
    killGridWindow();
    switchToControlPane();
  });

  // Prompt submit handler - run claude -p in worktree
  app.onKey('prompt-submit', async (prompt: string) => {
    const vm = state.vms[state.sidebarSelectedIndex];
    if (!vm) return;

    await addToHistory(prompt);

    if (vm.provisioningStatus !== 'done') {
      app.setStatusMessage(`${vm.displayLabel ?? vm.name} is not provisioned yet`);
      setTimeout(() => app.resetStatus(), 3000);
      return;
    }

    vm.taskStartedAt = Date.now();
    state.activeVmIndex = state.sidebarSelectedIndex;
    app.render();

    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const command = `cd '${vm.worktreePath.replace(/'/g, "'\\''")}' && claude -p '${escapedPrompt}'`;

    killWindow(vm.name);
    openVmInRightPane(vm.name, command);
  });

  // Broadcast prompt handler
  app.onKey('broadcast-submit', async (prompt: string) => {
    await addToHistory(prompt);

    const targets = state.vms.filter(vm => vm.provisioningStatus === 'done');
    if (targets.length === 0) {
      app.setStatusMessage('No provisioned branches to broadcast to');
      setTimeout(() => app.resetStatus(), 3000);
      return;
    }

    app.setStatusMessage(`Broadcasting prompt to ${targets.length} agent(s)...`);

    const escapedPrompt = prompt.replace(/'/g, "'\\''");

    for (const vm of targets) {
      vm.taskStartedAt = Date.now();
      const command = `cd '${vm.worktreePath.replace(/'/g, "'\\''")}' && claude -p '${escapedPrompt}'`;
      if (vm.name === state.rightPaneVmName) {
        ensureRightPane();
        respawnRightPane(command);
      } else {
        killWindow(vm.name);
        createWindow(vm.name, command);
      }
    }

    app.setStatusMessage(`Broadcast sent to ${targets.length} agent(s)`);
    app.render();
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Queue prompt handler
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

    if (vm.needsAttention || !vm.taskStartedAt) {
      const nextPrompt = dequeue(vm.name);
      if (!nextPrompt) return;

      if (vm.needsAttention) clearAttention(vm);

      vm.taskStartedAt = Date.now();
      const escapedPrompt = nextPrompt.replace(/'/g, "'\\''");
      const command = `cd '${vm.worktreePath.replace(/'/g, "'\\''")}' && claude -p '${escapedPrompt}'`;

      if (vm.name === state.rightPaneVmName) {
        ensureRightPane();
        respawnRightPane(command);
      } else {
        killWindow(vm.name);
        createWindow(vm.name, command);
      }
      app.setStatusMessage(`Sent queued prompt to ${vm.displayLabel ?? vm.name} (${queueSize(vm.name)} remaining)`);
      app.render();
      setTimeout(() => app.resetStatus(), 3000);
    }
  });

  // Broadcast queue prompt handler
  app.onKey('broadcast-queue-submit', async (prompt: string) => {
    await addToHistory(prompt);

    const targets = state.vms.filter(vm => vm.provisioningStatus === 'done');
    if (targets.length === 0) {
      app.setStatusMessage('No provisioned branches to broadcast queue to');
      setTimeout(() => app.resetStatus(), 3000);
      return;
    }

    let queued = 0;
    let sent = 0;

    const escapedPrompt = prompt.replace(/'/g, "'\\''");

    for (const vm of targets) {
      if (vm.needsAttention || !vm.taskStartedAt) {
        if (vm.needsAttention) clearAttention(vm);
        vm.taskStartedAt = Date.now();
        const command = `cd '${vm.worktreePath.replace(/'/g, "'\\''")}' && claude -p '${escapedPrompt}'`;
        if (vm.name === state.rightPaneVmName) {
          ensureRightPane();
          respawnRightPane(command);
        } else {
          killWindow(vm.name);
          createWindow(vm.name, command);
        }
        sent++;
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

  // Ralph prompt handler - run iterative claude loop
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

    vm.taskStartedAt = Date.now();
    state.activeVmIndex = state.sidebarSelectedIndex;
    app.render();

    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    const ralphScript = [
      `cd '${vm.worktreePath.replace(/'/g, "'\\''")}'`,
      `for i in $(seq 1 ${iterations}); do`,
      `  echo "=== Ralph iteration $i/${iterations} ==="`,
      `  tmpfile=$(mktemp)`,
      `  claude --dangerously-skip-permissions -p '${escapedPrompt}' 2>&1 | tee "$tmpfile"`,
      `  if grep -q '<promise>COMPLETE</promise>' "$tmpfile"; then`,
      `    echo "Ralph complete after $i iterations."`,
      `    rm -f "$tmpfile"`,
      `    break`,
      `  fi`,
      `  rm -f "$tmpfile"`,
      `done`,
    ].join('; ');

    const command = `bash -c '${ralphScript.replace(/'/g, "'\\''")}'`;
    killWindow(vm.name);
    openVmInRightPane(vm.name, command);
  });

  // Copy error to clipboard handler
  app.onKey('copy-error', async () => {
    const error = app.getSelectedVMError();
    if (!error) return;

    const { execFile } = await import('node:child_process');
    const commands: [string, string[]][] = process.platform === 'darwin'
      ? [['pbcopy', []]]
      : [['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];

    for (const [cmd, args] of commands) {
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = execFile(cmd, args, (err) => err ? reject(err) : resolve());
          proc.stdin?.write(error);
          proc.stdin?.end();
        });
        app.setStatusMessage('Error copied to clipboard');
        setTimeout(() => app.resetStatus(), 2000);
        return;
      } catch {
        continue;
      }
    }

    app.setStatusMessage('Failed to copy error: no clipboard command available');
    setTimeout(() => app.resetStatus(), 3000);
  });

  // Quit handler
  app.onKey('quit', async () => {
    stopMonitor();
    clearAllQueues();
    killGridWindow();
    killSession();
  });

  // Handle OS signals for graceful shutdown
  const signalHandler = async () => {
    stopMonitor();
    clearAllQueues();
    killSession();
    process.exit(0);
  };
  process.on('SIGTERM', signalHandler);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
