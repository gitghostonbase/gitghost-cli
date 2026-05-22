# @gitghost/cli

> ship code, leave no trace.

Anonymous git commits via linkable ring signatures (LSAG over secp256k1).
Sign as one of N declared contributors. Verifiers can prove the commit came
from your trusted set, but cannot tell which member signed.

## install

### one-line installer (recommended)

```bash
curl -fsSL https://gitghost.org/install.sh | sh
```

### npm

```bash
npm install -g @gitghost/cli
```

### no install (npx)

```bash
npx @gitghost/cli init my-team
npx @gitghost/cli ring add torvalds
npx @gitghost/cli commit -m "fix: critical CVE"
```

requires Node 18 or newer.

## quick start

```bash
# inside any git repo
gitghost init linux-kernel-core         # bootstrap .gitghost/ + identity

# build the ring (pulls keys from github.com/<user>.keys)
gitghost ring add-self                  # add your local pubkey
gitghost ring add torvalds              # 1 of 4
gitghost ring add gregkh                # 2 of 4
gitghost ring add bagder                # 3 of 4
gitghost ring add dhh                   # 4 of 4

gitghost ring list                      # inspect the ring root + members

# sign and ship
git add -A
gitghost commit -m "fix: critical CVE-2026-XXXX"

# verify
gitghost verify <sha>
```

## what gets written to your commit

A real RFC-5322 trailer block — picked up by any git host or tooling
that understands trailers, with no fork or extension required:

```
fix: critical CVE-2026-XXXX

Ghost-Ring: linux-kernel-core (4 members)
Ghost-Ring-Root: bafkreih7q2zi73p9aplc4eov3iqbjnmhrhuw5kbphr2kk7v2v3iq6q3aaa
Ghost-Key-Image: 02a1b2c3d4e5f6...
Ghost-Signature: lsag1.<c0>.<s_concat>.<keyImage>
```

Inspect with standard `git interpret-trailers`. Verify the same commit in
the browser at [gitghost.org/verify](https://gitghost.org/verify) — same
math, same result.

## commands

```
gitghost init [ring-name]            # bootstrap .gitghost/ in this repo
gitghost ring add <github-username>  # pull keys from github.com/<user>.keys
gitghost ring add-self               # add your local identity to the ring
gitghost ring remove <github>        # remove a member
gitghost ring list                   # print members + ring root
gitghost commit -m <message>         # sign + commit
gitghost commit -m <msg> --anchor    # sign + commit + anchor on Base
gitghost verify <commit-sha>         # parse trailers + verify LSAG
gitghost anchor [commit-sha]         # anchor (or list) an anchored commit
gitghost --help                      # full help
```

## what's in .gitghost

```
.gitghost/
├─ identity.json   secp256k1 keypair (NEVER commit — auto-gitignored)
├─ ring.json       ring config: name, context, members
└─ anchors.json    local index of anchored commits
```

`identity.json` is auto-gitignored on `init`. The ring config and anchor
log SHOULD be committed so verifiers and collaborators can re-run
`gitghost verify` against the same ring.

## how it works

- **LSAG** (Liu, Wei, Wong 2004) — linkable spontaneous anonymous group
  signature scheme. 1-out-of-N indistinguishability with a stable key
  image per (signer, ring) pair for sybil resistance.
- **secp256k1** — same curve as Bitcoin and Ethereum, well-tested.
- **Key image** — `I = sk * H_p(pk || ctx)`, deterministic per signer
  inside a ring. Same signer → same key image → reuse-detectable, but
  identity remains hidden.

References:

- [Liu, Wei, Wong (2004) — IACR ePrint 2004/027](https://eprint.iacr.org/2004/027)
- [git-ring by rot256](https://rot256.dev/post/git-ring/)
- [gitghost.org/docs](https://gitghost.org/docs) — full technical walkthrough

## security

- The CLI never makes network calls during `commit` or `verify`. The
  cryptography is fully local.
- `ring add <user>` does fetch `github.com/<user>.keys` to derive a
  deterministic ghost public key. This is the only outbound network
  call in normal use.
- `identity.json` holds your secret key. Treat it like `~/.ssh/id_rsa`:
  do not commit, do not share. On Windows, lock the file ACL down with
  `icacls .gitghost\identity.json /inheritance:r /grant:r %USERNAME%:F`.

## uninstall

```bash
npm uninstall -g @gitghost/cli
```

## license

MIT.

