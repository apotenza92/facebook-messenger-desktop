#!/bin/bash
# Post-installation script for Linux deb/rpm packages
# Updates desktop database and icon cache so the app appears in application menus

# Update desktop database to register the .desktop file
if command -v update-desktop-database &> /dev/null; then
    update-desktop-database /usr/share/applications 2>/dev/null || true
fi

# Update icon cache for hicolor theme
if command -v gtk-update-icon-cache &> /dev/null; then
    gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
fi

# On GNOME, notify the shell to refresh the app list
if command -v dbus-send &> /dev/null; then
    # Try to refresh GNOME Shell's app list (may fail if not running GNOME, that's ok)
    dbus-send --type=method_call --dest=org.gnome.Shell /org/gnome/Shell org.gnome.Shell.Eval string:'Main.overview._overview._controls._appDisplay._redisplay()' 2>/dev/null || true
fi

exit 0

