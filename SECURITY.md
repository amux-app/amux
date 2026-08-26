# Security Policy

## Supported Versions

MuxBase is currently in preview. Security fixes are provided for the latest
published release. Before reporting a vulnerability, please confirm that it is
reproducible on the latest available version.

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues,
Discussions, or pull requests.

Use [GitHub Security Advisories](https://github.com/muxbase-app/muxbase/security/advisories/new)
to submit a private report. Include the following when available:

- The affected MuxBase version and macOS version.
- A clear description of the impact and affected component.
- Minimal reproduction steps or a proof of concept.
- Any known mitigations or workarounds.

Reports involving renderer-to-main IPC boundaries, filesystem containment,
Git or worktree operations, tmux command execution, marketplace installation,
or credential exposure are especially useful when they identify the exact
trust boundary involved.

We will acknowledge the report as soon as practical, investigate it privately,
and coordinate remediation and disclosure with the reporter. Please allow time
for a fix to be prepared and distributed before publishing details.
