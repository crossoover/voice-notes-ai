import { useCallback, useEffect, useRef, useState } from 'react'
import PttButton from './components/PttButton'
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
  const [toast, setToast] = useState<string | null>(null)
  // Temporary: lets me confirm the captured audio is real before whisper exists.
  const [captured, setCaptured] = useState<{
    pcm: Float32Array<ArrayBuffer>
    sampleRate: number
  } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = useCallback((text: string): void => {
    setToast(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2500)
  }, [])

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  const { recording, level, elapsedMs, micError, openTiming, start, stop } = useRecorder({
    onUtterance: (pcm, sampleRate) => setCaptured({ pcm, sampleRate }),
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

  // Temporary debug affordance, removed once whisper is wired up.
  const playBack = (): void => {
    if (!captured) return
    const ctx = new AudioContext()
    const buffer = ctx.createBuffer(1, captured.pcm.length, captured.sampleRate)
    buffer.copyToChannel(captured.pcm, 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.onended = () => void ctx.close()
    source.start()
  }

  return (
    <div className="app">
      <header className="header">Voice Notes</header>

      {micError && <div className="banner">{micError}</div>}

      <main className="transcript">
        {captured ? (
          <p className="debug">
            Captured {(captured.pcm.length / captured.sampleRate).toFixed(2)}s —{' '}
            {captured.pcm.length} samples @ {captured.sampleRate}Hz{' '}
            <button type="button" onClick={playBack}>
              Play back
            </button>
            {openTiming && (
              <>
                <br />
                Mic opened in {Math.round(openTiming.gumMs + openTiming.workletMs)}ms (device{' '}
                {Math.round(openTiming.gumMs)}ms, worklet {Math.round(openTiming.workletMs)}ms)
              </>
            )}
          </p>
        ) : (
          <p className="empty">Hold Space or the button to talk.</p>
        )}
      </main>

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
        {toast && <div className="toast">{toast}</div>}
      </footer>
    </div>
  )
}
