#!/bin/bash
# Post-removal script for Linux deb/rpm packages
# Removes symlink from /usr/bin and cleans up icons installed to the hicolor theme
# Supports both stable (facebook-messenger-desktop) and beta (facebook-messenger-desktop-beta)

# Detect which variant is being removed by checking what symlinks/icons exist
# We check both and only remove what's actually present
# This ensures beta removal doesn't affect stable and vice versa

ICONS_DST="/usr/share/icons/hicolor"

# Function to remove icons for a specific app
remove_icons() {
    local ICON_NAME="$1"
    for SIZE in 16x16 22x22 24x24 32x32 48x48 64x64 72x72 96x96 128x128 256x256 512x512; do
        rm -f "$ICONS_DST/$SIZE/apps/$ICON_NAME" 2>/dev/null || true
    done
}

# Check if stable is being removed (install dir no longer exists but symlink does)
# Package managers remove the install dir before running after-remove
if [ -L "/usr/bin/facebook-messenger-desktop" ] && [ ! -d "/opt/Messenger" ]; then
    rm -f "/usr/bin/facebook-messenger-desktop" 2>/dev/null || true
    remove_icons "facebook-messenger-desktop.png"
    # Also remove legacy icon name
    remove_icons "com.facebook.messenger.desktop.png"
fi

# Check if beta is being removed
if [ -L "/usr/bin/facebook-messenger-desktop-beta" ] && [ ! -d "/opt/Messenger Beta" ]; then
    rm -f "/usr/bin/facebook-messenger-desktop-beta" 2>/dev/null || true
    remove_icons "facebook-messenger-desktop-beta.png"
    # Also remove legacy icon name
    remove_icons "com.facebook.messenger.desktop.beta.png"
fi

# Update icon cache for hicolor theme
if command -v update-icon-caches &> /dev/null; then
    update-icon-caches /usr/share/icons/hicolor 2>/dev/null || true
elif command -v gtk-update-icon-cache &> /dev/null; then
    gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
fi

exit 0
