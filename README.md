# pigs

> Manage AI coding agent sessions by turning every git worktree into its own agent playground.

pigs keeps large projects organized by pairing each feature branch with a dedicated AI session. It automates worktree creation, keeps track of conversation history, and helps you pause, resume, and clean up work in seconds.

pigs is based on [xlaude](https://github.com/Xuanwo/xlaude), originally created by Xuanwo. Licensed under Apache 2.0.

## Why pigs?

- **Worktree-native workflow** -- every feature branch lives in `../<repo>-<worktree>` with automatic branch creation, sanitized names, and submodule updates.
- **Session awareness** -- `list` reads Claude (`~/.claude/projects`) and Codex (`~/.codex/sessions`) logs to surface the last user prompt and activity timestamps per worktree.
- **Agent agnostic** -- configure a single `agent` command (default `claude --dangerously-skip-permissions`). When that command is `codex`, pigs auto-appends `resume <session-id>` matching the worktree.
- **Automation ready** -- every subcommand accepts piped input, honors `PIGS_YES`/`PIGS_NON_INTERACTIVE`, and exposes a hidden completion helper for shell integration.
- **Dashboard** -- embedded web dashboard for managing worktrees, launching agents, and monitoring sessions from a browser.
- **Branch from anywhere** -- `create --from <worktree|branch>` lets you branch off any existing worktree or branch, not just the base branch.
- **PR checkout** -- `checkout <pr-number>` resolves the actual branch name via `gh` CLI and creates a worktree for it.
- **Batch operations** -- `delete --all` cleans up all managed worktrees in one go.
- **Repo-level config** -- `.pigs/state.json` in the repo root lets you configure extra files to copy into new worktrees.
- **Agent passthrough args** -- `create` and `open` accept `-- <args>` to pass extra arguments to the agent command.

## Installation

```bash
# Install Rust if you don't have it
brew install rust

# Install pigs
cargo install --git https://github.com/layercodedev/pigs
```

### Prerequisites

- Git >= 2.36 (for worktree support).
- Claude CLI or any other agent command you plan to run.
- Optional: GitHub CLI (`gh`) so `delete` can detect merged PRs after squash merges.

## Shell completions

### Zsh (macOS default)

```bash
mkdir -p ~/.zfunc && pigs completions zsh > ~/.zfunc/_pigs
```

Then add these lines to your `~/.zshrc` (before any plugin that calls `compinit`):

```zsh
fpath+=~/.zfunc
autoload -Uz compinit && compinit
```

If you use `zsh-autocomplete`, add this **after** sourcing the plugin instead:

```zsh
autoload -Uz _pigs && compdef _pigs pigs
```

### Bash

```bash
mkdir -p ~/.bash_completion.d && pigs completions bash > ~/.bash_completion.d/pigs
```

### Fish

```bash
pigs completions fish > ~/.config/fish/completions/pigs.fish
```

## Configuration & state

### State file

State lives in `~/.pigs/settings.json`. Each entry is keyed by `<repo-name>/<worktree-name>`. Use `PIGS_CONFIG_DIR` to override the directory for testing or portable setups.

### Agent command

Set the global `agent` field to the exact command line pigs should launch for every worktree. Example:

```json
{
  "agent": "codex --dangerously-bypass-approvals-and-sandbox",
  "worktrees": {
    "repo/feature": { /* ... */ }
  }
}
```

- Default value: `claude --dangerously-skip-permissions`.
- The command is split with shell-style rules, so quotes are supported. Pipelines or redirects should live in a wrapper script.
- When the program name is `codex` and no positional arguments were supplied, pigs will locate the latest session under `~/.codex/sessions` (or `PIGS_CODEX_SESSIONS_DIR`) whose `cwd` matches the worktree and automatically append `resume <session-id>`.

### Worktree creation defaults

- `pigs create` and `checkout` copy `CLAUDE.local.md` into the new worktree if it exists at the repo root.
- Extra files can be configured via `.pigs/state.json` in the repo root with a `copy_files` array.
- Submodules are initialized with `git submodule update --init --recursive` in every new worktree.
- Branch names are sanitized (`feature/foo` -> `feature-foo`) before creating the directory.

## Command reference

### `pigs linear <issue-id> [--from <worktree|branch>] [-y] [-- <agent-args>]`

- Takes a Linear issue ID (e.g. `ENG-123`), fetches the issue title and description, and creates a worktree with the branch name Linear generates.
- Prompts to set the issue to "In Progress" and assign it to you.
- Requires `LINEAR_API_KEY` environment variable (a Linear personal API key).
- Shell completions for issue IDs are provided — `pigs linear <tab>` shows your Todo and Backlog issues.
- Delegates to `create` under the hood, so all `--from` and `-y` flags work the same way.

```bash
export LINEAR_API_KEY=lin_api_...
pigs linear ENG-123
pigs linear ENG-456 --from existing-worktree
```

### `pigs create [name] [--from <worktree|branch>] [-y] [-- <agent-args>]`

- Must be run from a base branch (`main`, `master`, `develop`, or the remote default), unless `--from` is used.
- `--from` creates a new worktree branching from an existing worktree (looked up in pigs state) or a local/remote branch.
- Without a name, pigs selects a random BIP39 word; set `PIGS_TEST_SEED` for deterministic names in CI.
- `-y` automatically opens the worktree after creation without prompting.
- `-- <agent-args>` passes extra arguments through to the agent command.
- Rejects duplicate worktree directories or existing state entries.
- Offers to open the new worktree unless `PIGS_NO_AUTO_OPEN` or `PIGS_TEST_MODE` is set.

```bash
pigs create auth-gateway
pigs create fix-batch --from ingestion-batch
pigs create -y my-feature -- --model opus
```

### `pigs checkout <branch | pr-number> [-y] [-- <agent-args>]`

- Accepts either a branch name or a GitHub pull request number (with or without `#`).
- For PR numbers, resolves the actual branch name via `gh pr view` for a cleaner worktree name (falls back to `pr/<n>` if `gh` is unavailable).
- Ensures the branch exists locally by fetching `origin/<branch>` when missing.
- If the branch already has a managed worktree, pigs offers to open it instead of duplicating the environment.
- `-y` automatically opens the worktree after checkout.

### `pigs open [name] [-- <agent-args>]`

- With a name, finds the corresponding worktree across all repositories and launches the configured agent.
- Without a name and while standing inside a non-base worktree, it reuses the current directory. If the worktree is not tracked yet, pigs offers to add it to `state.json`.
- Otherwise, presents an interactive selector or honors piped input.
- Every environment variable from the parent shell is forwarded to the agent process. When stdin is piped into `pigs`, it is drained and not passed to the agent to avoid stuck sessions.
- `-- <agent-args>` passes extra arguments through to the agent command.

### `pigs add [name]`

Attach the current git worktree (where `.git` is a file) to pigs state. Name defaults to the sanitized branch. The command refuses to add the same path twice, even under a different alias.

### `pigs rename <old> <new>`

Renames the entry in `state.json` within the current repository, keeping the underlying directory and git branch unchanged.

### `pigs list [--json]`

- Default output groups worktrees by repository, showing path, creation timestamp, and recent sessions.
- Claude sessions are read from `~/.claude/projects/<encoded-path>`; up to three per worktree are previewed with "time ago" labels.
- Codex sessions are read from the sessions archive, showing the last user utterance when available.
- `--json` emits a machine-readable structure:

```json
{
  "worktrees": [
    {
      "name": "auth-gateway",
      "branch": "feature/auth-gateway",
      "path": "/repos/repo-auth-gateway",
      "repo_name": "repo",
      "created_at": "2025-10-30T02:41:18Z",
      "sessions": [ { "last_user_message": "Deploy staging", "time_ago": "5m ago" } ],
      "codex_sessions": [ ... ]
    }
  ]
}
```

### `pigs dir [name]`

Prints the absolute path of a worktree with no ANSI formatting, making it ideal for subshells:

```bash
cd $(pigs dir auth-gateway)
```

When no argument is provided, an interactive selector (or piped input) chooses the worktree.

### `pigs delete [name] [--all]`

- If run without arguments, targets the worktree that matches the current directory.
- `--all` deletes all managed worktrees after confirmation.
- Refuses to proceed when there are uncommitted changes or unpushed commits unless you confirm.
- Checks whether the branch is merged either via `git branch --merged` or GitHub PR history (`gh pr list --state merged --head <branch>`). Squash merges are therefore detected.
- Removes the git worktree (force-removing if needed), prunes it if the directory already disappeared, and deletes the local branch after confirmation.

### `pigs clean`

Cross-checks `state.json` against actual `git worktree list` output for every known repository. Any missing directories are removed from state with a concise report.

### `pigs config`

Opens the state file in `$EDITOR`, creating parent directories as needed. Use this to hand-edit the global `agent` or worktree metadata.

### `pigs dashboard [--addr <bind-addr>] [--no-browser]`

Launches an embedded web dashboard for managing worktrees, launching agents, and viewing session logs. Defaults to `127.0.0.1:5710`.

### `pigs completions <shell>`

Prints shell completion scripts. Combine with `complete-worktrees` for dynamic worktree hints.

### `pigs complete-worktrees [--format=simple|detailed]` (hidden)

Emits sorted worktree names. The `detailed` format prints `name<TAB>repo<TAB>path<TAB>session-summary` and is consumed by the provided zsh/fish completion functions. You can also call it in custom tooling.

## Automation & non-interactive usage

Input priority is always **CLI argument > piped input > interactive prompt**. Example: `echo feature-x | pigs open correct-name` opens `correct-name`.

Environment switches:

| Variable | Effect |
| --- | --- |
| `PIGS_YES=1` | Auto-confirm every prompt (used by `delete`, `create`, etc.). |
| `PIGS_NON_INTERACTIVE=1` | Disable interactive prompts/selectors; commands fall back to defaults or fail fast. |
| `PIGS_NO_AUTO_OPEN=1` | Skip the "open now?" question after `create`. |
| `PIGS_CONFIG_DIR=/tmp/pigs-config` | Redirect both reads and writes of `state.json`. |
| `PIGS_CODEX_SESSIONS_DIR=/path/to/sessions` | Point Codex session discovery to a non-default location. |
| `PIGS_TEST_SEED=42` | Deterministically pick random names (handy for tests). |
| `PIGS_TEST_MODE=1` | Test harness flag; suppresses some interactivity (also skips auto-open). |

Piped input works with selectors and confirmations. For example, `yes | pigs delete feature-x` or `printf "1\n" | pigs open` to pick the first entry.

## Typical workflow

```bash
# 1. Create an isolated workspace from main
pigs create payments-strategy

# 2. Start working with your agent
pigs open payments-strategy

# 3. Branch off an existing worktree for a fix
pigs create hotfix --from payments-strategy

# 4. Check out a PR for review
pigs checkout 42

# 5. Inspect outstanding worktrees across repositories
pigs list --json | jq '.worktrees | length'

# 6. Clean up after merge
pigs delete payments-strategy
```

## License

Apache License 2.0. See `LICENSE` for details.
