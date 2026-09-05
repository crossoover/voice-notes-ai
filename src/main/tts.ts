import { spawn, type ChildProcess } from 'child_process'
import { endProcess } from './kill'

const VOICE = 'Samantha'
const MAX_CHARS = 400

/**
 * Replies are written to be spoken, but the agent still slips in Markdown. Strip
 * what a voice would read aloud as punctuation noise, and keep it short: a long
 * reply is fine to read on screen and tedious to sit through.
 */
export function speakable(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/_{1,3}(\S[^_]*\S)_{1,3}/g, '$1')
    .replace(/[*~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (plain.length <= MAX_CHARS) return plain
  const cut = plain.slice(0, MAX_CHARS)
  const lastSentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  // Only break at a sentence if one lands somewhere useful; otherwise just stop.
  return lastSentence > MAX_CHARS / 2 ? cut.slice(0, lastSentence + 1) : cut.trimEnd()
}

let speaking: ChildProcess | null = null
let muted = false

export function setMuted(next: boolean): void {
  muted = next
  if (muted) stopSpeaking()
}

/** Returns whether anything is actually being said, so the UI can show it. */
export function speak(text: string, onFinished: () => void): boolean {
  stopSpeaking()
  if (muted) return false
  const words = speakable(text)
  if (words === '') return false

  const child = spawn('say', ['-v', VOICE, words], { stdio: 'ignore' })
  speaking = child
  const finish = (): void => {
    if (speaking === child) speaking = null
    onFinished()
  }
  child.once('close', finish)
  // A missing voice or a `say` that won't start shouldn't take the turn down with
  // it — the reply is already on screen.
  child.once('error', finish)
  return true
}

export function stopSpeaking(): void {
  const child = speaking
  speaking = null
  endProcess(child)
}
