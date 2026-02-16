use anyhow::{Context, Result};
use colored::Colorize;

use crate::commands::create::handle_create;
use crate::input::{get_command_arg, smart_confirm, smart_select};
use crate::linear;

pub fn handle_linear(
    identifier: Option<String>,
    from: Option<String>,
    yes: bool,
    mut agent_args: Vec<String>,
) -> Result<()> {
    let identifier = match get_command_arg(identifier)? {
        Some(id) => id,
        None => {
            // Fetch assigned issues and let the user pick one
            std::env::var("LINEAR_API_KEY")
                .context("LINEAR_API_KEY environment variable is not set")?;

            let issues = linear::fetch_my_issues()
                .context("Failed to fetch Linear issues")?;

            if issues.is_empty() {
                anyhow::bail!("No assigned issues found in Linear");
            }

            let selection = smart_select(
                "Select a Linear issue",
                &issues,
                |issue| format!("{} {}", issue.identifier, issue.title),
            )?;

            match selection {
                Some(index) => issues[index].identifier.clone(),
                None => anyhow::bail!("A Linear issue identifier is required (e.g. ENG-123)"),
            }
        }
    };

    if !linear::is_linear_task_id(&identifier) {
        anyhow::bail!("'{}' is not a valid Linear task ID (expected format: ENG-123)", identifier);
    }

    std::env::var("LINEAR_API_KEY")
        .context("LINEAR_API_KEY environment variable is not set")?;

    let issue = linear::fetch_issue(&identifier)?;

    println!(
        "{} Found Linear issue: {}",
        "🔗".green(),
        issue.title.cyan()
    );

    let should_start = if yes || std::env::var("PIGS_YES").is_ok() {
        true
    } else {
        smart_confirm("Set issue to In Progress and assign to yourself?", true)?
    };

    if should_start {
        match linear::start_issue(&identifier) {
            Ok(()) => println!(
                "{} Issue set to In Progress and assigned to you",
                "✅".green()
            ),
            Err(e) => eprintln!(
                "{} Failed to update issue status: {}",
                "⚠️".yellow(),
                e
            ),
        }
    }

    let mut prompt = issue.title;
    if let Some(desc) = issue.description {
        prompt.push_str("\n\n");
        prompt.push_str(&desc);
    }
    agent_args.push(prompt);

    handle_create(Some(issue.branch_name), from, yes, agent_args)
}
