use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub name: String,
    pub branch: String,
    pub path: PathBuf,
    pub repo_name: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct PigsState {
    // Key format: "{repo_name}/{worktree_name}"
    pub worktrees: HashMap<String, WorktreeInfo>,
    // Global agent command to launch sessions (full command line string)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    // Preferred editor command (full command line string)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor: Option<String>,
    // Preferred interactive shell command
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
}

impl PigsState {
    pub fn make_key(repo_name: &str, worktree_name: &str) -> String {
        format!("{repo_name}/{worktree_name}")
    }

    pub fn load() -> Result<Self> {
        let config_path = get_config_path()?;
        if config_path.exists() {
            let content = fs::read_to_string(&config_path).context("Failed to read config file")?;
            let mut state: Self =
                serde_json::from_str(&content).context("Failed to parse config file")?;

            // ============================================================================
            // MIGRATION LOGIC: Upgrade from v0.2 to v0.3 format
            // TODO: Remove this migration code after v0.3 is stable and most users have upgraded
            //
            // In v0.2, keys were just the worktree name: "feature-x"
            // In v0.3, keys include the repo name: "repo-name/feature-x"
            // ============================================================================
            let needs_migration = state.worktrees.keys().any(|k| !k.contains('/'));

            if needs_migration {
                eprintln!("🔄 Migrating pigs state from v0.2 to v0.3 format...");

                let mut migrated_worktrees = HashMap::new();
                for (old_key, info) in state.worktrees {
                    // Check if this entry needs migration (doesn't contain '/')
                    let new_key = if old_key.contains('/') {
                        // Already in new format, keep as-is
                        old_key
                    } else {
                        // Old format, create new key
                        Self::make_key(&info.repo_name, &info.name)
                    };
                    migrated_worktrees.insert(new_key, info);
                }

                state.worktrees = migrated_worktrees;

                // Save the migrated state immediately
                state.save().context("Failed to save migrated state")?;
                eprintln!("✅ Migration completed successfully");
            }
            // ============================================================================
            // END OF MIGRATION LOGIC
            // ============================================================================

            Ok(state)
        } else {
            Ok(Self::default())
        }
    }

    pub fn save(&self) -> Result<()> {
        let config_path = get_config_path()?;
        if let Some(parent) = config_path.parent() {
            fs::create_dir_all(parent).context("Failed to create config directory")?;
        }
        let content = serde_json::to_string_pretty(self).context("Failed to serialize state")?;
        fs::write(&config_path, content).context("Failed to write config file")?;
        Ok(())
    }
}

pub fn get_config_dir() -> Result<PathBuf> {
    if let Ok(config_dir) = std::env::var("PIGS_CONFIG_DIR") {
        return Ok(PathBuf::from(config_dir));
    }

    let home = std::env::var("HOME").context("HOME environment variable is not set")?;
    Ok(PathBuf::from(home).join(".pigs"))
}

pub fn get_state_path() -> Result<PathBuf> {
    get_config_path()
}

fn get_config_path() -> Result<PathBuf> {
    let dir = get_config_dir()?;
    let new_path = dir.join("settings.json");

    if !new_path.exists() {
        // Migrate from old state.json in same dir
        let old_path = dir.join("state.json");
        if old_path.exists() {
            fs::rename(&old_path, &new_path).ok();
        } else {
            // Migrate from old macOS Application Support location
            if let Ok(home) = std::env::var("HOME") {
                let legacy_path = PathBuf::from(&home)
                    .join("Library/Application Support/com.dctanner.pigs/state.json");
                if legacy_path.exists() {
                    fs::create_dir_all(&dir).ok();
                    fs::rename(&legacy_path, &new_path).ok();
                }
            }
        }
    }

    Ok(new_path)
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct RepoConfig {
    #[serde(default)]
    pub copy_files: Vec<String>,
}

impl RepoConfig {
    pub fn load(repo_root: &Path) -> Result<Self> {
        let config_path = repo_root.join(".pigs/state.json");
        if config_path.exists() {
            let content = fs::read_to_string(&config_path)
                .context("Failed to read repo-level .pigs/state.json")?;
            Ok(serde_json::from_str(&content)?)
        } else {
            Ok(Self::default())
        }
    }
}

/// Resolve the agent command from state with a sensible default.
/// Returns the full command line string (not split).
pub fn get_default_agent() -> String {
    "claude --dangerously-skip-permissions".to_string()
}
