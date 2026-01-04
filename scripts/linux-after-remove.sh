#!/bin/bash
# Post-removal script for Linux deb/rpm packages
# Cleans up icons installed to the hicolor theme

APP_NAME="facebook-messenger-desktop"
HICOLOR_DIR="/usr/share/icons/hicolor"

# Remove icons from hicolor theme
for size in 16 22 24 32 48 64 72 96 128 256 512; do
    rm -f "${HICOLOR_DIR}/${size}x${size}/apps/${APP_NAME}.png" 2>/dev/null || true
done

# Update icon cache for hicolor theme
if command -v update-icon-caches &> /dev/null; then
    update-icon-caches "$HICOLOR_DIR" 2>/dev/null || true
elif command -v gtk-update-icon-cache &> /dev/null; then
    gtk-update-icon-cache -f -t "$HICOLOR_DIR" 2>/dev/null || true
fi

exit 0

