import { useCallback, useEffect, useRef, useState } from 'react'
import workletUrl from './capture-worklet.js?url'
import type { RejectionReason } from '../shared/types'

// Tuned on real hardware; see spec §4.3.
const MIN_DURATION_MS = 350
const MIN_PEAK_RMS = 0.01
const MAX_DURATION_MS = 60_000
const TARGET_SAMPLE_RATE = 16000
const TICK_MS = 60

const MIC_READY = 'Microphone ready — hold again to talk.'

// Temporary: how long the mic took to open, so the first-syllable cost is measurable.
export type OpenTiming = { gumMs: number; workletMs: number }

type Recording = {
  ctx: AudioContext
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode
  chunks: Float32Array<ArrayBuffer>[]
  frames: number
  peakRms: number
  lastRms: number
  startedAt: number
}

function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

function concat(chunks: Float32Array<ArrayBuffer>[], frames: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(frames)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

// Only used when the OS refuses a 16kHz AudioContext; whisper.cpp wants 16kHz mono.
function resample(
  input: Float32Array<ArrayBuffer>,
  from: number,
  to: number
): Float32Array<ArrayBuffer> {
  if (from === to) return input
  const ratio = from / to
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio
    const low = Math.floor(at)
    const high = Math.min(low + 1, input.length - 1)
    out[i] = input[low] + (input[high] - input[low]) * (at - low)
  }
  return out
}

// Denied and missing devices need the user to go fix something, so they get a
// persistent banner. Anything else (device busy, transient failure) is retryable.
function permanentMicError(err: unknown): string | null {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access denied — enable it in System Settings → Privacy & Security → Microphone, then restart the app.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone found — connect an input device and restart the app.'
  }
  return null
}

export function useRecorder(handlers: {
  onUtterance: (pcm: Float32Array<ArrayBuffer>, sampleRate: number) => void
  onRejected: (reason: RejectionReason) => void
  // For things that aren't utterance rejections and have no shared vocabulary.
  onNotice: (text: string) => void
}): {
  recording: boolean
  level: number
  elapsedMs: number
  micError: string | null
  openTiming: OpenTiming | null
  start: () => void
  stop: () => void
} {
  const [recording, setRecording] = useState(false)
  const [level, setLevel] = useState(0)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [micError, setMicError] = useState<string | null>(null)
  const [openTiming, setOpenTiming] = useState<OpenTiming | null>(null)

  const rec = useRef<Recording | null>(null)
  const opening = useRef(false)
  // A tap can release the key before getUserMedia resolves; remember that.
  const releasedWhileOpening = useRef(false)
  // The macOS mic prompt takes key window status, so a blur while opening is
  // usually that dialog, not the user leaving.
  const blurredWhileOpening = useRef(false)
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })

  const teardown = useCallback((r: Recording): void => {
    r.node.port.onmessage = null
    r.node.disconnect()
    r.source.disconnect()
    r.stream.getTracks().forEach((t) => t.stop())
    void r.ctx.close()
  }, [])

  const stop = useCallback((): void => {
    const r = rec.current
    if (!r) {
      releasedWhileOpening.current = true
      return
    }
    rec.current = null
    setRecording(false)
    setLevel(0)
    setElapsedMs(0)
    teardown(r)

    const durationMs = performance.now() - r.startedAt
    if (durationMs < MIN_DURATION_MS) return latest.current.onRejected('too-short')
    if (r.peakRms < MIN_PEAK_RMS) return latest.current.onRejected('silence')
    const pcm = concat(r.chunks, r.frames)
    latest.current.onUtterance(
      resample(pcm, r.ctx.sampleRate, TARGET_SAMPLE_RATE),
      TARGET_SAMPLE_RATE
    )
  }, [teardown])

  const start = useCallback((): void => {
    if (rec.current || opening.current || micError) return
    opening.current = true
    releasedWhileOpening.current = false
    blurredWhileOpening.current = false

    void (async (): Promise<void> => {
      let stream: MediaStream | undefined
      let ctx: AudioContext | undefined
      try {
        const t0 = performance.now()
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
        })
        const t1 = performance.now()
        ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
        await ctx.audioWorklet.addModule(workletUrl)
        setOpenTiming({ gumMs: t1 - t0, workletMs: performance.now() - t1 })

        // Either the key came back up before the device opened, or the window lost
        // focus while it did — most often the first-run permission dialog. Neither
        // should leave the mic running, and neither is worth an error.
        if (releasedWhileOpening.current || blurredWhileOpening.current) {
          stream.getTracks().forEach((t) => t.stop())
          void ctx.close()
          if (blurredWhileOpening.current) latest.current.onNotice(MIC_READY)
          else latest.current.onRejected('too-short')
          return
        }

        const source = ctx.createMediaStreamSource(stream)
        const node = new AudioWorkletNode(ctx, 'capture', { numberOfOutputs: 0 })
        const r: Recording = {
          ctx,
          stream,
          source,
          node,
          chunks: [],
          frames: 0,
          peakRms: 0,
          lastRms: 0,
          startedAt: performance.now()
        }
        node.port.onmessage = (e: MessageEvent<Float32Array<ArrayBuffer>>): void => {
          const chunk = e.data
          r.chunks.push(chunk)
          r.frames += chunk.length
          r.lastRms = rms(chunk)
          if (r.lastRms > r.peakRms) r.peakRms = r.lastRms
        }
        source.connect(node)
        rec.current = r
        setRecording(true)
      } catch (err) {
        stream?.getTracks().forEach((t) => t.stop())
        void ctx?.close()
        const permanent = permanentMicError(err)
        if (permanent) setMicError(permanent)
        else
          latest.current.onNotice(
            `Couldn't open the microphone: ${err instanceof Error ? err.message : String(err)}`
          )
      } finally {
        opening.current = false
      }
    })()
  }, [micError])

  // One timer drives both the elapsed counter and the level meter, so the
  // meter doesn't re-render React on every 128-frame block.
  useEffect(() => {
    if (!recording) return
    const id = setInterval(() => {
      const r = rec.current
      if (!r) return
      const elapsed = performance.now() - r.startedAt
      setElapsedMs(elapsed)
      setLevel(r.lastRms)
      if (elapsed >= MAX_DURATION_MS) stop()
    }, TICK_MS)
    return () => clearInterval(id)
  }, [recording, stop])

  // Cmd-tabbing away mid-hold must not leave the mic open. A blur while the device
  // is still opening is handled in start(), not here — treating it as a release
  // would turn the first-run permission grant into a "Too short" error.
  useEffect(() => {
    const onBlur = (): void => {
      if (opening.current) blurredWhileOpening.current = true
      else if (rec.current) stop()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [stop])

  return { recording, level, elapsedMs, micError, openTiming, start, stop }
}
