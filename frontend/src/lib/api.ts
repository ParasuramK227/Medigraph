import { cleanPersonName } from './formatters'

let rawApiBase: string = (import.meta.env.VITE_API_BASE ?? '').trim()
if (rawApiBase && !rawApiBase.startsWith('http') && !rawApiBase.startsWith('/')) {
  if (!rawApiBase.includes('.')) {
    rawApiBase = `${rawApiBase}.onrender.com`
  }
  rawApiBase = `https://${rawApiBase}`
} else if (!rawApiBase && typeof window !== 'undefined' && window.location.hostname.includes('onrender.com')) {
  rawApiBase = 'https://medigraph-backend.onrender.com'
}
const API_BASE: string = rawApiBase.replace(/\/+$/, '')



export interface HealthStatus {
  status: 'ok' | 'degraded'
  neo4j: 'connected' | 'disconnected'
}

export async function fetchHealth(): Promise<HealthStatus> {
  const res = await fetch(`${API_BASE}/api/health`)
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`)
  const data = (await res.json()) as Partial<HealthStatus>
  return {
    status: data.status ?? 'degraded',
    neo4j: data.neo4j ?? 'disconnected',
  }
}

export interface StructuredMedication {
  name: string
  dosage?: string
  unit?: string
  frequency?: string
  route?: string
  rationale?: string
  safety_alerts?: SafetyAlert[]
}

export interface SafetyAlert {
  type: string
  severity: 'WARNING' | 'CRITICAL' | 'INFO'
  message: string
  medication: string
  quick_fix?: {
    dosage: string
    unit: string
    reason: string
  }
}

export interface ScribeNote {
  title?: string
  summary: string
  diagnoses: string[]
  action_items: string[]
  medications_discussed: Array<string | StructuredMedication>
  safety_alerts?: SafetyAlert[]
  deidentified?: boolean
}

export interface ScribeStatus {
  status:
    | 'idle'
    | 'transcribing'
    | 'review'
    | 'approved'
    | 'extracting'
    | 'extracted'
    | 'extract_error'
    | 'save_error'
    | 'saved'
  failure_count: number
  retry_disabled: boolean
}

// --- Scribe pipeline -------------------------------------------------------

export async function scribeStart(): Promise<{ session_id: string }> {
  const res = await fetch(`${API_BASE}/api/scribe/start`, { method: 'POST' })
  if (!res.ok) throw new Error(`Failed to start session: ${res.status}`)
  return res.json()
}

export async function scribeTranslate(
  text: string,
  targetLang = 'English',
): Promise<{ translated_text?: string; original_text?: string; error?: string }> {
  const res = await fetch(`${API_BASE}/api/scribe/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, target_lang: targetLang }),
  })
  return res.json()
}

export interface UploadResult {
  session_id: string
  transcript: string
  status?: string
  provider?: string
  error?: string
  failure_count?: number
  retry_disabled?: boolean
}

export async function scribeUpload(
  sessionId: string,
  audioBlob: Blob,
  provider: 'groq' | 'local' | 'hf_space' = 'groq',
  modelSize?: string,
  hfEndpoint?: string,
): Promise<UploadResult> {
  const form = new FormData()
  form.append('session_id', sessionId)
  const mime = audioBlob.type || ''
  const ext = mime.includes('mp4') ? 'm4a' : mime.includes('wav') ? 'wav' : mime.includes('ogg') ? 'ogg' : 'webm'
  form.append('audio', audioBlob, `recording.${ext}`)
  form.append('provider', provider)
  if (modelSize) {
    form.append('model_size', modelSize)
  }
  if (hfEndpoint) {
    form.append('hf_endpoint', hfEndpoint)
  }

  const res = await fetch(`${API_BASE}/api/scribe/upload`, { method: 'POST', body: form })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Upload failed: ${res.status}`)
  }
  return data as UploadResult
}

export async function scribeGetTranscript(sessionId: string): Promise<{
  transcript: string
  approved: boolean
  status: string
}> {
  const res = await fetch(`${API_BASE}/api/scribe/transcript/${sessionId}`)
  if (!res.ok) throw new Error(`No transcript: ${res.status}`)
  return res.json()
}

export async function scribeSaveTranscript(
  sessionId: string,
  transcript: string,
  approved = true,
): Promise<{ status: string; approved: boolean }> {
  const res = await fetch(`${API_BASE}/api/scribe/transcript/${sessionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, approved }),
  })
  if (!res.ok) throw new Error(`Failed to save edited transcript: ${res.status}`)
  return res.json()
}

