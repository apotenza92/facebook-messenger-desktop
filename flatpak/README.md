# Self-hosted Flatpak Repository

This directory contains files for the self-hosted Flatpak repository.

## Setup Instructions

### 1. Generate GPG Key

Run these commands locally to generate a GPG key for signing the repository:

```bash
# Generate key (no passphrase for CI use)
gpg --batch --gen-key <<EOF
Key-Type: RSA
Key-Length: 4096
Name-Real: Messenger Desktop Flatpak
Name-Email: flatpak@messenger-desktop.local
Expire-Date: 0
%no-protection
%commit
EOF

# Export private key as base64 (add this as FLATPAK_GPG_PRIVATE_KEY secret in GitHub)
gpg --armor --export-secret-keys "Messenger Desktop Flatpak" | base64

# Export public key (save to this directory)
gpg --armor --export "Messenger Desktop Flatpak" > flatpak/flatpak-repo.gpg
```

### 2. Add GitHub Secret

1. Go to your repository Settings > Secrets and variables > Actions
2. Create a new secret named `FLATPAK_GPG_PRIVATE_KEY`
3. Paste the base64-encoded private key from the command above

### 3. Commit the Public Key

Commit the `flatpak-repo.gpg` file to this directory.

## User Installation

Users can install with:

```bash
flatpak remote-add --if-not-exists --user messenger https://apotenza92.github.io/facebook-messenger-desktop/flatpak/repo && flatpak install --user messenger com.facebook.messenger.desktop
```

## Updates

Users update via their software center or:

```bash
flatpak update
```

