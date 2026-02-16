use anyhow::Result;
use clap_complete::Shell;

pub fn handle_completions(shell: Shell) -> Result<()> {
    match shell {
        Shell::Bash => print_bash_completions(),
        Shell::Zsh => print_zsh_completions(),
        Shell::Fish => print_fish_completions(),
        _ => {
            eprintln!("Unsupported shell: {:?}", shell);
            eprintln!("Supported shells: bash, zsh, fish");
        }
    }
    Ok(())
}

fn print_bash_completions() {
    println!(
        r#"#!/bin/bash

_pigs() {{
    local cur prev words cword
    if type _init_completion &>/dev/null; then
        _init_completion || return
    else
        # Fallback for older bash-completion
        COMPREPLY=()
        cur="${{COMP_WORDS[COMP_CWORD]}}"
        prev="${{COMP_WORDS[COMP_CWORD-1]}}"
        words=("${{COMP_WORDS[@]}}")
        cword=$COMP_CWORD
    fi

    # Main commands
    local commands="create open delete add rename list clean dir completions"

    # Complete main commands
    if [[ $cword -eq 1 ]]; then
        COMPREPLY=($(compgen -W "$commands" -- "$cur"))
        return
    fi

    # Complete subcommand arguments
    case "${{words[1]}}" in
        create)
            if [[ "$prev" == "--from" ]]; then
                local targets=$(pigs complete-from 2>/dev/null)
                COMPREPLY=($(compgen -W "$targets" -- "$cur"))
            elif [[ "$cur" == -* ]]; then
                COMPREPLY=($(compgen -W "--from -y" -- "$cur"))
            else
                local linear_issues=$(pigs complete-linear 2>/dev/null | cut -f1)
                COMPREPLY=($(compgen -W "$linear_issues" -- "$cur"))
            fi
            ;;
        open|dir|delete)
            if [[ $cword -eq 2 ]]; then
                # Get worktree names for completion
                local worktrees=$(pigs complete-worktrees 2>/dev/null)
                COMPREPLY=($(compgen -W "$worktrees" -- "$cur"))
            fi
            ;;
        rename)
            if [[ $cword -eq 2 ]]; then
                # Complete first argument (old name)
                local worktrees=$(pigs complete-worktrees 2>/dev/null)
                COMPREPLY=($(compgen -W "$worktrees" -- "$cur"))
            fi
            ;;
        completions)
            if [[ $cword -eq 2 ]]; then
                COMPREPLY=($(compgen -W "bash zsh fish" -- "$cur"))
            fi
            ;;
    esac
}}

complete -F _pigs pigs
"#
    );
}

fn print_zsh_completions() {
    println!(
        r#"#compdef pigs

_pigs() {{
    local -a commands
    commands=(
        'create:Create a new git worktree'
        'open:Open an existing worktree and launch Claude'
        'delete:Delete a worktree and clean up'
        'add:Add current worktree to pigs management'
        'rename:Rename a worktree'
        'list:List all active Claude instances'
        'clean:Clean up invalid worktrees from state'
        'dir:Get the directory path of a worktree'
        'completions:Generate shell completions'
    )

    # Main command completion
    if (( CURRENT == 2 )); then
        _describe 'command' commands
        return
    fi

    # Subcommand argument completion
    case "${{words[2]}}" in
        open|dir|delete)
            if (( CURRENT == 3 )); then
                _pigs_worktrees
            fi
            ;;
        rename)
            if (( CURRENT == 3 )); then
                _pigs_worktrees
            elif (( CURRENT == 4 )); then
                _message "new name"
            fi
            ;;
        create)
            # Support --from with worktree completion, and positional name
            local -a create_opts
            create_opts=(
                '--from[Create from an existing worktree or branch]:source:_pigs_from_targets'
                '-y[Automatically open the worktree after creation]'
            )
            _arguments -s $create_opts '1:worktree name or Linear issue:_pigs_linear_issues'
            ;;
        add)
            if (( CURRENT == 3 )); then
                _message "worktree name"
            fi
            ;;
        completions)
            if (( CURRENT == 3 )); then
                local -a shells
                shells=(bash zsh fish)
                _describe 'shell' shells
            fi
            ;;
    esac
}}

