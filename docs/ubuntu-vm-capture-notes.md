# Ubuntu VM Capture Notes (`prlctl capture`)

These notes are for repeatable screenshot testing in Parallels Ubuntu VMs.

## Symptoms seen

- `prlctl capture` intermittently produced all-black PNGs.
- This happened more often on Ubuntu Wayland sessions.

## Working mitigation

1. Run Ubuntu in X11 (`xorg`) instead of Wayland.
2. Ensure the desktop session is unlocked before capture.
3. Wake session activity and wait a short settle period before first capture.
4. Retry multiple captures and reject tiny files that are likely black frames.

## Set Ubuntu VM to X11

Inside guest:

1. In `/etc/gdm3/custom.conf`:
   - Set `WaylandEnable=false`
2. In `/var/lib/AccountsService/users/parallels`:
   - Set `Session=ubuntu-xorg`
3. Reboot VM.

Validate:

```bash
prlctl exec "Ubuntu 24.04.3 ARM64" "loginctl show-session 2 -p Type -p Name -p State -p Active -p LockedHint"
```

Expected `Type=x11`.

## Automated reliability check

Use:

```bash
./scripts/verify-ubuntu-prlctl-capture.sh "Ubuntu 24.04.3 ARM64" "release/ubuntu-capture-check"
```

Optional env vars:

- `COUNT` (default `10`)
- `DELAY_SECONDS` (default `1`)
- `SETTLE_SECONDS` (default `5`)
- `BLACK_SIZE_THRESHOLD_BYTES` (default `20000`)

Exit codes:

- `0`: no likely-black captures
- `2`: one or more likely-black captures

## Notes

- A black frame can still appear transiently during app/compositor startup.
- In stable, settled X11 sessions, captures were consistently non-black in repeated tests.
