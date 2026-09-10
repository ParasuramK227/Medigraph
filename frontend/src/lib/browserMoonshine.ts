import { MicTranscriber, ModelArch, Transcriber } from '@moonshine-ai/moonshine-wasm'
import { blobToAudioBuffer } from './browserWhisper'

// Moonshine Medium Streaming: best-performing English streaming model (~245M params).
// Runs entirely in-browser via WebAssembly. 0 bytes leave the user's device.
//
// The model weights are self-hosted in frontend/public/models/moonshine/ so the
// engine works fully offline with no CDN fetch and zero latency on first load.
export const MOONSHINE_MODEL_ARCH: ModelArch = ModelArch.MediumStreaming
export const MOONSHINE_LANG = 'en'
export const MOONSHINE_MODEL_BASE = '/models/moonshine/'

// Explicit file map for streaming architecture — bypasses the WASM manifest
// size check so self-hosted files don't need to match CDN byte counts exactly.
const MOONSHINE_FILES: Record<string, string> = {
  'encoder.ort': `${MOONSHINE_MODEL_BASE}encoder.ort`,
  'adapter.ort': `${MOONSHINE_MODEL_BASE}adapter.ort`,
  'cross_kv.ort': `${MOONSHINE_MODEL_BASE}cross_kv.ort`,
  'decoder_kv.ort': `${MOONSHINE_MODEL_BASE}decoder_kv.ort`,
  'frontend.ort': `${MOONSHINE_MODEL_BASE}frontend.ort`,
  'streaming_config.json': `${MOONSHINE_MODEL_BASE}streaming_config.json`,
  'tokenizer.bin': `${MOONSHINE_MODEL_BASE}tokenizer.bin`,
}

export interface MoonshineMicOptions {
  onText: (text: string) => void
  onLine: (text: string) => void
  onProgress?: (fraction: number, status: string) => void
  onError?: (error: Error) => void
}

let localModelsChecked: boolean | null = null

/**
 * Checks whether self-hosted model files exist in /models/moonshine/.
 * Returns true if valid model files are served; false if missing or SPA HTML fallback is returned.
 */
export async function areLocalMoonshineModelsAvailable(): Promise<boolean> {
  if (localModelsChecked !== null) return localModelsChecked
  try {
    const res = await fetch(`${MOONSHINE_MODEL_BASE}streaming_config.json`, { method: 'HEAD' })
    if (!res.ok) {
      localModelsChecked = false
      return false
    }
    const ct = res.headers.get('content-type') || ''
    // If Vite serves index.html fallback for missing files, content-type is text/html
    localModelsChecked = !ct.includes('text/html')
    return localModelsChecked
  } catch {
    localModelsChecked = false
    return false
  }
}

/** Clear Moonshine model caches only if explicitly requested (e.g., debug/reset). */
export async function resetMoonshineCache(): Promise<void> {
  if (typeof caches === 'undefined') return
  for (const name of ['moonshine-models-v1', 'moonshine-models']) {
    try {
      await caches.delete(name)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Builds a live Moonshine transcriber from local model files (or CDN fallback)
 * and starts listening on the microphone. Everything happens 100% on-device.
 */
export async function startMoonshineMic(opts: MoonshineMicOptions): Promise<MicTranscriber> {
  const hasLocal = await areLocalMoonshineModelsAvailable()

  const mic = new MicTranscriber()
    .language(MOONSHINE_LANG)
    .modelArch(MOONSHINE_MODEL_ARCH)
    .onText((text) => opts.onText(text))
    .onLine((line) => opts.onLine(line.text))
    .onError((error) => opts.onError?.(error))
    .onProgress((fraction, file) => {
      if (opts.onProgress) {
        const pct = Math.min(100, Math.max(0, Math.round(fraction * 100)))
        const filename = file ? ` (${file.split('/').pop()})` : ''
        opts.onProgress(fraction, `Loading Moonshine model: ${pct}%${filename}`)
      }
    })

  // If local files are downloaded in public/models/moonshine, use them.
  // Otherwise, default to the official Moonshine CDN catalog.
  if (hasLocal) {
    mic.modelsFrom(MOONSHINE_FILES)
  }

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

  if (onProgress) onProgress('Loading Moonshine model in browser...')
  const hasLocal = await areLocalMoonshineModelsAvailable()

  const progressHandler = (loaded: number, total?: number, file?: string) => {
    if (onProgress && typeof total === 'number' && total > 0) {
      const pct = Math.round((loaded / total) * 100)
      const filename = file ? ` [${file}]` : ''
      onProgress(`Loading Moonshine model: ${pct}%${filename}`)
    } else if (onProgress) {
      onProgress('Loading Moonshine model...')
    }
  }

  let transcriber: Transcriber
  if (hasLocal) {
    transcriber = await Transcriber.loadFromUrls(MOONSHINE_FILES, {
      modelArch: MOONSHINE_MODEL_ARCH,
      onProgress: progressHandler,
    })
  } else {
    transcriber = await Transcriber.load({
      language: MOONSHINE_LANG,
      modelArch: MOONSHINE_MODEL_ARCH,
      onProgress: progressHandler,
    })
  }

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