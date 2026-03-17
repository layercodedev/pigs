use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use chrono::Utc;
use colored::Colorize;
use serde::{Deserialize, Serialize};

use crate::git::{copy_files_to_worktree, execute_git, get_repo_name, update_submodules};
use crate::input::{get_command_arg, smart_confirm};
use crate::state::{PigsState, RepoConfig, WorktreeInfo};
use crate::utils::sanitize_branch_name;

const REVIEW_STATE_FILE: &str = "pigs-review";

#[derive(Serialize, Deserialize)]
struct ReviewState {
    original_head: String,
    base_branch: String,
    branch_name: String,
}

fn review_state_path_in(worktree_path: &Path) -> Result<PathBuf> {
    let git_dir = execute_git(&[
        "-C",
        worktree_path.to_str().context("Invalid path")?,
        "rev-parse",
        "--git-dir",
    ])?;
    Ok(PathBuf::from(git_dir).join(REVIEW_STATE_FILE))
}

fn load_review_state_in(worktree_path: &Path) -> Result<Option<ReviewState>> {
    let path = review_state_path_in(worktree_path)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).context("Failed to read review state")?;
    let state: ReviewState =
        serde_json::from_str(&content).context("Failed to parse review state")?;
    Ok(Some(state))
}

fn save_review_state_in(worktree_path: &Path, state: &ReviewState) -> Result<()> {
    let path = review_state_path_in(worktree_path)?;
    let content = serde_json::to_string_pretty(state)?;
    fs::write(&path, content).context("Failed to save review state")?;
    Ok(())
}

fn clear_review_state_in(worktree_path: &Path) -> Result<()> {
    let path = review_state_path_in(worktree_path)?;
    if path.exists() {
        fs::remove_file(&path).context("Failed to remove review state")?;
    }
    Ok(())
}

/// Try to find the current directory's worktree review state for finish/abort.
fn current_review_worktree() -> Result<(PathBuf, ReviewState)> {
    let cwd = std::env::current_dir().context("Failed to get current directory")?;
    let state = load_review_state_in(&cwd)?
        .context("Not currently in a review worktree. Run this from a review worktree directory.")?;
    Ok((cwd, state))
}