_pigs_worktrees() {{
    local -a worktrees
    local IFS=$'\n'
    
    # Get detailed worktree information (sorted by repo, then by name)
    local worktree_data
    worktree_data=($(pigs complete-worktrees --format=detailed 2>/dev/null))
    
    if [[ -n "$worktree_data" ]]; then
        for line in $worktree_data; do
            # Parse tab-separated values: name<TAB>repo<TAB>path<TAB>sessions
            local name=$(echo "$line" | cut -f1)
            local repo=$(echo "$line" | cut -f2)
            local sessions=$(echo "$line" | cut -f4)
            
            # Add worktree with clear repo marker and session info
            worktrees+=("$name:[$repo] $sessions")
        done
        
        # Use _describe for better presentation
        # -V flag preserves the order (no sorting)
        if (( ${{#worktrees[@]}} > 0 )); then
            _describe -V -t worktrees 'worktree' worktrees
        fi
    else
        # Fallback to simple completion
        local simple_worktrees
        simple_worktrees=($(pigs complete-worktrees 2>/dev/null))
        if [[ -n "$simple_worktrees" ]]; then
            compadd -a simple_worktrees
        fi
    fi
}}

_pigs_linear_issues() {{
    local -a issues
    local IFS=$'\n'
    local issue_data
    issue_data=($(pigs complete-linear 2>/dev/null))

    if [[ -n "$issue_data" ]]; then
        for line in $issue_data; do
            local id=$(echo "$line" | cut -f1)
            local title=$(echo "$line" | cut -f2)
            issues+=("$id:$title")
        done
        _describe -V 'Linear issue' issues
    fi
}}

_pigs_from_targets() {{
    local -a targets
    targets=($(pigs complete-from 2>/dev/null))
    if [[ -n "$targets" ]]; then
        compadd -a targets
    fi
}}

_pigs "$@"
"#
    );
}

fn print_fish_completions() {
    println!(
        r#"# Fish completion for pigs

# Disable file completions by default
complete -c pigs -f

# Main commands
complete -c pigs -n "__fish_use_subcommand" -a create -d "Create a new git worktree"
complete -c pigs -n "__fish_use_subcommand" -a open -d "Open an existing worktree and launch Claude"
complete -c pigs -n "__fish_use_subcommand" -a delete -d "Delete a worktree and clean up"
complete -c pigs -n "__fish_use_subcommand" -a add -d "Add current worktree to pigs management"
complete -c pigs -n "__fish_use_subcommand" -a rename -d "Rename a worktree"
complete -c pigs -n "__fish_use_subcommand" -a list -d "List all active Claude instances"
complete -c pigs -n "__fish_use_subcommand" -a clean -d "Clean up invalid worktrees from state"
complete -c pigs -n "__fish_use_subcommand" -a dir -d "Get the directory path of a worktree"
complete -c pigs -n "__fish_use_subcommand" -a completions -d "Generate shell completions"

# Function to get worktree completions with repo markers
function __pigs_worktrees
    pigs complete-worktrees --format=detailed 2>/dev/null | while read -l line
        # Split tab-separated values: name<TAB>repo<TAB>path<TAB>sessions
        set -l parts (string split \t $line)
        if test (count $parts) -ge 4
            set -l name $parts[1]
            set -l repo $parts[2]
            set -l sessions $parts[4]
            echo "$name\t[$repo] $sessions"
        end
    end
end

# Simple worktree names (fallback)
function __pigs_worktrees_simple
    pigs complete-worktrees 2>/dev/null
end

# Worktree completions for commands
complete -c pigs -n "__fish_seen_subcommand_from open dir delete" -a "(__pigs_worktrees)"
complete -c pigs -n "__fish_seen_subcommand_from rename" -n "not __fish_seen_argument_from (__pigs_worktrees_simple)" -a "(__pigs_worktrees)"

# Linear issue completions
function __pigs_linear_issues
    pigs complete-linear 2>/dev/null | while read -l line
        set -l parts (string split \t $line)
        if test (count $parts) -ge 2
            echo "$parts[1]\t$parts[2]"
        end
    end
end

# --from flag for create command (completes worktrees + branches)
function __pigs_from_targets
    pigs complete-from 2>/dev/null
end

complete -c pigs -n "__fish_seen_subcommand_from create" -l from -d "Create from an existing worktree or branch" -r -a "(__pigs_from_targets)"

# Linear issue completions for create command
complete -c pigs -n "__fish_seen_subcommand_from create; and not __fish_seen_argument_from -l from" -a "(__pigs_linear_issues)"

# Shell completions for completions command
complete -c pigs -n "__fish_seen_subcommand_from completions" -a "bash zsh fish"
"#
    );
}
