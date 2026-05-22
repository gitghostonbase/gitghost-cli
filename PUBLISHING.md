# Publishing @gitghost/cli to npm

Step-by-step guide to publish the CLI. Follow in order.

## 0 · One-time prerequisites

Status: ✅ npm account exists (`git-ghost`), ✅ org `gitghost` exists, ✅ logged in.

### 0.1 · Account

```bash
npm whoami
# should print your handle (e.g. git-ghost)
```

If not logged in:

```bash
npm login
# username, password, email, OTP 2FA
```

### 0.2 · 2FA enabled

Settings → Account → Two-Factor Authentication. npm requires 2FA for publish.

### 0.3 · Org membership

The package is `@gitghost/cli`. Owner: org `gitghost`. Confirm membership:

```bash
npm org ls gitghost
# you should be listed as owner or developer
```

## 1 · Pre-publish checklist

Run from `cli/`:

```bash
# 1. clean rebuild
Remove-Item -LiteralPath dist -Recurse -Force   # PowerShell
# or: rm -rf dist/                              # bash
npm run build

# 2. preview the tarball — make sure no secrets/junk leaked in
npm pack --dry-run
# expected: ~16-18 kB, 15 files, all under dist/ + LICENSE + README + package.json

# 3. local smoke test
npm pack
npm install -g .\gitghost-cli-0.1.0.tgz   # PowerShell
# or: npm install -g ./gitghost-cli-0.1.0.tgz
gitghost --version          # should print 0.1.0
gitghost --help             # should show banner + commands
npm uninstall -g @gitghost/cli
Remove-Item .\gitghost-cli-0.1.0.tgz      # PowerShell
# or: rm gitghost-cli-0.1.0.tgz
```

## 2 · Publish

```bash
cd cli
npm publish
# npm prompts for OTP — enter your 2FA code
```

Expected output:

```
npm notice publishing to https://registry.npmjs.org/ with tag latest and public access
+ @gitghost/cli@0.1.0
```

If you get `403 Forbidden` on the first publish:

- You're not a member/owner of the `gitghost` org → check `npm org ls gitghost`
- 2FA not enabled on your account
- Email not verified

## 3 · Verify

```bash
# install from the live registry
npx @gitghost/cli@0.1.0 --version

# or globally
npm install -g @gitghost/cli
gitghost --version
```

Public package page: https://www.npmjs.com/package/@gitghost/cli
Org page: https://www.npmjs.com/org/gitghost

## 4 · Post-publish

### 4.1 · Verify the install.sh on prod

The site has the installer at `https://gitghost.org/install.sh`. Smoke test:

```bash
curl -fsSL https://gitghost.org/install.sh | sh
gitghost --version
```

### 4.2 · Tag the release in git

```bash
cd ..  # back to repo root
git tag -a cli-v0.1.0 -m "cli 0.1.0 — first npm publish"
git push origin cli-v0.1.0
```

## 5 · Future versions

```bash
# bump version (semver: patch/minor/major)
cd cli
npm version patch     # 0.1.0 → 0.2.1
# or:
npm version minor     # 0.1.0 → 0.3.0
# this also git-commits and git-tags

# publish
npm publish

# push
git push --follow-tags
```

`prepublishOnly` in package.json automatically rebuilds before publish,
so you can't accidentally ship stale dist files.

## Common gotchas

| Symptom | Fix |
|---|---|
| `403 Forbidden — must enable 2FA` | Settings → 2FA on npmjs.com |
| `403 — not authorized to publish` | Not a member of `gitghost` org. Check `npm org ls gitghost` |
| `402 Payment Required` | Scoped private packages need a paid plan; we publish public, so `publishConfig.access = "public"` is set in package.json |
| Stale dist after pub | `prepublishOnly` runs `npm run build` — if build itself is stale, force it: `Remove-Item dist -Recurse -Force; npm run build; npm publish` |
| Want to test locally without publishing | `npm pack` → `npm install -g ./<tarball>.tgz` |
| Want to UN-publish | `npm unpublish @gitghost/cli@0.1.0` works **only within 72 hours** of publishing |
