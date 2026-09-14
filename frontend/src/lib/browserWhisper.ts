import { pipeline, env } from '@huggingface/transformers'

// Configure transformers.js for optimal browser execution
env.allowLocalModels = false
env.useBrowserCache = true

let transcriberPromise: Promise<any> | null = null

/**
 * Singleton factory to load the Xenova/whisper-tiny.en model in browser memory.
 * Uses browser IndexedDB / Cache API for zero-cost subsequent loads (~40 MB).
 */
export async function getBrowserWhisper(
  onProgress?: (progress: { status: string; progress?: number; file?: string }) => void
) {
  if (!transcriberPromise) {
    transcriberPromise = pipeline(
      'automatic-speech-recognition',
      'Xenova/whisper-tiny.en',
      {
        dtype: 'fp32',
        progress_callback: (p: any) => {
          if (onProgress) {
            onProgress(p)
          }
        },
      }
    ).catch((err) => {
      transcriberPromise = null // Allow retrying if initial download or compilation failed
      throw err
    })
  }
  return transcriberPromise
}

/**
 * Converts an audio Blob into a 16 kHz mono Float32Array required by Whisper models.
 * Uses native Web Audio decoding + OfflineAudioContext resampling for maximum browser compatibility.
 */
export async function blobToAudioBuffer(blob: Blob): Promise<Float32Array> {
  if (!blob || blob.size < 500) {
    return new Float32Array(0)
  }

  const arrayBuffer = await blob.arrayBuffer()
  const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext
  if (!AudioCtxClass) {
    throw new Error('Web Audio API is not supported in this browser.')
  }

  const audioCtx = new AudioCtxClass()

  try {
    // 1. Decode audio using native hardware sample rate (avoids driver rate-mismatch errors)
    const decoded = await audioCtx.decodeAudioData(arrayBuffer)
    if (!decoded || decoded.duration === 0) {
      return new Float32Array(0)
    }

    // 2. Resample cleanly to 16 kHz mono via OfflineAudioContext
    const targetSampleRate = 16000
    const targetLength = Math.max(1, Math.round(decoded.duration * targetSampleRate))
    const offlineCtx = new OfflineAudioContext(1, targetLength, targetSampleRate)

    const source = offlineCtx.createBufferSource()
    source.buffer = decoded
    source.connect(offlineCtx.destination)
    source.start(0)

    const rendered = await offlineCtx.startRendering()
    return rendered.getChannelData(0)
  } finally {
    try {
      await audioCtx.close()
    } catch {}
  }
}

/**
 * Transcribes an audio blob 100% inside the browser tab using Web Transformers.
 * Zero network traffic is sent to external servers.
 */
export async function transcribeAudioInBrowser(
  audioBlob: Blob,
  onProgress?: (msg: string) => void
): Promise<string> {
  if (onProgress) onProgress('Preparing audio buffer...')
  const audioData = await blobToAudioBuffer(audioBlob)

  // If audio is under 100ms or empty, return empty
  if (audioData.length < 1600) {
    return ''
  }

  if (onProgress) onProgress('Loading Whisper ONNX in browser...')
  const transcriber = await getBrowserWhisper((p) => {
    if (onProgress && p.status === 'progress' && typeof p.progress === 'number') {
      onProgress(`Downloading Whisper ONNX: ${Math.round(p.progress)}%`)
    } else if (onProgress && p.status === 'ready') {
      onProgress('Whisper engine ready, transcribing...')
    }
  })

  if (onProgress) onProgress('Transcribing in browser via WebAssembly...')
  const output = await transcriber(audioData, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false,
  })

  if (typeof output === 'string') {
    return output.trim()
  }
  if (output && typeof output.text === 'string') {
    return output.text.trim()
  }
  return ''
}

/**
 * Fast interim audio slice transcription for live rolling speech-to-text.
 */
export async function transcribeAudioSlice(audioBlob: Blob): Promise<string> {
  const audioData = await blobToAudioBuffer(audioBlob)
  if (audioData.length < 16000) {
    // Need at least 1.0 second of audio
    return ''
  }

  const transcriber = await getBrowserWhisper()
  const output = await transcriber(audioData, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false,
  })

  if (typeof output === 'string') {
    return output.trim()
  }
  if (output && typeof output.text === 'string') {
    return output.text.trim()
  }
  return ''
}
