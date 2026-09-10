import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Mic,
  Square,
  Loader2,
  Save,
  FileText,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  PenLine,
  Languages,
  Upload,
  Sparkles,
  ShieldCheck,
  Check,
  Plus,
  Trash2,
  Zap,
  WifiOff,
} from 'lucide-react'
import {
  scribeStart,
  scribeSaveTranscript,
  scribeExtract,
  scribeSave,
  scribeTranslate,
  type ScribeNote,
  type StructuredMedication,
  type SafetyAlert,
} from '../../lib/api'
import { transcribeAudioInBrowser, transcribeAudioSlice } from '../../lib/browserWhisper'
import {
  startMoonshineMic,
  stopMoonshineMic,
  transcribeFileWithMoonshine,
} from '../../lib/browserMoonshine'
import type { MicTranscriber } from '@moonshine-ai/moonshine-wasm'
import { useOnline } from '../../hooks/useOnline'
import './ScribeWidget.css'

type ScribeStage =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'review'
  | 'extracting'
  | 'studio' // Interactive Post-Extraction Approval Studio
  | 'saved'
  | 'error'

type STTMode = 'browser-whisper' | 'moonshine' | 'manual'

interface Props {
  patientId: string
  patientName?: string
  doctorName?: string
  onNoteSaved?: () => void
}

