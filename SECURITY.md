# Security

`dsh-codex-collab` connects two local agents that may already have permission to read files, edit files, and run commands. Installing the bridge does not grant operating-system privileges by itself, but it allows either agent to delegate work to the other within their existing permission boundaries.

## Boundaries

- The Codex companion accepts only HTTP loopback DSH endpoints.
- The bridge does not expose a public listener.
- DSH launch tokens are exchanged at the loopback root for an in-memory session cookie. Credential-bearing requests do not follow redirects. Keep `auth-url.txt` private and out of source control; refresh it after restarting DSH.
- Installer-managed Codex and DSH configuration blocks are marked and backed up before replacement.
- Interactive approval and clarification requests are not yet bridged between agents.

Review both agents' access modes before delegating sensitive work. Do not place credentials in collaboration prompts.

## Reporting

Please report suspected vulnerabilities privately through GitHub's security advisory interface for this repository. Do not include secrets or private user data in a public issue.