export async function scribeExtract(
  sessionId: string,
  patientName?: string,
  doctorName?: string,
  deidentify = true,
): Promise<{ status: string; note: ScribeNote; error?: string }> {
  const res = await fetch(`${API_BASE}/api/scribe/extract/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      patient_name: patientName,
      doctor_name: doctorName,
      deidentify,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Extraction failed: ${res.status}`)
  return data as { status: string; note: ScribeNote; error?: string }
}

export async function scribeSave(
  sessionId: string,
  patientId: string,
  note: ScribeNote,
): Promise<{ status: string; note_id: string }> {
  const res = await fetch(`${API_BASE}/api/scribe/save/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patient_id: patientId, note }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Failed to save note: ${res.status}`)
  return data
}

export async function scribeAuditMedication(med: {
  name: string
  dosage?: string
  unit?: string
  frequency?: string
  route?: string
}): Promise<{ medication: typeof med; alerts: SafetyAlert[]; is_safe: boolean }> {
  const res = await fetch(`${API_BASE}/api/scribe/audit-medication`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(med),
  })
  if (!res.ok) throw new Error(`Failed to audit medication: ${res.status}`)
  return res.json()
}

export interface Patient {
  id: string
  first_name: string
  last_name: string
  gender?: string
  date_of_birth?: string
  email?: string
  contact_number?: string
}

// The backend returns patients in raw graph form: { element_id, labels,
// properties }. Normalize so the UI works against a flat Patient object.
interface RawNode {
  element_id: string
  labels?: string[]
  properties?: Record<string, unknown>
}

function toPatient(raw: RawNode): Patient {
  const p = raw.properties ?? {}
  const str = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = p[k]
      if (typeof v === 'string' && v) return v
    }
    return undefined
  }
  return {
    id: str('id') ?? raw.element_id ?? '',
    first_name: cleanPersonName(str('first_name') ?? ''),
    last_name: cleanPersonName(str('last_name') ?? ''),
    gender: str('gender'),
    date_of_birth: str('date_of_birth'),
    email: str('email'),
    contact_number: str('contact_number'),
  }
}

// --- Patients --------------------------------------------------------------

export async function fetchPatients(): Promise<Patient[]> {
  const res = await fetch(`${API_BASE}/api/graph/patients`)
  if (!res.ok) throw new Error(`Failed to fetch patients: ${res.status}`)
  const data = (await res.json()) as RawNode[]
  return Array.isArray(data) ? data.map(toPatient) : []
}

export async function fetchPatient(id: string): Promise<Patient | null> {
  const res = await fetch(`${API_BASE}/api/graph/patients/${id}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to fetch patient: ${res.status}`)
  const data = (await res.json()) as { patient?: RawNode } | null
  return data?.patient ? toPatient(data.patient) : null
}

// --- Patient intelligence + treatment intel ----------------------------

export interface SimilarPatient {
  id: string
  patient_id?: string
  name: string
  overlap: number
  similarity: number
  diagnoses?: string[]
  shared_diagnoses?: string[]
  gender?: string
}

export interface PatientIntel {
  patient: Patient
  summary: string
  medical_history: {
    diagnoses: string[]
    treatments: Array<{
      id: string
      type?: string
      cost?: string
      date?: string
      description?: string
      outcome?: string
    }>
    labs: Array<{
      id: string
      name: string
      result: string
      status: string
      unit?: string
      date?: string
    }>
    notes: Array<{
      id: string
      title?: string
      summary: string
      created_at: string
      diagnoses?: string[]
      medications?: string[]
      action_items?: string[]
    }>
    allergies?: Array<{
      id?: string
      substance?: string
      type?: string
      severity?: string
    }>
  }
  similar_patients: SimilarPatient[]
  medications: Record<string, string[]>
}

