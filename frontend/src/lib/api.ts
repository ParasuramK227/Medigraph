import { cleanPersonName } from './formatters'
import { clearAuth, getStoredToken, type AuthUser } from './auth-storage'
export type { AuthUser } from './auth-storage'

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

export interface ApiError extends Error {
  status?: number
}

let unauthorizedHandler: (() => void) | null = null

/** Register a hook that fires whenever any API call returns 401 (session drop). */
export function onUnauthorized(cb: () => void): () => void {
  unauthorizedHandler = cb
  return () => {
    if (unauthorizedHandler === cb) unauthorizedHandler = null
  }
}

/** Central fetch: injects the Bearer token and handles auth failures globally. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getStoredToken()
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers })

  if (res.status === 401) {
    clearAuth()
    unauthorizedHandler?.()
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) message = body.error
    } catch {}
    const err = new Error(message) as ApiError
    err.status = res.status
    throw err
  }

  return res.json() as Promise<T>
}



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
  return apiFetch<{ session_id: string }>('/api/scribe/start', { method: 'POST' })
}

export async function scribeTranslate(
  text: string,
  targetLang = 'English',
): Promise<{ translated_text?: string; original_text?: string; error?: string }> {
  return apiFetch('/api/scribe/translate', {
    method: 'POST',
    body: JSON.stringify({ text, target_lang: targetLang }),
  })
}

export async function scribeGetTranscript(sessionId: string): Promise<{
  transcript: string
  approved: boolean
  status: string
}> {
  return apiFetch(`/api/scribe/transcript/${sessionId}`)
}

export async function scribeSaveTranscript(
  sessionId: string,
  transcript: string,
  approved = true,
): Promise<{ status: string; approved: boolean }> {
  return apiFetch(`/api/scribe/transcript/${sessionId}`, {
    method: 'PUT',
    body: JSON.stringify({ transcript, approved }),
  })
}

export async function scribeExtract(
  sessionId: string,
  patientName?: string,
  doctorName?: string,
  deidentify = true,
): Promise<{ status: string; note: ScribeNote; error?: string }> {
  return apiFetch<{ status: string; note: ScribeNote; error?: string }>(
    `/api/scribe/extract/${sessionId}`,
    {
      method: 'POST',
      body: JSON.stringify({
        patient_name: patientName,
        doctor_name: doctorName,
        deidentify,
      }),
    },
  )
}

export async function scribeSave(
  sessionId: string,
  patientId: string,
  note: ScribeNote,
): Promise<{ status: string; note_id: string }> {
  return apiFetch(`/api/scribe/save/${sessionId}`, {
    method: 'POST',
    body: JSON.stringify({ patient_id: patientId, note }),
  })
}

export async function scribeAuditMedication(med: {
  name: string
  dosage?: string
  unit?: string
  frequency?: string
  route?: string
}): Promise<{ medication: typeof med; alerts: SafetyAlert[]; is_safe: boolean }> {
  return apiFetch('/api/scribe/audit-medication', {
    method: 'POST',
    body: JSON.stringify(med),
  })
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
  const data = await apiFetch<RawNode[]>('/api/graph/patients')
  return Array.isArray(data) ? data.map(toPatient) : []
}

export async function fetchPatient(id: string): Promise<Patient | null> {
  try {
    const data = await apiFetch<{ patient?: RawNode } | null>(`/api/graph/patients/${id}`)
    return data?.patient ? toPatient(data.patient) : null
  } catch (e) {
    if ((e as ApiError).status === 404) return null
    throw e
  }
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
  try {
    return await apiFetch<PatientIntel>(`/api/graph/patients/${id}/intelligence`)
  } catch (e) {
    if ((e as ApiError).status === 404) return null
    throw e
  }
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
  try {
    return await apiFetch<TreatmentIntel>(`/api/graph/patients/${id}/treatment-intel`)
  } catch (e) {
    if ((e as ApiError).status === 404) return null
    throw e
  }
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
  try {
    return await apiFetch<SectorIntelligence>(`/api/graph/sectors/${encoded}/intelligence`)
  } catch (e) {
    if ((e as ApiError).status === 404) return null
    throw e
  }
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
  return apiFetch<GraphSchema>('/api/graph/schema')
}

export interface CypherResult {
  columns: string[]
  rows: unknown[][]
  timing: { elapsed_ms: number }
  row_count: number
  error?: string
}

export async function runCypher(query: string, params: Record<string, unknown> = {}): Promise<CypherResult> {
  return apiFetch<CypherResult>('/api/graph/cypher', {
    method: 'POST',
    body: JSON.stringify({ query, params }),
  })
}

/** Run one of the server-authored graph presets (admin + researcher). */
export async function exploreGraph(preset: string): Promise<CypherResult> {
  return apiFetch<CypherResult>('/api/graph/explore', {
    method: 'POST',
    body: JSON.stringify({ preset }),
  })
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
    ? `/api/chat/suggestions?patient_id=${encodeURIComponent(patientId)}`
    : '/api/chat/suggestions'
  return apiFetch<SuggestionsResponse>(url)
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
  try {
    return await apiFetch<ChatResponse>('/api/chat/query', {
      method: 'POST',
      body: JSON.stringify({ message, patient_id: patientId }),
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Chatbot request failed' }
  }
}

// --- Auth -------------------------------------------------------------------

export interface LoginResponse {
  token: string
  user: AuthUser
}

export async function login(
  usernameOrEmail: string,
  password: string,
): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: usernameOrEmail, password }),
  })
}

export async function register(
  username: string,
  email: string,
  password: string,
): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, email, password }),
  })
}

export async function fetchMe(): Promise<AuthUser> {
  return apiFetch<AuthUser>('/api/auth/me')
}

export async function listUsers(): Promise<AuthUser[]> {
  return apiFetch<AuthUser[]>('/api/auth/users')
}

export async function setUserRole(userId: string, role: string): Promise<AuthUser> {
  return apiFetch<AuthUser>(`/api/auth/users/${encodeURIComponent(userId)}/role`, {
    method: 'PUT',
    body: JSON.stringify({ role }),
  })
}

// --- Dedicated data endpoints (replace raw/Cypher-dependent pages) -----------

export interface SectorRow {
  name: string
  patients: number
  medications: number
}

export async function fetchSectors(): Promise<SectorRow[]> {
  const data = await apiFetch<SectorRow[]>('/api/graph/sectors')
  return Array.isArray(data) ? data : []
}

export async function fetchSectorGraph(diseaseName: string): Promise<CypherResult> {
  const encoded = encodeURIComponent(diseaseName)
  return apiFetch<CypherResult>(`/api/graph/sectors/${encoded}/graph`)
}

export interface PatientSummary {
  id: string
  diagnoses: string[]
  treatmentCount: number
  labCount: number
}

export async function fetchPatientSummaries(): Promise<PatientSummary[]> {
  const data = await apiFetch<PatientSummary[]>('/api/graph/patient-summaries')
  return Array.isArray(data) ? data : []
}

export interface RecentNote {
  id: string
  name: string
  summary: string
  created: string
}

export async function fetchRecentNotes(): Promise<RecentNote[]> {
  const data = await apiFetch<RecentNote[]>('/api/graph/dashboard/recent-notes')
  return Array.isArray(data) ? data : []
}

export interface TopSectorRow {
  disease: string
  patients: number
}

export async function fetchTopSectors(): Promise<TopSectorRow[]> {
  const data = await apiFetch<TopSectorRow[]>('/api/graph/dashboard/top-sectors')
  return Array.isArray(data) ? data : []
}
