import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { HeartPulse, Loader2, Activity, ArrowRight } from 'lucide-react'
import { fetchPatients, fetchPatientSummaries, type Patient } from '../lib/api'
import './TreatmentIntelligencePage.css'

interface PatientWithDiags extends Patient {
  diagnoses: string[]
  treatmentCount: number
  labCount: number
}

export function TreatmentIntelligencePage() {
  const [patients, setPatients] = useState<PatientWithDiags[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    Promise.all([fetchPatients(), fetchPatientSummaries()])
      .then(([patientList, summaries]) => {
        if (cancelled) return
        const diagMap = new Map<string, { diagnoses: string[]; treatmentCount: number; labCount: number }>()
        for (const s of summaries) {
          diagMap.set(s.id, {
            diagnoses: (s.diagnoses ?? []).filter(Boolean),
            treatmentCount: Number(s.treatmentCount) || 0,
            labCount: Number(s.labCount) || 0,
          })
        }
        setPatients(
          patientList.map((p) => ({
            ...p,
            ...(diagMap.get(p.id) ?? { diagnoses: [], treatmentCount: 0, labCount: 0 }),
          })),
        )
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load patients')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const hasRanking = (p: PatientWithDiags) => p.diagnoses.length > 0

  return (
    <div className="page">
      <div className="ti__header">
        <div className="ti__icon">
          <HeartPulse size={16} />
        </div>
        <div>
          <h1 className="page__heading">Treatment Intelligence</h1>
          <p className="ti__sub">
            A culmination of all patients and their diagnoses. Open a patient&apos;s
            Treatment Intelligence page to see their diagnoses ranked by likelihood of
            success, computed from similar patients&apos; outcomes — no LLM involved.
          </p>
        </div>
      </div>

      {loading && (
        <div className="ti__loading">
          <Loader2 className="ti__spin" size={20} />
          Loading patients…
        </div>
      )}
      {!loading && error && <div className="ti__error">{error}</div>}
      {!loading && !error && patients.length === 0 && (
        <div className="ti__loading">No patients found.</div>
      )}

      {!loading && !error && patients.length > 0 && (
        <div className="ti__grid">
          {patients.map((p) => (
            <div className="ti__card" key={p.id}>
              <div className="ti__card-head">
                <span className="ti__card-name">
                  {p.first_name} {p.last_name}
                </span>
                <span className="ti__card-id">{p.id}</span>
              </div>

              <div className="ti__card-meta">
                <span className="ti__meta-chip ti__meta-chip--disease">
                  {p.diagnoses.length} diagnosis{p.diagnoses.length === 1 ? '' : 'es'}
                </span>
                <span className="ti__meta-chip">
                  <Activity size={12} /> {p.treatmentCount} treatment{p.treatmentCount === 1 ? '' : 's'}
                </span>
                <span className="ti__meta-chip ti__meta-chip--lab">
                  {p.labCount} lab test{p.labCount === 1 ? '' : 's'}
                </span>
              </div>

              <div className="ti__card-diags">
                {p.diagnoses.length ? (
                  p.diagnoses.slice(0, 3).map((d) => (
                    <span className="ti__diag-chip" key={d}>
                      {d}
                    </span>
                  ))
                ) : (
                  <span className="ti__muted">No diagnoses on record</span>
                )}
                {p.diagnoses.length > 3 && (
                  <span className="ti__muted">+{p.diagnoses.length - 3} more</span>
                )}
              </div>

              <div className="ti__card-foot">
                {hasRanking(p) ? (
                  <Link className="ti__intel-btn" to={`/treatment-intelligence/${p.id}`}>
                    Treatment Intelligence
                    <ArrowRight size={14} />
                  </Link>
                ) : (
                  <span className="ti__muted">No diagnoses to rank</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
