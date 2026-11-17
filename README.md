# github-core-clone-01-v2

[![make.fun](https://img.shields.io/badge/make.fun-github--core--clone--01-blue)](https://make.fun/bounty/github-core-clone-01)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A standalone, GitHub-compatible git forge in a single process. Node 22
standard library only — no git binary, no outside service, no UI.

## What it implements

- **Git smart HTTP** (v0 + v2 upload-pack, v0 receive-pack): clone, fetch,
  shallow clone, deepen, push, annotated tags, empty repos, non-fast-forward
  rejection with `report-status`.
- **GitHub REST API** (`/api/v3`): repos, branches, commits, contents
  (file create/update/delete with real git objects), labels, issues,
  comments, pull requests, squash/merge/rebase merge.
- **GraphQL** (`/api/graphql`): viewer, repository, issues, pull requests,
  mutations (`createIssue`, `closeIssue`, `createPullRequest`,
  `mergePullRequest`, `addComment`), `node` round-trip, introspection.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP, protocol revision
  2026-07-28, six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`).
- **Health**: `GET /healthz` → `{"status":"ok"}` (no auth).

## Run

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:PORT \
MAKEFUN_SHOP_TOKEN=<token> \
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`,
polls `$MAKEFUN_ENV_URL/done`, and exits 0 when the environment is done.

## Design notes

- One in-memory store: repos, issues, PRs, and git objects share a single
  unified object store, so contents commits are visible to `git clone`,
  `GET /commits`, and GraphQL fixtures alike.
- O(1) lookups everywhere (`Map` by owner/name, issue number, object id);
  serialized issue JSON and pack bytes are cached per repo version and
  invalidated only on mutation.
- Packs are plain objects only (no deltas), zlib-compressed per object.
- Deterministic timestamps (counter-based), so repeated runs are reproducible.

## License

MIT — see [LICENSE](LICENSE).
