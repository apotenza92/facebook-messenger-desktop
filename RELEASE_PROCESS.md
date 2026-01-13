# Release Process

## ⚠️ CRITICAL: Release Tag Policy

**NEVER create or push version tags (v*) without explicit user permission.**

### Why This Matters
- Tags trigger automatic production releases via GitHub Actions
- Releases are distributed to all users across multiple platforms
- Releases cannot be easily undone once published

### The Rule
**Before creating ANY version tag:**
1. ✅ Get explicit approval from repository owner
2. ✅ Confirm CHANGELOG.md is updated
3. ✅ Confirm package.json version matches
4. ✅ Confirm all tests pass
5. ✅ Get final "go ahead" before pushing tag

## Release Checklist

### Pre-Release (Development)
- [ ] Code changes completed and tested
- [ ] Update `CHANGELOG.md` with version and changes
- [ ] Update `package.json` version number
- [ ] Commit changes with descriptive message
- [ ] Push changes to `main` branch
- [ ] **STOP HERE - DO NOT CREATE TAGS YET**

### Release Creation (WITH PERMISSION ONLY)
- [ ] **Ask user: "Should I create the release tag for vX.Y.Z now?"**
- [ ] Wait for explicit confirmation
- [ ] Only after approval: `git tag vX.Y.Z`
- [ ] Only after approval: `git push origin vX.Y.Z`
- [ ] Monitor GitHub Actions for build status
- [ ] Verify release artifacts are created

### Post-Release
- [ ] Verify release appears on GitHub releases page
- [ ] Test download links work
- [ ] Monitor for user reports of issues

## Emergency Procedures

### If Tag Was Created By Mistake
```bash
# Delete local tag
git tag -d vX.Y.Z

# Delete remote tag
git push origin :refs/tags/vX.Y.Z

# Delete GitHub release (if created)
gh release delete vX.Y.Z --yes
```

### If Release Build Failed
- Check GitHub Actions logs
- Fix issues
- Delete and recreate tag (with permission)

## Commands Reference

### Safe Development Workflow
```bash
# Make changes
git add .
git commit -m "fix: description"
git push origin main
# STOP - No tags yet
```

### Release Workflow (WITH PERMISSION)
```bash
# After getting explicit permission:
git tag vX.Y.Z
git push origin vX.Y.Z

# Monitor build
gh run list --workflow=release.yml --limit 1
```

## GitHub Actions Trigger

The `.github/workflows/release.yml` is triggered by:
- **Push tags matching `v*`** ← This is what triggers releases
- Manual workflow dispatch

**Be extremely careful with tags starting with `v`**

## Remember
🚫 **NEVER push version tags without explicit permission**
✅ **ALWAYS ask first: "Should I create the release tag now?"**
⏸️ **WAIT for confirmation before pushing tags**

---

*This policy exists to prevent accidental production releases.*
