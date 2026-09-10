import { useEffect, useRef, useState, useCallback } from 'react'
import { Send, Loader2, Sparkles, RotateCcw, Trash2, HelpCircle } from 'lucide-react'
import {
  chatQuery,
  fetchPatients,
  fetchChatSuggestions,
  type Patient,
  type ChatSuggestion,
  type ChatTraversal,
} from '../../lib/api'
import { ChatMarkdown } from './ChatMarkdown'
import { TraversalPanel, type TraversalInstance } from './TraversalPanel'
import { cleanPersonName } from '../../lib/formatters'
import './ChatPanel.css'

interface Message {
  role: 'user' | 'assistant'
  text: string
  error?: boolean
  traversal?: ChatTraversal | null
}

interface Props {
  compact?: boolean
  /** Patient id to auto-select in the dropdown. Passed from the layout when
      the user is inside a patient page (e.g. /patients/P001). */
  preselectedPatientId?: string
}

export function ChatPanel({ compact = false, preselectedPatientId }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [patientId, setPatientId] = useState<string>('')
  const [patients, setPatients] = useState<Patient[]>([])
  const [suggestions, setSuggestions] = useState<ChatSuggestion[]>([])
  const [suggestionsMode, setSuggestionsMode] = useState<'patient' | 'cohort'>('cohort')
  const [patientName, setPatientName] = useState<string | null>(null)
  const [loadingSuggestions, setLoadingSuggestions] = useState(false)
  const [busy, setBusy] = useState(false)
  const [traversalInstances, setTraversalInstances] = useState<TraversalInstance[]>([])
  const [activeTraversalIndex, setActiveTraversalIndex] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchPatients()
      .then((p) => {
        if (!cancelled) setPatients(p)
      })
      .catch(() => {
        if (!cancelled) setPatients([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Reflect the caller-provided patient (e.g. from the current patient page).
  useEffect(() => {
    if (preselectedPatientId) setPatientId(preselectedPatientId)
  }, [preselectedPatientId])

  const loadSuggestions = useCallback(async (targetPid?: string) => {
    setLoadingSuggestions(true)
    try {
      const res = await fetchChatSuggestions(targetPid || undefined)
      if (res.suggestions && res.suggestions.length > 0) {
        setSuggestions(res.suggestions)
        setSuggestionsMode(res.mode || (targetPid ? 'patient' : 'cohort'))
        setPatientName(res.patient_name ? cleanPersonName(res.patient_name) : null)
      }
    } catch {
      // Keep existing suggestions if fetch fails
    } finally {
      setLoadingSuggestions(false)
    }
  }, [])

  useEffect(() => {
    loadSuggestions(patientId)
  }, [patientId, loadSuggestions])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, busy])

  async function submit(text: string) {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    const userMsg: Message = { role: 'user', text: trimmed }
    setMessages((m) => [...m, userMsg])
    setInput('')
    setBusy(true)
    try {
      const res = await chatQuery(trimmed, patientId || undefined)
      const answer = res.error?.length ? res.error : res.answer
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          text: answer ?? 'No answer available.',
          error: !!res.error,
          traversal: res.traversal,
        },
      ])

      const resolvedPid = res.patient_id ?? (patientId || undefined)
      const p = resolvedPid ? patients.find((x) => x.id === resolvedPid) : undefined
      const label =
        p && p.first_name
          ? cleanPersonName(`${p.first_name} ${p.last_name}`)
          : patientName

      setTraversalInstances((prev) => [
        ...prev,
        {
          id: Date.now(),
          query: trimmed,
          traversal: res.traversal ?? null,
          patientName: label,
        },
      ])
      setActiveTraversalIndex((prev) => prev + 1)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Chat unavailable.'
      setMessages((m) => [...m, { role: 'assistant', text: msg, error: true }])
    } finally {
      setBusy(false)
    }
  }

  function clearHistory() {
    setMessages([])
    setTraversalInstances([])
    setActiveTraversalIndex(0)
  }

  return (
    <div className={`chat-panel ${compact ? 'chat-panel--compact' : ''}`}>
      <div className="chat-panel__head">
        <div className="chat-panel__title">
          <Sparkles className="chat-panel__spark" size={16} aria-hidden />
          <span>Clinical Assistant</span>
        </div>
        <div className="chat-panel__actions">
          <label className="chat-panel__filter">
            <span>Context:</span>
            <select
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
              disabled={busy}
              aria-label="Filter patient context"
            >
              <option value="">All Patients (Population)</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {cleanPersonName(`${p.first_name} ${p.last_name}`)}
                </option>
              ))}
            </select>
          </label>
          {messages.length > 0 && (
            <button
              type="button"
              className="chat-panel__icon-btn"
              onClick={clearHistory}
              title="Clear conversation"
              aria-label="Clear conversation"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="chat-panel__body">
        <div className="chat-panel__scroll" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="chat-panel__empty">
              <div className="chat-panel__hero">
                <div className="chat-panel__hero-badge">
                  <HelpCircle size={13} />
                  <span>
                    {suggestionsMode === 'patient' && patientName
                      ? `Patient Focus: ${patientName}`
                      : 'Knowledge Graph Q&A'}
                  </span>
                </div>
                <p className="chat-panel__hero-desc">
                  {suggestionsMode === 'patient'
                    ? 'Ask clinically grounded questions regarding active diagnoses, indicated medications, abnormal lab values, and doctor notes.'
                    : 'Ask population-wide questions across all patients, disease prevalences, treatments, and clinical consultation records.'}
                </p>
              </div>

              <div className="chat-panel__suggestions-header">
                <span>Suggested Questions</span>
                <button
                  type="button"
                  className="chat-panel__refresh-btn"
                  onClick={() => loadSuggestions(patientId)}
                  disabled={loadingSuggestions}
                  title="Refresh suggested questions"
                >
                  <RotateCcw size={12} className={loadingSuggestions ? 'chat-panel__spin' : ''} />
                  <span>Refresh</span>
                </button>
              </div>

              <div className="chat-panel__suggestions">
                {suggestions.map((s, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="chat-panel__suggestion-card"
                    disabled={busy}
                    onClick={() => submit(s.prompt)}
                  >
                    <span className="chat-panel__badge">{s.category}</span>
                    <span className="chat-panel__suggestion-prompt">{s.prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={`chat-panel__msg chat-panel__msg--${m.role}`}>
                <div className={`chat-panel__bubble ${m.error ? 'chat-panel__bubble--error' : ''}`}>
                  {m.role === 'assistant' && !m.error ? (
                    <ChatMarkdown content={m.text} />
                  ) : (
                    m.text
                  )}
                </div>
              </div>
            ))
          )}

          {busy && (
            <div className="chat-panel__msg chat-panel__msg--assistant">
              <div className="chat-panel__bubble chat-panel__bubble--typing">
                <Loader2 className="chat-panel__spin" size={14} aria-hidden />
                Analyzing knowledge graph & generating clinical response…
              </div>
            </div>
          )}
        </div>

        {!compact && (
          <TraversalPanel
            instances={traversalInstances}
            activeIndex={activeTraversalIndex}
            onSelect={setActiveTraversalIndex}
            loading={busy && traversalInstances.length > 0 && traversalInstances[activeTraversalIndex]?.traversal == null}
          />
        )}
      </div>

      {/* Persistent Quick Suggestions Strip when in a conversation */}
      {messages.length > 0 && suggestions.length > 0 && (
        <div className="chat-panel__quick-strip">
          <span className="chat-panel__quick-label">Try:</span>
          <div className="chat-panel__quick-scroll">
            {suggestions.map((s, idx) => (
              <button
                key={idx}
                type="button"
                className="chat-panel__quick-chip"
                disabled={busy}
                onClick={() => submit(s.prompt)}
              >
                <span className="chat-panel__quick-cat">{s.category}:</span>
                <span className="chat-panel__quick-text">{s.prompt}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <form
        className="chat-panel__form"
        onSubmit={(e) => {
          e.preventDefault()
          submit(input)
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            patientId
              ? `Ask about ${patientName || 'this patient'}...`
              : 'Ask about conditions, medications, lab alerts, outcomes…'
          }
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          aria-label="Send message"
          className="chat-panel__send"
        >
          <Send size={16} aria-hidden />
        </button>
      </form>
    </div>
  )
}