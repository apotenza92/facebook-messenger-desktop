# Messenger update trust

`root.json` is the reviewed public trust anchor for Windows and AppImage
update metadata. Its SHA-256 digest is:

`6656f0dee4d52eb8d9c6e37c3799c4db39a90159edf185bff08018dc16d4be8a`

The root private key is offline in 1Password and must never be uploaded to
GitHub. The targets, snapshot, and timestamp keys are separately scoped to the
protected `update-signing` environment. Root rotation requires an explicitly
reviewed, sequentially versioned root and must not overwrite a newer root
already persisted in an installed application's user-data directory.
