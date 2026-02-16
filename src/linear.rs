use anyhow::{Context, Result};
use serde::Deserialize;

const LINEAR_API_URL: &str = "https://api.linear.app/graphql";

pub struct LinearIssue {
    pub title: String,
    pub description: Option<String>,
    pub branch_name: String,
}

pub struct LinearIssueSummary {
    pub identifier: String,
    pub title: String,
}

pub fn is_linear_task_id(s: &str) -> bool {
    let Some((prefix, suffix)) = s.split_once('-') else {
        return false;
    };
    !prefix.is_empty()
        && prefix.chars().all(|c| c.is_ascii_uppercase())
        && !suffix.is_empty()
        && suffix.chars().all(|c| c.is_ascii_digit())
}

pub fn fetch_issue(identifier: &str) -> Result<LinearIssue> {
    let api_key = std::env::var("LINEAR_API_KEY")
        .context("LINEAR_API_KEY environment variable is not set")?;

    let query = format!(
        r#"{{"query":"{{ issue(id: \"{}\") {{ title description branchName }} }}"}}"#,
        identifier
    );

    let response: serde_json::Value = ureq::post(LINEAR_API_URL)
        .header("Authorization", &api_key)
        .header("Content-Type", "application/json")
        .send(query.as_bytes())
        .context("Failed to send request to Linear API")?
        .body_mut()
        .read_json()
        .context("Failed to parse Linear API response")?;

    let issue = &response["data"]["issue"];
    if issue.is_null() {
        let errors = &response["errors"];
        if !errors.is_null() {
            anyhow::bail!("Linear API error: {}", errors);
        }
        anyhow::bail!("Issue '{}' not found in Linear", identifier);
    }

    Ok(LinearIssue {
        title: issue["title"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        description: issue["description"]
            .as_str()
            .map(String::from),
        branch_name: issue["branchName"]
            .as_str()
            .context("Linear issue has no branch name")?
            .to_string(),
    })
}

#[derive(Deserialize)]
struct ViewerResponse {
    data: ViewerData,
}

#[derive(Deserialize)]
struct ViewerData {
    viewer: Viewer,
}

#[derive(Deserialize)]
struct Viewer {
    #[serde(rename = "assignedIssues")]
    assigned_issues: AssignedIssues,
}

#[derive(Deserialize)]
struct AssignedIssues {
    nodes: Vec<IssueNode>,
}

#[derive(Deserialize)]
struct IssueNode {
    identifier: String,
    title: String,
}

pub fn fetch_my_issues() -> Result<Vec<LinearIssueSummary>> {
    let api_key = std::env::var("LINEAR_API_KEY")
        .context("LINEAR_API_KEY environment variable is not set")?;

    let query = r#"{"query":"{ viewer { assignedIssues(filter: { state: { type: { nin: [\"completed\", \"canceled\"] } } }, first: 50) { nodes { identifier title } } } }"}"#;

    let response: ViewerResponse = ureq::post(LINEAR_API_URL)
        .header("Authorization", &api_key)
        .header("Content-Type", "application/json")
        .send(query.as_bytes())
        .context("Failed to send request to Linear API")?
        .body_mut()
        .read_json()
        .context("Failed to parse Linear API response")?;

    Ok(response
        .data
        .viewer
        .assigned_issues
        .nodes
        .into_iter()
        .map(|n| LinearIssueSummary {
            identifier: n.identifier,
            title: n.title,
        })
        .collect())
}
