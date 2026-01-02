# Facebook Messenger Desktop

<img src="assets/icons/icon-rounded.png" alt="Facebook Messenger Desktop icon" width="128" />

A self-contained desktop application for Facebook Messenger, built with Electron. Wraps messenger.com with native platform notifications and badge counts.

This project exists because the original Facebook Desktop Messenger app was deprecated, so I built a maintained replacement for a native-like experience.

<br>

<a href="https://apotenza92.github.io/facebook-messenger-desktop/">
  <img src="https://img.shields.io/badge/Download-Messenger%20Desktop-0084ff?style=for-the-badge&logo=messenger&logoColor=white" alt="Download Messenger Desktop" height="40">
</a>

*Automatically detects your platform (macOS, Windows, Linux)*

## Install via Package Manager

### macOS (Homebrew)

```bash
brew install --cask apotenza92/tap/facebook-messenger-desktop
```

### Windows (WinGet)

```bash
winget install apotenza92.FacebookMessengerDesktop
```

## Direct Downloads

| Platform | Download |
|----------|----------|
| **macOS (Apple Silicon)** | [Download](https://github.com/apotenza92/facebook-messenger-desktop/releases/latest/download/Messenger-macos-arm64.zip) |
| **macOS (Intel)** | [Download](https://github.com/apotenza92/facebook-messenger-desktop/releases/latest/download/Messenger-macos-x64.zip) |
| **Windows (x64)** | [Download](https://github.com/apotenza92/facebook-messenger-desktop/releases/latest/download/Messenger-windows-x64-setup.exe) |
| **Windows (ARM)** | [Download](https://github.com/apotenza92/facebook-messenger-desktop/releases/latest/download/Messenger-windows-arm64-setup.exe) |
| **Linux** | [Download](https://github.com/apotenza92/facebook-messenger-desktop/releases/latest/download/Messenger-linux.AppImage) |

## Development

**Prerequisites:** Node.js 18+ and npm

1. Install dependencies:
```bash
npm install
```

2. Run the app:
```bash
npm start
```
