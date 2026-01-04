#!/bin/bash
# Post-removal script for Linux deb/rpm packages
# Cleans up icons installed to the hicolor theme

ICONS_DST="/usr/share/icons/hicolor"
APP_ICON="facebook-messenger-desktop.png"

# Remove icons from hicolor theme - explicit paths to avoid shell variable syntax issues
rm -f "$ICONS_DST/16x16/apps/$APP_ICON" 2>/dev/null || true
rm -f "$ICONS_DST/22x22/apps/$APP_ICON" 2>/dev/null || true
rm -f "$ICONS_DST/24x24/apps/$APP_ICON" 2>/dev/null || true
rm -f "$ICONS_DST/32x32/apps/$APP_ICON" 2>/dev/null || true
rm -f "$ICONS_DST/48x48/apps/$APP_ICON" 2>/dev/null || true
rm -f "$ICONS_DST/64x64/apps/$APP_ICON" 2>/dev/null || true
rm -f "$ICONS_DST/72x72/apps/$APP_ICON" 2>/dev/null || true
rm -f "$ICONS_DST/96x96/apps/$APP_ICON" 2>/dev/null || true
rm -f "$ICONS_DST/128x128/apps/$APP_ICON" 2>/dev/null || true
rm -f "$ICONS_DST/256x256/apps/$APP_ICON" 2>/dev/null || true
rm -f "$ICONS_DST/512x512/apps/$APP_ICON" 2>/dev/null || true

# Update icon cache for hicolor theme
if command -v update-icon-caches &> /dev/null; then
    update-icon-caches /usr/share/icons/hicolor 2>/dev/null || true
elif command -v gtk-update-icon-cache &> /dev/null; then
    gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
fi

exit 0
