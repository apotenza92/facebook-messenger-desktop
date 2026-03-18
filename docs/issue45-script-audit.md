# Issue #45 script inventory

Last updated: 2026-03-16

This is the cleaned post-consolidation inventory for Issue #45.

## Canonical scripts

### Real live capture / repro

- `scripts/test-issue45-live-types-symmetry-gui.js`
  - package scripts:
    - `npm run test:issue45:live:types:gui`
    - `npm run test:issue45:live:scan:gui`
  - use targeted mode when you pass thread/media args
  - use discovery mode when you do not pass thread/media args

### Real resize checks

- `scripts/test-issue45-real-resize-gui.js`
  - package script:
    - `npm run test:issue45:real:resize:gui`
  - modes:
    - `--mode direct`
    - `--mode click-flow`

### Real media-history discovery helper

- `scripts/scan-issue45-media-history-gui.js`
  - package script:
    - `npm run test:issue45:media-history:gui`

### Real focused regression checks

- `scripts/test-issue45-close-return-gui.js`
- `scripts/test-issue45-thread-open-close-extensive-gui.js`
- `scripts/capture-real-e2ee-same-route-gui.js`
- `scripts/find-e2ee-media-target-gui.js`

## Deleted during consolidation

These were removed instead of being kept as wrappers:

- `scripts/capture-issue45-live-media-gui.js`
- `scripts/capture-issue45-media-buttons-gui.js`
- `scripts/test-issue45-media-buttons-gui.js`
- `scripts/scan-issue45-live-media-types-gui.js`
- `scripts/capture-issue45-live-real-resize-gui.js`
- `scripts/capture-issue45-real-flow-resize-gui.js`
- `scripts/archive/issue45/`
- `scripts/test-issue45-gui.js`
- `scripts/test-issue45-route-types-fixture-gui.js`
- `scripts/test-issue45-buttons-resize-gui.js`
- `scripts/capture-issue45-e2ee-same-route-gui.js`

## Package scripts kept

- `test:issue45:gui`
- `test:issue45:buttons:gui`
- `test:issue45:buttons:resize:gui`
- `test:issue45:live:scan:gui`
- `test:issue45:live:types:gui`
- `test:issue45:media-history:gui`
- `test:issue45:real:resize:gui`
- `test:issue45:close:return:gui`
- `test:issue45:e2ee:same-route:gui`
- `test:issue45:e2ee:same-route:current:gui`
- `test:issue45:thread:extensive:gui`

## Removed package scripts

- `test:issue45:capture:gui`
- `test:issue45:live:capture:gui`
- `test:issue45:real:flow:resize:gui`
- `test:issue45:types:fixture:gui`
- `test:issue45:e2ee:same-route:before:gui`

## Mental model

- use `test:issue45:live:types:gui` for real live targeted captures
- use `test:issue45:live:scan:gui` for broad discovery via the same maintained harness
- use `test:issue45:real:resize:gui` for real resize checks, switching modes as needed
- use `capture-real-e2ee-same-route-gui.js` for real same-route E2EE before/after checks
- use `find-e2ee-media-target-gui.js` to discover a real E2EE attachment target before capture
- do not rely on synthetic fixture windows for Issue #45 anymore
