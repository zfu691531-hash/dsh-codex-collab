import { stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { assertPromptIntegrity } from "./prompt-integrity";

export interface CollaborationReferenceInput {
  uri: string;
  title?: string;
  mediaType?: string;
}

export interface CollaborationArtifactInput {
  path: string;
  name?: string;
  mediaType?: string;
}

export interface CollaborationReferenceReceipt extends CollaborationReferenceInput {
  status?: "unavailable";
}

export interface CollaborationArtifactReceipt extends CollaborationArtifactInput {
  mediaType: string;
  status: "available" | "unavailable";
  sizeBytes?: number;
  modifiedAt?: string;
}

export interface CollaborationInputIssue {
  code: "REFERENCE_INVALID" | "ARTIFACT_UNAVAILABLE";
  target: "reference" | "artifact";
  index: number;
  message: string;
  retryable: true;
}

export interface CollaborationMessageInput {
  text: string;
  references?: CollaborationReferenceInput[];
  artifacts?: CollaborationArtifactInput[];
}

export interface CollaborationMessageReceipt {
  text: string;
  references: CollaborationReferenceReceipt[];
  artifacts: CollaborationArtifactReceipt[];
}

export interface PreparedCollaborationMessage {
  wireText: string;
  receipt: CollaborationMessageReceipt;
  issues: CollaborationInputIssue[];
}

function mediaTypeFor(path: string, explicit?: string): string {
  if (explicit) return explicit;
  switch (extname(path).toLowerCase()) {
    case ".pdf": return "application/pdf";
    case ".md": return "text/markdown";
    case ".txt": return "text/plain";
    case ".json": return "application/json";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    default: return "application/octet-stream";
  }
}

function trimUrlCandidate(candidate: string): string {
  let value = candidate.replace(/[.,;:!?，。；：！？]+$/gu, "");
  while (value.endsWith(")")) {
    const opens = [...value].filter((character) => character === "(").length;
    const closes = [...value].filter((character) => character === ")").length;
    if (closes <= opens) break;
    value = value.slice(0, -1);
  }
  return value.replace(/[\]}》】]+$/gu, "");
}

function referencesFromText(text: string): CollaborationReferenceInput[] {
  const candidates = text.match(/https?:\/\/[^\s<>"'，。；！？、]+/giu) ?? [];
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const uri = trimUrlCandidate(candidate);
    if (seen.has(uri)) return [];
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return [];
    } catch {
      return [];
    }
    seen.add(uri);
    return [{ uri }];
  });
}

function mergeReferences(text: string, explicit: CollaborationReferenceInput[]): CollaborationReferenceInput[] {
  const merged = referencesFromText(text);
  const indexByUri = new Map(merged.map((reference, index) => [reference.uri, index]));
  for (const reference of explicit) {
    const index = indexByUri.get(reference.uri);
    if (index === undefined) {
      indexByUri.set(reference.uri, merged.length);
      merged.push(reference);
    } else {
      merged[index] = { ...merged[index], ...reference };
    }
  }
  return merged;
}

function prepareReferences(inputs: CollaborationReferenceInput[]): {
  receipts: CollaborationReferenceReceipt[];
  issues: CollaborationInputIssue[];
} {
  const receipts: CollaborationReferenceReceipt[] = [];
  const issues: CollaborationInputIssue[] = [];
  inputs.forEach((input, index) => {
    let valid = false;
    try {
      const parsed = new URL(input.uri);
      valid = parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      valid = false;
    }
    receipts.push({ ...input, ...(valid ? {} : { status: "unavailable" as const }) });
    if (!valid) {
      issues.push({
        code: "REFERENCE_INVALID",
        target: "reference",
        index,
        message: `reference ${index} is not a valid HTTP(S) URL: ${input.uri}`,
        retryable: true,
      });
    }
  });
  return { receipts, issues };
}

async function prepareArtifact(input: CollaborationArtifactInput, index: number): Promise<{
  receipt: CollaborationArtifactReceipt;
  issue?: CollaborationInputIssue;
}> {
  const mediaType = mediaTypeFor(input.path, input.mediaType);
  try {
    if (!isAbsolute(input.path)) throw new Error("path is not absolute");
    const info = await stat(input.path);
    if (!info.isFile()) throw new Error("path is not a file");
    return {
      receipt: {
        ...input,
        mediaType,
        status: "available",
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString(),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      receipt: { ...input, mediaType, status: "unavailable" },
      issue: {
        code: "ARTIFACT_UNAVAILABLE",
        target: "artifact",
        index,
        message: `artifact ${index} is unavailable at ${input.path}: ${message}`,
        retryable: true,
      },
    };
  }
}

function projectForPrompt(receipt: CollaborationMessageReceipt, issues: CollaborationInputIssue[]): string {
  if (receipt.references.length === 0 && receipt.artifacts.length === 0) return receipt.text;
  const manifest = JSON.stringify({
    version: 1,
    references: receipt.references,
    artifacts: receipt.artifacts,
    inputIssues: issues,
  }, null, 2);
  const recovery = issues.length === 0
    ? "Use these inputs as part of the task and preserve them when forwarding work to another agent."
    : "Continue with available inputs. Explicitly ask the collaborator to resend each unavailable input; do not guess its contents.";
  const readable = [
    ...receipt.references.map((item, index) => `Reference ${index}: ${item.title ? `${item.title} — ` : ""}${item.uri}`),
    ...receipt.artifacts.map((item, index) => `Artifact ${index}: ${item.name ? `${item.name} — ` : ""}${item.path} (${item.mediaType}, ${item.status})`),
  ].join("\n");
  return `${receipt.text}\n\n[Collaboration inputs — structured local envelope]\n${readable}\n${manifest}\n${recovery}`;
}

/** Prepare one lossless local collaboration envelope for prompt-only backends. */
export async function prepareCollaborationMessage(input: CollaborationMessageInput): Promise<PreparedCollaborationMessage> {
  const text = assertPromptIntegrity(input.text);
  const references = prepareReferences(mergeReferences(text, input.references ?? []));
  const artifacts = await Promise.all((input.artifacts ?? []).map(prepareArtifact));
  const receipt: CollaborationMessageReceipt = {
    text,
    references: references.receipts,
    artifacts: artifacts.map((item) => item.receipt),
  };
  const issues = [...references.issues, ...artifacts.flatMap((item) => item.issue ? [item.issue] : [])];
  return { wireText: projectForPrompt(receipt, issues), receipt, issues };
}
