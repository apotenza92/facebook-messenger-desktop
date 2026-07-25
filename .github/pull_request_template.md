## Outcome

Describe the user-visible result and link the issue (`Fixes #...`) when applicable.

## Root cause and evidence

- Root cause:
- Failing regression before the fix:
- Why the fix is scoped to that boundary:

## Risk

- [ ] Low — deterministic tests/docs/contained behaviour
- [ ] Medium — notifications, calls, auth, windows, IPC, persistence, updates, dependencies, or packaging
- [ ] High — security, secrets, signing, release channels, destructive actions, or stable release

## Verification

- [ ] `npm run test:ci`
- [ ] Applicable platform packaging or GUI checks listed in `package.json`
- [ ] Live Facebook check when deterministic coverage is insufficient
- [ ] Failure artifacts contain no private data or secrets

Commands and results:

```text

```

## Public-text check

- [ ] No real names, private messages, thread/account identifiers, credentials, or unredacted logs were added to public text or artifacts.
- [ ] `CHANGELOG.md` is updated if this is user-visible and release-bound.
