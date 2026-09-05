import { useCallback, useEffect, useRef, useState } from 'react'
import PttButton from './components/PttButton'
import Transcript, { type Entry } from './components/Transcript'
import { useRecorder } from './useRecorder'
import type { RejectionReason } from '../shared/types'

const WARN_AT_MS = 50_000

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
  const [status, setStatus] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = useCallback((text: string): void => {
    setToast(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2500)
  }, [])

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  const addEntry = useCallback((entry: Omit<Entry, 'id'>): void => {
    setStatus(null)
    setEntries((prev) => [...prev, { ...entry, id: crypto.randomUUID() }])
  }, [])

  const { recording, level, elapsedMs, micError, start, stop } = useRecorder({
    onUtterance: (pcm, sampleRate) => {
      window.api.submitUtterance(pcm.buffer, sampleRate).catch((err: unknown) => {
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

  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.repeat || isTypingTarget(e.target)) return
      e.preventDefault()
      start()
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
  }, [start, stop])

  useEffect(
    () =>
      window.api.onTurnEvent((event) => {
        switch (event.type) {
          case 'transcribing':
            setStatus('Transcribing…')
            break
          case 'transcript':
            addEntry({ kind: 'you', text: event.text })
            break
          case 'rejected':
            setStatus(null)
            showToast(REJECTION_TEXT[event.reason])
            break
          case 'error':
            addEntry({ kind: 'error', text: event.message, detail: event.detail })
            break
        }
      }),
    [addEntry, showToast]
  )

  return (
    <div className="app">
      <header className="header">Voice Notes</header>

      {micError && <div className="banner">{micError}</div>}

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
          onStart={start}
          onStop={stop}
        />
        <p className="status">
          {status ?? (recording ? 'Listening…' : 'Hold Space or the button to talk.')}
        </p>
        {toast && <div className="toast">{toast}</div>}
      </footer>
    </div>
  )
}
