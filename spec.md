I want you to build me a command-line TUI application that runs on macOS, that is designed for creating, monitoring, and interacting with remote VMs that are running the Claude code coding agent on them. The VMs run on sprites.dev and they're controlled with the sprites.dev REST API. There is also a sprite CLI, which will be needed to do some things like SSH into an interactive console.

## Tasks

- [x] Scaffold project: TypeScript + blessed TUI + @fly/sprites SDK, basic TUI layout with sidebar VM list, main console view, status bar, and key command stubs (c:create, d:delete, j/k:navigate, Enter:activate, q:quit)
- [x] Integrate Sprites API: list existing VMs on startup, create VM (with `pigs-` prefix), delete VM with confirmation dialog
- [ ] SSH console session: attach to active VM console via sprites exec TTY, pipe stdin/stdout, detach on switch
- [ ] VM provisioning: on create, install Claude code + SSH via exec, copy CLAUDE.md content from ~/.pigs/settings.json
- [ ] Settings setup: create ~/.pigs/settings.json on first run with default CLAUDE.md content and config
- [ ] Notification hook: Claude code finish hook sends signal, TUI polls/listens and shows attention indicator on VM card
- [ ] Mount VM filesystem: key command to mount sprite FS locally over SSH
- [ ] Exit gracefully: detach from active VM on quit, all VMs keep running in background

Read all relevant sprites api docs in ../toyo/docs/sprites/ and docs.sprites.dev if there's not a docs file for something.
