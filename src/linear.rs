use anyhow::{Context, Result};
use serde::Deserialize;

const LINEAR_API_URL: &str = "https://api.linear.app/graphql";

pub struct LinearIssue {
    pub title: String,
    pub description: Option<String>,
    pub branch_name: String,
}

#[derive(Clone)]
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
        title: issue["title"].as_str().unwrap_or_default().to_string(),
        description: issue["description"].as_str().map(String::from),
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
    state: Option<IssueState>,
}

#[derive(Deserialize)]
struct IssueState {
    #[serde(rename = "type")]
    state_type: String,
}

pub fn start_issue(identifier: &str) -> Result<()> {
    let api_key = std::env::var("LINEAR_API_KEY")
        .context("LINEAR_API_KEY environment variable is not set")?;

    // First, fetch the issue's team and find the "started" workflow state
    let query = format!(
        r#"{{"query":"{{ issue(id: \"{}\") {{ id team {{ states {{ nodes {{ id type }} }} }} }} }}"}}"#,
        identifier
    );

    let response: serde_json::Value = ureq::post(LINEAR_API_URL)
        .header("Authorization", &api_key)
        .header("Content-Type", "application/json")
        .send(query.as_bytes())
        .context("Failed to query issue team states")?
        .body_mut()
        .read_json()
        .context("Failed to parse Linear API response")?;

    let issue = &response["data"]["issue"];
    if issue.is_null() {
        anyhow::bail!("Issue '{}' not found in Linear", identifier);
    }

    let issue_id = issue["id"].as_str().context("Issue has no id")?;

    let started_state_id = issue["team"]["states"]["nodes"]
        .as_array()
        .context("No workflow states found")?
        .iter()
        .find(|s| s["type"].as_str() == Some("started"))
        .and_then(|s| s["id"].as_str())
        .context("No 'started' workflow state found for this team")?;

    // Get current viewer ID
    let viewer_query = r#"{"query":"{ viewer { id } }"}"#;
    let viewer_response: serde_json::Value = ureq::post(LINEAR_API_URL)
        .header("Authorization", &api_key)
        .header("Content-Type", "application/json")
        .send(viewer_query.as_bytes())
        .context("Failed to query viewer")?
        .body_mut()
        .read_json()
        .context("Failed to parse viewer response")?;

    let viewer_id = viewer_response["data"]["viewer"]["id"]
        .as_str()
        .context("Failed to get viewer ID")?;

    // Mutate: set state to "started" and assign to viewer
    let mutation = format!(
        r#"{{"query":"mutation {{ issueUpdate(id: \"{}\", input: {{ stateId: \"{}\", assigneeId: \"{}\" }}) {{ success }} }}"}}"#,
        issue_id, started_state_id, viewer_id
    );

    let mutate_response: serde_json::Value = ureq::post(LINEAR_API_URL)
        .header("Authorization", &api_key)
        .header("Content-Type", "application/json")
        .send(mutation.as_bytes())
        .context("Failed to update issue")?
        .body_mut()
        .read_json()
        .context("Failed to parse mutation response")?;

    let success = mutate_response["data"]["issueUpdate"]["success"]
        .as_bool()
        .unwrap_or(false);

    if !success {
        anyhow::bail!("Failed to update issue state in Linear");
    }

    Ok(())
}

pub fn fetch_my_issues() -> Result<Vec<LinearIssueSummary>> {
    let api_key = std::env::var("LINEAR_API_KEY")
        .context("LINEAR_API_KEY environment variable is not set")?;

    let query = r#"{"query":"{ viewer { assignedIssues(filter: { state: { type: { in: [\"unstarted\", \"backlog\"] } } }, first: 50, orderBy: updatedAt) { nodes { identifier title state { type } } } } }"}"#;

    let response: ViewerResponse = ureq::post(LINEAR_API_URL)
        .header("Authorization", &api_key)
        .header("Content-Type", "application/json")
        .send(query.as_bytes())
        .context("Failed to send request to Linear API")?
        .body_mut()
        .read_json()
        .context("Failed to parse Linear API response")?;

    let mut nodes = response.data.viewer.assigned_issues.nodes;
    nodes.sort_by_key(|n| {
        match n.state.as_ref().map(|s| s.state_type.as_str()) {
            Some("unstarted") => 0, // Todo first
            Some("backlog") => 1,   // Backlog second
            _ => 2,
        }
    });

    Ok(nodes
        .into_iter()
        .map(|n| LinearIssueSummary {
            identifier: n.identifier,
            title: n.title,
        })
        .collect())
}
