---
name: dsh-collab
description: Use when the user asks Codex to chat, collaborate, delegate, continue work, or exchange context with DeepSeek Harness or DSH.
---

# Collaborate with DeepSeek Harness

Use the `dsh_task_*` MCP tools when the user explicitly asks to work with DSH.

- Start new DSH work with `dsh_task_start`; use `agent_preset: cordis` for plugin creation.
- Pass the current Codex workspace as `cwd` when starting DSH work so the session appears under the matching DSH workspace instead of “Ungrouped”.
- Continue the same DSH session with `dsh_task_reply` and its returned task ID.
- Use `dsh_task_status` for bounded status checks and `dsh_task_cancel` only when the user asks to stop.
- Preserve message text, structured references, and artifacts when delegating or replying.
- If a tool returns `needs-clarification`, ask the collaborator for the missing or corrupted input and retry the same operation.
- Do not invent DSH results. Report unavailable DSH or incomplete work plainly.
