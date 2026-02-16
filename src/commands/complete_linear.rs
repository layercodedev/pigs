use anyhow::Result;

use crate::linear;

pub fn handle_complete_linear() -> Result<()> {
    let issues = match linear::fetch_my_issues() {
        Ok(issues) => issues,
        Err(_) => return Ok(()),
    };

    for issue in issues {
        println!("{}\t{}", issue.identifier, issue.title);
    }

    Ok(())
}
