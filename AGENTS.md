# xlaude · Agent Handbook

## 0 · About the User
- User: Xuanwo
- Preferences: Frequent context switching, managing multiple branches via git worktree, and relying on AI agents for coding assistance.

## 1 · Programming Philosophy
1. Programs are written primarily for humans to read; machine executability is a side benefit.
2. Follow idiomatic style for each language; code should be self-explanatory.
3. Identify and eliminate these code smells: rigidity, redundancy, circular dependencies, fragility, obscurity, data clumps, unnecessary complexity.
4. Once a code smell is detected, flag it immediately and propose improvements.

## 2 · Language Policy

| Content Type | Language |
| --- | --- |
| Explanations, discussions, communication | **English** |
| Code, comments, variable names, commit messages, documentation examples | **English** (no Chinese characters allowed in technical content) |

## 3 · Coding Standards
- Only add English comments when the behavior is not self-evident.
- No new tests by default; only add them when necessary or explicitly requested.
- Code structure must remain evolvable; no copy-paste implementations.

## 4 · CLI Feature Overview

| Command | Responsibilities & Key Points |
| --- | --- |
| `create [name] [--from <worktree\|branch>]` | Only runs on a base branch (main/master/develop or the remote default); `--from` bypasses this restriction, creating a new worktree from a specified worktree or local branch (first looks up worktree names in xlaude state, then matches branch names via `git show-ref`); without a name, a random BIP39 word is selected; automatically updates submodules and copies `CLAUDE.local.md`; set `XLAUDE_NO_AUTO_OPEN` to skip the "open now?" prompt. |
| `checkout <branch|pr>` | Accepts branch names or PR numbers (`123`/`#123`); missing branches are fetched from `origin`; PRs auto-fetch `pull/<n>/head` into `pr/<n>`; if a matching worktree already exists, suggests using `open` instead. |
| `open [name]` | Without arguments: if the current directory is a non-base worktree, opens it directly; untracked worktrees are offered to be added to state; otherwise enters interactive selection or accepts piped input; launches the global `agent` command and inherits all environment variables. |
| `add [name]` | Writes the current git worktree to state; name defaults to the branch name (slashes replaced with `-`); rejects duplicate paths. |
| `rename <old> <new>` | Only updates the worktree alias in state; does not touch the actual directory or branch. |
| `list [--json]` | Groups worktrees by repository, showing path/creation time, and reads Claude (`~/.claude/projects`) and Codex (`~/.codex/sessions` or `XLAUDE_CODEX_SESSIONS_DIR`) sessions, listing the 3 most recent user messages; `--json` outputs structured fields for script consumption. |
| `dir [name]` | Outputs the bare path, useful for `cd $(xlaude dir foo)`; supports interactive selection or piped input. |
| `delete [name]` | Automatically checks for uncommitted changes, unpushed commits, and merge status (via both `git branch --merged` and `gh pr list`), prompting for confirmation as needed; runs `git worktree prune` if the directory no longer exists; finally attempts a safe branch deletion, asking about `-D` if unmerged. |
| `clean` | Iterates over all repositories, compares `git worktree list --porcelain` with state, and removes worktrees that were manually deleted. |
| `config` | Opens the state file in `$EDITOR` for manual editing of `agent` and other global settings. |
| `completions <shell>` | Outputs Bash/Zsh/Fish completion scripts; internally calls the hidden `complete-worktrees` command for dynamic listings. |
| `complete-worktrees [--format=simple|detailed]` | Provides a simple or detailed (repo/path/session summary) worktree list for completion scripts or custom tooling. |

## 5 · Agent & Session Management
- The `agent` field in `state.json` defines the launch command; default is `claude --dangerously-skip-permissions`. The command is tokenized using shell rules; complex pipelines should be wrapped in a script.
- When `agent`'s executable is `codex` and no positional arguments are given, xlaude searches `~/.codex/sessions` (or `XLAUDE_CODEX_SESSIONS_DIR`) for the latest session matching the current worktree and automatically appends `resume <session-id>`.
- `list` parses Claude JSONL and Codex session directories, displaying recent user messages with "time ago" labels to help decide whether a context is worth resuming.

## 6 · State & Data
- State file locations:
  - macOS: `~/Library/Application Support/com.xuanwo.xlaude/state.json`
  - Linux: `~/.config/xlaude/state.json`
  - Windows: `%APPDATA%\xuanwo\xlaude\config\state.json`
- Entry keys follow the format `<repo-name>/<worktree-name>`; old-format entries (without `/`) are auto-migrated at runtime.
- `XLAUDE_CONFIG_DIR` redirects the entire config directory for testing or isolated environments.
- When creating/checking out a new worktree, `CLAUDE.local.md` is automatically copied from the repo root if it exists; `git submodule update --init --recursive` is also run to ensure dependencies are in place.

## 7 · Environment Variables & Automation

| Variable | Purpose |
| --- | --- |
| `XLAUDE_YES=1` | Auto-confirm all prompts; commonly used for scripted deletions or batch operations. |
| `XLAUDE_NON_INTERACTIVE=1` | Disable interactive selection; commands fail or use defaults when no input is provided. |
| `XLAUDE_NO_AUTO_OPEN=1` | Skip the "open now?" prompt after `create`. |
| `XLAUDE_CONFIG_DIR=/path` | Override the state/config directory location. |
| `XLAUDE_CODEX_SESSIONS_DIR=/path` | Specify the Codex session log location for custom sync strategies. |
| `XLAUDE_TEST_SEED=42` | Make random worktree names reproducible in tests. |
| `XLAUDE_TEST_MODE=1` | CI/test mode; disables some interactivity and prevents auto-opening new worktrees. |

- Input priority: CLI arguments > piped input > interactive prompt. For example, `echo wrong | xlaude open correct` will still open `correct`.
- Piped input works for both names and `y/n` confirmations to `smart_confirm`, so `yes | xlaude delete foo` enables unattended cleanup.

## 8 · Workflow Examples
```bash
# Create and immediately start a feature branch
xlaude create ingestion-batch
xlaude open ingestion-batch

# Branch off an existing worktree (e.g., to continue work on an unmerged feature)
xlaude create fix-for-batch --from ingestion-batch

# Check out GitHub PR #128 and assign a dedicated worktree
xlaude checkout 128
xlaude open pr-128

# View all active contexts and recent conversations
xlaude list

# Clean up after the task is done
xlaude delete ingestion-batch
```

## 9 · Dependencies
- Git >= 2.36 (mature worktree support required).
- Rust toolchain (for building or `cargo install`).
- Claude CLI or a custom agent (e.g., Codex).
- `gh` CLI is optional; used by `delete` to detect merged PRs (falls back to git-only detection without it).

## 10 · Notes
- `create`/`checkout` refuse to run on non-base branches to prevent an unmanageable branch forest.
- `delete` switches back to the main repository when the current directory is about to be deleted, preventing `worktree remove` from hanging; if the directory is already gone, it offers to clean up state only.
- `list --json` exposes precise paths, branches, creation times, and Claude/Codex sessions; be aware of sensitive information in the output.
- Shell completions rely on the hidden `complete-worktrees` command; use `--format=detailed` for repo/path/session descriptions when building custom completions.
- Follow the "think first, then try" principle: when uncertain, restate the problem, list possible approaches, then implement.
