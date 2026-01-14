# Download Page

This folder contains the download page for Facebook Messenger Desktop, hosted at:

**https://apotenza92.github.io/facebook-messenger-desktop/**

## How It Gets Updated

The page is served via **GitHub Pages** from the `main` branch `/docs` folder.

### Automatic Updates

Any changes pushed to `main` that modify files in `/docs` will automatically trigger a GitHub Pages rebuild. The update typically completes within 1-2 minutes.

### Manual Trigger

If needed, you can manually trigger a Pages rebuild:

```bash
# Request a new build
gh api -X POST repos/apotenza92/facebook-messenger-desktop/pages/builds

# Check build status
gh api repos/apotenza92/facebook-messenger-desktop/pages/builds --jq '.[0]'
```

### Verifying Updates

1. Check the latest build status:
   ```bash
   gh api repos/apotenza92/facebook-messenger-desktop/pages/builds --jq '.[0] | {status, created_at}'
   ```

2. Visit the page and hard-refresh (Cmd+Shift+R / Ctrl+Shift+R) to bypass cache.

## Files

- `index.html` - Main download page with platform detection and release channel switching
- `.nojekyll` - Prevents Jekyll processing (allows files starting with `_`)
- `flatpak/` - Flatpak repository files
