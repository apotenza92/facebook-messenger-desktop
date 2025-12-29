# Facebook Messenger Desktop

A self-contained desktop application for Facebook Messenger, built with Electron. Wraps messenger.com with native platform notifications and badge counts.

## Installation

Download the latest release from the [Releases](https://github.com/apotenza92/FacebookMessengerDesktop/releases) page:
- **macOS**: `.dmg` file
- **Windows**: `.exe` installer
- **Linux**: `.AppImage` (portable, works on all distributions)

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