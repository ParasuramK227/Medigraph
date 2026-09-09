import { MicTranscriber, ModelArch, Transcriber } from '@moonshine-ai/moonshine-wasm'
import { blobToAudioBuffer } from './browserWhisper'

// Moonshine Medium Streaming: best-performing English streaming model (~245M params).
// Runs entirely in-browser via WebAssembly. 0 bytes leave the user's device.
export const MOONSHINE_MODEL_ARCH: ModelArch = ModelArch.MediumStreaming
export const MOONSHINE_LANG = 'en'

export interface MoonshineMicOptions {
  onText: (text: string) => void
  onLine: (text: string) => void
  onProgress?: (fraction: number, status: string) => void
  onError?: (error: Error) => void
}

/**
 * Builds a live Moonshine transcriber, downloads the model (cached on first use),
 * and starts listening on the microphone. Everything happens on-device.
 */
export async function startMoonshineMic(opts: MoonshineMicOptions): Promise<MicTranscriber> {
  const mic = new MicTranscriber()
    .language(MOONSHINE_LANG)
    .modelArch(MOONSHINE_MODEL_ARCH)
    .onText((text) => opts.onText(text))
    .onLine((line) => opts.onLine(line.text))
    .onError((error) => opts.onError?.(error))
    .onProgress((fraction, _file) => {
      if (opts.onProgress) {
        const pct = Math.min(100, Math.max(0, Math.round(fraction * 100)))
        opts.onProgress(fraction, `Downloading Moonshine model (Medium Streaming): ${pct}%`)
      }
    })

  await mic.load()
  await mic.start()
  return mic
}

/**
 * Stops capture, flushes a final transcript, and releases the mic + transcriber.
 */
export async function stopMoonshineMic(mic: MicTranscriber | null): Promise<void> {
  if (!mic) return
  try {
    if (mic.isRunning) {
      await mic.stop()
    }
  } finally {
    mic.close()
  }
}

/**
 * Transcribes an uploaded audio file 100% in-browser via the non-streaming
 * Moonshine engine. Returns the raw transcript text.
 */
export async function transcribeFileWithMoonshine(
  audioBlob: Blob,
  onProgress?: (msg: string) => void
): Promise<string> {
  if (onProgress) onProgress('Preparing audio buffer...')
  const audioData = await blobToAudioBuffer(audioBlob)

  // If audio is under 100ms or empty, return empty
  if (audioData.length < 1600) {
    return ''
  }

  if (onProgress) onProgress('Loading Moonshine model (Medium Streaming) in browser...')
  const transcriber = await Transcriber.load({
    language: MOONSHINE_LANG,
    modelArch: MOONSHINE_MODEL_ARCH,
    onProgress: (loaded, total) => {
      if (onProgress && typeof total === 'number' && total > 0) {
        onProgress(`Downloading Moonshine model: ${Math.round((loaded / total) * 100)}%`)
      } else if (onProgress) {
        onProgress('Downloading Moonshine model...')
      }
    },
  })

  try {
    if (onProgress) onProgress('Transcribing in browser via WebAssembly...')
    const output = transcriber.transcribe(audioData, { sampleRate: 16000 })
    return output.lines
      .map((line) => line.text.trim())
      .filter(Boolean)
      .join(' ')
      .trim()
  } finally {
    transcriber.close()
  }
}