# Text integrity contract

Prompt text is core task evidence. The bridge must either deliver the exact
Unicode string or ask the sender for clarification before it reaches the remote
agent. It never guesses, repairs, normalizes, silently replaces, or silently
drops text.

## Supported path

The product path is shell-independent:

```text
DSH/Codex tool arguments
  -> MCP SDK JSON over binary stdio (UTF-8)
  -> companion JavaScript string
  -> JSON HTTP body with application/json; charset=utf-8
  -> loopback Host API
```

This path works the same from Windows, macOS, and Linux and does not depend on
the active PowerShell, CMD, Bash, locale, terminal code page, or console font.

## Cooperative recovery checks

Both directions return a normal `needs-clarification` collaboration outcome
before starting the task when the prompt contains high-confidence evidence of
prior encoding loss:

- Unicode replacement character `U+FFFD`;
- an invalid lone UTF-16 surrogate;
- C1 control characters produced by a bad decode;
- four or more consecutive ASCII question marks.

The caller is instructed to ask the sender and retry. A corrupted new task
creates no session; a corrupted reply preserves the existing session. Valid
Chinese, Japanese, Arabic, accents, and emoji are preserved exactly. A normal
question such as `Really? Why??` remains valid.

References and artifacts are validated independently. One unavailable resource
does not discard intact text or sibling resources; see
[`collaboration-message.md`](collaboration-message.md).

## Shell automation

Use the MCP tool API and pass `prompt` as a string value. Do not generate a
program by piping user text through a shell and then embed that text in source
code. In particular, Windows PowerShell 5.1 can encode pipeline text using a
legacy code page before the receiving process sees it.

If a separate automation layer must accept text from a shell, that layer must
read an explicitly UTF-8 file or raw UTF-8 bytes, then call the MCP SDK with the
decoded string. The bridge cannot reconstruct characters after an upstream
program has irreversibly replaced them, so it requests the intended text and
waits for a retry instead of executing a different instruction or ending the
collaboration.

## Verification

Run:

```powershell
npm run verify
```

The transport verification starts a local fake DSH Host API and the real stdio
companion. It proves multilingual text, links, and structured receipts survive
MCP stdio and HTTP JSON exactly, then proves damaged core text becomes a
recoverable clarification without reaching the Host API.