export function ScribeWidget({ patientId, patientName, doctorName, onNoteSaved }: Props) {
  const [stage, setStage] = useState<ScribeStage>('idle')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sttMode, setSttMode] = useState<STTMode>('browser-whisper')
  const [clientWhisperStatus, setClientWhisperStatus] = useState<string>('')

  // Transcript states
  const [transcript, setTranscript] = useState('')
  const [liveInterimText, setLiveInterimText] = useState('')
  const [recordingSeconds, setRecordingSeconds] = useState(0)

  // Live translation
  const [enableTranslation, setEnableTranslation] = useState(false)
  const [targetLang, setTargetLang] = useState('English')
  const [liveTranslation, setLiveTranslation] = useState('')
  const [isTranslating, setIsTranslating] = useState(false)

  // Error & loading
  const [errorMsg, setErrorMsg] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  // Interactive Post-Extraction Approval Studio states
  const [extractedTitle, setExtractedTitle] = useState('')
  const [extractedSummary, setExtractedSummary] = useState('')
  const [diagnoses, setDiagnoses] = useState<string[]>([])
  const [newDiagnosisInput, setNewDiagnosisInput] = useState('')
  const [medications, setMedications] = useState<StructuredMedication[]>([])
  const [actionItems, setActionItems] = useState<string[]>([])
  const [newActionInput, setNewActionInput] = useState('')
  const [safetyAlerts, setSafetyAlerts] = useState<SafetyAlert[]>([])
  const [isDeidentified, setIsDeidentified] = useState(true)

  // New med modal/inline inputs
  const [showAddMed, setShowAddMed] = useState(false)
  const [newMedName, setNewMedName] = useState('')
  const [newMedDosage, setNewMedDosage] = useState('')
  const [newMedUnit, setNewMedUnit] = useState('mg')
  const [newMedFreq, setNewMedFreq] = useState('once daily')

  // Refs for recording & live streaming
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedMimeTypeRef = useRef<string>('audio/webm')
  const audioChunksRef = useRef<Blob[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const liveChunkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isChunkProcessingRef = useRef<boolean>(false)
  const sessionIdRef = useRef<string | null>(null)

  const moonshineMicRef = useRef<MicTranscriber | null>(null)
  const moonshineLinesRef = useRef<string[]>([])
  const moonshineInterimRef = useRef<string>('')

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  const isOnline = useOnline()

  // Start a backend scribe session; if the backend is unreachable (offline),
  // fall back to a local session id so on-device Moonshine keeps working.
  const startOrLocalSession = useCallback(async (): Promise<string> => {
    try {
      const init = await scribeStart()
      return init.session_id
    } catch {
      return typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }
  }, [])

  // Reset recording timers and hardware instances
  const cleanupMedia = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (liveChunkTimerRef.current) {
      clearInterval(liveChunkTimerRef.current)
      liveChunkTimerRef.current = null
    }
    isChunkProcessingRef.current = false
    if (moonshineMicRef.current) {
      const mic = moonshineMicRef.current
      moonshineMicRef.current = null
      stopMoonshineMic(mic).catch(() => {})
    }
    moonshineLinesRef.current = []
    moonshineInterimRef.current = ''
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop()
      } catch {}
      mediaRecorderRef.current = null
    }
    setRecordingSeconds(0)
  }, [])

  useEffect(() => {
    return () => cleanupMedia()
  }, [cleanupMedia])

  // Detect supported browser audio recording container
  const getSupportedMimeType = (): string => {
    if (typeof MediaRecorder === 'undefined') return ''
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/wav',
    ]
    for (const t of candidates) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
        return t
      }
    }
    return ''
  }

  // --- Handlers: Start / Stop Recording ---

  const handleStartRecording = async () => {
    setErrorMsg('')
    setLiveInterimText('')
    if (sttMode === 'moonshine') {
      await handleStartMoonshineRecording()
      return
    }
    cleanupMedia()

    try {
      const init = await scribeStart()
      setSessionId(init.session_id)
      sessionIdRef.current = init.session_id

      // Capture microphone audio via MediaRecorder
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const mimeType = getSupportedMimeType()
      recordedMimeTypeRef.current = mimeType
      const options: MediaRecorderOptions = mimeType ? { mimeType } : {}
      const recorder = new MediaRecorder(stream, options)
      audioChunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data)
        }
      }

      recorder.start(500)
      mediaRecorderRef.current = recorder

      setStage('recording')
      timerRef.current = setInterval(() => {
        setRecordingSeconds((s) => s + 1)
      }, 1000)

      // Start rolling 3.5s background chunk worker for live interim STT
      liveChunkTimerRef.current = setInterval(async () => {
        if (isChunkProcessingRef.current) return
        if (audioChunksRef.current.length < 3) return // Need at least ~1.5s of recorded chunks

        const mime = recordedMimeTypeRef.current || 'audio/webm'
        const interimBlob = new Blob([...audioChunksRef.current], { type: mime })
        if (interimBlob.size < 4000) return

        isChunkProcessingRef.current = true
        try {
          const sliceText = await transcribeAudioSlice(interimBlob)
          if (sliceText) setLiveInterimText(sliceText)
        } catch {
          // Background slice error is non-blocking
        } finally {
          isChunkProcessingRef.current = false
        }
      }, 3000)
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to start recording. Please allow microphone access.')
      setStage('idle')
    }
  }

  // Start on-device Moonshine streaming transcription (100% in-browser WASM).
  const handleStartMoonshineRecording = async () => {
    try {
      const session = await startOrLocalSession()
      setSessionId(session)
      sessionIdRef.current = session

      moonshineLinesRef.current = []
      moonshineInterimRef.current = ''
      const composeMoonshineLive = () =>
        [...moonshineLinesRef.current, moonshineInterimRef.current].filter(Boolean).join(' ')
      setStage('transcribing')
      setClientWhisperStatus('Preparing Moonshine model (Medium Streaming)...')

      const mic = await startMoonshineMic({
        onText: (text) => {
          moonshineInterimRef.current = text
          setLiveInterimText(composeMoonshineLive())
        },
        onLine: (text) => {
          moonshineLinesRef.current.push(text.trim())
          moonshineInterimRef.current = ''
          setLiveInterimText(composeMoonshineLive())
        },
        onProgress: (_fraction, status) => setClientWhisperStatus(status),
        onError: (err) => setErrorMsg(err.message || 'Moonshine transcription error.'),
      })
      moonshineMicRef.current = mic

      setClientWhisperStatus('')
      setStage('recording')
      timerRef.current = setInterval(() => {
        setRecordingSeconds((s) => s + 1)
      }, 1000)
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to start Moonshine. Please allow microphone access.')
      setStage('idle')
    }
  }

  const handleStopRecording = async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (liveChunkTimerRef.current) {
      clearInterval(liveChunkTimerRef.current)
      liveChunkTimerRef.current = null
    }
    isChunkProcessingRef.current = false

    if (sttMode === 'moonshine') {
      await handleStopMoonshineRecording()
      return
    }

    setStage('transcribing')
    const recorder = mediaRecorderRef.current
    if (!recorder) {
      setStage('review')
      return
    }

    try {
      // Safely await recorder stopping and collecting all audio chunks
      const audioBlob = await new Promise<Blob>((resolve) => {
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            audioChunksRef.current.push(e.data)
          }
        }
        recorder.onstop = () => {
          const mime = recordedMimeTypeRef.current || 'audio/webm'
          const blob = new Blob(audioChunksRef.current, { type: mime })
          resolve(blob)
        }
        try {
          if (recorder.state === 'recording') {
            recorder.requestData()
            recorder.stop()
          } else {
            const mime = recordedMimeTypeRef.current || 'audio/webm'
            resolve(new Blob(audioChunksRef.current, { type: mime }))
          }
        } catch {
          const mime = recordedMimeTypeRef.current || 'audio/webm'
          resolve(new Blob(audioChunksRef.current, { type: mime }))
        }
      })

      // Immediately release hardware microphone stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
        streamRef.current = null
      }
      mediaRecorderRef.current = null

      if (audioBlob.size < 500) {
        if (liveInterimText) {
          setTranscript((prev) => (prev ? `${prev} ${liveInterimText}` : liveInterimText))
        } else {
          setErrorMsg('Recording was very short or silent. You can dictate again or type directly.')
        }
        setStage('review')
        return
      }

      const activeSid = sessionId || (await startOrLocalSession())
      if (!sessionId) setSessionId(activeSid)

      setClientWhisperStatus('Finalizing complete consultation transcript in browser...')
      const clientText = await transcribeAudioInBrowser(audioBlob, (msg) => {
        setClientWhisperStatus(msg)
      })
      const finalText = clientText || liveInterimText
      if (finalText) {
        setTranscript((prev) => (prev ? `${prev} ${finalText}` : finalText))
      } else {
        setErrorMsg('No speech recognized in recording. You can dictate again or type directly.')
      }
      setClientWhisperStatus('')
      setStage('review')
    } catch (err: any) {
      if (liveInterimText) {
        setTranscript((prev) => (prev ? `${prev} ${liveInterimText}` : liveInterimText))
      } else {
        setErrorMsg(err.message || 'Transcription failed.')
      }
      setStage('review')
    } finally {
      cleanupMedia()
    }
  }

  // Stop on-device Moonshine streaming and merge final lines into the transcript.
  const handleStopMoonshineRecording = async () => {
    const mic = moonshineMicRef.current
    moonshineMicRef.current = null

    setStage('transcribing')
    setClientWhisperStatus('Finalizing complete consultation transcript on-device...')

    try {
      if (mic) {
        await stopMoonshineMic(mic)
      }

      const finalText = [...moonshineLinesRef.current, moonshineInterimRef.current]
        .filter(Boolean)
        .join(' ')
        .trim()

      if (finalText) {
        setTranscript((prev) => (prev ? `${prev} ${finalText}` : finalText))
      } else {
        setErrorMsg('No speech recognized in recording. You can dictate again or type directly.')
      }

      moonshineLinesRef.current = []
      moonshineInterimRef.current = ''
      setLiveInterimText('')
      setClientWhisperStatus('')
      setStage('review')
    } catch (err: any) {
      if (moonshineLinesRef.current.length > 0 || moonshineInterimRef.current) {
        const fallbackText = [...moonshineLinesRef.current, moonshineInterimRef.current]
          .filter(Boolean)
          .join(' ')
          .trim()
        setTranscript((prev) => (prev ? `${prev} ${fallbackText}` : fallbackText))
      } else {
        setErrorMsg(err.message || 'Transcription failed.')
      }
      moonshineLinesRef.current = []
      moonshineInterimRef.current = ''
      setLiveInterimText('')
      setClientWhisperStatus('')
      setStage('review')
    } finally {
      cleanupMedia()
    }
  }

  // Handle manual audio file upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setErrorMsg('')
    setStage('transcribing')

    try {
      const init = await startOrLocalSession()
      setSessionId(init)

      if (sttMode === 'moonshine') {
        setClientWhisperStatus('Transcribing uploaded file in browser via Moonshine...')
        const clientText = await transcribeFileWithMoonshine(file, (msg) => {
          setClientWhisperStatus(msg)
        })
        setTranscript(clientText)
      } else {
        setClientWhisperStatus('Transcribing uploaded file in browser via Whisper...')
        const clientText = await transcribeAudioInBrowser(file, (msg) => {
          setClientWhisperStatus(msg)
        })
        setTranscript(clientText)
      }
      setClientWhisperStatus('')
      setStage('review')
    } catch (err: any) {
      setErrorMsg(err.message || 'Audio file transcription failed.')
      setStage('review')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // Handle translation
  const handleTranslate = async () => {
    if (!transcript) return
    setIsTranslating(true)
    try {
      const res = await scribeTranslate(transcript, targetLang)
      setLiveTranslation(res.translated_text || '')
    } catch {
      // translation fallback
    } finally {
      setIsTranslating(false)
    }
  }

  // Handle approval and triggering extraction
  const handleExtractNote = async () => {
    if (!sessionId || !transcript.trim()) return

    setStage('extracting')
    setErrorMsg('')

    try {
      // 1. Save doctor-reviewed transcript
      await scribeSaveTranscript(sessionId, transcript.trim(), true)

      // 2. Trigger Safe Harbor de-identification + Groq extraction + safety audit
      const res = await scribeExtract(sessionId, patientName, doctorName, true)
      const note = res.note

      setExtractedTitle(note.title || 'Clinical Consultation Note')
      setExtractedSummary(note.summary || '')
      setDiagnoses(note.diagnoses || [])

      // Normalize medications
      const meds: StructuredMedication[] = (note.medications_discussed || []).map((m) => {
        if (typeof m === 'string') {
          return { name: m }
        }
        return m
      })
      setMedications(meds)
      setActionItems(note.action_items || [])
      setSafetyAlerts(note.safety_alerts || [])
      setIsDeidentified(note.deidentified ?? true)

      setStage('studio')
    } catch (err: any) {
      setErrorMsg(err.message || 'Clinical extraction failed.')
      setStage('error')
    }
  }

  // --- Interactive Studio Actions ---

  // 1-Click Dosage Quick-Fix
  const handleQuickFix = (medIndex: number, alert: SafetyAlert) => {
    if (!alert.quick_fix) return

    setMedications((prev) => {
      const updated = [...prev]
      const target = { ...updated[medIndex] }
      target.dosage = alert.quick_fix!.dosage
      target.unit = alert.quick_fix!.unit
      target.safety_alerts = (target.safety_alerts || []).filter((a) => a.type !== alert.type)
      updated[medIndex] = target
      return updated
    })

    // Also remove from global alerts
    setSafetyAlerts((prev) => prev.filter((a) => !(a.medication.toLowerCase() === alert.medication.toLowerCase() && a.type === alert.type)))
  }

  const handleRemoveMedication = (index: number) => {
    setMedications((prev) => prev.filter((_, i) => i !== index))
  }

  const handleAddMedication = () => {
    if (!newMedName.trim()) return
    const newMed: StructuredMedication = {
      name: newMedName.trim(),
      dosage: newMedDosage.trim() || undefined,
      unit: newMedUnit.trim() || undefined,
      frequency: newMedFreq.trim() || undefined,
      route: 'oral',
    }
    setMedications((prev) => [...prev, newMed])
    setNewMedName('')
    setNewMedDosage('')
    setShowAddMed(false)
  }

  const handleRemoveDiagnosis = (index: number) => {
    setDiagnoses((prev) => prev.filter((_, i) => i !== index))
  }

  const handleAddDiagnosis = () => {
    if (!newDiagnosisInput.trim()) return
    setDiagnoses((prev) => [...prev, newDiagnosisInput.trim()])
    setNewDiagnosisInput('')
  }

  const handleRemoveAction = (index: number) => {
    setActionItems((prev) => prev.filter((_, i) => i !== index))
  }

  const handleAddAction = () => {
    if (!newActionInput.trim()) return
    setActionItems((prev) => [...prev, newActionInput.trim()])
    setNewActionInput('')
  }

  // Save approved note to Neo4j Knowledge Graph
  const handleSaveToGraph = async () => {
    if (!sessionId) return
    setIsSaving(true)
    setErrorMsg('')

    try {
      const finalizedNote: ScribeNote = {
        title: extractedTitle.trim() || 'Clinical Consultation Note',
        summary: extractedSummary.trim(),
        diagnoses,
        action_items: actionItems,
        medications_discussed: medications,
      }

      await scribeSave(sessionId, patientId, finalizedNote)
      setStage('saved')
      onNoteSaved?.()
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to save note to knowledge graph.')
    } finally {
      setIsSaving(false)
    }
  }

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${s < 10 ? '0' : ''}${s}`
  }

  // --- Render ---

  return (
    <div className="scribe-widget">
      {/* Header with STT Provider Switcher */}
      <div className="scribe-header-row">
        <div className="scribe-widget-title">
          <FileText size={18} className="text-accent" />
          <span>AI Clinical Scribe Studio</span>
        </div>

        {!isOnline && (
          <div className="scribe-offline-pill" title="No internet connection detected. On-device transcription keeps working; translation, extraction, and saving need internet.">
            <WifiOff size={13} />
            Offline — On-device transcription active
          </div>
        )}

        {stage === 'idle' && (
          <div className="scribe-mode-selector">
            <button
              type="button"
              className={`scribe-mode-btn ${sttMode === 'browser-whisper' ? 'active' : ''}`}
              onClick={() => setSttMode('browser-whisper')}
              title="Runs Whisper-Tiny ONNX 100% inside your browser tab via WebAssembly. 0 bytes leave your machine, completely private."
            >
              <Mic size={13} />
              Whisper Web (In-Browser)
            </button>
            <button
              type="button"
              className={`scribe-mode-btn ${sttMode === 'moonshine' ? 'active' : ''}`}
              onClick={() => setSttMode('moonshine')}
              title="Runs the Moonshine Medium Streaming ONNX model 100% inside your browser tab via WebAssembly. 0 bytes leave your machine, completely private."
            >
              <Zap size={13} />
              Moonshine (On-Device)
            </button>
            <button
              type="button"
              className={`scribe-mode-btn ${sttMode === 'manual' ? 'active' : ''}`}
              onClick={() => {
                setSttMode('manual')
                setStage('review')
                if (!sessionId) {
                  startOrLocalSession().then((res) => setSessionId(res))
                }
              }}
              title="Quickly type or paste doctor consultation notes."
            >
              <PenLine size={13} />
              Type / Paste
            </button>
          </div>
        )}
      </div>

      {/* Error Banner */}
      {errorMsg && (
        <div className="scribe-error-banner">
          <AlertTriangle size={16} />
          <span>{errorMsg}</span>
          <button
            type="button"
            className="scribe-link-btn"
            onClick={() => {
              setErrorMsg('')
              if (stage === 'error') setStage('idle')
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* STAGE: ERROR RECOVERY */}
      {stage === 'error' && (
        <div className="scribe-idle-container">
          <div className="scribe-actions">
            <button
              type="button"
              className="scribe-btn scribe-btn--primary"
              onClick={() => {
                setErrorMsg('')
                setStage('idle')
              }}
            >
              <RotateCcw size={15} />
              Try Again
            </button>
            <button
              type="button"
              className="scribe-btn scribe-btn--secondary"
              onClick={() => {
                setErrorMsg('')
                setSttMode('manual')
                setStage('review')
              }}
            >
              <PenLine size={15} />
              Type Notes Directly
            </button>
          </div>
        </div>
      )}

      {/* STAGE: IDLE */}
      {stage === 'idle' && (
        <div className="scribe-idle-container">
          <p className="scribe-idle-subtext">
            Dictate patient findings, medication orders, or consultation dialogue.
            Speech is processed securely with zero paid APIs.
          </p>

          <div className="scribe-actions">
            <button
              type="button"
              className="scribe-btn scribe-btn--primary"
              onClick={handleStartRecording}
            >
              <Mic size={16} />
              {sttMode === 'moonshine'
                ? 'Start Dictation (Moonshine (ONNX On-Device))'
                : 'Start Dictation (Whisper Web (ONNX In-Browser))'}
            </button>

            <label className="scribe-btn scribe-btn--secondary scribe-upload-label">
              <Upload size={14} />
              Upload Audio File
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                onChange={handleFileUpload}
                style={{ display: 'none' }}
              />
            </label>
          </div>

          <div className="scribe-privacy-pill">
            <ShieldCheck size={14} className="text-success" />
            <span>
              {sttMode === 'moonshine'
                ? 'Moonshine Active: Model runs 100% in-browser via WebAssembly. 0 bytes leave your machine.'
                : 'Client-Side Whisper Active: Model runs 100% in-browser via WebAssembly. 0 bytes leave your machine.'}
            </span>
          </div>
        </div>
      )}

      {/* STAGE: RECORDING */}
      {stage === 'recording' && (
        <div className="scribe-recording-box">
          <div className="scribe-recording-head">
            <div className="scribe-rec-dot" />
            <span className="scribe-rec-timer">Recording: {formatTimer(recordingSeconds)}</span>
            <span className="scribe-mode-tag">
              {sttMode === 'moonshine'
                ? 'Moonshine: Capturing Audio (On-Device)'
                : 'Whisper Web: Capturing Audio (In-Browser)'}
            </span>
          </div>

          {/* Live recording status box */}
          <div className="scribe-live-box">
            {liveInterimText ? (
              <div className="scribe-live-interim-wrap">
                <div className="scribe-live-interim-badge">
                  <span className="scribe-live-pulse-dot" />
                  <span>Live Speech-to-Text Stream</span>
                </div>
                <div className="scribe-live-interim-text">
                  &ldquo;{liveInterimText}&rdquo;
                </div>
              </div>
            ) : (
              <div className="scribe-live-listening">
                <span className="scribe-live-pulse-dot" />
                <span className="text-muted italic">
                  Listening for clinical speech... Real-time transcription streams here as you speak.
                </span>
              </div>
            )}
          </div>

          <div className="scribe-actions">
            <button
              type="button"
              className="scribe-btn scribe-btn--stop"
              onClick={handleStopRecording}
            >
              <Square size={16} />
              Stop & Transcribe Note
            </button>
          </div>
        </div>
      )}

      {/* STAGE: TRANSCRIBING */}
      {stage === 'transcribing' && (
        <div className="scribe-center-loader">
          <Loader2 size={32} className="scribe-spin" />
          <p>
            {clientWhisperStatus ||
              (sttMode === 'moonshine'
                ? 'Transcribing audio via Moonshine engine...'
                : 'Transcribing audio via Whisper engine...')}
          </p>
        </div>
      )}

      {/* STAGE: REVIEW TRANSCRIPT */}
      {stage === 'review' && (
        <div className="scribe-review-box">
          <div className="scribe-review-head">
            <div className="scribe-sec-label">Doctor Consultation Transcript</div>
            <div className="scribe-trans-tools">
              <button
                type="button"
                className="scribe-tool-btn"
                onClick={() => setEnableTranslation(!enableTranslation)}
              >
                <Languages size={13} />
                {enableTranslation ? 'Hide Translation' : 'Translate'}
              </button>
            </div>
          </div>

          <textarea
            className="scribe-textarea"
            rows={5}
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder="Consultation transcript will appear here. You can edit, format, or type directly..."
          />

          {/* Translation controls */}
          {enableTranslation && (
            <div className="scribe-translation-panel">
              <div className="scribe-translation-controls">
                <span>Translate to:</span>
                <select
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value)}
                  className="scribe-select"
                >
                  <option value="English">English</option>
                  <option value="Spanish">Spanish</option>
                  <option value="Hindi">Hindi</option>
                  <option value="Tamil">Tamil</option>
                  <option value="French">French</option>
                  <option value="German">German</option>
                </select>
                <button
                  type="button"
                  className="scribe-btn scribe-btn--secondary scribe-btn--sm"
                  onClick={handleTranslate}
                  disabled={isTranslating || !transcript}
                >
                  {isTranslating ? <Loader2 size={12} className="scribe-spin" /> : 'Run Translation'}
                </button>
              </div>

              {liveTranslation && (
                <div className="scribe-translation-result">
                  <div className="scribe-trans-header">Translated Clinical Text ({targetLang})</div>
                  <p>{liveTranslation}</p>
                </div>
              )}
            </div>
          )}

          <div className="scribe-actions">
            {sttMode !== 'manual' && (
              <button
                type="button"
                className="scribe-btn scribe-btn--secondary"
                onClick={handleStartRecording}
                title="Dictate additional sentences to append to this transcript"
              >
                <Mic size={14} />
                Dictate More (Append)
              </button>
            )}

            <button
              type="button"
              className="scribe-btn scribe-btn--primary"
              onClick={handleExtractNote}
              disabled={!transcript.trim()}
            >
              <Sparkles size={16} />
              Extract Structured Note & Run Safety Audit
            </button>

            <button
              type="button"
              className="scribe-btn scribe-btn--secondary"
              onClick={() => {
                setStage('idle')
                setTranscript('')
              }}
            >
              <RotateCcw size={14} />
              Clear & Start Over
            </button>
          </div>
        </div>
      )}

      {/* STAGE: EXTRACTING */}
      {stage === 'extracting' && (
        <div className="scribe-center-loader">
          <Loader2 size={32} className="scribe-spin" />
          <p>Sanitizing PHI locally & extracting structured clinical note...</p>
        </div>
      )}

      {/* STAGE: INTERACTIVE APPROVAL STUDIO (20-Second Physician Review) */}
      {stage === 'studio' && (
        <div className="scribe-studio">
          <div className="scribe-studio-banner">
            <div className="scribe-shield-info">
              <ShieldCheck size={18} className="text-success" />
              <div>
                <span className="scribe-shield-title">Interactive Approval Studio</span>
                <span className="scribe-shield-subtitle">
                  {isDeidentified
                    ? 'Local Safe Harbor Active: All PHI (names, DOB, age) removed. Verified against 10-fold dosage bounds & sound-alikes.'
                    : 'Clinical safety audit complete.'}
                </span>
              </div>
            </div>
            <div className="scribe-studio-badge">Pending Doctor Sign-off</div>
          </div>

          {/* Consultation Title & Summary */}
          <div className="scribe-studio-card">
            <div className="scribe-field-group">
              <label className="scribe-field-label">Consultation Focus / Title</label>
              <input
                type="text"
                className="scribe-input"
                value={extractedTitle}
                onChange={(e) => setExtractedTitle(e.target.value)}
              />
            </div>

            <div className="scribe-field-group">
              <label className="scribe-field-label">Clinical Summary</label>
              <textarea
                className="scribe-textarea scribe-summary-area"
                rows={3}
                value={extractedSummary}
                onChange={(e) => setExtractedSummary(e.target.value)}
              />
            </div>
          </div>

          {/* Diagnoses Chips */}
          <div className="scribe-studio-card">
            <div className="scribe-studio-card-head">
              <span className="scribe-field-label">Diagnoses & Conditions ({diagnoses.length})</span>
              <span className="scribe-hint">Click &apos;x&apos; to remove or add below</span>
            </div>

            <div className="scribe-chips-wrap">
              {diagnoses.map((d, i) => (
                <div key={i} className="scribe-chip">
                  <Check size={12} className="scribe-chip-check" />
                  <span>{d}</span>
                  <button
                    type="button"
                    className="scribe-chip-del"
                    onClick={() => handleRemoveDiagnosis(i)}
                    title="Remove diagnosis"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            <div className="scribe-add-row">
              <input
                type="text"
                placeholder="Add diagnosis e.g. Type 2 Diabetes..."
                className="scribe-input scribe-input--sm"
                value={newDiagnosisInput}
                onChange={(e) => setNewDiagnosisInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddDiagnosis())}
              />
              <button
                type="button"
                className="scribe-btn scribe-btn--secondary scribe-btn--sm"
                onClick={handleAddDiagnosis}
              >
                <Plus size={13} /> Add
              </button>
            </div>
          </div>

          {/* Medications Discussed & Safety Bounds Audit */}
          <div className="scribe-studio-card">
            <div className="scribe-studio-card-head">
              <span className="scribe-field-label">Prescriptions & Dosage Safety Audit</span>
              <button
                type="button"
                className="scribe-btn scribe-btn--secondary scribe-btn--sm"
                onClick={() => setShowAddMed(!showAddMed)}
              >
                <Plus size={13} /> Add Medication
              </button>
            </div>

            {/* Optional inline add medication */}
            {showAddMed && (
              <div className="scribe-add-med-box">
                <input
                  type="text"
                  placeholder="Medication name e.g. Metformin"
                  className="scribe-input scribe-input--sm"
                  value={newMedName}
                  onChange={(e) => setNewMedName(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Dose (e.g. 500)"
                  className="scribe-input scribe-input--sm"
                  style={{ width: '80px' }}
                  value={newMedDosage}
                  onChange={(e) => setNewMedDosage(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Unit (mg)"
                  className="scribe-input scribe-input--sm"
                  style={{ width: '60px' }}
                  value={newMedUnit}
                  onChange={(e) => setNewMedUnit(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Freq (e.g. twice daily)"
                  className="scribe-input scribe-input--sm"
                  value={newMedFreq}
                  onChange={(e) => setNewMedFreq(e.target.value)}
                />
                <button
                  type="button"
                  className="scribe-btn scribe-btn--primary scribe-btn--sm"
                  onClick={handleAddMedication}
                >
                  Confirm
                </button>
              </div>
            )}

            <div className="scribe-meds-list">
              {medications.length === 0 ? (
                <div className="text-muted text-sm italic">No medications recorded.</div>
              ) : (
                medications.map((m, idx) => {
                  // Find any matching safety alerts for this medication
                  const medAlerts = safetyAlerts.filter(
                    (a) => a.medication.toLowerCase() === m.name.toLowerCase()
                  )

                  return (
                    <div
                      key={idx}
                      className={`scribe-med-card ${medAlerts.length > 0 ? 'scribe-med-card--alert' : ''}`}
                    >
                      <div className="scribe-med-top">
                        <div className="scribe-med-title-row">
                          <span className="scribe-med-name">{m.name}</span>
                          <span className="scribe-med-dosage-badge">
                            {m.dosage ? `${m.dosage} ${m.unit || 'mg'}` : 'Unspecified dose'}
                          </span>
                          {m.frequency && (
                            <span className="scribe-med-freq-badge">{m.frequency}</span>
                          )}
                          {m.route && <span className="scribe-med-route-badge">{m.route}</span>}
                        </div>

                        <button
                          type="button"
                          className="scribe-icon-del"
                          onClick={() => handleRemoveMedication(idx)}
                          title="Remove medication"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>

                      {m.rationale && (
                        <div className="scribe-med-rationale">Indication: {m.rationale}</div>
                      )}

                      {/* Safety Alert & 1-Click Quick-Fix Button */}
                      {medAlerts.map((alert, aIdx) => (
                        <div key={aIdx} className="scribe-alert-box">
                          <div className="scribe-alert-content">
                            <AlertTriangle size={16} className="text-warning shrink-0" />
                            <span className="scribe-alert-msg">{alert.message}</span>
                          </div>

                          {alert.quick_fix && (
                            <button
                              type="button"
                              className="scribe-quick-fix-btn"
                              onClick={() => handleQuickFix(idx, alert)}
                            >
                              <Sparkles size={13} />
                              Quick-Fix: Change to {alert.quick_fix.dosage} {alert.quick_fix.unit}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* Action Items Checklist */}
          <div className="scribe-studio-card">
            <div className="scribe-studio-card-head">
              <span className="scribe-field-label">Clinical Action Items & Follow-ups</span>
            </div>

            <div className="scribe-actions-list">
              {actionItems.map((act, i) => (
                <div key={i} className="scribe-action-item">
                  <CheckCircle2 size={15} className="text-success shrink-0" />
                  <span className="scribe-action-text">{act}</span>
                  <button
                    type="button"
                    className="scribe-icon-del"
                    onClick={() => handleRemoveAction(i)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            <div className="scribe-add-row">
              <input
                type="text"
                placeholder="Add follow-up action item..."
                className="scribe-input scribe-input--sm"
                value={newActionInput}
                onChange={(e) => setNewActionInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddAction())}
              />
              <button
                type="button"
                className="scribe-btn scribe-btn--secondary scribe-btn--sm"
                onClick={handleAddAction}
              >
                <Plus size={13} /> Add
              </button>
            </div>
          </div>

          {/* Final Save Action */}
          <div className="scribe-studio-footer">
            <button
              type="button"
              className="scribe-btn scribe-btn--primary scribe-btn--lg"
              onClick={handleSaveToGraph}
              disabled={isSaving}
            >
              {isSaving ? <Loader2 size={16} className="scribe-spin" /> : <Save size={16} />}
              Approve & Commit Note to Knowledge Graph
            </button>

            <button
              type="button"
              className="scribe-btn scribe-btn--secondary"
              onClick={() => setStage('review')}
            >
              Back to Transcript
            </button>
          </div>
        </div>
      )}

      {/* STAGE: SAVED SUCCESS */}
      {stage === 'saved' && (
        <div className="scribe-saved-card">
          <CheckCircle2 size={36} className="text-success" />
          <div className="scribe-saved-info">
            <h4>Consultation Note Saved to Knowledge Graph</h4>
            <p>
              Diagnoses and active medications have been connected to Patient{' '}
              <strong>{patientName || patientId}</strong> in the Neo4j graph.
            </p>
          </div>
          <button
            type="button"
            className="scribe-btn scribe-btn--primary"
            onClick={() => {
              setStage('idle')
              setTranscript('')
              setMedications([])
              setDiagnoses([])
              setActionItems([])
            }}
          >
            Start Another Dictation
          </button>
        </div>
      )}
    </div>
  )
}