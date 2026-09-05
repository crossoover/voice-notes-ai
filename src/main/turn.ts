import { randomUUID } from 'crypto'
import { app } from 'electron'
import { unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import type { TurnEvent } from '../shared/types'
import { encodeWav } from './wav'
import { isBlank, transcribe } from './whisper'

type Send = (event: TurnEvent) => void

/** Starts one turn and returns its id immediately; progress arrives as events. */
export function startTurn(send: Send, pcm: ArrayBuffer, sampleRate: number): string {
  const turnId = randomUUID()
  void run(turnId, send, pcm, sampleRate)
  return turnId
}

async function run(
  turnId: string,
  send: Send,
  pcm: ArrayBuffer,
  sampleRate: number
): Promise<void> {
  const wavPath = join(app.getPath('temp'), `voice-notes-${turnId}.wav`)
  try {
    send({ turnId, type: 'transcribing' })
    await writeFile(wavPath, encodeWav(new Float32Array(pcm), sampleRate))

    const transcript = await transcribe(wavPath).text
    if (isBlank(transcript)) {
      send({ turnId, type: 'rejected', reason: 'blank-transcript' })
      return
    }
    send({ turnId, type: 'transcript', text: transcript })
  } catch (err) {
    send({
      turnId,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      detail: err instanceof Error && typeof err.cause === 'string' ? err.cause : undefined
    })
  } finally {
    // A temp WAV must never outlive its turn, however the turn ended.
    await unlink(wavPath).catch(() => {})
  }
}
