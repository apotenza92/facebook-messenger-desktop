# Implement Keyboard Shortcuts & Command Palette

## Feature 1: Chat Navigation Shortcuts

### Keyboard Shortcuts
- **Cmd/Ctrl + 1, 2, 3, 4...** → Jump to that numbered chat in sidebar
- **Cmd/Ctrl + Shift + [** → Go to previous chat in sidebar
- **Cmd/Ctrl + Shift + ]** → Go to next chat in sidebar

### Cross-Platform
- macOS: Use Cmd key
- Windows/Linux: Use Ctrl key

## Feature 2: Keyboard Shortcuts Help

### Menu Item
- Add "Keyboard Shortcuts" to app menu that shows all available shortcuts

### Global Shortcut
- **Cmd/Ctrl + ?** → Display keyboard shortcuts overlay/dialog

### Content
- Show all available shortcuts organized by category
- Easy to dismiss

## Feature 3: Command Palette

### Trigger
- **Cmd/Ctrl + Shift + P** → Open command palette

### UI
- Small overlay window on top of the messenger UI
- Text input field to search

### Search Functionality
- Search contacts from sidebar by real name or nickname
- Fuzzy matching preferred for UX
- Display matching contacts with avatar or name
- Click or Enter to open the chat with that contact

### Example
- User types "john" → shows all contacts with "john" in name/nickname
- User selects one → opens that conversation

## Implementation Notes
- Sidebar already contains all chat data - extract/index for search
- Need to capture keyboard events globally (preload script)
- Command palette should be a floating component over main UI
- Maintain consistent styling with the app

## Success Criteria
✓ All keyboard shortcuts work on macOS and Windows/Linux
✓ Shortcuts integrate cleanly with existing UI
✓ Command palette functional with search working
✓ Menu shows keyboard shortcuts
✓ Cmd/Ctrl ? displays help overlay
✓ Build passes, no errors
