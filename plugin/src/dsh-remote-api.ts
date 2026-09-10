import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { DshApiClient, DshApiError } from "./dsh-api";
import type { DshHistoryEvent } from "./dsh-task-client";

/** DSH 0.1.5 Remote API: named arguments and a snapshot from the follow stream. */
export class DshRemoteApiClient extends DshApiClient {
  override call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const endpoint = method.replace(".", "/");
    const request = method === "session.prompt" ? { ...payload, requestId: randomUUID() } : payload;
    return super.call<T>(endpoint, { args: { [method === "session.list" ? "_request" : "request"]: request } }, signal);
  }

  override async history(sessionId: string, signal?: AbortSignal): Promise<{
    events: Array<{ event: DshHistoryEvent }>;
    hasMore: boolean;
  }> {
    const headers = await this.authHeaders(signal);
    const url = new URL("/api/remote.mux", this.baseUrl);
    url.protocol = "ws:";
    const streamId = randomUUID();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers, followRedirects: false, handshakeTimeout: this.timeoutMs });
      let settled = false;
      const finish = (error?: Error, result?: { events: Array<{ event: DshHistoryEvent }>; hasMore: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (socket.readyState === WebSocket.OPEN) socket.close();
        else socket.terminate();
        if (error) reject(error);
        else resolve(result!);
      };
      const onAbort = () => finish(new DshApiError("DSH_CANCELLED", "DSH history request cancelled"));
      const timer = setTimeout(() => finish(new DshApiError("DSH_UNAVAILABLE", "DSH history snapshot timed out")), this.timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      socket.on("open", () => socket.send(JSON.stringify({
        type: "open", streamId, endpoint: "session/follow",
        payload: { args: { request: { address: { kind: "session", sessionId }, maxMessages: 32 } } },
      })));
      socket.on("message", (data) => {
        try {
          const frame = JSON.parse(data.toString());
          if (frame.streamId !== streamId) throw new Error("unexpected stream");
          if (frame.type === "error") {
            finish(new DshApiError("DSH_REMOTE_ERROR", "DSH rejected the history request"));
            return;
          }
          const snapshot = frame.value;
          if (frame.type !== "item" || snapshot?.type !== "snapshot" || !Array.isArray(snapshot.records) || typeof snapshot.hasMore !== "boolean") {
            throw new Error("invalid snapshot");
          }
          for (const record of snapshot.records) {
            if (record?.type !== "event" || typeof record.event?.type !== "string" || !Number.isSafeInteger(record.event?.seq)) throw new Error("invalid event");
          }
          finish(undefined, { events: snapshot.records, hasMore: snapshot.hasMore });
        } catch {
          finish(new DshApiError("DSH_PROTOCOL_ERROR", "Invalid DSH history snapshot"));
        }
      });
      socket.on("error", () => finish(new DshApiError("DSH_UNAVAILABLE", "Cannot open authenticated DSH history stream")));
      socket.on("close", () => finish(new DshApiError("DSH_TRANSPORT_ERROR", "DSH history stream closed before its snapshot")));
    });
  }
}
