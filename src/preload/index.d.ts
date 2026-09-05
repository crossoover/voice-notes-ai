import type { VoiceNotesApi } from '../shared/types'

declare global {
  interface Window {
    api: VoiceNotesApi
  }
}