pub fn handle_review(target: Option<String>, base: Option<String>) -> Result<()> {
    let raw_target = get_command_arg(target)?
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .context("Please provide a branch name, pull request number, 'finish', or 'abort'")?;

    if raw_target == "finish" {
        return handle_review_finish();
    }

    if raw_target == "abort" {
        return handle_review_abort();
    }

    let base_branch = base.unwrap_or_else(|| "develop".to_string());

    // Resolve PR number to branch name if needed
    let trimmed = raw_target.trim();
    let digits_only = trimmed.trim_start_matches('#');
    let branch_name =
        if !digits_only.is_empty() && digits_only.chars().all(|c| c.is_ascii_digit()) {
            let pr_number: u64 = digits_only.parse().context("Invalid pull request number")?;
            resolve_pr_branch_name(pr_number)
                .unwrap_or_else(|| format!("pr/{pr_number}"))
        } else {
            trimmed.to_string()
        };

    let worktree_name = format!("review-{}", sanitize_branch_name(&branch_name));

    let repo_root_str = execute_git(&["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();
    let repo_root = PathBuf::from(&repo_root_str);
    let repo_name = get_repo_name().context("Not in a git repository")?;

    // Check if this review worktree already exists
    let mut pigs_state = PigsState::load()?;
    let key = PigsState::make_key(&repo_name, &worktree_name);
    if let Some(existing) = pigs_state.worktrees.get(&key) {
        println!(
            "{} Review worktree for '{}' already exists at {}",
            "⚠️".yellow(),
            branch_name.cyan(),
            existing.path.display()
        );
        let should_open = smart_confirm("Open the existing review worktree?", true)?;
        if should_open {
            launch_editor(&existing.path)?;
            let wt_display = existing.path.display();
            println!();
            println!(
                "  {} When done:",
                "💡".cyan(),
            );
            println!(
                "    {}",
                format!("cd {wt_display} && pigs review finish").cyan()
            );
            println!(
                "    {}",
                format!("cd {wt_display} && pigs review abort").cyan()
            );
        }
        return Ok(());
    }

    // Ensure branch is available
    ensure_branch_available(&branch_name)?;

    println!(
        "{} Creating review worktree for '{}'...",
        "🔍".green(),
        branch_name.cyan()
    );

    // Create worktree
    let worktree_parent = repo_root
        .parent()
        .context("Repository root has no parent directory")?;
    let worktree_path = worktree_parent.join(format!("{repo_name}-{worktree_name}"));

    if worktree_path.exists() {
        bail!(
            "Directory '{}' already exists. Remove it first.",
            worktree_path.display()
        );
    }

    let worktree_arg = worktree_path
        .to_str()
        .context("Worktree path contains invalid UTF-8")?;

    execute_git(&[
        "-C",
        &repo_root_str,
        "worktree",
        "add",
        worktree_arg,
        &branch_name,
    ])
    .context("Failed to create worktree")?;

    if let Err(e) = update_submodules(&worktree_path) {
        println!(
            "{} Warning: Failed to update submodules: {}",
            "⚠️".yellow(),
            e
        );
    }

    let repo_config = RepoConfig::load(&repo_root)?;
    copy_files_to_worktree(&repo_root, &worktree_path, &repo_config.copy_files, false)?;

    // Save to pigs state
    pigs_state.worktrees.insert(
        key,
        WorktreeInfo {
            name: worktree_name.clone(),
            branch: branch_name.clone(),
            path: worktree_path.clone(),
            repo_name: repo_name.clone(),
            created_at: Utc::now(),
        },
    );
    pigs_state.save()?;

    // Now set up review mode inside the worktree
    let wt_str = worktree_path
        .to_str()
        .context("Invalid worktree path")?;

    // Fetch base branch for merge-base calculation
    let _ = execute_git(&["-C", wt_str, "fetch", "origin", &base_branch]);

    let base_ref = if execute_git(&[
        "-C",
        wt_str,
        "show-ref",
        "--verify",
        &format!("refs/heads/{base_branch}"),
    ])
    .is_ok()
    {
        base_branch.clone()
    } else {
        format!("origin/{base_branch}")
    };

    let merge_base = execute_git(&["-C", wt_str, "merge-base", &base_ref, "HEAD"])
        .with_context(|| {
            format!(
                "Failed to find merge base between '{}' and HEAD. \
                 Make sure the base branch '{}' exists.",
                base_ref, base_branch
            )
        })?;

    let original_head = execute_git(&["-C", wt_str, "rev-parse", "HEAD"])?;

    save_review_state_in(
        &worktree_path,
        &ReviewState {
            original_head: original_head.clone(),
            base_branch: base_branch.clone(),
            branch_name: branch_name.clone(),
        },
    )?;

    // Soft reset so all PR changes appear as staged
    execute_git(&["-C", wt_str, "reset", "--soft", &merge_base])
        .context("Failed to soft reset to merge base")?;

    let diff_stat =
        execute_git(&["-C", wt_str, "diff", "--cached", "--stat"]).unwrap_or_default();

    println!(
        "{} Review worktree created at: {}",
        "✅".green(),
        worktree_path.display()
    );
    println!(
        "  {} Base: {} (merge base: {})",
        "📌".cyan(),
        base_branch.cyan(),
        &merge_base[..8.min(merge_base.len())].cyan()
    );
    if !diff_stat.is_empty() {
        println!("  {diff_stat}");
    }
    println!();
    println!(
        "  All PR changes are now {} — opening editor...",
        "staged".green().bold()
    );

    // cd into worktree and launch editor
    std::env::set_current_dir(&worktree_path)
        .context("Failed to change to review worktree")?;
    launch_editor(&worktree_path)?;

    let wt_display = worktree_path.display();
    println!();
    println!(
        "  {} When done:",
        "💡".cyan(),
    );
    println!(
        "    {}",
        format!("cd {wt_display} && pigs review finish").cyan()
    );
    println!(
        "    {}",
        format!("cd {wt_display} && pigs review abort").cyan()
    );

    Ok(())
}

fn handle_review_finish() -> Result<()> {
    let (worktree_path, state) = current_review_worktree()?;
    let wt_str = worktree_path
        .to_str()
        .context("Invalid worktree path")?;

    // Capture any unstaged changes (user's review edits)
    let user_diff = execute_git(&["-C", wt_str, "diff"])?;
    let has_edits = !user_diff.is_empty();

    if has_edits {
        println!("{} Capturing your review edits...", "📝".green());
    }

    // Write the diff to a temp file if there are edits
    let patch_path = if has_edits {
        let path = worktree_path.join(".pigs-review-edits.patch");
        fs::write(&path, &user_diff).context("Failed to save review edits")?;
        Some(path)
    } else {
        None
    };

    // Restore the branch to its original state
    execute_git(&["-C", wt_str, "reset", "--hard", &state.original_head])
        .context("Failed to restore branch to original state")?;

    // Apply user's edits if any
    if let Some(ref patch) = patch_path {
        let patch_str = patch
            .to_str()
            .context("Patch path contains invalid UTF-8")?;

        execute_git(&["-C", wt_str, "apply", patch_str])
            .context("Failed to apply your review edits. The patch has been saved.")?;

        let _ = fs::remove_file(patch);
    }

    clear_review_state_in(&worktree_path)?;

    println!(
        "{} Exited review mode for branch '{}'",
        "✅".green(),
        state.branch_name.cyan()
    );

    if has_edits {
        println!(
            "  Your review edits are now {} on the branch.",
            "unstaged".yellow().bold()
        );
        println!("  You can stage and commit them as a review fix.");
    } else {
        println!("  No edits were made during the review.");
    }

    Ok(())
}

fn handle_review_abort() -> Result<()> {
    let (worktree_path, state) = current_review_worktree()?;
    let wt_str = worktree_path
        .to_str()
        .context("Invalid worktree path")?;

    // Discard everything and restore the branch
    execute_git(&["-C", wt_str, "reset", "--hard", &state.original_head])
        .context("Failed to restore branch to original state")?;

    clear_review_state_in(&worktree_path)?;

    println!(
        "{} Aborted review of branch '{}'",
        "🚫".red(),
        state.branch_name.cyan()
    );
    println!("  All review edits have been discarded.");
    println!(
        "  {} To remove the worktree, run: {} {}",
        "💡".cyan(),
        "pigs delete".cyan(),
        format!("review-{}", sanitize_branch_name(&state.branch_name)).cyan()
    );

    Ok(())
}

fn resolve_editor() -> String {
    // Check pigs state for editor config
    if let Ok(state) = PigsState::load_with_local_overrides() {
        if let Some(editor) = state.editor {
            return editor;
        }
    }

    // Fall back to VISUAL, then EDITOR, then vi
    std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| "vi".to_string())
}

fn launch_editor(worktree_path: &Path) -> Result<()> {
    let editor_cmd = resolve_editor();
    let parts = shell_words::split(&editor_cmd)
        .map_err(|e| anyhow::anyhow!("Invalid editor command: {editor_cmd} ({e})"))?;

    if parts.is_empty() {
        bail!("Editor command is empty");
    }

    let program = &parts[0];
    // Strip --wait / -w flags — we want fire-and-forget
    let filtered_args: Vec<&str> = parts[1..]
        .iter()
        .map(|s| s.as_str())
        .filter(|&a| a != "--wait" && a != "-w")
        .collect();

    let mut cmd = Command::new(program);
    cmd.args(&filtered_args)
        .arg(".")
        .current_dir(worktree_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    cmd.spawn()
        .with_context(|| format!("Failed to launch editor '{program}'"))?;

    Ok(())
}

fn resolve_pr_branch_name(pr_number: u64) -> Option<String> {
    Command::new("gh")
        .args([
            "pr",
            "view",
            &pr_number.to_string(),
            "--json",
            "headRefName",
            "-q",
            ".headRefName",
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if branch.is_empty() {
                None
            } else {
                Some(branch)
            }
        })
}

fn ensure_branch_available(branch_name: &str) -> Result<()> {
    if execute_git(&[
        "show-ref",
        "--verify",
        &format!("refs/heads/{branch_name}"),
    ])
    .is_ok()
    {
        return Ok(());
    }

    println!(
        "{} Fetching branch '{}' from origin...",
        "🌐".blue(),
        branch_name.cyan()
    );

    execute_git(&["remote", "get-url", "origin"])
        .context("Remote 'origin' is not configured")?;

    let fetch_spec = format!("{branch_name}:{branch_name}");
    execute_git(&["fetch", "origin", &fetch_spec])
        .with_context(|| format!("Failed to fetch branch '{branch_name}' from origin"))?;

    if execute_git(&[
        "show-ref",
        "--verify",
        &format!("refs/heads/{branch_name}"),
    ])
    .is_ok()
    {
        Ok(())
    } else {
        bail!("Branch '{branch_name}' does not exist locally or on origin");
    }
}
