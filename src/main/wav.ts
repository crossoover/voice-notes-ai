// Canonical 44-byte mono 16-bit PCM WAV — what whisper.cpp expects.
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  const bytes = samples.length * 2

  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + bytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // PCM, uncompressed
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(bytes, 40)

  const pcm = Buffer.alloc(bytes)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    pcm.writeInt16LE(Math.round(clamped * 32767), i * 2)
  }
  return Buffer.concat([header, pcm])
}
