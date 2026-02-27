use anyhow::{Context, Result};
use chrono::Utc;
use colored::Colorize;
use std::path::PathBuf;

use crate::commands::open::handle_open;
use crate::git::{
    copy_files_to_worktree, execute_git, extract_repo_name_from_url, get_repo_name, list_worktrees,
    update_submodules,
};
use crate::input::{get_command_arg, smart_confirm};
use crate::state::{PigsState, RepoConfig, WorktreeInfo};
use crate::utils::{generate_random_name, sanitize_branch_name};

pub fn handle_create(
    name: Option<String>,
    from: Option<String>,
    yes: bool,
    selected_agent: Option<String>,
    agent_args: Vec<String>,
) -> Result<()> {
    handle_create_in_dir(name, None, from, yes, selected_agent, agent_args)
}

pub fn handle_create_in_dir(
    name: Option<String>,
    repo_path: Option<PathBuf>,
    from: Option<String>,
    yes: bool,
    selected_agent: Option<String>,
    agent_args: Vec<String>,
) -> Result<()> {
    handle_create_in_dir_quiet(
        name,
        repo_path,
        from,
        false,
        yes,
        selected_agent,
        agent_args,
    )?;
    Ok(())
}

// Create worktree quietly without prompting for open, returns the created worktree name
pub fn handle_create_in_dir_quiet(
    name: Option<String>,
    repo_path: Option<PathBuf>,
    from: Option<String>,
    quiet: bool,
    yes: bool,
    selected_agent: Option<String>,
    agent_args: Vec<String>,
) -> Result<String> {
    // Helper to execute git in the right directory using git -C
    let exec_git = |args: &[&str]| -> Result<String> {
        if let Some(ref path) = repo_path {
            // Use git -C to execute in specified directory
            let mut full_args = vec!["-C", path.to_str().unwrap()];
            full_args.extend_from_slice(args);
            execute_git(&full_args)
        } else {
            execute_git(args)
        }
    };

    // Get repo name from the target directory
    let repo_name = if let Some(ref path) = repo_path {
        // Get repo name from the specified path using git -C
        let output = execute_git(&["-C", path.to_str().unwrap(), "remote", "get-url", "origin"])?;
        if let Some(name) = extract_repo_name_from_url(&output) {
            name
        } else {
            // Fallback to directory name
            path.file_name()
                .and_then(|n| n.to_str())
                .map(String::from)
                .context("Failed to get repository name")?
        }
    } else {
        get_repo_name().context("Not in a git repository")?
    };

    // Resolve --from target to a source branch if provided
    let source_branch = if let Some(ref from_target) = from {
        Some(resolve_from_target(from_target, &repo_name, &exec_git)?)
    } else {
        None
    };

    // Only check base branch if no repo_path is provided and no --from flag
    // Clients that pass repo_path are expected to enforce their own branch safety checks
    if repo_path.is_none() && source_branch.is_none() {
        let current_branch = exec_git(&["branch", "--show-current"])?;
        let default_branch = exec_git(&["symbolic-ref", "refs/remotes/origin/HEAD"])
            .ok()
            .and_then(|s| s.strip_prefix("refs/remotes/origin/").map(String::from))
            .unwrap_or_else(|| "main".to_string());

        let base_branches = ["main", "master", "develop", &default_branch];
        if !base_branches.contains(&current_branch.as_str()) {
            anyhow::bail!(
                "Must be on a base branch (main, master, or develop) to create a new worktree. \
                 Current branch: {}\n\
                 Tip: use --from <worktree|branch> to create from a specific branch.",
                current_branch
            );
        }
    }

    // Get name from CLI args or pipe, generate if not provided
    let branch_name = match get_command_arg(name)? {
        Some(n) => n,
        None => generate_random_name()?,
    };

    // Sanitize the branch name for use in directory names
    let worktree_name = sanitize_branch_name(&branch_name);

    // Check if a worktree with this name already exists in pigs state
    let state = PigsState::load()?;
    let key = PigsState::make_key(&repo_name, &worktree_name);
    if state.worktrees.contains_key(&key) {
        anyhow::bail!(
            "A worktree named '{}' already exists for repository '{}' (tracked by pigs). Please choose a different name.",
            worktree_name,
            repo_name
        );
    }

    // Check if the worktree directory will be created
    let worktree_dir_path = if let Some(ref path) = repo_path {
        path.parent()
            .unwrap()
            .join(format!("{repo_name}-{worktree_name}"))
    } else {
        std::env::current_dir()?
            .parent()
            .unwrap()
            .join(format!("{repo_name}-{worktree_name}"))
    };

    // Check if the directory already exists
    if worktree_dir_path.exists() {
        anyhow::bail!(
            "Directory '{}' already exists. Please choose a different name or remove the existing directory.",
            worktree_dir_path.display()
        );
    }

    // Check if a git worktree already exists at this path
    // Need to run git worktree list in the correct directory
    let existing_worktrees = if let Some(ref path) = repo_path {
        // Parse git worktree list output from the specified directory
        let output = execute_git(&[
            "-C",
            path.to_str().unwrap(),
            "worktree",
            "list",
            "--porcelain",
        ])?;
        let mut worktrees = Vec::new();
        for line in output.lines() {
            if let Some(worktree_path) = line.strip_prefix("worktree ") {
                worktrees.push(PathBuf::from(worktree_path));
            }
        }
        worktrees
    } else {
        list_worktrees()?
    };

    if existing_worktrees.iter().any(|w| w == &worktree_dir_path) {
        anyhow::bail!(
            "A git worktree already exists at '{}'. Please choose a different name or remove the existing worktree.",
            worktree_dir_path.display()
        );
    }

    // Check if the branch already exists
    let branch_already_exists = exec_git(&[
        "show-ref",
        "--verify",
        &format!("refs/heads/{}", branch_name),
    ])
    .is_ok();

    if branch_already_exists {
        if !quiet {
            println!(
                "{} Creating worktree '{}' from existing branch '{}'...",
                "✨".green(),
                worktree_name.cyan(),
                branch_name.cyan()
            );
        }
    } else {
        if !quiet {
            if let Some(ref src) = source_branch {
                println!(
                    "{} Creating worktree '{}' with new branch '{}' from '{}'...",
                    "✨".green(),
                    worktree_name.cyan(),
                    branch_name.cyan(),
                    src.cyan()
                );
            } else {
                println!(
                    "{} Creating worktree '{}' with new branch '{}'...",
                    "✨".green(),
                    worktree_name.cyan(),
                    branch_name.cyan()
                );
            }
        }

        if let Some(ref src) = source_branch {
            // Create branch from the resolved --from target
            exec_git(&["branch", &branch_name, src])
                .context("Failed to create branch from source")?;
        } else if repo_path.is_some() {
            // When repo_path is provided, create branch from the default branch
            let default_branch = exec_git(&["symbolic-ref", "refs/remotes/origin/HEAD"])
                .ok()
                .and_then(|s| s.strip_prefix("refs/remotes/origin/").map(String::from))
                .unwrap_or_else(|| "main".to_string());

            exec_git(&[
                "branch",
                &branch_name,
                &format!("origin/{}", default_branch),
            ])
            .context("Failed to create branch from default branch")?;
        } else {
            // Create branch from current branch (original behavior for CLI)
            exec_git(&["branch", &branch_name]).context("Failed to create branch")?;
        }
    }

    // Create worktree with sanitized directory name
    let worktree_dir = format!("../{repo_name}-{worktree_name}");
    exec_git(&["worktree", "add", &worktree_dir, &branch_name])
        .context("Failed to create worktree")?;

    // Get absolute path
    let worktree_path = if let Some(ref path) = repo_path {
        path.parent()
            .unwrap()
            .join(format!("{repo_name}-{worktree_name}"))
    } else {
        std::env::current_dir()?
            .parent()
            .unwrap()
            .join(format!("{repo_name}-{worktree_name}"))
    };

    // Update submodules if they exist
    if let Err(e) = update_submodules(&worktree_path) {
        if !quiet {
            println!(
                "{} Warning: Failed to update submodules: {}",
                "⚠️".yellow(),
                e
            );
        }
    } else {
        // Check if submodules were actually updated
        let gitmodules = worktree_path.join(".gitmodules");
        if gitmodules.exists() && !quiet {
            println!("{} Updated submodules", "📦".green());
        }
    }

    // Copy CLAUDE.local.md and any repo-configured extra files
    let source_root = if let Some(ref path) = repo_path {
        path.clone()
    } else {
        PathBuf::from(std::env::current_dir()?)
    };
    let repo_config = RepoConfig::load(&source_root)?;
    copy_files_to_worktree(&source_root, &worktree_path, &repo_config.copy_files, quiet)?;

    // Save state
    let mut state = PigsState::load()?;
    let key = PigsState::make_key(&repo_name, &worktree_name);
    state.worktrees.insert(
        key,
        WorktreeInfo {
            name: worktree_name.clone(),
            branch: branch_name.clone(),
            path: worktree_path.clone(),
            repo_name,
            created_at: Utc::now(),
        },
    );
    state.save()?;

    if !quiet {
        println!(
            "{} Worktree created at: {}",
            "✅".green(),
            worktree_path.display()
        );
    }

    // Ask if user wants to open the worktree (skip in quiet mode)
    if !quiet {
        // Skip opening in test mode or when explicitly disabled
        let should_open = if std::env::var("PIGS_TEST_MODE").is_ok()
            || std::env::var("PIGS_NO_AUTO_OPEN").is_ok()
        {
            println!(
                "  {} To open it, run: {} {}",
                "💡".cyan(),
                "pigs open".cyan(),
                worktree_name.cyan()
            );
            false
        } else if yes {
            true
        } else {
            smart_confirm("Would you like to open the worktree now?", true)?
        };

        if should_open {
            handle_open(
                Some(worktree_name.clone()),
                selected_agent.clone(),
                agent_args,
            )?;
        } else if std::env::var("PIGS_NON_INTERACTIVE").is_err() {
            println!(
                "  {} To open it later, run: {} {}",
                "💡".cyan(),
                "pigs open".cyan(),
                worktree_name.cyan()
            );
        }
    }

    Ok(worktree_name)
}

