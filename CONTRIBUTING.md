# Contributing

Thanks for helping improve MuxBase.

## Prerequisites

- macOS 13 or newer for desktop development.
- Host Node.js >= 22.13; pnpm automatically downloads and checksum-pins the Node.js 24.19.0 build runtime.
- pnpm 11.22.0, selected by the repository's package-manager pin.
- tmux >= 3.7b.
- git >= 2.20.

## Development Setup

```bash
make bootstrap
```

If `pnpm` is not already available, `make bootstrap` provisions the pinned
version through Corepack when Corepack is present. After installation,
`make doctor` verifies the managed Node/pnpm pair as well as tmux and git.

For desktop development:

```bash
cd desktop
pnpm dev
```

## Validation

Use the smallest reliable check while iterating:

```bash
pnpm run lint:ci
pnpm test
cd desktop && pnpm test
```

Before opening a release-impacting PR, run the full local gate:

```bash
pnpm run release:verify
```

## Pull Requests

- Keep changes focused and easy to review.
- Add tests for critical behavior changes.
- Run the relevant validation commands before opening a PR.
- Update public docs when behavior, setup, or user-facing workflows change.
- Keep generated, local, and secret files out of commits.
- Link related issues when available and describe user-visible impact.

## Reporting Issues

Use the GitHub issue templates and include reproduction steps, expected behavior, actual behavior, OS, Node.js version, pnpm version, and tmux version when relevant.

Do not report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md).

## Maintainer Release Setup

The release workflow can run with the default `GITHUB_TOKEN`, but maintainers should configure `RELEASE_PLEASE_TOKEN` as a fine-grained token for smoother release PR checks. Signed macOS releases also require the Apple signing and notarization secrets referenced in `.github/workflows/publish.yml`.
