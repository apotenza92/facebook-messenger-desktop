# Flathub Submission: io.github.apotenza92.messenger

**Repository**: https://github.com/apotenza92/facebook-messenger-desktop  
**License**: MIT  
**Upstream Maintainer**: Alex Potenza (apotenza92@gmail.com)

---

## Policy Compliance

### Trademark Compliance
- **App ID**: `io.github.apotenza92.messenger` (no trademarked terms)
- **App Name**: "Messenger" (generic term with disclaimers)
- **Icon**: Uses Messenger branding elements. Descriptive use with explicit disclaimers in LICENSE/metainfo.
- **Disclaimers**: Required notices stating unofficial/community package, not affiliated with Meta Platforms, Inc.

### Impermissible Submissions Compliance
**Provides Substantial Native Functionality**: This is not a simple web view; it provides native OS integrations:

| Feature | Standard Web/PWA | This App |
|---------|------------------|----------|
| Native Notifications | Broken in PWA | Full native system |
| System Tray | Not possible | Full integration |
| Badge Counts | Not in PWA | All platforms |
| Background Service | Service Worker limitations, unreliable connections | Hidden window maintains persistent WebSocket connections |

**8 Native Feature Categories**: System tray, native notifications, badges, auto-updates, background service, platform integrations, window management, permission handling.

### Technical Compliance
- App ID: `io.github.apotenza92.messenger` (4 components, io.github. prefix)
- Build from source (TypeScript compilation, no pre-built binaries)
- Runtime: 24.08 (current stable)
- Socket permissions: wayland + fallback-x11
- Architecture: x86_64 and aarch64
- License: MIT, installed to correct location
- All sources in manifest with SHA256

---

## Pre-Submission Checklist

### Completed
- App ID, build from source, runtime 24.08, socket permissions, license, architecture support

### Required Before Submission
- Desktop File: `io.github.apotenza92.messenger.desktop` in repo root
- Metainfo File: `io.github.apotenza92.messenger.metainfo.xml` in repo root
  - Include disclaimer: "This is a community package of Messenger and not officially supported by Meta Platforms, Inc."
  - Use release tag URL for screenshot (not main branch)
  - App ID must match: `io.github.apotenza92.messenger`
- SHA256: Calculate and update for source archive URL
- Video: Create demonstration video (Linux + Flatpak)
- Test Build: Build locally with flatpak-builder

---

## PR Description Template

```markdown
## Application Details

**Application ID**: io.github.apotenza92.messenger
**Application Name**: Messenger
**License**: MIT
**Homepage**: https://github.com/apotenza92/facebook-messenger-desktop

## Description

An unofficial desktop client for Facebook Messenger with substantial native OS integrations.

### Native Features:
- System tray integration (background operation)
- Native OS notifications (replaces broken PWA notifications)
- Badge management (dock/taskbar unread counts, not available in PWA)
- Auto-update system (independent from web)
- Background service (maintains connections)
- Platform-specific integrations

### Policy Compliance:

**Trademark**: Generic app name "Messenger" with required disclaimers. App ID avoids trademarked terms. Icon uses descriptive branding elements with explicit disclaimers.

**Impermissible Submissions**: Provides substantial native integration across 8 feature categories. Critical functionality (working notifications, badges) impossible in PWA.

**Technical**: Builds from source, uses 24.08 runtime, correct permissions, supports both architectures.

See FLATHUB_SUBMISSION.md for detailed compliance documentation.

## Verification

- Tested in sandboxed environment
- Built locally with flatpak-builder
- All required files included
- Video demonstration attached
```

---

## Quick Reference

**Testing**:
```bash
flatpak install org.freedesktop.Sdk//24.08 org.freedesktop.Platform//24.08
flatpak install org.electronjs.Electron2.BaseApp//24.08
flatpak-builder --user --install --force-clean build-dir io.github.apotenza92.messenger.yml
flatpak run io.github.apotenza92.messenger
appstream-util validate io.github.apotenza92.messenger.metainfo.xml
```

**Files in PR**: Manifest only (io.github.apotenza92.messenger.yml). Desktop/metainfo must be in upstream repo.

**Common Issues**: Do not include source/binaries, use release tag URLs (not branches), desktop/metainfo must be upstream, include SHA256, use 24.08 runtime, use wayland + fallback-x11.

---

## References

- [Flathub Requirements](https://docs.flathub.org/docs/for-app-authors/requirements)
- [Flathub Submission Guide](https://docs.flathub.org/docs/for-app-authors/submission)
- [No trademark violations](https://docs.flathub.org/docs/for-app-authors/requirements#no-trademark-violations)
- [Impermissible submissions](https://docs.flathub.org/docs/for-app-authors/requirements#impermissible-submissions)
