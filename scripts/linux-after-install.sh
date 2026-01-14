#!/bin/bash
# Post-installation script for Linux deb/rpm packages
# Creates symlink to /usr/bin, sets up sandbox permissions, installs icons, and updates caches
# Supports both stable (facebook-messenger-desktop) and beta (facebook-messenger-desktop-beta)

# Detect if this is a beta installation by checking which directory exists
# Beta installs to /opt/Messenger Beta, stable to /opt/Messenger
if [ -d "/opt/Messenger Beta" ]; then
    INSTALL_DIR="/opt/Messenger Beta"
    EXEC_NAME="facebook-messenger-desktop-beta"
    APP_ICON="facebook-messenger-desktop-beta.png"
    DESKTOP_FILE="/usr/share/applications/facebook-messenger-desktop-beta.desktop"
    ICONS_SRC="/opt/Messenger Beta/resources/app.asar.unpacked/assets/icons/beta/linux"
    # Fallback for non-asar-unpacked builds
    if [ ! -d "$ICONS_SRC" ]; then
        ICONS_SRC="/opt/Messenger Beta/resources/app/assets/icons/beta/linux"
    fi
elif [ -d "/opt/Messenger" ]; then
    INSTALL_DIR="/opt/Messenger"
    EXEC_NAME="facebook-messenger-desktop"
    APP_ICON="facebook-messenger-desktop.png"
    DESKTOP_FILE="/usr/share/applications/facebook-messenger-desktop.desktop"
    ICONS_SRC="/opt/Messenger/resources/app.asar.unpacked/assets/icons/linux"
    # Fallback for non-asar-unpacked builds
    if [ ! -d "$ICONS_SRC" ]; then
        ICONS_SRC="/opt/Messenger/resources/app/assets/icons/linux"
    fi
else
    echo "Error: Neither /opt/Messenger nor /opt/Messenger Beta found"
    exit 0
fi

# Create symlink to /usr/bin so the app is available in PATH
if [ -f "$INSTALL_DIR/$EXEC_NAME" ]; then
    ln -sf "$INSTALL_DIR/$EXEC_NAME" "/usr/bin/$EXEC_NAME" 2>/dev/null || true
fi

# Fix chrome-sandbox permissions (required for Electron apps on Linux)
# The sandbox binary must be owned by root with SUID bit set (mode 4755)
if [ -f "$INSTALL_DIR/chrome-sandbox" ]; then
    chown root:root "$INSTALL_DIR/chrome-sandbox" 2>/dev/null || true
    chmod 4755 "$INSTALL_DIR/chrome-sandbox" 2>/dev/null || true
fi

# Install icons to hicolor theme (electron-builder may not do this properly)
# This ensures the app icon appears in the applications menu
ICONS_DST="/usr/share/icons/hicolor"

if [ -d "$ICONS_SRC" ]; then
    # Install each icon size explicitly
    [ -f "$ICONS_SRC/16x16.png" ] && mkdir -p "$ICONS_DST/16x16/apps" && cp "$ICONS_SRC/16x16.png" "$ICONS_DST/16x16/apps/$APP_ICON" 2>/dev/null || true
    [ -f "$ICONS_SRC/22x22.png" ] && mkdir -p "$ICONS_DST/22x22/apps" && cp "$ICONS_SRC/22x22.png" "$ICONS_DST/22x22/apps/$APP_ICON" 2>/dev/null || true
    [ -f "$ICONS_SRC/24x24.png" ] && mkdir -p "$ICONS_DST/24x24/apps" && cp "$ICONS_SRC/24x24.png" "$ICONS_DST/24x24/apps/$APP_ICON" 2>/dev/null || true
    [ -f "$ICONS_SRC/32x32.png" ] && mkdir -p "$ICONS_DST/32x32/apps" && cp "$ICONS_SRC/32x32.png" "$ICONS_DST/32x32/apps/$APP_ICON" 2>/dev/null || true
    [ -f "$ICONS_SRC/48x48.png" ] && mkdir -p "$ICONS_DST/48x48/apps" && cp "$ICONS_SRC/48x48.png" "$ICONS_DST/48x48/apps/$APP_ICON" 2>/dev/null || true
    [ -f "$ICONS_SRC/64x64.png" ] && mkdir -p "$ICONS_DST/64x64/apps" && cp "$ICONS_SRC/64x64.png" "$ICONS_DST/64x64/apps/$APP_ICON" 2>/dev/null || true
    [ -f "$ICONS_SRC/72x72.png" ] && mkdir -p "$ICONS_DST/72x72/apps" && cp "$ICONS_SRC/72x72.png" "$ICONS_DST/72x72/apps/$APP_ICON" 2>/dev/null || true
    [ -f "$ICONS_SRC/96x96.png" ] && mkdir -p "$ICONS_DST/96x96/apps" && cp "$ICONS_SRC/96x96.png" "$ICONS_DST/96x96/apps/$APP_ICON" 2>/dev/null || true
    [ -f "$ICONS_SRC/128x128.png" ] && mkdir -p "$ICONS_DST/128x128/apps" && cp "$ICONS_SRC/128x128.png" "$ICONS_DST/128x128/apps/$APP_ICON" 2>/dev/null || true
    [ -f "$ICONS_SRC/256x256.png" ] && mkdir -p "$ICONS_DST/256x256/apps" && cp "$ICONS_SRC/256x256.png" "$ICONS_DST/256x256/apps/$APP_ICON" 2>/dev/null || true
    [ -f "$ICONS_SRC/512x512.png" ] && mkdir -p "$ICONS_DST/512x512/apps" && cp "$ICONS_SRC/512x512.png" "$ICONS_DST/512x512/apps/$APP_ICON" 2>/dev/null || true
fi

# Fix Categories field in desktop file (electron-builder may only set it to "Network;")
# GNOME Applications menu requires proper categories to display the app
if [ -f "$DESKTOP_FILE" ]; then
    sed -i 's/^Categories=.*/Categories=Network;InstantMessaging;Chat;/' "$DESKTOP_FILE" 2>/dev/null || true
fi

# Update desktop database to register the .desktop file
if command -v update-desktop-database &> /dev/null; then
    update-desktop-database /usr/share/applications 2>/dev/null || true
fi

# Update icon cache for hicolor theme
if command -v update-icon-caches &> /dev/null; then
    update-icon-caches /usr/share/icons/hicolor 2>/dev/null || true
elif command -v gtk-update-icon-cache &> /dev/null; then
    gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
fi

exit 0
