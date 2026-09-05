import { useCallback, useEffect, useRef, useState } from 'react'
import PttButton from './components/PttButton'
import Transcript, { type Entry } from './components/Transcript'
import { useRecorder } from './useRecorder'
import type { RejectionReason } from '../shared/types'

const WARN_AT_MS = 50_000

// The states §5 requires, each distinct on screen. `thinking` carries its start so
// the status line can count the seconds the agent is taking.
type Status =
  { kind: 'transcribing' } | { kind: 'thinking'; since: number } | { kind: 'speaking' } | null

// Cancellation is not atomic and the UI has to say so: files the agent already
// wrote stay written (spec §7.2).
const INTERRUPTED = 'Interrupted — the assistant may have already changed files.'

const NO_AGENT =
  'Claude CLI not found. Install with `npm i -g @anthropic-ai/claude-code` and run `claude` once to sign in.'
const NO_SPEECH = 'Speech model not installed — run `npm run setup`.'

// One home for rejection wording, wherever the rejection came from.
const REJECTION_TEXT: Record<RejectionReason, string> = {
  'too-short': 'Too short — hold and speak.',
  silence: "Didn't catch that — try again.",
  'blank-transcript': "Didn't catch that — try again."
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
}

export default function App(): React.JSX.Element {
  const [entries, setEntries] = useState<Entry[]>([])
  const [status, setStatus] = useState<Status>(null)
  const [thinkingFor, setThinkingFor] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [banners, setBanners] = useState<string[]>([])
  const [muted, setMuted] = useState(false)
  const toastTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    window.api
      .preflight()
      .then(({ agent, speech }) =>
        setBanners([...(speech.ok ? [] : [NO_SPEECH]), ...(agent.ok ? [] : [NO_AGENT])])
      )
      .catch(() => setBanners([NO_AGENT]))
  }, [])

  const showToast = useCallback((text: string): void => {
    setToast(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2500)
  }, [])

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  useEffect(() => {
    if (status?.kind !== 'thinking') return
    const tick = (): void => setThinkingFor(Math.floor((Date.now() - status.since) / 1000))
    tick()
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [status])

  // The id of the reply being streamed into, so deltas append to it instead of
  // stacking up new entries. Cleared when a turn starts thinking.
  const replyId = useRef<string | null>(null)

  const addEntry = useCallback((entry: Omit<Entry, 'id'>): string => {
    const id = crypto.randomUUID()
    setEntries((prev) => [...prev, { ...entry, id }])
    return id
  }, [])

  const appendReply = useCallback(
    (turnId: string, text: string): void => {
      const id = replyId.current
      if (id === null) replyId.current = addEntry({ kind: 'ai', turnId, text })
      else setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, text: e.text + text } : e)))
    },
    [addEntry]
  )

  // `done` is authoritative (spec §4.5), so it replaces every reply bubble this turn
  // streamed — however many tool calls split them up — with one final bubble at the
  // bottom. Replacing only the last bubble would leave earlier partial text above it.
  const settleReply = useCallback((turnId: string, text: string): void => {
    setEntries((prev) => [
      ...prev.filter((e) => !(e.kind === 'ai' && e.turnId === turnId)),
      { id: crypto.randomUUID(), turnId, kind: 'ai', text }
    ])
    replyId.current = null
  }, [])

  const { recording, level, elapsedMs, micError, start, stop } = useRecorder({
    onUtterance: (pcm, sampleRate) => {
      window.api.submitUtterance(pcm.buffer, sampleRate).catch((err: unknown) => {
        setStatus(null)
        addEntry({
          kind: 'error',
          text: "Couldn't start that turn.",
          detail: err instanceof Error ? err.message : String(err)
        })
      })
    },
    onRejected: (reason) => showToast(REJECTION_TEXT[reason]),
    onNotice: showToast
  })

  // Pushing to talk barges in on whatever is running (spec §7.2). The cancel is not
  // awaited: main kills the children before it returns, and opening the mic takes
  // orders of magnitude longer than the round trip, so waiting would only make
  // recording hostage to an IPC call.
  const beginTalking = useCallback((): void => {
    void window.api.cancelTurn()
    start()
  }, [start])

  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.repeat || isTypingTarget(e.target)) return
      e.preventDefault()
      beginTalking()
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || isTypingTarget(e.target)) return
      e.preventDefault()
      stop()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [beginTalking, stop])

  useEffect(
    () =>
      window.api.onTurnEvent((event) => {
        switch (event.type) {
          case 'transcribing':
            setStatus({ kind: 'transcribing' })
            break
          case 'transcript':
            addEntry({ kind: 'you', text: event.text })
            break
          case 'thinking':
            replyId.current = null
            setStatus({ kind: 'thinking', since: Date.now() })
            break
          case 'tool':
            // Text after a tool call belongs in a new bubble below the tool line,
            // not appended to the one that was already streaming above it.
            replyId.current = null
            addEntry({ kind: 'tool', text: event.label })
            break
          case 'delta':
            appendReply(event.turnId, event.text)
            break
          case 'done':
            settleReply(event.turnId, event.text.trim() === '' ? '(no reply)' : event.text)
            setStatus(null)
            break
          case 'speaking':
            setStatus(event.on ? { kind: 'speaking' } : null)
            break
          case 'cancelled':
            // Keep the label, drop the half-sentence (spec §7.2).
            setEntries((prev) => [
              ...prev.filter((e) => !(e.kind === 'ai' && e.turnId === event.turnId)),
              { id: crypto.randomUUID(), kind: 'note', text: INTERRUPTED }
            ])
            replyId.current = null
            setStatus(null)
            break
          case 'rejected':
            setStatus(null)
            showToast(REJECTION_TEXT[event.reason])
            break
          case 'error':
            setStatus(null)
            addEntry({ kind: 'error', text: event.message, detail: event.detail })
            break
        }
      }),
    [addEntry, appendReply, settleReply, showToast]
  )

  return (
    <div className="app">
      <header className="header">
        <span>Voice Notes</span>
        <div className="header-actions">
          <button
            type="button"
            className={`ghost${muted ? ' ghost-on' : ''}`}
            aria-pressed={muted}
            title={muted ? 'Replies are muted' : 'Replies are spoken'}
            onClick={() => {
              const next = !muted
              setMuted(next)
              window.api.setMuted(next).catch((err: unknown) => {
                // Main is the one that actually mutes; don't let the icon lie.
                setMuted(!next)
                addEntry({
                  kind: 'error',
                  text: "Couldn't change the mute setting.",
                  detail: err instanceof Error ? err.message : String(err)
                })
              })
            }}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              window.api.newConversation().catch((err: unknown) => {
                addEntry({
                  kind: 'error',
                  text: "Couldn't start a new conversation.",
                  detail: err instanceof Error ? err.message : String(err)
                })
              })
              replyId.current = null
              setEntries([])
              setStatus(null)
            }}
          >
            ＋ New
          </button>
        </div>
      </header>

      {[...(micError ? [micError] : []), ...banners].map((text) => (
        <div className="banner" key={text}>
          {text}
        </div>
      ))}

      <Transcript entries={entries} />

      <footer className="controls">
        <div className="meter-row">
          <div className="meter" aria-hidden>
            <div className="meter-fill" style={{ width: `${Math.min(1, level * 8) * 100}%` }} />
          </div>
          <span className={`timer${elapsedMs >= WARN_AT_MS ? ' timer-warn' : ''}`}>
            {recording ? clock(elapsedMs) : ''}
          </span>
        </div>
        <PttButton
          recording={recording}
          disabled={micError !== null}
          onStart={beginTalking}
          onStop={stop}
        />
        <p className="status">
          <span className={status?.kind === 'speaking' ? 'speaking' : undefined}>
            {status === null
              ? recording
                ? 'Listening…'
                : 'Hold Space or the button to talk.'
              : status.kind === 'transcribing'
                ? 'Transcribing…'
                : status.kind === 'thinking'
                  ? `Thinking ${thinkingFor}s`
                  : 'Speaking…'}
          </span>
          {status !== null && (
            <button
              type="button"
              className="ghost stop"
              onClick={() => void window.api.cancelTurn()}
            >
              Stop
            </button>
          )}
        </p>
        {toast && <div className="toast">{toast}</div>}
      </footer>
    </div>
  )
}
