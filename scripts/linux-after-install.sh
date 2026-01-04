#!/bin/bash
# Post-installation script for Linux deb/rpm packages
# Sets up sandbox permissions, installs icons, and updates desktop/icon caches

# Fix chrome-sandbox permissions (required for Electron apps on Linux)
# The sandbox binary must be owned by root with SUID bit set (mode 4755)
if [ -f "/opt/Messenger/chrome-sandbox" ]; then
    chown root:root "/opt/Messenger/chrome-sandbox" 2>/dev/null || true
    chmod 4755 "/opt/Messenger/chrome-sandbox" 2>/dev/null || true
fi

# Install icons to hicolor theme (electron-builder may not do this properly)
# This ensures the app icon appears in the applications menu
ICONS_SRC="/opt/Messenger/resources/app/assets/icons/linux"
ICONS_DST="/usr/share/icons/hicolor"
APP_ICON="facebook-messenger-desktop.png"

if [ -d "$ICONS_SRC" ]; then
    # Install each icon size explicitly to avoid shell variable syntax issues
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
