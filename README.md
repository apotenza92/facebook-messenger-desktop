# Facebook Messenger Desktop

<img src="assets/icons/icon-rounded.png" alt="Facebook Messenger Desktop icon" width="128" />

A self-contained desktop application for Facebook Messenger, built with Electron. Wraps messenger.com with native platform notifications and badge counts.

This project exists because the original Facebook Desktop Messenger app was deprecated, so I built a maintained replacement for a native-like experience.

## Installation

### macOS (Homebrew) (Signed and notarized)

```bash
brew install --cask apotenza92/tap/facebook-messenger-desktop
```

### Windows (WinGet) (Pending approval)

```bash
winget install apotenza92.FacebookMessengerDesktop
```

### Direct Download

| Platform | Download |
|----------|----------|
| **macOS (Apple Silicon) (Signed and notarized)** | [Download](https://github.com/apotenza92/facebook-messenger-desktop/releases/latest/download/Messenger-macos-arm64.zip) |
| **macOS (Intel) (Signed and notarized)** | [Download](https://github.com/apotenza92/facebook-messenger-desktop/releases/latest/download/Messenger-macos-x64.zip) |
| **Windows (x64)** | [Download](https://github.com/apotenza92/facebook-messenger-desktop/releases/latest/download/Messenger-windows-x64-setup.exe) |
| **Windows (ARM)** | [Download](https://github.com/apotenza92/facebook-messenger-desktop/releases/latest/download/Messenger-windows-arm64-setup.exe) |
| **Linux** | [Download](https://github.com/apotenza92/facebook-messenger-desktop/releases/latest/download/Messenger-linux.AppImage) |

## Development

**Prerequisites:** Node.js 18+ and npm

1. Install dependencies:
```bash
npm install
```

2. Generate icons (first time only):
```bash
npm run generate-icons
```

3. Run the app:
```bash
npm start
```
