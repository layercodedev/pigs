#!/usr/bin/env bash
set -euo pipefail

REPO="layercodedev/pigs"
INSTALL_DIR="${PIGS_INSTALL_DIR:-$HOME/.pigs/bin}"

info() { printf '\033[0;34m%s\033[0m\n' "$1"; }
error() { printf '\033[0;31mError: %s\033[0m\n' "$1" >&2; exit 1; }

# Check for bun, install if missing
if ! command -v bun &>/dev/null; then
  info "Bun not found — installing..."
  curl -fsSL https://bun.sh/install | bash
  # Source the updated PATH so bun is available in this session
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun &>/dev/null; then
    error "Bun installation failed. Install manually: https://bun.sh"
  fi
  info "Bun installed: $(bun --version)"
fi

# Create install directory
mkdir -p "$INSTALL_DIR"

# Clone or update the repo
PIGS_DIR="$INSTALL_DIR/pigs"
if [ -d "$PIGS_DIR" ]; then
  info "Updating existing installation..."
  git -C "$PIGS_DIR" pull --ff-only
else
  info "Cloning pigs..."
  git clone "https://github.com/$REPO.git" "$PIGS_DIR"
fi

# Install dependencies
info "Installing dependencies..."
cd "$PIGS_DIR"
bun install

# Create launcher script
LAUNCHER="$INSTALL_DIR/pigs"
cat > "$LAUNCHER" << 'SCRIPT'
#!/usr/bin/env bash
exec bun "$HOME/.pigs/bin/pigs/src/index.ts" "$@"
SCRIPT
chmod +x "$LAUNCHER"

# Add to PATH if needed
SHELL_NAME="$(basename "$SHELL")"
PROFILE=""
case "$SHELL_NAME" in
  zsh)  PROFILE="$HOME/.zshrc" ;;
  bash)
    if [ -f "$HOME/.bash_profile" ]; then
      PROFILE="$HOME/.bash_profile"
    else
      PROFILE="$HOME/.bashrc"
    fi
    ;;
  fish) PROFILE="$HOME/.config/fish/config.fish" ;;
esac

PATH_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""
if [ "$SHELL_NAME" = "fish" ]; then
  PATH_LINE="set -gx PATH $INSTALL_DIR \$PATH"
fi

if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  if [ -n "$PROFILE" ]; then
    if ! grep -qF "$INSTALL_DIR" "$PROFILE" 2>/dev/null; then
      echo "" >> "$PROFILE"
      echo "# pigs" >> "$PROFILE"
      echo "$PATH_LINE" >> "$PROFILE"
      info "Added $INSTALL_DIR to PATH in $PROFILE"
    fi
  fi
  export PATH="$INSTALL_DIR:$PATH"
fi

info "pigs installed successfully!"
echo ""
echo "  Run 'pigs' to start (you may need to restart your shell or run: source $PROFILE)"
echo ""
