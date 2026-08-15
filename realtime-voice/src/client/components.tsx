import { useEffect, useState, useSyncExternalStore } from 'react'
import type { VoiceController } from './controller.ts'
import { loadPrefs, subscribePrefs, updatePrefs } from './prefs.ts'

const styles = {
  button: { width: 32, height: 32, border: 0, borderRadius: 999, cursor: 'pointer', display: 'grid', placeItems: 'center', color: 'var(--dsw-alias-label-secondary)', background: 'transparent' },
  active: { color: '#fff', background: '#2563eb' },
  dock: { margin: '0 auto 4px', maxWidth: 760, padding: '5px 12px', borderRadius: '10px 10px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-specific-tip)' },
  continueDock: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' },
  continueTitle: { flex: 'none', color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
  card: { listStyle: 'none', padding: '14px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
  row: { display: 'grid', gridTemplateColumns: '150px 1fr', gap: 12, alignItems: 'center', marginTop: 10 },
  input: { minWidth: 0, padding: '7px 9px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7, background: 'var(--dsw-alias-bg-base)', color: 'inherit' },
} as const

export function MicButton({ controller }: { controller: VoiceController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const active = snapshot.state !== 'idle' && snapshot.state !== 'error'
  return <button
    type="button"
    aria-label={active ? '停止实时语音' : '开始实时语音'}
    aria-pressed={active}
    title={active ? '停止实时语音' : `开始实时语音（${snapshot.provider === 'qwen' ? '千问' : 'GPT'}）`}
    style={{ ...styles.button, ...(active ? styles.active : {}) }}
    onClick={() => { void controller.toggle() }}
  >
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm6-3a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.94V22h2v-2.06A8 8 0 0 0 20 12h-2Z" /></svg>
  </button>
}

interface NativeInputProps {
  input: { readonly draft: string }
  inputActions: { setDraft(text: string): void; submit(): void }
}

export function VoiceStatus({ controller, input, inputActions }: { controller: VoiceController } & NativeInputProps) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useEffect(() => controller.bindDraft({ getDraft: () => input.draft, setDraft: text => inputActions.setDraft(text) }), [controller, input.draft, inputActions])
  if (snapshot.state === 'idle') return null
  const labels: Record<string, string> = { connecting: '正在连接', listening: '正在聆听', speaking: '正在说话', working: 'Harness 正在执行', error: '语音不可用' }
  const continuePrefix = '继续任务：'
  if (snapshot.detail.startsWith(continuePrefix)) return <div role="status" data-voice-continue-task="" style={{ ...styles.dock, ...styles.continueDock }}>
    <span aria-hidden="true">↪</span>
    <span style={styles.continueTitle}>继续任务</span>
    <span>{snapshot.detail.slice(continuePrefix.length)}</span>
  </div>
  return <div role={snapshot.state === 'error' ? 'alert' : 'status'} style={styles.dock}>
    {snapshot.provider === 'qwen' ? '千问' : 'GPT'} · {labels[snapshot.state]}{snapshot.detail ? `：${snapshot.detail}` : ''}
  </div>
}

export function SettingsCard() {
  const prefs = useSyncExternalStore(subscribePrefs, loadPrefs, loadPrefs)
  const [open, setOpen] = useState(false)
  return <li style={styles.card}>
    <button type="button" onClick={() => setOpen(!open)} style={{ width: '100%', border: 0, background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer', padding: 0 }}>
      <strong>实时语音（千问 / GPT）</strong>
      <div style={{ opacity: .66, marginTop: 4 }}>独立 ASR → Harness 推理/插件 → 独立 TTS；不会由语音模型直接回答</div>
    </button>
    {open && <div>
      <Field label="服务商"><select style={styles.input} value={prefs.provider} onChange={e => updatePrefs({ provider: e.currentTarget.value === 'openai' ? 'openai' : 'qwen' })}><option value="qwen">国内：千问专用 ASR / TTS</option><option value="openai">全球：OpenAI GPT Realtime</option></select></Field>
      {prefs.provider === 'qwen' ? <>
        <Field label="Workspace ID"><input style={styles.input} value={prefs.qwenWorkspaceId} placeholder="阿里云百炼 Workspace ID" onChange={e => updatePrefs({ qwenWorkspaceId: e.currentTarget.value })} /></Field>
        <Field label="区域"><select style={styles.input} value={prefs.qwenRegion} onChange={e => updatePrefs({ qwenRegion: e.currentTarget.value === 'ap-southeast-1' ? 'ap-southeast-1' : 'cn-beijing' })}><option value="cn-beijing">北京</option><option value="ap-southeast-1">新加坡</option></select></Field>
        <Field label="ASR 模型"><input style={styles.input} value={prefs.qwenAsrModel} onChange={e => updatePrefs({ qwenAsrModel: e.currentTarget.value })} /></Field>
        <Field label="TTS 模型"><input style={styles.input} value={prefs.qwenTtsModel} onChange={e => updatePrefs({ qwenTtsModel: e.currentTarget.value })} /></Field>
        <Field label="TTS 音色"><select style={styles.input} value={prefs.qwenTtsVoice} onChange={e => updatePrefs({ qwenTtsVoice: e.currentTarget.value })}><option value="Chelsie">Chelsie（软糯亲昵，最接近 Tina）</option><option value="Cherry">Cherry（清亮活泼）</option><option value="Serena">Serena（甜润亲切）</option><option value="Ethan">Ethan（清朗男声）</option></select></Field>
        <Field label="人声阈值"><input style={styles.input} type="number" min={-1} max={1} step={0.05} value={prefs.qwenVadThreshold} onChange={e => updatePrefs({ qwenVadThreshold: e.currentTarget.valueAsNumber })} /></Field>
        <Field label="断句等待(ms)"><input style={styles.input} type="number" min={200} max={6000} step={100} value={prefs.qwenSilenceMs} onChange={e => updatePrefs({ qwenSilenceMs: e.currentTarget.valueAsNumber })} /></Field>
        <Field label="语段合并等待(ms)"><input style={styles.input} type="number" min={100} max={5000} step={100} value={prefs.qwenMergeMs} onChange={e => updatePrefs({ qwenMergeMs: e.currentTarget.valueAsNumber })} /></Field>
      </> : <>
        <Field label="模型"><input style={styles.input} value={prefs.openaiModel} onChange={e => updatePrefs({ openaiModel: e.currentTarget.value })} /></Field>
        <Field label="声音"><input style={styles.input} value={prefs.openaiVoice} onChange={e => updatePrefs({ openaiVoice: e.currentTarget.value })} /></Field>
      </>}
      <Field label="播报风格"><textarea style={{ ...styles.input, minHeight: 84, resize: 'vertical' }} value={prefs.instructions} onChange={e => updatePrefs({ instructions: e.currentTarget.value })} /></Field>
      <p style={{ opacity: .66, fontSize: 12, lineHeight: 1.55 }}>密钥不会进入浏览器或插件配置：请由 Harness 凭据系统提供 {prefs.provider === 'qwen' ? 'DASHSCOPE_API_KEY' : 'OPENAI_API_KEY'}。千问识别结果统一写入原生输入框，点击发送后才由 Harness 推理并播报；不会生成语音专属的“调整方向”任务。Tina 属于 Omni，专用 TTS 不支持；默认改用最接近其风格的 Chelsie。桌面壳当前禁用麦克风，点击话筒会在外部浏览器打开同一会话。</p>
    </div>}
  </li>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={styles.row}><span>{label}</span>{children}</label>
}
