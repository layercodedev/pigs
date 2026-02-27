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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOption {
    pub name: String,
    pub command: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct PigsState {
    // Key format: "{repo_name}/{worktree_name}"
    #[serde(default)]
    pub worktrees: HashMap<String, WorktreeInfo>,
    // Global agent options to launch sessions (first entry is default)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<Vec<AgentOption>>,
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

    /// Load global settings then overlay any local `.pigs/settings.json` found
    /// by walking up from the current directory. Local settings override global
    /// ones for `agent`, `editor`, and `shell`.
    pub fn load_with_local_overrides() -> Result<Self> {
        let mut state = Self::load()?;

        if let Some(local) = Self::find_local_settings()? {
            if local.agent.is_some() {
                state.agent = local.agent;
            }
            if local.editor.is_some() {
                state.editor = local.editor;
            }
            if local.shell.is_some() {
                state.shell = local.shell;
            }
        }

        Ok(state)
    }

    /// Search for a `.pigs/settings.json` in the current directory or any
    /// ancestor. Returns `Ok(None)` when no local file is found.
    /// Skips repo-level config files that don't contain pigs state fields.
    fn find_local_settings() -> Result<Option<Self>> {
        let global_path = get_config_path()?;
        let mut dir = std::env::current_dir().ok();
        while let Some(d) = dir {
            let candidate = d.join(".pigs/settings.json");
            if candidate.exists() {
                // Skip the global settings file (handled separately by load())
                if candidate.canonicalize().ok() == global_path.canonicalize().ok() {
                    dir = d.parent().map(Path::to_path_buf);
                    continue;
                }
                let content = fs::read_to_string(&candidate)
                    .with_context(|| format!("Failed to read {}", candidate.display()))?;
                // Try to parse as PigsState; skip files that don't match
                // (e.g. repo-level RepoConfig files with copy_files)
                match serde_json::from_str::<Self>(&content) {
                    Ok(local) => return Ok(Some(local)),
                    Err(_) => {
                        // Not a pigs state file, keep walking up
                        dir = d.parent().map(Path::to_path_buf);
                        continue;
                    }
                }
            }
            dir = d.parent().map(Path::to_path_buf);
        }
        Ok(None)
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
    Ok(dir.join("settings.json"))
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct RepoConfig {
    #[serde(default)]
    pub copy_files: Vec<String>,
}

impl RepoConfig {
    pub fn load(repo_root: &Path) -> Result<Self> {
        let config_path = repo_root.join(".pigs/settings.json");
        if config_path.exists() {
            let content = fs::read_to_string(&config_path)
                .context("Failed to read repo-level .pigs/settings.json")?;
            Ok(serde_json::from_str(&content)?)
        } else {
            Ok(Self::default())
        }
    }
}

/// Resolve default agent option when no config is present.
pub fn get_default_agent() -> AgentOption {
    AgentOption {
        name: "claude".to_string(),
        command: "claude --dangerously-skip-permissions".to_string(),
    }
}
