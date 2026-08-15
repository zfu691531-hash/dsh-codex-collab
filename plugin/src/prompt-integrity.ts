import { Codes, CodexCollabError } from "./errors";

const REPLACEMENT_CHARACTER = "\uFFFD";
const REPEATED_QUESTION_MARKS = /\?{4,}/u;
const C1_CONTROL = /[\u0080-\u009F]/u;

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function damagedReason(value: string): string | undefined {
  if (value.includes(REPLACEMENT_CHARACTER)) return "contains the Unicode replacement character U+FFFD";
  if (hasLoneSurrogate(value)) return "contains an invalid lone UTF-16 surrogate";
  if (C1_CONTROL.test(value)) return "contains a C1 control character commonly produced by a bad text decode";
  if (REPEATED_QUESTION_MARKS.test(value)) return "contains four or more consecutive question marks, indicating likely lossy encoding";

  // TextEncoder replaces invalid scalar values. Equality proves that the exact
  // JavaScript string survives the UTF-8 wire representation we use.
  const roundTrip = new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value));
  if (roundTrip !== value) return "does not survive an exact UTF-8 round trip";
  return undefined;
}

/**
 * Fail closed when prompt text has already suffered high-confidence encoding
 * damage. Valid text is returned byte-for-byte: no normalization or repair is
 * attempted because prompts are core task evidence.
 */
export function assertPromptIntegrity(value: string): string {
  const reason = damagedReason(value);
  if (!reason) return value;
  throw new CodexCollabError(
    Codes.PROMPT_ENCODING_CORRUPTED,
    `${Codes.PROMPT_ENCODING_CORRUPTED}: prompt ${reason}. The task was not sent. Retry through the native MCP tool or another UTF-8-safe input path.`,
  );
}

/** Final wire guard: only rejects strings that cannot survive UTF-8 exactly. */
export function assertUtf8TransportIntegrity(value: string): string {
  if (hasLoneSurrogate(value)) {
    throw new CodexCollabError(
      Codes.PROMPT_ENCODING_CORRUPTED,
      `${Codes.PROMPT_ENCODING_CORRUPTED}: message contains an invalid lone UTF-16 surrogate and cannot be transported losslessly.`,
    );
  }
  const roundTrip = new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value));
  if (roundTrip !== value) {
    throw new CodexCollabError(
      Codes.PROMPT_ENCODING_CORRUPTED,
      `${Codes.PROMPT_ENCODING_CORRUPTED}: message does not survive an exact UTF-8 round trip.`,
    );
  }
  return value;
}

export function isPromptIntegrityError(value: unknown): value is CodexCollabError {
  return value instanceof CodexCollabError && value.code === Codes.PROMPT_ENCODING_CORRUPTED;
}

export interface CollaborationClarification {
  state: "needs-clarification";
  ok: false;
  recoverable: true;
  code: "PROMPT_ENCODING_CORRUPTED";
  action: "ask-sender-and-retry";
  content: string;
  taskId?: string;
  sessionId?: string;
}

export function clarificationForPrompt(error: CodexCollabError, identity: { taskId?: string; sessionId?: string } = {}): CollaborationClarification {
  return {
    state: "needs-clarification",
    ok: false,
    recoverable: true,
    code: Codes.PROMPT_ENCODING_CORRUPTED,
    action: "ask-sender-and-retry",
    content: `${error.message} Ask the collaborator for the intended text, then retry the same operation. No damaged instruction was executed.`,
    ...identity,
  };
}
