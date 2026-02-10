~~Refactor pigs into local only git worktrees, within the same tmux wrapper. Remove all sprites functionality and code. Rename VMs to 'branches'. User starts pigs in a git repo. Each branch is a new feature branch in a git worktree. Ensure files like .dev.vars needed to run the app in a worktree are also in every worktree.~~ DONE

~~Ensure chained PRs functionally still works.~~ DONE

~~Ensure create from linear still works. The agent command should be `docker sandbox run claude "Do linear task ID"` (no need to include linear task description in prompt, as Claude will use its linear MCP to fetch it and start work).~~ DONE

~~Add 'open app' command which starts the dev server and opens in browser. Each worktree should auto find an open port. URL should be pretend [localhost](http://localhost) subdomain so you can identify branch in browser: branchname-foldername.localhost:port~~ DONE

~~Add grid feature which shows all agent terminals in grid at same time.~~ DONE

~~Claude complete notification could probably be done via tmux terminal notifications or claude hooks, instead of the touch file method now.~~ DONE
