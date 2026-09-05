// Vocabulary shared by main and the renderer. Main emits reasons, the renderer
// owns the wording, so the capture-side and whisper-side rejections can't drift.
export type RejectionReason = 'silence' | 'too-short' | 'blank-transcript'

// One turn's life, as seen by the renderer. Spec §3.
export type TurnEvent =
  | { turnId: string; type: 'transcribing' }
  | { turnId: string; type: 'transcript'; text: string }
  | { turnId: string; type: 'rejected'; reason: RejectionReason }
  | { turnId: string; type: 'thinking' }
  | { turnId: string; type: 'tool'; label: string }
  | { turnId: string; type: 'delta'; text: string }
  | { turnId: string; type: 'done'; text: string }
  | { turnId: string; type: 'error'; message: string; detail?: string }
  | { turnId: string; type: 'cancelled' }

export type VoiceNotesApi = {
  submitUtterance(pcm: ArrayBuffer, sampleRate: number): Promise<{ turnId: string }>
  newConversation(): Promise<void>
  onTurnEvent(handler: (event: TurnEvent) => void): () => void
}
