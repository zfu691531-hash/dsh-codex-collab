export const VOICE_SUMMARY_START = '<!--voice-summary-->'
export const VOICE_SUMMARY_END = '<!--/voice-summary-->'

/**
 * Per-turn output contract delivered through Harness runtime context. It must
 * never be concatenated with the user's transcript, otherwise Harness renders
 * this transport instruction inside the visible user message bubble.
 */
export const VOICE_OUTPUT_CONTEXT = `本轮由实时语音发起。所有工具调用和推理完成后，最终可见回答必须严格按下面顺序输出：
先输出一个内容严格为 voice-summary 的 HTML 注释，紧接一至两句自然口语摘要，中文不超过120字；直接说结论，不写标题、列表、代码、链接、推理过程或“总结如下”等套话。摘要后输出一个内容严格为 /voice-summary 的 HTML 注释。
随后输出完整结果，详略只按任务需要；简单问题保持简短，复杂任务保留必要细节。HTML 注释只充当语音边界，不要解释。最终回答之前的工具调用步骤不要输出这两个注释。`
