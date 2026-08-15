import type { Context } from "@deepseek-ai/cordis";
import { Config as RawConfig } from "./config";
import { defaultResolver } from "./resolver";
import { detectCodex, invokeProcess, unavailableError } from "./status";
import { defaultBackend } from "./backend";
import { InMemoryTaskStore } from "./store";
import { TaskManager } from "./task-manager";
import { createTools } from "./tools";

/**
 * DSH ↔ Codex collaboration plugin.
 *
 * Named exports only (`name`, `inject`, `Config`, `apply`) — no default export.
 * Config validated with Schemastery. All external processes (codex child) and
 * subscriptions are owned by `ctx.effect` and torn down on plugin dispose.
 */
export const name = "dsh-codex-collab";
export const inject: string[] = ["tools"];

/** Value: Schemastery config schema. */
export const Config = RawConfig;
/** Type: resolved plugin config. */
export type Config = ReturnType<typeof RawConfig>;

export function apply(ctx: Context, config: Config): void {
  const resolver = defaultResolver(config.codexCommand);

  // Effect owns the full lifecycle: resolve → probe → backend → store →
  // manager → register tools; disposal closes the backend and unregisters.
  ctx.effect(async () => {
    const resolved = await resolver.resolve();
    const probe = await detectCodex(resolved.executable, resolved.candidates, resolved.failures, invokeProcess, config.statusCommandTimeoutMs);
    const selection = defaultBackend(
      config,
      probe.codexAvailable ? resolved.executable : undefined,
      probe.codexAvailable ? undefined : unavailableError(probe).message,
    );
    const store = new InMemoryTaskStore();
    const manager = new TaskManager({
      backendKind: selection.kind,
      backend: selection.backend,
      store,
    });
    const tools = createTools(manager, () => probe);

    const disposers = [
      ctx.tools.register(tools.status),
      ctx.tools.register(tools.taskStart),
      ctx.tools.register(tools.taskReply),
    ];

    return async () => {
      for (const d of disposers) d();
      await manager.close();
    };
  });
}
