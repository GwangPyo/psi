#!/bin/bash
set -e

# Get the absolute path of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$SCRIPT_DIR/pi"

echo "=> Starting source build..."
cd "$PI_DIR"

# Install dependencies and build
npm install
npm run build

# Path to the built CLI executable
TARGET_BIN="$PI_DIR/packages/coding-agent/dist/cli.js"

if [ ! -f "$TARGET_BIN" ]; then
    echo "Error: The build failed or the executable ($TARGET_BIN) could not be found."
    exit 1
fi

# Grant execute permission
chmod +x "$TARGET_BIN"

# Create a symbolic link named psi in the user's local bin directory (no sudo required)
DEST_DIR="$HOME/.local/bin"
mkdir -p "$DEST_DIR"

echo "=> Registering the 'psi' command in the local user environment... ($DEST_DIR/psi)"
ln -sf "$TARGET_BIN" "$DEST_DIR/psi"

echo "=> Done!"
echo "=> Note: To use the psi command in a terminal, $DEST_DIR must be included in the PATH environment variable."
