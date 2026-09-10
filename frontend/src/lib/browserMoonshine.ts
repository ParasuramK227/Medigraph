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
export const MOONSHINE_MODEL_VERSION = 'v2'

// Explicit file map for streaming architecture with cache buster query params
// to guarantee stale SPA HTML responses from previous failed loads are bypassed.
const MOONSHINE_FILES: Record<string, string> = {
  'encoder.ort': `${MOONSHINE_MODEL_BASE}encoder.ort?v=${MOONSHINE_MODEL_VERSION}`,
  'adapter.ort': `${MOONSHINE_MODEL_BASE}adapter.ort?v=${MOONSHINE_MODEL_VERSION}`,
  'cross_kv.ort': `${MOONSHINE_MODEL_BASE}cross_kv.ort?v=${MOONSHINE_MODEL_VERSION}`,
  'decoder_kv.ort': `${MOONSHINE_MODEL_BASE}decoder_kv.ort?v=${MOONSHINE_MODEL_VERSION}`,
  'frontend.ort': `${MOONSHINE_MODEL_BASE}frontend.ort?v=${MOONSHINE_MODEL_VERSION}`,
  'streaming_config.json': `${MOONSHINE_MODEL_BASE}streaming_config.json?v=${MOONSHINE_MODEL_VERSION}`,
  'tokenizer.bin': `${MOONSHINE_MODEL_BASE}tokenizer.bin?v=${MOONSHINE_MODEL_VERSION}`,
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
    const res = await fetch(`${MOONSHINE_MODEL_BASE}streaming_config.json?v=${MOONSHINE_MODEL_VERSION}`, {
      method: 'GET',
    })
    if (!res.ok) {
      localModelsChecked = false
      return false
    }
    const text = await res.clone().text()
    if (text.startsWith('<!doctype') || text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
      localModelsChecked = false
      return false
    }
    localModelsChecked = true
    return true
  } catch {
    localModelsChecked = false
    return false
  }
}

/** Clear Moonshine model caches only if explicitly requested or corrupted. */
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
 * Automatically scans browser Cache Storage for corrupted HTML entries
 * (e.g. from Vite SPA routing fallback when model files weren't yet present)
 * and purges them so valid ONNX/JSON model files are fetched.
 */
export async function cleanCorruptedMoonshineCaches(): Promise<void> {
  if (typeof caches === 'undefined') return
  try {
    for (const name of ['moonshine-models-v1', 'moonshine-models']) {
      const cache = await caches.open(name).catch(() => null)
      if (!cache) continue
      const keys = await cache.keys()
      let isCorrupted = false
      for (const req of keys) {
        const resp = await cache.match(req)
        if (!resp) continue
        const ct = resp.headers.get('content-type') || ''
        const text = await resp.clone().text().catch(() => '')
        if (
          text.startsWith('<!doctype') ||
          text.startsWith('<!DOCTYPE') ||
          text.startsWith('<html') ||
          ct.includes('text/html')
        ) {
          console.warn(`[Moonshine] Corrupted cache entry found for ${req.url}. Purging ${name}...`)
          isCorrupted = true
          break
        }
      }
      if (isCorrupted) {
        await caches.delete(name)
      }
    }
  } catch (err) {
    console.warn('[Moonshine] Cache inspection warning:', err)
  }
}

/**
 * Builds a live Moonshine transcriber from local model files (or CDN fallback)
 * and starts listening on the microphone. Everything happens 100% on-device.
 */
export async function startMoonshineMic(opts: MoonshineMicOptions): Promise<MicTranscriber> {
  await cleanCorruptedMoonshineCaches()
  const hasLocal = await areLocalMoonshineModelsAvailable()

  const createMic = () => {
    const m = new MicTranscriber()
      .language(MOONSHINE_LANG)
      .modelArch(MOONSHINE_MODEL_ARCH)
      .onText((text) => opts.onText(text))
      .onLine((line) => opts.onLine(line.text))
      .onError((error) => opts.onError?.(error))
      .onProgress((fraction, file) => {
        if (opts.onProgress) {
          const pct = Math.min(100, Math.max(0, Math.round(fraction * 100)))
          const filename = file ? ` (${file.split('/').pop()?.split('?')[0]})` : ''
          opts.onProgress(fraction, `Loading Moonshine model: ${pct}%${filename}`)
        }
      })

    // If local files are downloaded in public/models/moonshine, use them.
    // Otherwise, default to the official Moonshine CDN catalog.
    if (hasLocal) {
      m.modelsFrom(MOONSHINE_FILES)
    }
    return m
  }

  let mic = createMic()
  try {
    await mic.load()
  } catch (err: any) {
    console.warn('[Moonshine] Initial mic.load() failed, purging cache and retrying once...', err)
    await resetMoonshineCache()
    mic.close()
    mic = createMic()
    await mic.load()
  }

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
  await cleanCorruptedMoonshineCaches()
  const hasLocal = await areLocalMoonshineModelsAvailable()

  const progressHandler = (loaded: number, total?: number, file?: string) => {
    if (onProgress && typeof total === 'number' && total > 0) {
      const pct = Math.round((loaded / total) * 100)
      const filename = file ? ` [${file.split('?')[0]}]` : ''
      onProgress(`Loading Moonshine model: ${pct}%${filename}`)
    } else if (onProgress) {
      onProgress('Loading Moonshine model...')
    }
  }

  let transcriber: Transcriber
  const loadTranscriber = async () => {
    if (hasLocal) {
      return Transcriber.loadFromUrls(MOONSHINE_FILES, {
        modelArch: MOONSHINE_MODEL_ARCH,
        onProgress: progressHandler,
      })
    }
    return Transcriber.load({
      language: MOONSHINE_LANG,
      modelArch: MOONSHINE_MODEL_ARCH,
      onProgress: progressHandler,
    })
  }

  try {
    transcriber = await loadTranscriber()
  } catch (err: any) {
    console.warn('[Moonshine] File transcriber load failed, purging cache and retrying...', err)
    await resetMoonshineCache()
    transcriber = await loadTranscriber()
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