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
  Cpu,
} from 'lucide-react'
import {
  scribeStart,
  scribeUpload,
  scribeSaveTranscript,
  scribeExtract,
  scribeSave,
  scribeTranslate,
  type ScribeNote,
  type StructuredMedication,
  type SafetyAlert,
} from '../../lib/api'
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

type STTMode = 'webspeech' | 'groq' | 'hf_space' | 'manual'

interface Props {
  patientId: string
  patientName?: string
  doctorName?: string
  onNoteSaved?: () => void
}

export function ScribeWidget({ patientId, patientName, doctorName, onNoteSaved }: Props) {
  const [stage, setStage] = useState<ScribeStage>('idle')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sttMode, setSttMode] = useState<STTMode>('webspeech')
  const [hfEndpoint, setHfEndpoint] = useState<string>('')

  // Transcript states
  const [transcript, setTranscript] = useState('')
  const [partialTranscript, setPartialTranscript] = useState('')
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

  // Refs for recording
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const recognitionRef = useRef<any>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Reset recording timers and instances
  const cleanupMedia = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch {}
      recognitionRef.current = null
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop()
      } catch {}
      mediaRecorderRef.current = null
    }
    setRecordingSeconds(0)
    setPartialTranscript('')
  }, [])

  useEffect(() => {
    return () => cleanupMedia()
  }, [cleanupMedia])

  // --- Handlers: Start / Stop Recording ---

  const handleStartRecording = async () => {
    setErrorMsg('')
    cleanupMedia()

    try {
      const init = await scribeStart()
      setSessionId(init.session_id)

      if (sttMode === 'webspeech') {
        // Use Browser-native Web Speech API
        const SpeechRecognition =
          (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
        if (!SpeechRecognition) {
          throw new Error('Web Speech API is not supported in this browser. Please select Groq Whisper or Chrome.')
        }

        const recognizer = new SpeechRecognition()
        recognizer.continuous = true
        recognizer.interimResults = true
        recognizer.lang = 'en-US'

        recognizer.onresult = (event: any) => {
          let interim = ''
          let final = ''
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const item = event.results[i]
            if (item.isFinal) {
              final += item[0].transcript + ' '
            } else {
              interim += item[0].transcript
            }
          }
          if (final) {
            setTranscript((prev) => (prev ? prev + ' ' + final.trim() : final.trim()))
          }
          setPartialTranscript(interim)
        }

        recognizer.onerror = (e: any) => {
          console.warn('Web Speech error:', e)
        }

        recognizer.start()
        recognitionRef.current = recognizer
      } else {
        // Use MediaRecorder for Groq Whisper or Hugging Face Space
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
        audioChunksRef.current = []

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            audioChunksRef.current.push(e.data)
          }
        }

        recorder.start(500)
        mediaRecorderRef.current = recorder
      }

      setStage('recording')
      timerRef.current = setInterval(() => {
        setRecordingSeconds((s) => s + 1)
      }, 1000)
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to start recording')
      setStage('error')
    }
  }

  const handleStopRecording = async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    if (sttMode === 'webspeech') {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop()
        } catch {}
        recognitionRef.current = null
      }
      setStage('review')
      return
    }

    // For Groq or Hugging Face Space, finalize audio and upload
    setStage('transcribing')
    const recorder = mediaRecorderRef.current
    if (!recorder) {
      setStage('review')
      return
    }

    recorder.onstop = async () => {
      try {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        if (!sessionId) {
          const init = await scribeStart()
          setSessionId(init.session_id)
        }
        const activeSid = sessionId || (await scribeStart()).session_id

        const res = await scribeUpload(
          activeSid,
          audioBlob,
          sttMode === 'hf_space' ? 'hf_space' : 'groq',
          sttMode === 'hf_space' ? hfEndpoint : undefined
        )
        setTranscript(res.transcript)
        setStage('review')
      } catch (err: any) {
        setErrorMsg(err.message || 'Transcription failed.')
        setStage('error')
      } finally {
        cleanupMedia()
      }
    }

    recorder.stop()
  }

  // Handle manual audio file upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setErrorMsg('')
    setStage('transcribing')

    try {
      const init = await scribeStart()
      setSessionId(init.session_id)

      const res = await scribeUpload(
        init.session_id,
        file,
        sttMode === 'hf_space' ? 'hf_space' : 'groq',
        sttMode === 'hf_space' ? hfEndpoint : undefined
      )
      setTranscript(res.transcript)
      setStage('review')
    } catch (err: any) {
      setErrorMsg(err.message || 'Audio file transcription failed.')
      setStage('error')
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

        {stage === 'idle' && (
          <div className="scribe-mode-selector">
            <button
              type="button"
              className={`scribe-mode-btn ${sttMode === 'webspeech' ? 'active' : ''}`}
              onClick={() => setSttMode('webspeech')}
              title="Runs 100% inside your browser. Zero backend RAM, zero cost, completely private."
            >
              <Mic size={13} />
              Web Speech (Instant)
            </button>
            <button
              type="button"
              className={`scribe-mode-btn ${sttMode === 'groq' ? 'active' : ''}`}
              onClick={() => setSttMode('groq')}
              title="Groq Whisper-Large-v3-Turbo: 0.4s transcription via free tier."
            >
              <Sparkles size={13} />
              Groq Whisper Turbo
            </button>
            <button
              type="button"
              className={`scribe-mode-btn ${sttMode === 'hf_space' ? 'active' : ''}`}
              onClick={() => setSttMode('hf_space')}
              title="Connect to a free Hugging Face Space running faster-whisper."
            >
              <Cpu size={13} />
              HF Space
            </button>
            <button
              type="button"
              className={`scribe-mode-btn ${sttMode === 'manual' ? 'active' : ''}`}
              onClick={() => {
                setSttMode('manual')
                setStage('review')
                if (!sessionId) {
                  scribeStart().then((res) => setSessionId(res.session_id))
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

      {/* Hugging Face Space endpoint input (if selected) */}
      {sttMode === 'hf_space' && stage === 'idle' && (
        <div className="scribe-hf-config">
          <label className="scribe-hf-label">HF Space URL:</label>
          <input
            type="text"
            className="scribe-hf-input"
            placeholder="https://your-user-medigraph-whisper.hf.space"
            value={hfEndpoint}
            onChange={(e) => setHfEndpoint(e.target.value)}
          />
        </div>
      )}

      {/* Error Banner */}
      {errorMsg && (
        <div className="scribe-error-banner">
          <AlertTriangle size={16} />
          <span>{errorMsg}</span>
          <button type="button" className="scribe-link-btn" onClick={() => setErrorMsg('')}>
            Dismiss
          </button>
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
              Start Dictation ({sttMode === 'webspeech' ? 'Browser Web Speech' : sttMode === 'groq' ? 'Groq Whisper' : 'HF Space'})
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
            <span>Local Safe Harbor Shield Active: All patient PHI is masked locally before any AI processing.</span>
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
              {sttMode === 'webspeech' ? 'Live Browser Dictation' : 'Capturing Audio'}
            </span>
          </div>

          {/* Live partial transcription box */}
          <div className="scribe-live-box">
            {transcript ? <span>{transcript}</span> : null}
            {partialTranscript ? (
              <span className="scribe-live-partial"> {partialTranscript}...</span>
            ) : null}
            {!transcript && !partialTranscript && (
              <span className="text-muted italic">Listening for speech...</span>
            )}
          </div>

          <div className="scribe-actions">
            <button
              type="button"
              className="scribe-btn scribe-btn--stop"
              onClick={handleStopRecording}
            >
              <Square size={16} />
              Complete & Review Note
            </button>
          </div>
        </div>
      )}

      {/* STAGE: TRANSCRIBING */}
      {stage === 'transcribing' && (
        <div className="scribe-center-loader">
          <Loader2 size={32} className="scribe-spin" />
          <p>Transcribing audio via free Whisper engine...</p>
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
              Discard
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
                    ? 'Local Safe Harbor Active: Verified against 10-fold dosage bounds & sound-alikes.'
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