# Keyboard Shortcuts & Command Palette

## Feature Requirements

1. **Chat Navigation Shortcuts**
   - Cmd/Ctrl + 1-9 → Jump to numbered chat in sidebar
   - Cmd/Ctrl + Shift + [ → Previous chat
   - Cmd/Ctrl + Shift + ] → Next chat

2. **Keyboard Shortcuts Help**
   - Menu item "Keyboard Shortcuts"
   - Cmd/Ctrl + ? → Display shortcuts overlay

3. **Command Palette**
   - Cmd/Ctrl + Shift + P → Open palette
   - Search contacts by name/nickname with fuzzy matching
   - Enter/click opens that chat

## Architecture Plan

- **Keyboard events**: Captured in `notifications-inject.ts` (runs in page context)
- **IPC for commands**: Add channels in `preload.ts` + handlers in `main.ts`
- **Command palette UI**: Inject floating DOM element via `notifications-inject.ts`
- **Shortcuts overlay**: Inject as DOM overlay OR use Electron dialog

## Tasks

- [x] Task 1: Add keyboard event listener in notifications-inject.ts for shortcuts
- [~] Task 2: Add IPC channels for keyboard commands (not needed - handled in page context)
- [x] Task 3: Implement chat navigation (jump to nth, prev/next) in inject script
- [x] Task 4: Create shortcuts help overlay UI (injected DOM)
- [x] Task 5: Create command palette UI with fuzzy search
- [x] Task 6: Add "Keyboard Shortcuts" menu item in main.ts menus (macOS + Win/Linux)
- [x] Task 7: Build and typecheck
