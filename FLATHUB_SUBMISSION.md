# Flathub Submission: io.github.apotenza92.messenger

Repository: https://github.com/apotenza92/facebook-messenger-desktop  
License: MIT  
Author: Alex Potenza (upstream maintainer)

---

## Native Functionality

Features with no Web API equivalent:

| Feature | Implementation |
|---------|----------------|
| System Tray | Full tray with context menu, background operation — no Web API exists |
| macOS Dock Bounce | `app.dock.bounce('critical')` on incoming call — no Web API exists |
| Automatic Window Focus on Call | `win.show()` + `win.focus()` without user interaction — browsers restrict focus stealing |

Features that work in Chrome/Edge PWAs but not Safari:
- Badges: This app uses native APIs (`app.dock.setBadge()`, `setOverlayIcon()`) that work regardless of browser

Additional features:
- Notifications: Custom implementation with mute detection and duplicate filtering
- Screen sharing on Linux Wayland: XWayland mode toggle for compatibility
- Native downloads: Intercepts Facebook CDN URLs, downloads directly to ~/Downloads

---

## Trademark Compliance

- App ID: `io.github.apotenza92.messenger` — uses code hosting prefix, no trademarked terms
- App Name: "Messenger" — generic term, with required disclaimer in description
- Icon: Custom design (isometric cube/graph in speech bubble), distinct from Meta's branding
- Disclaimer: First paragraph of metainfo description states this is a community package not officially supported by Meta Platforms, Inc.

---

## Technical Compliance

| Requirement | Status |
|-------------|--------|
| Build from source | ✅ TypeScript compilation from `src/` |
| Runtime 24.08 | ✅ |
| Socket: wayland + fallback-x11 | ✅ |
| Desktop/metainfo upstream | ✅ In repo |
| Screenshot URL immutable | ✅ Uses release tag URL |
| aarch64 support | ✅ Both architectures |
| Video demonstration | ✅ Will provide |

---

## Submission Files

Only the manifest (`io.github.apotenza92.messenger.yml`) goes in the PR. Desktop file and metainfo are in the upstream repo.

---

## Test Commands

```bash
flatpak-builder --user --install --force-clean build-dir io.github.apotenza92.messenger.yml
flatpak run io.github.apotenza92.messenger
```
