# Collaboration message envelope

Collaboration is the product outcome; transport is only the mechanism. A task
message is therefore not modeled as one disposable string.

```ts
interface CollaborationMessage {
  text: string
  references?: Array<{ uri: string; title?: string; mediaType?: string }>
  artifacts?: Array<{ path: string; name?: string; mediaType?: string }>
}
```

## Local transport

DSH currently accepts native `text` and `image` prompt blocks. The verified
Codex MCP tools accept `prompt` text. Neither side has a common native block for
URLs, PDFs, or general files.

The bridge therefore keeps two representations:

1. a structured receipt returned by the collaboration tool, preserving the
   exact text, URL metadata, and local artifact metadata;
2. a deterministic prompt projection containing a readable list and JSON
   manifest for the receiving agent.

HTTP(S) URLs embedded only in message text are automatically promoted into
structured references. Explicit `references` entries are merged by URI and can
enrich an inferred link with a title or media type. This makes link preservation
the bridge's responsibility rather than a convention every agent must remember.

Local artifacts are zero-copy. The bridge sends the absolute path, media type,
size, modification time, and availability. It does not upload or duplicate the
file. PDFs infer `application/pdf` when no media type is supplied.

## Recovery semantics

- Damaged core text produces a successful tool outcome with
  `state: needs-clarification`, `recoverable: true`, and
  `action: ask-sender-and-retry`. No damaged task is executed.
- A damaged new-task message creates no DSH session or Codex thread.
- A damaged reply leaves the existing task/session/thread unchanged.
- One invalid URL or missing artifact does not discard valid text or sibling
  inputs. The receiver continues with available inputs and is explicitly told
  to ask the collaborator for the missing item.
- A corrected message is retried through the same start/reply tool. No special
  recovery endpoint is required.

This envelope is intentionally close to future A2A Message/Artifact semantics,
while remaining compatible with today's local prompt-only backends.
