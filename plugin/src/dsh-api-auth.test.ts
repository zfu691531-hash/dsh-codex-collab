import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DshApiClient, DshApiError } from "./dsh-api";

const ENV_NAMES = ["DSH_AUTH_TOKEN", "DSH_AUTH_URL_FILE", "DSH_HOME"] as const;

async function withAuthEnv(values: Partial<Record<(typeof ENV_NAMES)[number], string>>, action: () => Promise<void>): Promise<void> {
  const previous = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
  try {
    for (const name of ENV_NAMES) {
      if (values[name] === undefined) delete process.env[name];
      else process.env[name] = values[name];
    }
    await action();
  } finally {
    for (const name of ENV_NAMES) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function rpcSuccess(input: RequestInfo | URL, init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body)) as { rpcId: string };
  assert.equal(new URL(String(input)).pathname, "/api/session.list");
  return Response.json({
    type: "server-response",
    rpcId: body.rpcId,
    result: { ok: true, value: { items: [] } },
  });
}

test("exchanges a tokenized URL for an in-memory cookie and cleans API URLs", async () => {
  await withAuthEnv({ DSH_AUTH_TOKEN: "explicit-token", DSH_AUTH_URL_FILE: "missing-auth-url.txt" }, async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new DshApiClient({
      baseUrl: "http://127.0.0.1:43123/?token=url-token",
      fetcher: async (input, init) => {
        requests.push({ url: String(input), init });
        if (init?.method === "GET") {
          assert.equal(new URL(String(input)).searchParams.get("token"), "explicit-token");
          return new Response(null, {
            status: 303,
            headers: { location: "/", "set-cookie": "dsh-auth-hash=memory-cookie; Path=/; HttpOnly" },
          });
        }
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("cookie"), "dsh-auth-hash=memory-cookie");
        return rpcSuccess(input, init);
      },
    });

    await client.listSessions();
    assert.deepEqual(requests.map(({ url }) => url), [
      "http://127.0.0.1:43123/?token=explicit-token",
      "http://127.0.0.1:43123/api/session.list",
    ]);
    assert.equal(String(requests[1]?.init?.body).includes("url-token"), false);
  });
});

