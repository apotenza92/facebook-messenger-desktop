#!/bin/bash
# Post-installation script for Linux deb/rpm packages
# Sets up sandbox permissions, installs icons, and updates desktop/icon caches

APP_NAME="facebook-messenger-desktop"
APP_DIR="/opt/Messenger"
ICONS_SOURCE_DIR="${APP_DIR}/resources/app/assets/icons/linux"
HICOLOR_DIR="/usr/share/icons/hicolor"

# Fix chrome-sandbox permissions (required for Electron apps on Linux)
# The sandbox binary must be owned by root with SUID bit set (mode 4755)
SANDBOX_PATH="${APP_DIR}/chrome-sandbox"
if [ -f "$SANDBOX_PATH" ]; then
    chown root:root "$SANDBOX_PATH" 2>/dev/null || true
    chmod 4755 "$SANDBOX_PATH" 2>/dev/null || true
fi

# Install icons to hicolor theme (electron-builder may not do this properly)
# This ensures the app icon appears in the applications menu
if [ -d "$ICONS_SOURCE_DIR" ]; then
    for size in 16 22 24 32 48 64 72 96 128 256 512; do
        icon_file="${ICONS_SOURCE_DIR}/${size}x${size}.png"
        target_dir="${HICOLOR_DIR}/${size}x${size}/apps"
        if [ -f "$icon_file" ]; then
            mkdir -p "$target_dir" 2>/dev/null || true
            cp "$icon_file" "${target_dir}/${APP_NAME}.png" 2>/dev/null || true
        fi
    done
fi

# Update desktop database to register the .desktop file
if command -v update-desktop-database &> /dev/null; then
    update-desktop-database /usr/share/applications 2>/dev/null || true
fi

# Update icon cache for hicolor theme (try multiple methods for compatibility)
if command -v update-icon-caches &> /dev/null; then
    update-icon-caches "$HICOLOR_DIR" 2>/dev/null || true
elif command -v gtk-update-icon-cache &> /dev/null; then
    gtk-update-icon-cache -f -t "$HICOLOR_DIR" 2>/dev/null || true
fi

exit 0

