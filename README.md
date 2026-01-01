# Facebook Messenger Desktop

<img src="assets/icons/icon.png" alt="Facebook Messenger Desktop icon" width="128" />

A self-contained desktop application for Facebook Messenger, built with Electron. Wraps messenger.com with native platform notifications and badge counts.

This project exists because the original Facebook Desktop Messenger app was deprecated, so I built a maintained replacement for a native-like experience.

## Installation

### macOS (Homebrew)

```bash
brew tap apotenza92/apps
brew install --cask messenger
```

### Manual Download

Download the latest release from the [Releases](https://github.com/apotenza92/facebook-messenger-desktop/releases) page:
- **macOS (Apple Silicon)**: `Messenger-<version>-macos-arm64.zip`
- **macOS (Intel)**: `Messenger-<version>-macos-x64.zip`
- **Windows**: `Messenger-<version>-windows-setup.exe`
- **Linux**: `Messenger-<version>-linux.AppImage`

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