import type { VoicePrefs } from './prefs.ts'

export const HARNESS_FIRST_POLICY = `
你是 DeepSeek Harness 的实时语音输入输出层，不是独立回答问题的助手。
对用户的每一次有效发言，无论是闲聊、知识问答、天气查询、电脑操作还是多步骤任务，你的第一步且唯一允许的处理方式都是调用 delegate_to_harness。
调用时必须把用户原意完整、忠实地写入 task；不得自行回答、搜索、推理、执行工具或省略用户要求。
收到 delegate_to_harness 的结果后，只朗读工具输出中的自然语言内容，不补充、不改写、不总结，也不要再次调用工具。
`.trim()

export interface ToolCall {
  callId: string
  name: 'delegate_to_harness' | 'cancel_harness_task'
  arguments: string
}

export function sessionUpdate(prefs: VoicePrefs): Record<string, unknown> {
  const functions = [{
    name: 'delegate_to_harness',
    description: '必须对用户每一次有效发言调用。把完整原意交给当前 DeepSeek Harness 会话，由 Harness 统一完成推理、记忆、搜索、插件和工具调度。',
    parameters: {
      type: 'object',
      properties: { task: { type: 'string', description: '完整、忠实、可执行的用户原意；不要自行回答或删改' } },
      required: ['task'],
      additionalProperties: false,
    },
  }]

  const instructions = `${prefs.instructions.trim()}\n\n${HARNESS_FIRST_POLICY}`.trim()

  if (prefs.provider === 'openai') {
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions,
        output_modalities: ['audio'],
        audio: {
          input: {
            turn_detection: {
              type: 'semantic_vad',
              eagerness: 'auto',
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { voice: prefs.openaiVoice },
        },
        tools: functions.map(fn => ({ type: 'function', ...fn })),
        tool_choice: 'required',
      },
    }
  }

  return {
    type: 'session.update',
    session: {
      modalities: ['text', 'audio'],
      instructions,
      voice: prefs.qwenVoice,
      input_audio_transcription: {
        model: 'qwen3-asr-flash-realtime',
        language: 'zh',
      },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        silence_duration_ms: 450,
        create_response: true,
      },
      tools: functions.map(fn => ({ type: 'function', function: fn })),
      tool_choice: 'auto',
    },
  }
}

export function parseToolCall(event: unknown): ToolCall | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const record = event as Record<string, unknown>
  if (record.type === 'response.function_call_arguments.done') {
    if (record.name !== 'delegate_to_harness' && record.name !== 'cancel_harness_task') return undefined
    if (typeof record.call_id !== 'string') return undefined
    return {
      callId: record.call_id,
      name: record.name,
      arguments: typeof record.arguments === 'string' ? record.arguments : '{}',
    }
  }
  const item = record.type === 'response.output_item.done'
    ? record.item
    : record.type === 'conversation.item.created'
      ? record.item
      : undefined
  if (typeof item !== 'object' || item === null) return undefined
  const call = item as Record<string, unknown>
  if (call.type !== 'function_call') return undefined
  if (call.name !== 'delegate_to_harness' && call.name !== 'cancel_harness_task') return undefined
  const callId = typeof call.call_id === 'string' ? call.call_id : typeof call.id === 'string' ? call.id : undefined
  if (callId === undefined) return undefined
  return {
    callId,
    name: call.name,
    arguments: typeof call.arguments === 'string' ? call.arguments : '{}',
  }
}

export function toolOutput(callId: string, output: unknown): Array<Record<string, unknown>> {
  const spoken = normalizeHarnessOutput(output)
  return [{
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output: spoken },
  }, { type: 'response.create' }]
}

function normalizeHarnessOutput(output: unknown): string {
  if (typeof output === 'object' && output !== null) {
    const result = output as { ok?: unknown; text?: unknown; error?: unknown; cancelled?: unknown }
    if (result.ok === true && typeof result.text === 'string' && result.text.trim() !== '') return result.text
    if (result.cancelled === true) return '任务已取消。'
    if (typeof result.error === 'string' && result.error.trim() !== '') return `Harness 执行失败：${result.error}`
  }
  return typeof output === 'string' ? output : JSON.stringify(output)
}
