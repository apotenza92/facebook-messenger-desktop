#!/bin/bash
# Post-installation script for Linux deb/rpm packages
# Sets up sandbox permissions and updates desktop/icon caches

# Fix chrome-sandbox permissions (required for Electron apps on Linux)
# The sandbox binary must be owned by root with SUID bit set (mode 4755)
SANDBOX_PATH="/opt/Messenger/chrome-sandbox"
if [ -f "$SANDBOX_PATH" ]; then
    chown root:root "$SANDBOX_PATH" 2>/dev/null || true
    chmod 4755 "$SANDBOX_PATH" 2>/dev/null || true
fi

# Update desktop database to register the .desktop file
if command -v update-desktop-database &> /dev/null; then
    update-desktop-database /usr/share/applications 2>/dev/null || true
fi

# Update icon cache for hicolor theme
if command -v gtk-update-icon-cache &> /dev/null; then
    gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
fi

exit 0

