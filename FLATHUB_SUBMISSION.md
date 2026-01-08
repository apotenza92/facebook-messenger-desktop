# Flathub Submission: io.github.apotenza92.messenger

**Repository:** https://github.com/apotenza92/facebook-messenger-desktop  
**License:** MIT  
**Author:** Alex Potenza (upstream maintainer)

---

## Requirements Reference

This submission aims to meet all requirements documented at:
- **Flathub Requirements:** https://docs.flathub.org/docs/for-app-authors/requirements
- **Previous PR (reference):** https://github.com/flathub/flathub/pull/7476

---

## Submission Checklist

| Requirement | Status | Notes |
|-------------|--------|-------|
| Build from source | ✅ | TypeScript compiled during build |
| Runtime 24.08 | ✅ | Not EOL |
| Socket: wayland + fallback-x11 | ✅ | Not both x11 and wayland |
| Desktop/metainfo upstream | ✅ | In this repo, not in PR |
| Screenshot URL immutable | ✅ | Uses versioned tag URL |
| Both architectures | ✅ | x86_64 and aarch64 |
| License file installed | ✅ | To /app/share/licenses/ |
| Unofficial disclaimer | ✅ | First `<p>` in metainfo |
| App ID uses code hosting | ✅ | `io.github.apotenza92.messenger` |

---

## Test Build

```bash
# Install dependencies
flatpak install --user flathub org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08 \
  org.freedesktop.Sdk.Extension.node20//24.08 org.electronjs.Electron2.BaseApp//24.08

# Generate npm sources (required for offline build)
pip install flatpak-node-generator
flatpak-node-generator npm package-lock.json -o generated-sources.json

# Build and install
flatpak-builder --user --install --force-clean build-dir io.github.apotenza92.messenger.yml

# Run
flatpak run io.github.apotenza92.messenger
```

---

## Files for Flathub PR

Only submit to flathub/flathub repo:
1. `io.github.apotenza92.messenger.yml` - the manifest
2. `generated-sources.json` - npm dependencies for offline build

**Do NOT submit** (these are in upstream repo):
- `io.github.apotenza92.messenger.desktop`
- `io.github.apotenza92.messenger.metainfo.xml`

---

## Native Functionality (Why not a PWA)

| Feature | Why Native |
|---------|------------|
| System Tray | Background operation with context menu — no Web API |
| Dock Badge | Native badge count on macOS/Windows — works in all browsers |
| Auto-focus on Call | Focus window on incoming call — browsers block this |
| Notifications | Custom filtering, mute detection — beyond Web Notification API |

---

## Trademark Compliance

- **App ID:** `io.github.apotenza92.messenger` — code hosting prefix
- **App Name:** "Messenger" — generic term
- **Icon:** Custom design, distinct from Meta branding
- **Disclaimer:** First paragraph states "community package, not officially supported by Meta"
