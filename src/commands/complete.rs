use anyhow::Result;
use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;

use crate::claude::get_claude_sessions;
use crate::state::{WorktreeInfo, PigsState};

pub fn handle_complete_worktrees(format: &str) -> Result<()> {
    // Silently load state, return empty on any error
    let state = match PigsState::load() {
        Ok(s) => s,
        Err(_) => return Ok(()), // Silent failure for completions
    };

    if state.worktrees.is_empty() {
        return Ok(());
    }

    // Collect all worktrees and sort them
    // Primary sort: by repository name
    // Secondary sort: by worktree name within same repository
    let mut all_worktrees: Vec<&WorktreeInfo> = state.worktrees.values().collect();
    all_worktrees.sort_by(|a, b| match a.repo_name.cmp(&b.repo_name) {
        std::cmp::Ordering::Equal => a.name.cmp(&b.name),
        other => other,
    });

    match format {
        "simple" => {
            // Simple format: just worktree names, one per line, sorted
            for info in &all_worktrees {
                println!("{}", info.name);
            }
        }
        "detailed" => {
            // Detailed format: name<TAB>repo<TAB>path<TAB>sessions
            // Used by shell completions for rich descriptions
            for info in &all_worktrees {
                let session_count = count_sessions_safe(&info.path);
                let session_text = match session_count {
                    0 => "no sessions".to_string(),
                    1 => "1 session".to_string(),
                    n => format!("{} sessions", n),
                };

                // Use tab separator for easy parsing
                println!(
                    "{}\t{}\t{}\t{}",
                    info.name,
                    info.repo_name,
                    info.path.display(),
                    session_text
                );
            }
        }
        _ => {
            // Unknown format, fall back to simple
            for info in &all_worktrees {
                println!("{}", info.name);
            }
        }
    }

    Ok(())
}

/// Output completion candidates for `--from`: worktree names + local branch names, deduplicated.
pub fn handle_complete_from() -> Result<()> {
    let mut candidates = BTreeSet::new();

    // Add worktree names
    if let Ok(state) = PigsState::load() {
        for info in state.worktrees.values() {
            candidates.insert(info.name.clone());
        }
    }

    // Add local branch names
    if let Ok(output) = Command::new("git")
        .args(["branch", "--format=%(refname:short)"])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let branch = line.trim();
                if !branch.is_empty() {
                    candidates.insert(branch.to_string());
                }
            }
        }
    }

    for name in &candidates {
        println!("{}", name);
    }

    Ok(())
}

// Safe wrapper for counting sessions that won't fail
fn count_sessions_safe(worktree_path: &Path) -> usize {
    get_claude_sessions(worktree_path).len()
}
