import { randomUUID } from 'crypto'
import { app } from 'electron'
import { unlink, writeFile } from 'fs/promises'
import { unlinkSync } from 'fs'
import { join } from 'path'
import type { TurnEvent } from '../shared/types'
import { ask } from './agent'
import { endProcess } from './kill'
import { encodeWav } from './wav'
import { speak, stopSpeaking } from './tts'
import { isBlank, transcribe } from './whisper'

type Send = (event: TurnEvent) => void

type Active = {
  turnId: string
  send: Send
  wavPath: string
  // How to stop whatever this turn is waiting on right now, if anything.
  cancel: (() => void) | null
  cancelled: boolean
}

// One turn at a time (spec §7.8). Everything cancellable hangs off this.
let active: Active | null = null

/** Starts one turn and returns its id immediately; progress arrives as events. */
export function startTurn(send: Send, pcm: ArrayBuffer, sampleRate: number): string {
  cancelTurn()
  const turnId = randomUUID()
  const turn: Active = {
    turnId,
    send,
    wavPath: join(app.getPath('temp'), `voice-notes-${turnId}.wav`),
    cancel: null,
    cancelled: false
  }
  active = turn
  void run(turn, pcm, sampleRate)
  return turnId
}

/**
 * Hard barge-in. Kills whatever the turn is waiting on and tells the renderer.
 * Idempotent: cancelling an already-dead turn does nothing (spec §7.2).
 */
export function cancelTurn({ notify = true }: { notify?: boolean } = {}): void {
  // Unconditional: speech outlives its turn, so Stop has to reach it even once
  // the turn itself is finished.
  stopSpeaking()
  const turn = active
  if (!turn || turn.cancelled) return
  turn.cancelled = true
  active = null
  turn.cancel?.()
  // Starting a new conversation clears the window, so an "interrupted" note there
  // would have nothing left to refer to.
  if (notify) turn.send({ turnId: turn.turnId, type: 'cancelled' })
}

/** Leave nothing running or lying around when the app quits (spec §7.9). */
export function shutdown(): void {
  // Before the early return, for the same reason as in cancelTurn: speech always
  // runs after its turn has been cleared, so this is the only path that reaches it.
  stopSpeaking()
  const turn = active
  if (!turn) return
  turn.cancelled = true
  active = null
  turn.cancel?.()
  try {
    unlinkSync(turn.wavPath)
  } catch {
    // Already gone, or never written.
  }
}

async function run(turn: Active, pcm: ArrayBuffer, sampleRate: number): Promise<void> {
  const { turnId, send, wavPath } = turn
  try {
    send({ turnId, type: 'transcribing' })
    await writeFile(wavPath, encodeWav(new Float32Array(pcm), sampleRate))
    if (turn.cancelled) return

    const transcription = transcribe(wavPath)
    turn.cancel = () => endProcess(transcription.child)
    const transcript = await transcription.text
    if (turn.cancelled) return
    if (isBlank(transcript)) {
      send({ turnId, type: 'rejected', reason: 'blank-transcript' })
      return
    }
    send({ turnId, type: 'transcript', text: transcript })

    send({ turnId, type: 'thinking' })
    const agent = ask(transcript, {
      tool: (label) => !turn.cancelled && send({ turnId, type: 'tool', label }),
      delta: (text) => !turn.cancelled && send({ turnId, type: 'delta', text })
    })
    turn.cancel = agent.kill
    const reply = await agent.reply
    if (turn.cancelled) return
    send({ turnId, type: 'done', text: reply })
    if (speak(reply, () => send({ turnId, type: 'speaking', on: false }))) {
      send({ turnId, type: 'speaking', on: true })
    }
  } catch (err) {
    // A killed child fails loudly; that failure is the cancellation, not an error.
    if (turn.cancelled) return
    send({
      turnId,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      detail: err instanceof Error && typeof err.cause === 'string' ? err.cause : undefined
    })
  } finally {
    if (active === turn) active = null
    // A temp WAV must never outlive its turn, however the turn ended.
    await unlink(wavPath).catch(() => {})
  }
}
