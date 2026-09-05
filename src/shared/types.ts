// Vocabulary shared by main and the renderer. Main emits reasons, the renderer
// owns the wording, so the capture-side and whisper-side rejections can't drift.
export type RejectionReason = 'silence' | 'too-short' | 'blank-transcript'
