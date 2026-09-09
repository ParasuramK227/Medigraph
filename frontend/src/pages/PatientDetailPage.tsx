import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  User, Loader2, FileText, Stethoscope, Microscope, ClipboardList,
  Users, ArrowRight, ShieldAlert, Calendar,
} from 'lucide-react'
import { fetchPatient, fetchPatientIntel, type Patient, type PatientIntel } from '../lib/api'
import { fetchPatientGraphRaw, rawGraphToF } from '../lib/graphData'
import { LazyFeatureGraph, type FEdge, type FNode } from '../components/feature/LazyFeatureGraph'
import { ScribeWidget } from '../components/scribe/ScribeWidget'
import { useAuth } from '../hooks/useAuth'
import { formatClinicalDate, cleanLabName, cleanPersonName } from '../lib/formatters'
import './PatientDetailPage.css'

export function PatientDetailPage() {
  const { id } = useParams()
  const { user } = useAuth()
  const canScribe = user?.role === 'admin' || user?.role === 'doctor'
  const [patient, setPatient] = useState<Patient | null>(null)
  const [intel, setIntel] = useState<PatientIntel | null>(null)
  const [graph, setGraph] = useState<{ nodes: FNode[]; edges: FEdge[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const loadData = useCallback(() => {
    if (!id) return
    fetchPatient(id)
      .then((p) => {
        if (!p) {
          setNotFound(true)
          return
        }
        setPatient(p)
      })
      .catch(() => {
        setNotFound(true)
      })
      .finally(() => {
        setLoading(false)
      })

    fetchPatientIntel(id)
      .then((i) => {
        if (i) setIntel(i)
      })
      .catch(() => {})

    fetchPatientGraphRaw(id)
      .then((raw) => {
        if (raw) {
          setGraph(rawGraphToF(raw.nodes, raw.relationships))
        }
      })
      .catch(() => {})
  }, [id])

  useEffect(() => {
    setLoading(true)
    setNotFound(false)
    loadData()
  }, [loadData])

  if (loading) {
    return (
      <div className="page page--centered">
        <Loader2 className="patient-detail__spinner" size={28} />
      </div>
    )
  }

  if (notFound || !patient) {
    return (
      <div className="page">
        <h1 className="page__heading">Patient not found</h1>
        <p className="patient-detail__muted">No record exists with ID {id}.</p>
        <Link to="/patients" className="patient-detail__back">
          ← Back to patients
        </Link>
      </div>
    )
  }

  const fullName = cleanPersonName(`${patient.first_name} ${patient.last_name}`)
  const patientNodeId = graph?.nodes.find((n) => n.labels.includes('Patient'))?.id
  const history = intel?.medical_history

  return (
    <div className="patient-detail page">
      <header className="patient-detail__head">
        <div className="patient-detail__avatar">
          <User size={22} />
        </div>
        <div>
          <h1 className="page__heading">{fullName}</h1>
          <p className="patient-detail__muted">
            <span className="patient-detail__id-tag">{patient.id}</span>
            {patient.date_of_birth ? ` • Born ${formatClinicalDate(patient.date_of_birth)}` : ''}
            {patient.gender ? ` • ${patient.gender === 'M' ? 'Male' : patient.gender === 'F' ? 'Female' : patient.gender}` : ''}
            {patient.email ? ` • ${patient.email}` : ''}
          </p>
        </div>
        <Link
          to={`/treatment-intelligence/${patient.id}`}
          className="patient-detail__intel-link"
        >
          Treatment Intelligence
          <ArrowRight size={14} />
        </Link>
      </header>

      <div className="patient-detail__grid">
        <div className="patient-detail__main">
          <section className="patient-detail__card">
            <h2 className="patient-detail__section-title">
              <FileText size={16} /> Clinical summary
            </h2>
            <p className="patient-detail__summary">
              {intel?.summary ?? 'Loading summary…'}
            </p>
          </section>

          {canScribe && (
            <section className="patient-detail__card patient-detail__scribe">
              <ScribeWidget patientId={patient.id} patientName={fullName} onNoteSaved={loadData} />
            </section>
          )}

          <section className="patient-detail__card">
            <h2 className="patient-detail__section-title">
              <ClipboardList size={16} /> Medical history
            </h2>
            {!intel || (history && !history.diagnoses.length && !history.treatments.length && !history.labs.length && !history.notes.length) ? (
              <p className="patient-detail__muted">No medical history on record.</p>
            ) : (
              <div className="patient-detail__history">
                {history?.diagnoses.length ? (
                  <div className="patient-detail__history-block">
                    <div className="patient-detail__history-label">Diagnoses ({history.diagnoses.length})</div>
                    <div className="patient-detail__chips">
                      {history.diagnoses.map((d, i) => (
                        <span className="patient-detail__chip patient-detail__chip--disease" key={`${d}-${i}`}>
                          {d}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {history?.treatments.length ? (
                  <div className="patient-detail__history-block">
                    <div className="patient-detail__history-label">
                      <Stethoscope size={13} /> Treatments & Procedures ({history.treatments.length})
                    </div>
                    <ul className="patient-detail__list">
                      {history.treatments.map((t, i) => (
                        <li key={`${t.id || 't'}-${i}`} className="patient-detail__item-row">
                          <div className="patient-detail__item-main">
                            <span className="patient-detail__item-title">{t.type ?? 'Treatment'}</span>
                            {t.outcome && (
                              <span className={`patient-detail__outcome-pill patient-detail__outcome-pill--${t.outcome.toLowerCase()}`}>
                                {t.outcome}
                              </span>
                            )}
                          </div>
                          <div className="patient-detail__item-meta">
                            {t.date && (
                              <span className="patient-detail__date-badge">
                                <Calendar size={12} /> {formatClinicalDate(t.date)}
                              </span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {history?.labs.length ? (
                  <div className="patient-detail__history-block">
                    <div className="patient-detail__history-label">
                      <Microscope size={13} /> Lab Tests & Vitals ({history.labs.length})
                    </div>
                    <ul className="patient-detail__list">
                      {history.labs.map((l, i) => (
                        <li key={`${l.id || 'l'}-${i}`} className="patient-detail__item-row">
                          <div className="patient-detail__item-main">
                            <span className="patient-detail__item-title">{cleanLabName(l.name)}</span>
                            <div className="patient-detail__lab-value">
                              <strong>{l.result}</strong>
                              <span className="patient-detail__unit">
                                {l.unit ? l.unit.replace('{score}', '/ 10') : ''}
                              </span>
                            </div>
                          </div>
                          <div className="patient-detail__item-meta">
                            <span className={`patient-detail__lab-status patient-detail__lab-status--${(l.status || 'normal').toLowerCase()}`}>
                              {l.status || 'normal'}
                            </span>
                            {l.date && (
                              <span className="patient-detail__date-badge">
                                <Calendar size={12} /> {formatClinicalDate(l.date)}
                              </span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {history?.notes.length ? (
                  <div className="patient-detail__history-block">
                    <div className="patient-detail__history-label">
                      <ClipboardList size={13} /> Consultation notes
                    </div>
                    <ul className="patient-detail__list patient-detail__list--notes">
                      {history.notes.map((n, i) => (
                        <li key={`${n.id || 'n'}-${i}`} className="patient-detail__note-card">
                          <div className="patient-detail__note-head">
                            <span className="patient-detail__date-badge">
                              <Calendar size={12} /> {formatClinicalDate(n.created_at)}
                            </span>
                            {n.title && <span className="patient-detail__note-title">{n.title}</span>}
                          </div>
                          <div className="patient-detail__note-body">{n.summary}</div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {history?.allergies && history.allergies.length ? (
                  <div className="patient-detail__history-block">
                    <div className="patient-detail__history-label">
                      <ShieldAlert size={13} /> Recorded Allergies
                    </div>
                    <div className="patient-detail__chips">
                      {history.allergies.map((a, i) => (
                        <span
                          className="patient-detail__chip patient-detail__chip--allergy"
                          key={`${a.id ?? a.substance ?? 'a'}-${i}`}
                        >
                          {a.substance} {a.severity ? `(${a.severity})` : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </div>

        <div className="patient-detail__aside">
          <section className="patient-detail__card">
            <h2 className="patient-detail__section-title">
              <Users size={16} /> Similar patients
            </h2>
            {!intel || !intel.similar_patients.length ? (
              <p className="patient-detail__muted">No similar patients found.</p>
            ) : (
              <ul className="patient-detail__similar">
                {intel.similar_patients.map((s, i) => (
                  <li key={`${s.id ?? s.patient_id ?? 'sp'}-${i}`}>
                    <Link
                      to={`/patients/${s.id ?? s.patient_id}`}
                      className="patient-detail__similar-link"
                    >
                      <span>{s.name}</span>
                      <span className="patient-detail__similar-meta">
                        {Math.round(s.similarity * 100)}% similar
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="patient-detail__card">
            <div className="patient-detail__card-head">
              <h2 className="patient-detail__section-title">Medications by diagnosis</h2>
              <p className="patient-detail__subtext">
                Active medications indicated and prescribed to treat each of this patient's diagnosed conditions.
              </p>
            </div>
            {!intel || !Object.keys(intel.medications).length ? (
              <p className="patient-detail__muted">No matching medications in the graph.</p>
            ) : (
              <ul className="patient-detail__med-groups">
                {Object.entries(intel.medications).map(([disease, meds], i) => (
                  <li key={`${disease}-${i}`} className="patient-detail__med-group">
                    <div className="patient-detail__med-disease-badge">{disease}</div>
                    <div className="patient-detail__chips">
                      {meds.map((m, mi) => (
                        <span className="patient-detail__chip patient-detail__chip--med" key={`${disease}-${m}-${mi}`}>
                          {m}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {graph && (
        <section className="patient-detail__card patient-detail__card--graph">
          <div className="patient-detail__card-head">
            <h2 className="patient-detail__section-title">Clinical graph</h2>
            <p className="patient-detail__subtext">
              Interactive knowledge graph of this patient's care network. Click any node to inspect properties in the sidebar.
            </p>
          </div>
          <LazyFeatureGraph
            nodes={graph.nodes}
            edges={graph.edges}
            centerId={patientNodeId}
            height={600}
          />
        </section>
      )}
    </div>
  )
}
