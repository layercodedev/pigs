# pigs

A terminal UI for orchestrating multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agents in parallel across cloud VMs.

Spin up a fleet of agent VMs, send them prompts, monitor their progress in real-time, queue up sequential tasks, and broadcast instructions to every agent at once — all from a single terminal.

Built on [sprites.dev](https://sprites.dev) for VM provisioning and [blessed](https://github.com/chjj/blessed) for the terminal interface.

```
┌─ VMs (5 ready) ──────────────┐  ┌─ Console: myapp:main ───────────────┐
│                               │  │                                     │
│ > * myapp:main         3m12s  │  │ $ claude -p 'Add auth middleware'   │
│     myapp:feature-x    1m45s  │  │                                     │
│   ! api-server:dev            │  │ I'll add JWT authentication         │
│     frontend:redesign  5m03s  │  │ middleware to the Express app...    │
│     tests:ci           0m30s  │  │                                     │
│                               │  │ Created src/middleware/auth.ts      │
│                               │  │ Updated src/index.ts                │
│                               │  │ All tests passing.                  │
│                               │  │                                     │
└───────────────────────────────┘  └─────────────────────────────────────┘
 c:create C:bulk d:del p:prompt b:broadcast f:ralph Q:queue i:dash ?:help
```

## Installation

**Prerequisites:**
- Node.js 18+
- A [sprites.dev](https://sprites.dev) account with API access
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) authenticated locally (your auth token is automatically synced to VMs during provisioning)

```bash
# Clone the repository
git clone https://github.com/layercodedev/pigs.git
cd pigs

# Install dependencies
npm install

# Build
npm run build

# Run
npm start
```

On first launch, pigs creates `~/.pigs/settings.json` with a default `CLAUDE.md` template that gets written to every VM. Edit this file to customize the system instructions your agents receive.

## Quick Start

1. **Start pigs** — `npm start`
2. **Create a VM** — Press `c` to create a single agent VM, or `C` to create a batch (up to 20)
3. **Wait for provisioning** — VMs show `[setup]` in the sidebar while Claude Code and SSH are being installed
4. **Send a prompt** — Press `p`, type your instruction, hit Enter. The agent starts working.
5. **Watch it work** — The console shows real-time output. Navigate between agents with `j`/`k` to see previews without attaching.
6. **Get notified** — When an agent finishes, a `!` attention indicator appears in the sidebar. Press `a` to jump to it.

## Common Workflows

### Single Agent Task

The simplest flow: send one prompt to one agent.

1. Select the VM with `j`/`k`
2. Press `p` to open the prompt dialog
3. Type your instruction and press Enter
4. Watch output in real-time. Press Escape to detach (the agent keeps running).

### Parallel Development Across Multiple Agents

Work on several features simultaneously, each on its own VM.

1. Press `C` to bulk-create 5 VMs
2. Press `l` on each VM to label them (`auth`, `api`, `frontend`, etc.)
3. Select each VM and press `p` to send a different task to each
4. Press `i` to open the fleet dashboard and monitor all agents at a glance
5. Press `a` to jump between agents as they finish

### Broadcast the Same Task to All Agents

Useful for running the same operation across your entire fleet — like updating dependencies, running tests, or applying a codebase-wide change.

1. Press `b` to open the broadcast dialog
2. Type your prompt and press Enter
3. The prompt is sent to **all provisioned VMs** simultaneously
4. Monitor progress in the dashboard (`i`) or jump between agents (`a`)

### Sequential Task Chains with Queues

Queue up multiple prompts that execute one after another on a single agent. Each queued prompt auto-sends when the previous one finishes.

1. Select a VM and press `Q` to queue a prompt
2. Press `Q` again to queue more prompts — they stack up in order
3. Press `v` to view the queue, `d` to remove items, `X` to clear
4. The sidebar shows `[q:N]` indicating how many prompts are queued
5. When the current task finishes, the next queued prompt fires automatically

### Broadcast Queues for Fleet-Wide Pipelines

Combine broadcast and queuing: send a prompt to every agent's queue. Idle agents start immediately; busy agents queue it for later.

1. Press `B` to open the broadcast queue dialog
2. Type your prompt and press Enter
3. Idle VMs start immediately. Busy VMs queue the prompt for when they finish.
4. Repeat with `B` to build up a multi-step pipeline across the fleet

### Ralph Mode: Iterative Autonomous Execution

Ralph mode runs a prompt in a loop, up to N iterations, with `--dangerously-skip-permissions` for fully autonomous execution. The agent keeps working until it outputs `<promise>COMPLETE</promise>` or exhausts all iterations. You get a single notification when the entire loop finishes — not on every iteration.

1. Select a VM and press `f` to start Ralph mode
2. Enter the number of iterations (1-100, default: 5)
3. Enter your prompt — this is what the agent executes each iteration
4. The agent loops autonomously, streaming output to the console

**Example Ralph prompt:**
```
@todo.md @progress.md
1. Find the next task and implement it.
2. Run tests and type checks.
3. Mark done items in todo.md.
4. Append progress to progress.md.
5. Commit your changes.
ONLY WORK ON A SINGLE TASK.
If all work is complete, output <promise>COMPLETE</promise>.
```

This is especially powerful combined with bulk VMs — spin up 10 agents, give each a different todo file, and let them all work autonomously.

### Editing Agent Config

The `CLAUDE.md` file written to each VM controls how Claude Code behaves. To update it:

1. Edit `~/.pigs/settings.json` and change the `claudeMd` field
2. Press `r` to re-provision the selected VM (pushes the new config)
3. Or press `R` to re-provision all VMs at once

### Mounting and Editing Files

Mount a VM's filesystem locally to browse or edit files with your local editor.

1. Select a VM and press `m` to mount via sshfs
2. If `openInVscode` is enabled in settings (default: true), VS Code opens automatically
3. Press `u` to unmount when done

### Chained Feature Branches

When running multiple agents in parallel on the same repo, each producing a feature as a commit + PR, you often want **task B to build on task A's work** — not start fresh from `main` every time.

The solution is chained feature branches:

```
main ──→ feature-a ──→ feature-b ──→ feature-c
           │  PR #1       │  PR #2       │  PR #3
           │  base:main   │  base:a      │  base:b
```

Each agent branches from the **current HEAD** (the previous agent's branch), not from `main`. When creating the PR, `--base <parent-branch>` ensures GitHub shows only that feature's diff — not every prior feature stacked on top.

When PR #1 merges into `main`, PR #2's base updates to `main`, and the chain continues cleanly.

#### CLAUDE.md Git Instructions

Add the following to the `claudeMd` field in `~/.pigs/settings.json` so each agent automatically follows the chained branch workflow:

````
## Git Workflow

- Branch from the CURRENT branch (HEAD), not main — the previous agent's work is your starting point
- Create a descriptive branch name for your feature (e.g. `add-auth-middleware`)
- Commit all changes with a clear commit message
- Push the branch and create a PR:
  ```
  git checkout -b <your-feature-branch>
  # ... do work, commit ...
  git push -u origin <your-feature-branch>
  gh pr create --base <parent-branch> --fill
  ```
  where `<parent-branch>` is the branch you branched FROM (not main, unless you are on main)
- After creating the PR, STAY on your new branch so the next task chains from it
- Do NOT switch back to main
````

This ensures each agent leaves the repo in the right state for the next task in the chain.

#### Cascade Rebase GitHub Action

When a parent PR merges, its child PRs need their base updated and their commits rebased. GitHub's web UI handles base updates automatically, but `gh pr merge --delete-branch` (and API-driven merges) do not — the child PRs can end up targeting a deleted branch.

Add this workflow to your repo as `.github/workflows/cascade-rebase.yml`:

```yaml
name: Cascade Rebase

on:
  pull_request:
    types: [closed]

jobs:
  cascade:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Rebase dependent PRs
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          MERGED_BRANCH: ${{ github.event.pull_request.head.ref }}
          MERGE_TARGET: ${{ github.event.pull_request.base.ref }}
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

          # Find PRs that were based on the merged branch
          DEPENDENT_PRS=$(gh pr list --base "$MERGED_BRANCH" --json number,headRefName --jq '.[] | "\(.number) \(.headRefName)"')

          if [ -z "$DEPENDENT_PRS" ]; then
            echo "No dependent PRs found"
            exit 0
          fi

          # Update the merge target ref
          git fetch origin "$MERGE_TARGET"

          echo "$DEPENDENT_PRS" | while read -r PR_NUMBER HEAD_BRANCH; do
            echo "Updating PR #$PR_NUMBER ($HEAD_BRANCH) — new base: $MERGE_TARGET"

            # Update the PR's base branch
            gh pr edit "$PR_NUMBER" --base "$MERGE_TARGET"

            # Rebase the branch onto the new base
            git fetch origin "$HEAD_BRANCH"
            git checkout "$HEAD_BRANCH"
            if git rebase "origin/$MERGE_TARGET"; then
              git push --force-with-lease origin "$HEAD_BRANCH"
              echo "PR #$PR_NUMBER rebased successfully"
            else
              git rebase --abort
              echo "PR #$PR_NUMBER rebase had conflicts — manual resolution needed"
            fi
          done
```

**How it works:**
1. When a PR merges, the action finds all open PRs that were based on the merged branch
2. It updates each dependent PR's base to the merge target (e.g. `main`)
3. It rebases each branch onto the updated base and force-pushes
4. If a rebase has conflicts, it aborts and logs a warning — you'll need to resolve those manually

**Caveat:** If you use `gh pr merge --delete-branch`, the merged branch gets deleted before GitHub can auto-update dependent PR bases. This action handles that by explicitly setting the new base via `gh pr edit`. If you merge through the GitHub web UI with "Delete branch" checked, the auto-update usually works — but having this action as a safety net is still recommended.

## Feature Reference

### Navigation

| Key | Action |
|-----|--------|
| `j` / `↓` | Move selection down in sidebar |
| `k` / `↑` | Move selection up in sidebar |
| `a` | Jump to next VM needing attention (cycles through) |
| `Enter` | Attach console to selected VM (live I/O) |
| `Escape` | Detach from console / clear search filter |

### VM Management

| Key | Action |
|-----|--------|
| `c` | Create a new agent VM |
| `C` | Bulk-create multiple VMs (1-20) |
| `d` | Delete selected VM (with confirmation) |
| `D` | Delete ALL VMs (with confirmation) |
| `r` | Re-provision selected VM (updates CLAUDE.md + hooks) |
| `R` | Re-provision ALL VMs |
| `l` | Rename/label selected VM |
| `t` | Retry provisioning on a failed VM |
| `m` | Mount VM filesystem via sshfs |
| `u` | Unmount VM filesystem |

### Prompts and Execution

| Key | Action |
|-----|--------|
| `p` | Send a `claude -p` prompt to the selected VM |
| `b` | Broadcast a prompt to all provisioned VMs at once |
| `f` | Ralph mode — iterative autonomous execution with configurable iterations |
| `Q` | Queue a prompt for the selected VM (auto-sends when idle) |
| `B` | Broadcast-queue a prompt to all VMs (auto-sends when each becomes idle) |
| `v` | View/manage the prompt queue for the selected VM |
| `x` | Stop the running agent (sends Ctrl-C) |
| `o` | Export console log to `~/.pigs/logs/` |
| `↑` / `↓` | Cycle through prompt history (inside any prompt dialog) |

### Views and Display

| Key | Action |
|-----|--------|
| `i` | Toggle fleet dashboard — bird's-eye grid of all agents |
| `s` | Cycle sort mode: default / name / status / attention / elapsed |
| `/` | Search/filter VMs in the sidebar |
| `?` | Toggle help screen |
| `q` | Quit (graceful cleanup) |
| `Ctrl-C` | Force quit |

### Sidebar Indicators

| Indicator | Meaning |
|-----------|---------|
| `>` | Currently selected VM |
| `*` | Console is attached to this VM |
| `!` | Agent finished — needs attention |
| `[setup]` | VM is being provisioned |
| `[fail]` | Provisioning failed (press `t` to retry) |
| `[q:N]` | N prompts queued for auto-execution |
| `3m12s` | Elapsed time since task started |

### Settings

Configuration lives in `~/.pigs/settings.json`:

```json
{
  "claudeMd": "# Agent Instructions\n\nYou are a coding agent...",
  "openInVscode": true
}
```

| Field | Description |
|-------|-------------|
| `claudeMd` | Contents written to `/root/CLAUDE.md` on each VM. Controls Claude Code behavior. |
| `openInVscode` | Auto-open VS Code when mounting a VM filesystem. Default: `true`. |

### Notification System

Pigs uses a polling-based notification system to detect when agents finish:

- A Claude Code [Stop hook](https://docs.anthropic.com/en/docs/claude-code/hooks) is installed on each VM during provisioning
- When Claude finishes, the hook creates a signal file (`/tmp/claude-done-signal`)
- Pigs polls for this file every 5 seconds
- When detected, the VM gets the `!` attention indicator and any queued prompts auto-send

In **Ralph mode**, intermediate signals are suppressed — you only get notified when the entire iteration loop completes.

## Mobile Access

Pigs runs in a terminal, which means you can monitor and control your agent fleet from your phone. Two options:

### Option 1: Termius (SSH)

[Termius](https://apps.apple.com/app/termius-terminal-ssh-client/id549039908) is a full SSH client for iOS (and Android). If pigs is running on a remote server or your home machine, you can SSH in and attach directly.

1. Install Termius from the App Store
2. Add a new host with your machine's IP/hostname, username, and SSH key or password
3. Connect and run `cd pigs && npm start` (or attach to an existing session — see tmux tip below)

**Tip: Use tmux so you can detach and reattach without losing your session:**

```bash
# On your machine, start pigs inside tmux
tmux new -s pigs
npm start

# From Termius on your phone, reattach
tmux attach -t pigs
```

Termius supports key-based auth, saved hosts, and port forwarding — so you can set this up once and connect with a single tap.

### Option 2: VibeTunnel (Browser)

[VibeTunnel](https://github.com/amantus-ai/vibetunnel) turns any browser into a terminal. No SSH keys or client apps needed — just open a URL on your phone.

**Install:**

```bash
# macOS (Apple Silicon)
brew install --cask vibetunnel

# Any system with Node.js 22.12+
npm install -g vibetunnel
```

**Run pigs through VibeTunnel:**

```bash
# Wrap pigs in a VibeTunnel session
vt npm start

# Or use an interactive shell
vt --shell
# then run: npm start
```

**Access from your phone:**

On the same network, open `http://<your-machine-ip>:4020` in your phone's browser.

For access from anywhere, use one of VibeTunnel's tunneling options:

```bash
# Tailscale (recommended — secure, peer-to-peer)
# Access via your Tailscale hostname with automatic HTTPS

# ngrok (quick public URL)
# Generates a public URL with SSL

# Cloudflare Quick Tunnel
cloudflared tunnel --url http://localhost:4020
```

VibeTunnel records sessions in asciinema format, so you can replay what your agents did while you were away.

## Development

```bash
# Watch mode (recompile on changes)
npm run dev

# Type-check without emitting
npm run typecheck

# Run tests
npm test
```

## License

[MIT](LICENSE)