export async function fetchPatientIntel(id: string): Promise<PatientIntel | null> {
  const res = await fetch(`${API_BASE}/api/graph/patients/${id}/intelligence`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to fetch patient intelligence: ${res.status}`)
  return (await res.json()) as PatientIntel
}

export interface RankedDiagnosis {
  rank: number
  disease: string
  score: number
  confidence_low: boolean
  cohort_size: number
  patients_with_labs: number
  lab_count: number
  note: string
}

export interface RankedTreatment {
  rank?: number
  name: string
  treatment_type?: string
  disease: string
  success_rate: number | null
  cost?: string
  description?: string
  recovered_patients: Array<{ id: string; name: string }>
}

export interface TreatmentRanking {
  has_data: boolean
  has_outcome: boolean
  treatments: RankedTreatment[]
  note: string | null
}

export interface TreatmentIntel {
  patient: Patient
  diagnoses: string[]
  ranked: RankedDiagnosis[]
  treatments?: TreatmentRanking
  recovered_patients_by_treatment?: Record<string, Array<{ id: string; name: string }>>
  similar_patients: Array<{
    id: string
    name: string
    similarity: number
    overlap: number
  }>
}

export async function fetchTreatmentIntel(id: string): Promise<TreatmentIntel | null> {
  const res = await fetch(`${API_BASE}/api/graph/patients/${id}/treatment-intel`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to fetch treatment intelligence: ${res.status}`)
  return (await res.json()) as TreatmentIntel
}

export async function fetchAllTreatmentIntel(): Promise<TreatmentIntel[]> {
  const patients = await fetchPatients()
  const results = await Promise.all(
    patients.map(async (p) => {
      try {
        return await fetchTreatmentIntel(p.id)
      } catch {
        return null
      }
    }),
  )
  return results.filter((r): r is TreatmentIntel => r !== null)
}

export interface SectorMedication {
  name: string
  cost: string
  raw_cost?: number
  type: string
  success_rate: number
  recommendation_level: string
  evidence_note: string
}

export interface SectorTreatment {
  name: string
  type: string
  success_rate: number
  cost: string
  raw_cost?: number
  outcome: string
  total_cases: number
  recommendation_level: string
  evidence_note: string
}

export interface SectorIntelligence {
  disease: string
  total_patients: number
  controlled_patients: number
  control_rate: number
  biomarkers_monitored: string[]
  best_option: SectorMedication | SectorTreatment | null
  medications: SectorMedication[]
  treatments: SectorTreatment[]
}

export async function fetchSectorIntelligence(diseaseName: string): Promise<SectorIntelligence | null> {
  const encoded = encodeURIComponent(diseaseName)
  const res = await fetch(`${API_BASE}/api/graph/sectors/${encoded}/intelligence`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to fetch sector intelligence: ${res.status}`)
  return (await res.json()) as SectorIntelligence
}


// --- Graph schema + Cypher (admin panel) -------------------------------

export interface LabelCount {
  label: string
  count: number
}
export interface RelCount {
  type: string
  count: number
}
export interface GraphSchema {
  labels: LabelCount[]
  relationships: RelCount[]
  property_keys: string[]
  node_count: number
  relationship_count: number
  last_update: string
}

export async function fetchSchema(): Promise<GraphSchema> {
  const res = await fetch(`${API_BASE}/api/graph/schema`)
  if (!res.ok) throw new Error(`Failed to fetch schema: ${res.status}`)
  return res.json()
}

export interface CypherResult {
  columns: string[]
  rows: unknown[][]
  timing: { elapsed_ms: number }
  row_count: number
  error?: string
}

export async function runCypher(query: string, params: Record<string, unknown> = {}): Promise<CypherResult> {
  const res = await fetch(`${API_BASE}/api/graph/cypher`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, params }),
  })
  const data = (await res.json()) as CypherResult
  return data
}

// --- Chatbot --------------------------------------------------------------

export interface ChatSuggestion {
  category: string
  prompt: string
}

export interface SuggestionsResponse {
  mode?: 'patient' | 'cohort'
  patient_id?: string
  patient_name?: string
  suggestions: ChatSuggestion[]
  error?: string
}

export async function fetchChatSuggestions(patientId?: string): Promise<SuggestionsResponse> {
  const url = patientId
    ? `${API_BASE}/api/chat/suggestions?patient_id=${encodeURIComponent(patientId)}`
    : `${API_BASE}/api/chat/suggestions`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch chat suggestions: ${res.status}`)
  return (await res.json()) as SuggestionsResponse
}

export interface ChatResponse {
  answer?: string
  candidate_count?: number
  source_count?: number
  error?: string
}

export async function chatQuery(
  message: string,
  patientId?: string,
): Promise<ChatResponse> {
  const res = await fetch(`${API_BASE}/api/chat/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, patient_id: patientId }),
  })
  return (await res.json()) as ChatResponse
}
