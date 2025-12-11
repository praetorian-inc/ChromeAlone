#!/bin/bash
set -e

echo "Building BLOWTORCH WASM Relay Client..."

# Check for Go
if ! command -v go &> /dev/null; then
    echo "Warning: Go is not installed. Skipping WASM build."
    echo "The application will use standard WebSocket (no domain fronting support)"
    exit 0
fi

# Set WASM build environment
export GOOS=js
export GOARCH=wasm

# Directories
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SRC_DIR="$PROJECT_DIR/src"

# Output WASM directly to src so it can be imported by webpack
mkdir -p "$SRC_DIR"

echo "Building relay-client.wasm..."

# Build the WASM module - all files must be in same directory for go build
cd "$SRC_DIR"
go build -o "$SRC_DIR/relay-client.wasm" \
    relay-client-main.go \
    wasm-websocket.go \
    wasm-relay-proxy.go \
    directsocket.go \
    fingerprint.go

if [ $? -eq 0 ]; then
    echo "✓ WASM build successful: $(du -h "$SRC_DIR/relay-client.wasm" | cut -f1)"

    # Copy wasm_exec.js from Go installation to src
    WASM_EXEC_SRC="$(go env GOROOT)/misc/wasm/wasm_exec.js"
    if [ -f "$WASM_EXEC_SRC" ]; then
        cp "$WASM_EXEC_SRC" "$SRC_DIR/wasm_exec.js"
        echo "✓ Copied wasm_exec.js"
    fi

    # socket-helper.js is already in src/wasm, no need to copy
else
    echo "✗ WASM build failed"
    exit 1
fi

echo "WASM build complete!"