test("allows an old unauthenticated host when the default auth file is absent", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-auth-old-host-"));
  try {
    await withAuthEnv({ DSH_HOME: home }, async () => {
      let calls = 0;
      const client = new DshApiClient({
        baseUrl: "http://localhost:43124",
        fetcher: async (input, init) => {
          calls += 1;
          assert.equal(init?.method, "POST");
          return rpcSuccess(input, init);
        },
      });
      await client.listSessions();
      assert.equal(calls, 1);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reports missing explicit credentials and unauthenticated 401s without secrets", async () => {
  await withAuthEnv({ DSH_AUTH_URL_FILE: "definitely-missing-auth-url.txt" }, async () => {
    const client = new DshApiClient({ baseUrl: "http://127.0.0.1:43125" });
    await assert.rejects(client.listSessions(), (error: unknown) => {
      return error instanceof DshApiError && error.code === "DSH_AUTH_CONFIG_ERROR" && !error.message.includes("definitely");
    });
  });

  const home = await mkdtemp(join(tmpdir(), "dsh-auth-required-"));
  try {
    await withAuthEnv({ DSH_HOME: home }, async () => {
      const secret = "network-secret-token";
      const client = new DshApiClient({
        baseUrl: "http://127.0.0.1:43126",
        fetcher: async (_input, init) => {
          assert.equal(init?.method, "POST");
          return new Response("unauthorized", { status: 401 });
        },
      });
      await assert.rejects(client.listSessions(), (error: unknown) => {
        return error instanceof DshApiError &&
          error.code === "DSH_AUTH_REQUIRED" &&
          error.message.includes("~/.dsh/dsh-codex-collab/auth-url.txt") &&
          !error.message.includes(secret);
      });
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rejects credential-bearing redirects and never exposes a token from network errors", async () => {
  const secret = "redirect-secret-token";
  await withAuthEnv({ DSH_AUTH_TOKEN: secret }, async () => {
    const rejectedClient = new DshApiClient({
      baseUrl: "http://127.0.0.1:43127",
      fetcher: async (_input, init) => {
        assert.equal(init?.method, "GET");
        return new Response("unauthorized", { status: 401 });
      },
    });
    await assert.rejects(rejectedClient.listSessions(), (error: unknown) => {
      return error instanceof DshApiError && error.code === "DSH_AUTH_FAILED" && !error.message.includes(secret);
    });

    const redirectClient = new DshApiClient({
      baseUrl: "http://127.0.0.1:43127",
      fetcher: async (_input, init) => {
        assert.equal(init?.redirect, "manual");
        return new Response(null, { status: 303, headers: { location: `/?token=${secret}` } });
      },
    });
    await assert.rejects(redirectClient.listSessions(), (error: unknown) => {
      return error instanceof DshApiError && error.code === "DSH_AUTH_FAILED" && !error.message.includes(secret);
    });

    const networkClient = new DshApiClient({
      baseUrl: "http://127.0.0.1:43128",
      fetcher: async (input) => {
        throw new Error(`request failed for ${String(input)}`);
      },
    });
    await assert.rejects(networkClient.listSessions(), (error: unknown) => {
      return error instanceof DshApiError && error.code === "DSH_AUTH_UNAVAILABLE" && !error.message.includes(secret);
    });
  });
});

test("refreshes a changed auth file only after a 401 and rejects an origin mismatch", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-auth-refresh-"));
  try {
    const authDirectory = join(home, "dsh-codex-collab");
    const authFile = join(authDirectory, "auth-url.txt");
    await (await import("node:fs/promises")).mkdir(authDirectory, { recursive: true });
    await writeFile(authFile, "http://127.0.0.1:43129/?token=first-token\n", "utf8");

    await withAuthEnv({ DSH_HOME: home }, async () => {
      const mismatchFile = join(home, "wrong-origin.txt");
      await writeFile(mismatchFile, "http://127.0.0.1:43130/?token=wrong-origin-token\n", "utf8");
      await withAuthEnv({ DSH_AUTH_URL_FILE: mismatchFile }, async () => {
        const mismatchClient = new DshApiClient({ baseUrl: "http://127.0.0.1:43129" });
        await assert.rejects(mismatchClient.listSessions(), (error: unknown) => {
          return error instanceof DshApiError && error.code === "DSH_AUTH_CONFIG_ERROR" && !error.message.includes("wrong-origin-token");
        });
      });

      let postCount = 0;
      const seenTokens: string[] = [];
      const client = new DshApiClient({
        baseUrl: "http://127.0.0.1:43129",
        fetcher: async (input, init) => {
          const url = new URL(String(input));
          if (init?.method === "GET") {
            seenTokens.push(url.searchParams.get("token") ?? "");
            const cookie = seenTokens.length === 1 ? "dsh-auth-old=stale" : "dsh-auth-new=fresh";
            return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `${cookie}; Path=/` } });
          }
          postCount += 1;
          if (postCount === 1) {
            await writeFile(authFile, "http://127.0.0.1:43129/?token=refreshed-token\n", "utf8");
            return new Response("expired", { status: 401 });
          }
          return rpcSuccess(input, init);
        },
      });
      await client.listSessions();
      assert.deepEqual(seenTokens, ["first-token", "refreshed-token"]);
      assert.equal(postCount, 2);
      assert.equal((await readFile(authFile, "utf8")).includes("refreshed-token"), true);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("coalesces concurrent token exchanges into one request", async () => {
  await withAuthEnv({ DSH_AUTH_TOKEN: "concurrent-token" }, async () => {
    let exchanges = 0;
    const client = new DshApiClient({
      baseUrl: "http://127.0.0.1:43131",
      fetcher: async (input, init) => {
        if (init?.method === "GET") {
          exchanges += 1;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          return new Response(null, { status: 303, headers: { location: "/", "set-cookie": "dsh-auth-concurrent=cookie" } });
        }
        return rpcSuccess(input, init);
      },
    });
    await Promise.all([client.listSessions(), client.listSessions(), client.listSessions()]);
    assert.equal(exchanges, 1);
  });
});