/// Resolve a `--from` target to a branch name.
///
/// Priority:
/// 1. Look up as a pigs worktree name in the current repo (exact, then sanitized)
/// 2. Treat as a raw branch name (verified via `git show-ref`)
fn resolve_from_target(
    target: &str,
    repo_name: &str,
    exec_git: &impl Fn(&[&str]) -> Result<String>,
) -> Result<String> {
    let state = PigsState::load()?;
    let sanitized = sanitize_branch_name(target);

    // Try full key lookup (repo/name format)
    let key = PigsState::make_key(repo_name, target);
    if let Some(info) = state.worktrees.get(&key) {
        return Ok(info.branch.clone());
    }
    // Also try with sanitized name
    if sanitized != target {
        let key = PigsState::make_key(repo_name, &sanitized);
        if let Some(info) = state.worktrees.get(&key) {
            return Ok(info.branch.clone());
        }
    }

    // Scan by worktree name within the same repo
    for info in state.worktrees.values() {
        if info.repo_name != repo_name {
            continue;
        }
        if info.name == target || info.name == sanitized {
            return Ok(info.branch.clone());
        }
    }

    // Fall back to raw branch name
    if exec_git(&["show-ref", "--verify", &format!("refs/heads/{}", target)]).is_ok() {
        return Ok(target.to_string());
    }

    // Try remote branch (origin/<target>)
    let remote_ref = format!("origin/{}", target);
    if exec_git(&[
        "show-ref",
        "--verify",
        &format!("refs/remotes/{}", remote_ref),
    ])
    .is_ok()
    {
        return Ok(remote_ref);
    }

    anyhow::bail!(
        "Cannot resolve --from '{}': not a known worktree name, local branch, or remote branch in '{}'.",
        target,
        repo_name
    )
}
