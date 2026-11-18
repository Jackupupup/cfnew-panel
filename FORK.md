# Fork maintenance

This repository is a fork of [byJoey/cfnew-panel](https://github.com/byJoey/cfnew-panel). The panel source, license, and authorship stay with that project. The local change is the Loon VLESS credential line.

Loon's node manual writes VLESS as `protocol, server, port, "<uuid>"`, then named fields such as `transport`, `path`, `host`, and `over-tls` ([node manual](https://nsloon.bid/document/node)). `username=<uuid>` is not read as the VLESS credential. This fork emits the quoted UUID immediately after the port and keeps `udp=true`, `path=/?ed=2048`, host, SNI, and the TLS / non-TLS flags. Protocol case stays `vless`. Trojan and the other subscription formats are not rewritten.

`scripts/repair-loon-vless.mjs` reapplies that edit. It changes nothing when the positional UUID is already present, and it stops when the serializer no longer matches that one line.

## Upstream sync

`.github/workflows/sync-upstream.yml` polls `byJoey/cfnew-panel` `main` every hour at minute 17, and it can be run with `workflow_dispatch`. It is not an upstream webhook. A new upstream commit is normally picked up within about an hour, and GitHub may start the scheduled run later when Actions is busy.

Scheduled workflows on a fork do not run by themselves. After this file is on the fork's default branch:

1. Open the Actions tab and enable workflows if GitHub has them turned off.
2. Enable **Sync upstream** so the hourly schedule is allowed. Until then, use **Run workflow**.
3. Add no secrets. The workflow uses the built-in `GITHUB_TOKEN` only.

GitHub also disables scheduled workflows after about 60 days without a repository activity that it counts.

### What the two jobs do

The workflow grants no permissions until a job asks for them.

- **validate** has `contents: read`, checks out without stored credentials, and does not push. It merges the upstream commit in a temporary worktree, restores this fork's workflow and repair files, runs the repair, then runs `node --test`. Upstream code executes only there. The test process does not receive tokens or other secret environment variables.
- **publish** runs only after validate succeeds. It has `contents: write`. It fetches `origin/main` again, repeats the merge for the **same upstream commit** validate tested, and pushes only when the tree hash matches and `origin/main` is still the validated base. The push is fast-forward only.

A failed test, an unexpected merge conflict, a dirty tree, or a serializer the repair does not recognize fails the job. `main` is not moved. The Actions log is the diagnostic. The workflow does not open issues, comment, or send mail. Because Vercel deploys this fork's `main`, leaving `main` in place also leaves the current deployment in place. A successful sync does push `main`, and the existing Vercel connection will deploy that commit. This workflow does not call Vercel, Cloudflare, or DNS.

### What is not automatic

- Upstream files under `.github/workflows/` are not imported. The built-in `GITHUB_TOKEN` cannot be granted permission to create or update workflow files, and a push that changes those files is rejected. The sync keeps workflow files identical to the current `main`, which is a change that token can push. Editing this workflow takes a normal commit from an account that is allowed to update workflow files. Do not add a personal access token for it.
- Only `src/engine.mjs` may conflict, and the resolution is the upstream file plus this repair. Any other conflict stops the sync.
- The repair recognizes one current source shape. If upstream already writes the positional quoted UUID, it is left alone. If upstream changes the serializer into a shape the repair does not know, the run fails closed instead of guessing.
- A conflict in `src/engine.mjs` keeps the upstream copy of that file except for this credential repair. Other local edits in that file are not carried forward.
- This does not mean every upstream change is safe to publish. Tests can reject a tree, and they cannot prove that a new upstream behavior is appropriate for this deployment.

No Cloudflare, Vercel, or registry tokens are required for the sync.
