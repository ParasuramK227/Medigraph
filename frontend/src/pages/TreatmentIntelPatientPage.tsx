import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Loader2,
  TrendingUp,
  Users,
  Pill,
  Share2,
  Sparkles,
  CheckCircle2,
  Zap,
  Network,
  Info,
  ChevronDown,
  ChevronUp,
  Activity,
  Stethoscope,
  Calculator,
  Binary,
  Sliders,
} from 'lucide-react'
import { fetchTreatmentIntel, type TreatmentIntel, type SimilarPatient } from '../lib/api'
import { LazyFeatureGraph, type FEdge, type FNode } from '../components/feature/LazyFeatureGraph'
import './TreatmentIntelPatientPage.css'

// Helper to extract clean active drug name
function cleanDrug(med: string): string {
  if (!med) return ''
  const m = med.replace(/\s+/g, ' ').trim()
  const match = m.match(/^([A-Za-z\s\-\//\(\)]+?)(?:\s+\d+|\s+Oral|\s+Tablet|\s+Injection|$)/i)
  return (match && match[1].trim().length > 2 ? match[1].trim() : m).toLowerCase()
}

// Interactive Vector Comparator Component
function PatientVectorComparator({
  targetDiagnoses,
  targetMedications,
  candidateDiagnoses,
  candidateMedications,
  candidateRank,
  conditionWeights = {},
  drugWeights = {},
}: {
  targetDiagnoses: string[]
  targetMedications: string[]
  candidateDiagnoses: string[]
  candidateMedications: string[]
  candidateRank: number
  conditionWeights?: Record<string, number>
  drugWeights?: Record<string, number>
}) {
  // Conditions set and map
  const targetCondSet = new Set((targetDiagnoses || []).map((d) => d.trim().toLowerCase()))
  const candCondSet = new Set((candidateDiagnoses || []).map((d) => d.trim().toLowerCase()))

  const allCondMap = new Map<string, string>()
  ;(targetDiagnoses || []).forEach((d) => {
    if (d && d.trim()) allCondMap.set(d.trim().toLowerCase(), d.trim())
  })
  ;(candidateDiagnoses || []).forEach((d) => {
    if (d && d.trim() && !allCondMap.has(d.trim().toLowerCase())) {
      allCondMap.set(d.trim().toLowerCase(), d.trim())
    }
  })
  const allConditions = Array.from(allCondMap.entries()).sort((a, b) => {
    const aShared = targetCondSet.has(a[0]) && candCondSet.has(a[0])
    const bShared = targetCondSet.has(b[0]) && candCondSet.has(b[0])
    if (aShared && !bShared) return -1
    if (!aShared && bShared) return 1
    return a[1].localeCompare(b[1])
  })

  // Drugs set and map
  const targetDrugSet = new Set((targetMedications || []).map(cleanDrug).filter(Boolean))
  const candDrugSet = new Set((candidateMedications || []).map(cleanDrug).filter(Boolean))

  const allDrugMap = new Map<string, string>()
  ;(targetMedications || []).forEach((m) => {
    const c = cleanDrug(m)
    if (c && !allDrugMap.has(c)) allDrugMap.set(c, m.trim())
  })
  ;(candidateMedications || []).forEach((m) => {
    const c = cleanDrug(m)
    if (c && !allDrugMap.has(c)) allDrugMap.set(c, m.trim())
  })
  const allDrugs = Array.from(allDrugMap.entries()).sort((a, b) => {
    const aShared = targetDrugSet.has(a[0]) && candDrugSet.has(a[0])
    const bShared = targetDrugSet.has(b[0]) && candDrugSet.has(b[0])
    if (aShared && !bShared) return -1
    if (!aShared && bShared) return 1
    return a[1].localeCompare(b[1])
  })

  return (
    <div className="tii__vector-comparator">
      <div className="tii__vc-header">
        <div className="tii__vc-title">
          <Sliders size={13} />
          <span>Feature Vector Projection: Target vs Match #{candidateRank}</span>
        </div>
        <span className="tii__vc-subtitle">
          Binary multi-hot dimensions across condition &amp; pharmacotherapy spaces
        </span>
      </div>

      {/* Conditions Vector Dimension */}
      <div className="tii__vc-section">
        <div className="tii__vc-section-header">
          <span className="tii__vc-sec-title">
            <Stethoscope size={12} /> Condition Vector Space ({allConditions.length} active dimensions)
          </span>
          <span className="tii__vc-dim-summary">
            Target: {targetCondSet.size} bits • Match: {candCondSet.size} bits
          </span>
        </div>
        <div className="tii__vc-table">
          <div className="tii__vc-table-header">
            <span className="tii__vc-col-feat">Clinical Condition Feature</span>
            <span className="tii__vc-col-weight">Clinical IDF Weight</span>
            <span className="tii__vc-col-bit" title="Target Patient Vector Bit">Target v<sub>tgt</sub></span>
            <span className="tii__vc-col-bit" title="Candidate Vector Bit">Match v<sub>{candidateRank}</sub></span>
            <span className="tii__vc-col-status">Alignment</span>
          </div>
          {allConditions.map(([key, label]) => {
            const inTgt = targetCondSet.has(key)
            const inCand = candCondSet.has(key)
            const isMatch = inTgt && inCand
            const weight = conditionWeights[key] || 0.5
            const weightCategory = weight >= 0.65 ? 'high' : weight >= 0.35 ? 'med' : 'low'
            const weightLabel = weight >= 0.65 ? 'High Specificity' : weight >= 0.35 ? 'Moderate' : 'Common Baseline'

            return (
              <div
                className={`tii__vc-row ${isMatch ? 'tii__vc-row--match' : ''}`}
                key={key}
              >
                <span className="tii__vc-feat-name">{label}</span>
                <span className="tii__vc-weight-col">
                  <span className={`tii__vc-weight-tag tii__vc-weight-tag--${weightCategory}`}>
                    w = {weight.toFixed(2)} ({weightLabel})
                  </span>
                </span>
                <span className={`tii__vc-bit ${inTgt ? 'tii__vc-bit--1' : 'tii__vc-bit--0'}`}>
                  {inTgt ? '1' : '0'}
                </span>
                <span className={`tii__vc-bit ${inCand ? 'tii__vc-bit--1' : 'tii__vc-bit--0'}`}>
                  {inCand ? '1' : '0'}
                </span>
                <span className="tii__vc-status">
                  {isMatch ? (
                    <span className="tii__vc-badge tii__vc-badge--match">1 • 1 (w² = {(weight*weight).toFixed(3)})</span>
                  ) : inTgt ? (
                    <span className="tii__vc-badge tii__vc-badge--target">1 • 0 (Target)</span>
                  ) : (
                    <span className="tii__vc-badge tii__vc-badge--cand">0 • 1 (Candidate)</span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Drug Regimens Vector Dimension */}
      <div className="tii__vc-section">
        <div className="tii__vc-section-header">
          <span className="tii__vc-sec-title">
            <Pill size={12} /> Pharmacotherapy Regimen Vector Space ({allDrugs.length} active dimensions)
          </span>
          <span className="tii__vc-dim-summary">
            Target: {targetDrugSet.size} bits • Match: {candDrugSet.size} bits
          </span>
        </div>
        {allDrugs.length === 0 ? (
          <div className="tii__vc-empty">No active medications recorded for this comparison.</div>
        ) : (
          <div className="tii__vc-table">
            <div className="tii__vc-table-header">
              <span className="tii__vc-col-feat">Active Pharmacotherapy Regimen</span>
              <span className="tii__vc-col-weight">Clinical IDF Weight</span>
              <span className="tii__vc-col-bit" title="Target Patient Vector Bit">Target v<sub>tgt</sub></span>
              <span className="tii__vc-col-bit" title="Candidate Vector Bit">Match v<sub>{candidateRank}</sub></span>
              <span className="tii__vc-col-status">Alignment</span>
            </div>
            {allDrugs.map(([key, label]) => {
              const inTgt = targetDrugSet.has(key)
              const inCand = candDrugSet.has(key)
              const isMatch = inTgt && inCand
              const weight = drugWeights[key] || 0.5
              const weightCategory = weight >= 0.65 ? 'high' : weight >= 0.35 ? 'med' : 'low'
              const weightLabel = weight >= 0.65 ? 'High Specificity' : weight >= 0.35 ? 'Moderate' : 'Common Baseline'

              return (
                <div
                  className={`tii__vc-row ${isMatch ? 'tii__vc-row--match' : ''}`}
                  key={key}
                >
                  <span className="tii__vc-feat-name">{label}</span>
                  <span className="tii__vc-weight-col">
                    <span className={`tii__vc-weight-tag tii__vc-weight-tag--${weightCategory}`}>
                      w = {weight.toFixed(2)} ({weightLabel})
                    </span>
                  </span>
                  <span className={`tii__vc-bit ${inTgt ? 'tii__vc-bit--1' : 'tii__vc-bit--0'}`}>
                    {inTgt ? '1' : '0'}
                  </span>
                  <span className={`tii__vc-bit ${inCand ? 'tii__vc-bit--1' : 'tii__vc-bit--0'}`}>
                    {inCand ? '1' : '0'}
                  </span>
                  <span className="tii__vc-status">
                    {isMatch ? (
                      <span className="tii__vc-badge tii__vc-badge--match">1 • 1 (w² = {(weight*weight).toFixed(3)})</span>
                    ) : inTgt ? (
                      <span className="tii__vc-badge tii__vc-badge--target">1 • 0 (Target)</span>
                    ) : (
                      <span className="tii__vc-badge tii__vc-badge--cand">0 • 1 (Candidate)</span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export function TreatmentIntelPatientPage() {
  const { id } = useParams()
  const [method, setMethod] = useState<'vector' | 'cypher'>('vector')
  const [data, setData] = useState<TreatmentIntel | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showInspector, setShowInspector] = useState(true)
  const [showAllVectors, setShowAllVectors] = useState(false)
  const [expandedVectors, setExpandedVectors] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)
    setNotFound(false)
    setError(null)
    fetchTreatmentIntel(id, method)
      .then((d) => {
        if (cancelled) return
        if (!d) setNotFound(true)
        else setData(d)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id, method])

  const toggleVector = (patientId: string) => {
    setExpandedVectors((prev) => ({
      ...prev,
      [patientId]: !prev[patientId],
    }))
  }

  const toggleAllVectors = () => {
    const next = !showAllVectors
    setShowAllVectors(next)
    if (data?.similar_patients) {
      const updated: Record<string, boolean> = {}
      data.similar_patients.slice(0, 3).forEach((s) => {
        updated[s.id] = next
      })
      setExpandedVectors(updated)
    }
  }

  // Build Vis.js pathway graph:
  const pathwayGraph = useMemo<{ nodes: FNode[]; edges: FEdge[] }>(() => {
    if (!data) return { nodes: [], edges: [] }

    const nodes: FNode[] = []
    const edges: FEdge[] = []
    const seenNodes = new Set<string>()
    const seenEdges = new Set<string>()

    const pName = `${data.patient.first_name} ${data.patient.last_name}`.trim() || data.patient.id
    nodes.push({
      id: data.patient.id,
      label: pName,
      labels: ['Patient'],
      properties: {
        id: data.patient.id,
        name: pName,
        gender: data.patient.gender || 'Unknown',
        diagnoses_count: data.diagnoses.length,
        medications_count: data.patient.medications?.length || 0,
        role: 'Target Patient',
      },
    })
    seenNodes.add(data.patient.id)

    data.diagnoses.forEach((d) => {
      const dId = `disease_${d.toLowerCase().replace(/\s+/g, '_')}`
      if (!seenNodes.has(dId)) {
        nodes.push({
          id: dId,
          label: d,
          labels: ['Disease'],
          properties: { name: d, indication: 'Active Diagnosis' },
        })
        seenNodes.add(dId)
      }
      const edgeKey = `diag_${data.patient.id}_${dId}`
      if (!seenEdges.has(edgeKey)) {
        edges.push({
          id: edgeKey,
          source: data.patient.id,
          target: dId,
          label: 'HAS_DIAGNOSIS',
        })
        seenEdges.add(edgeKey)
      }
    })

    const topTreatments = (data.treatments?.treatments || []).slice(0, 4)
    topTreatments.forEach((tr) => {
      const tId = `treatment_${tr.name.toLowerCase().replace(/\s+/g, '_')}`
      if (!seenNodes.has(tId)) {
        nodes.push({
          id: tId,
          label: tr.name,
          labels: ['Treatment'],
          properties: {
            name: tr.name,
            type: tr.treatment_type || 'Therapy',
            success_rate: tr.success_rate != null ? `${Math.round(tr.success_rate * 100)}%` : 'N/A',
            cost: tr.cost || 'N/A',
            disease_indication: tr.disease,
          },
        })
        seenNodes.add(tId)
      }
      const dId = `disease_${tr.disease.toLowerCase().replace(/\s+/g, '_')}`
      const edgeTreat = `treat_to_${dId}_${tId}`
      if (!seenEdges.has(edgeTreat) && seenNodes.has(dId)) {
        edges.push({
          id: edgeTreat,
          source: tId,
          target: dId,
          label: tr.success_rate != null ? `${Math.round(tr.success_rate * 100)}% Success` : 'Indicated',
        })
        seenEdges.add(edgeTreat)
      }
    })

    data.similar_patients.slice(0, 4).forEach((s) => {
      if (!seenNodes.has(s.id)) {
        nodes.push({
          id: s.id,
          label: s.name,
          labels: ['Patient'],
          properties: {
            id: s.id,
            name: s.name,
            similarity: `${Math.round(s.similarity * 100)}%`,
            condition_similarity: s.condition_similarity != null ? `${Math.round(s.condition_similarity * 100)}%` : 'N/A',
            drug_similarity: s.drug_similarity != null ? `${Math.round(s.drug_similarity * 100)}%` : 'N/A',
            shared_diagnoses: s.shared_diagnoses?.join(', ') || `${s.overlap} conditions`,
            shared_medications: s.shared_medications?.join(', ') || `${s.drug_overlap || 0} drugs`,
            role: 'Similar Cohort',
          },
        })
        seenNodes.add(s.id)
      }
      const edgeSim = `sim_${data.patient.id}_${s.id}`
      if (!seenEdges.has(edgeSim)) {
        const edgeLabel = s.drug_overlap && s.drug_overlap > 0
          ? `${Math.round(s.similarity * 100)}% Sim (${s.overlap} Diag • ${s.drug_overlap} Rx)`
          : `${Math.round(s.similarity * 100)}% Sim`
        edges.push({
          id: edgeSim,
          source: data.patient.id,
          target: s.id,
          label: edgeLabel,
        })
        seenEdges.add(edgeSim)
      }
    })

    return { nodes, edges }
  }, [data])

  if (loading) {
    return (
      <div className="tii page">
        <div className="tii__loading">
          <Loader2 className="tii__spin" size={20} />
          Computing clinical intelligence via {method === 'vector' ? 'Multimodal Vector Space' : 'Cypher Join'}…
        </div>
      </div>
    )
  }

  if (notFound || !data) {
    return (
      <div className="tii page">
        <h1 className="page__heading">Patient not found</h1>
        <p className="tii__muted">
          No patient with id “{id}” exists. <Link to="/treatment-intelligence">Back to Treatment Intelligence</Link>
        </p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="tii page">
        <div className="tii__error">{error}</div>
      </div>
    )
  }

  const name = `${data.patient.first_name} ${data.patient.last_name}`.trim() || data.patient.id
  const maxScore = Math.max(...data.ranked.map((r) => Math.max(r.score, 0.01)), 0.01)
  const calcMeta = data.calculation_meta

  const top3 = data.similar_patients.slice(0, 3)
  const remainingCohort = data.similar_patients.slice(3)

  return (
    <div className="tii page">
      <div className="tii__topbar">
        <Link to="/treatment-intelligence" className="tii__back">
          <ArrowLeft size={15} />
          Treatment Intelligence
        </Link>
        <Link to={`/patients/${data.patient.id}`} className="tii__back">
          Patient profile
        </Link>
      </div>

      <header className="tii__head">
        <div className="tii__icon">
          <TrendingUp size={16} />
        </div>
        <div style={{ flex: 1 }}>
          <div className="tii__title-row">
            <h1 className="page__heading">{name}</h1>
            <span className="tii__patient-id-badge">ID: {data.patient.id.slice(0, 8)}…</span>
          </div>
          <p className="tii__muted">
            Clinical intelligence &amp; personalized care pathways. Scored by biomarker control and positive recovery
            outcomes across similar patient cohorts.
          </p>
        </div>
      </header>

      {/* --- Methodology Selector Bar --- */}
      <div className="tii__methodology-card">
        <div className="tii__methodology-header">
          <div className="tii__methodology-title">
            <Activity size={16} />
            <span>Patient Similarity Methodology</span>
          </div>
          <span className="tii__methodology-note">
            Jury Challenge: Alternate to Cypher graph query for conditions &amp; drug usage
          </span>
        </div>
        <div className="tii__methodology-toggles">
          <button
            type="button"
            className={`tii__toggle-btn ${method === 'vector' ? 'tii__toggle-btn--active' : ''}`}
            onClick={() => setMethod('vector')}
          >
            <Zap size={14} className="tii__toggle-icon" />
            <div className="tii__toggle-text">
              <span className="tii__toggle-title">
                Multimodal Phenotype Vector Space
                {method === 'vector' && <span className="tii__badge-active">Active</span>}
              </span>
              <span className="tii__toggle-sub">
                Dual Cosine Similarity: 50% Condition Vector + 50% Drug Regimen Vector
              </span>
            </div>
          </button>

          <button
            type="button"
            className={`tii__toggle-btn ${method === 'cypher' ? 'tii__toggle-btn--active' : ''}`}
            onClick={() => setMethod('cypher')}
          >
            <Network size={14} className="tii__toggle-icon" />
            <div className="tii__toggle-text">
              <span className="tii__toggle-title">
                Legacy Cypher Graph Overlap
                {method === 'cypher' && <span className="tii__badge-active">Active</span>}
              </span>
              <span className="tii__toggle-sub">
                Discrete Jaccard Set Overlap on Diagnosis string nodes only
              </span>
            </div>
          </button>
        </div>
      </div>

      {/* --- Mathematical Provenance & Vector Calculation Inspector --- */}
      <section className="tii__inspector-card">
        <button
          type="button"
          className="tii__inspector-header-btn"
          onClick={() => setShowInspector(!showInspector)}
        >
          <div className="tii__inspector-title">
            <Info size={16} />
            <span>Mathematical Calculation &amp; Feature Vector Inspector</span>
            <span className="tii__inspector-pill">{method.toUpperCase()} ENGINE</span>
          </div>
          {showInspector ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>

        {showInspector && (
          <div className="tii__inspector-body">
            {method === 'vector' ? (
              <>
                <div className="tii__inspector-formula-box">
                  <div className="tii__formula-label">Continuous Clinical TF-IDF Distance Formula:</div>
                  <div className="tii__formula-code">
                    Similarity(P<sub>target</sub>, P<sub>i</sub>) = (0.50 × Cosine<sub>IDF</sub>(C<sub>target</sub>, C<sub>i</sub>)) + (0.50 × Cosine<sub>IDF</sub>(D<sub>target</sub>, D<sub>i</sub>))
                  </div>
                  <p className="tii__formula-desc">
                    Features are weighted by <strong>Inverse Patient Frequency (IDF)</strong> across the entire hospital cohort: 
                    IDF(t) = ln(1 + N / (1 + DF(t))). Ubiquitous drugs and common symptoms receive lower baseline weights (~0.15–0.30), 
                    while high-risk, specialized medications (e.g. Chemotherapy, Biologics, Insulin) and distinctive diagnoses carry higher similarity impact (~0.75–1.0).
                  </p>
                </div>

                <div className="tii__dimensions-grid">
                  <div className="tii__dimension-card">
                    <span className="tii__dim-num">{calcMeta?.condition_vocab_size || data.diagnoses.length}</span>
                    <span className="tii__dim-label">Condition Feature Dimensions</span>
                    <span className="tii__dim-sub">Target has {data.diagnoses.length} active</span>
                  </div>
                  <div className="tii__dimension-card">
                    <span className="tii__dim-num">{calcMeta?.drug_vocab_size || data.patient.medications?.length || 0}</span>
                    <span className="tii__dim-label">Pharmacotherapy Feature Dimensions</span>
                    <span className="tii__dim-sub">Target has {data.patient.medications?.length || 0} prescribed</span>
                  </div>
                  <div className="tii__dimension-card">
                    <span className="tii__dim-num">50% / 50%</span>
                    <span className="tii__dim-label">Orthogonal Weight Ratio</span>
                    <span className="tii__dim-sub">Equal condition &amp; drug balance</span>
                  </div>
                  <div className="tii__dimension-card">
                    <span className="tii__dim-num">{data.similar_patients.length}</span>
                    <span className="tii__dim-label">Candidate Matches Indexed</span>
                    <span className="tii__dim-sub">Filtered by non-zero overlap</span>
                  </div>
                </div>
              </>
            ) : (
              <div className="tii__inspector-formula-box">
                <div className="tii__formula-label">Discrete Graph Jaccard Overlap:</div>
                <div className="tii__formula-code">
                  Jaccard(P<sub>target</sub>, P<sub>i</sub>) = |Diagnoses<sub>target</sub> ∩ Diagnoses<sub>i</sub>| / |Diagnoses<sub>target</sub> ∪ Diagnoses<sub>i</sub>|
                </div>
                <p className="tii__formula-desc">
                  <strong>Limitation:</strong> Evaluates exact-string node joins only. Fails to model drug regimens, polypharmacy, dosage adjustments, or medication overlap.
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      {/* --- SECTION 1: Top 3 Similar Patients Live Cohort Cards --- */}
      <section className="tii__similar tii__similar--top3">
        <div className="tii__similar-header-row">
          <div>
            <h2 className="tii__section-title">
              <Users size={16} /> Top #{Math.min(3, top3.length)} Similar Patients Live Cohort
            </h2>
            <span className="tii__similar-sub">
              {method === 'vector'
                ? 'Highest-ranking multimodal clinical matches with live continuous mathematical proof & multi-hot vector space.'
                : 'Highest-ranking discrete Cypher graph overlap matches.'}
            </span>
          </div>
          <div className="tii__header-actions">
            <button
              type="button"
              className={`tii__toggle-vectors-btn ${showAllVectors ? 'tii__toggle-vectors-btn--active' : ''}`}
              onClick={toggleAllVectors}
              title="Toggle multi-hot feature vectors for all top 3 matches"
            >
              <Binary size={14} />
              <span>{showAllVectors ? 'Hide All Multi-Hot Vectors' : 'Show All Feature Vectors'}</span>
            </button>
            <span className="tii__engine-tag">
              Engine: {method === 'vector' ? 'Multimodal Dual-Vector' : 'Legacy Cypher Jaccard'}
            </span>
          </div>
        </div>

        {top3.length === 0 ? (
          <p className="tii__muted">No similar patients found in this cohort.</p>
        ) : (
          <div className="tii__cohort-grid">
            {top3.map((s: SimilarPatient, index: number) => {
              const compPct = Math.round(s.similarity * 100)
              const condPct = s.condition_similarity != null ? Math.round(s.condition_similarity * 100) : compPct
              const drugPct = s.drug_similarity != null ? Math.round(s.drug_similarity * 100) : 0
              const isVectorExpanded = showAllVectors || !!expandedVectors[s.id]

              return (
                <div className="tii__patient-card tii__patient-card--top3" key={s.id}>
                  <div className="tii__card-top">
                    <div className="tii__card-identity">
                      <span className="tii__card-rank-badge">Rank #{index + 1}</span>
                      <Link to={`/treatment-intelligence/${s.id}`} className="tii__card-name">
                        {s.name}
                      </Link>
                      <span className="tii__card-id">ID: {s.id.slice(0, 8)}…</span>
                    </div>
                    <div className="tii__score-badge" title="Composite Similarity Score">
                      <span className="tii__score-num">{compPct}%</span>
                      <span className="tii__score-text">Match</span>
                    </div>
                  </div>

                  {/* Subscore meters for vector mode */}
                  {method === 'vector' && (
                    <div className="tii__subscores">
                      <div className="tii__subscore-item">
                        <div className="tii__subscore-info">
                          <span className="tii__subscore-name">
                            <Stethoscope size={12} /> Condition Vector
                          </span>
                          <span className="tii__subscore-val">{condPct}%</span>
                        </div>
                        <div className="tii__subscore-bar">
                          <div className="tii__subscore-fill tii__subscore-fill--cond" style={{ width: `${condPct}%` }} />
                        </div>
                      </div>

                      <div className="tii__subscore-item">
                        <div className="tii__subscore-info">
                          <span className="tii__subscore-name">
                            <Pill size={12} /> Drug Regimen Vector
                          </span>
                          <span className="tii__subscore-val">{drugPct}%</span>
                        </div>
                        <div className="tii__subscore-bar">
                          <div className="tii__subscore-fill tii__subscore-fill--drug" style={{ width: `${drugPct}%` }} />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Interactive Step-by-Step Proof */}
                  <div className="tii__math-proof">
                    <div className="tii__math-proof-badge">
                      <Calculator size={13} />
                      <span>Live Mathematical Proof &amp; Exact Substitution (Top #{index + 1})</span>
                    </div>

                    {method === 'vector' ? (
                      <div className="tii__math-steps">
                        {/* Step 1: Clinical TF-IDF Weighted Condition Cosine */}
                        <div className="tii__math-step">
                          <div className="tii__math-step-title">
                            <span className="tii__step-num">Step 1:</span> Condition Vector Cosine (Inverse Patient Frequency Weighted)
                          </div>
                          <div className="tii__math-formula">
                            Cosine<sub>IDF</sub>(C<sub>tgt</sub>, C<sub>{index + 1}</sub>) = (∑<sub>t ∈ C<sub>tgt</sub> ∩ C<sub>{index + 1}</sub></sub> w<sub>t</sub>²) / (||v<sub>tgt</sub>|| × ||v<sub>{index + 1}</sub>||)
                          </div>
                          <div className="tii__math-eval">
                            {s.cond_dot != null && s.cond_norm_tgt != null && s.cond_norm_cand != null ? (
                              <>
                                = {s.cond_dot.toFixed(3)} / ({s.cond_norm_tgt.toFixed(3)} × {s.cond_norm_cand.toFixed(3)})
                                <br />
                                = {s.cond_dot.toFixed(3)} / {(s.cond_norm_tgt * s.cond_norm_cand).toFixed(3)}
                                {' '}= <strong>{condPct}%</strong> (score: {s.condition_similarity ?? 0})
                                <span className="tii__math-subnote"> ({s.shared_diag_count ?? s.overlap} shared conditions, rarity-scaled)</span>
                              </>
                            ) : (
                              <>
                                = {s.shared_diag_count ?? s.overlap} shared / (√{s.target_diag_count ?? data.diagnoses.length} × √{s.candidate_diag_count ?? s.overlap})
                                = <strong>{condPct}%</strong> (score: {s.condition_similarity ?? 0})
                              </>
                            )}
                          </div>
                        </div>

                        {/* Step 2: Clinical TF-IDF Weighted Pharmacotherapy Cosine */}
                        <div className="tii__math-step">
                          <div className="tii__math-step-title">
                            <span className="tii__step-num">Step 2:</span> Drug Regimen Cosine (Inverse Patient Frequency Weighted)
                          </div>
                          <div className="tii__math-formula">
                            Cosine<sub>IDF</sub>(D<sub>tgt</sub>, D<sub>{index + 1}</sub>) = (∑<sub>m ∈ D<sub>tgt</sub> ∩ D<sub>{index + 1}</sub></sub> w<sub>m</sub>²) / (||v<sub>tgt</sub>|| × ||v<sub>{index + 1}</sub>||)
                          </div>
                          <div className="tii__math-eval">
                            {s.drug_dot != null && s.drug_norm_tgt != null && s.drug_norm_cand != null && (s.drug_norm_tgt * s.drug_norm_cand > 0) ? (
                              <>
                                = {s.drug_dot.toFixed(3)} / ({s.drug_norm_tgt.toFixed(3)} × {s.drug_norm_cand.toFixed(3)})
                                <br />
                                = {s.drug_dot.toFixed(3)} / {(s.drug_norm_tgt * s.drug_norm_cand).toFixed(3)}
                                {' '}= <strong>{drugPct}%</strong> (score: {s.drug_similarity ?? 0})
                                <span className="tii__math-subnote"> ({s.shared_drug_count ?? s.drug_overlap ?? 0} shared regimens, rarity-scaled)</span>
                              </>
                            ) : (
                              <>
                                = 0 (no drug overlap or regimen unrecorded) = <strong>{drugPct}%</strong> (score: {s.drug_similarity ?? 0})
                              </>
                            )}
                          </div>
                        </div>

                        {/* Step 3: Composite Clinical Phenotype Score */}
                        <div className="tii__math-step tii__math-step--composite">
                          <div className="tii__math-step-title">
                            <span className="tii__step-num">Step 3:</span> Weighted Composite Clinical Score
                          </div>
                          <div className="tii__math-formula">
                            Score = (0.50 × Cosine<sub>Cond,IDF</sub>) + (0.50 × Cosine<sub>Drug,IDF</sub>)
                          </div>
                          <div className="tii__math-eval">
                            = (0.50 × {s.condition_similarity ?? 0}) + (0.50 × {s.drug_similarity ?? 0})
                            <br />
                            = {(0.5 * (s.condition_similarity ?? 0)).toFixed(3)} + {(0.5 * (s.drug_similarity ?? 0)).toFixed(3)}
                            {' '}= <span className="tii__math-final-score">{s.similarity} ({compPct}% Match)</span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="tii__math-steps">
                        <div className="tii__math-step">
                          <div className="tii__math-step-title">
                            <span className="tii__step-num">Step 1:</span> Discrete Graph Jaccard Overlap
                          </div>
                          <div className="tii__math-formula">
                            Jaccard = |Diags<sub>tgt</sub> ∩ Diags<sub>{index + 1}</sub>| / |Diags<sub>tgt</sub> ∪ Diags<sub>{index + 1}</sub>|
                          </div>
                          <div className="tii__math-eval">
                            = {s.overlap} / ({s.target_diag_count ?? data.diagnoses.length} + {s.candidate_diag_count ?? s.overlap} - {s.overlap})
                            <br />
                            = {s.overlap} / {(s.target_diag_count ?? data.diagnoses.length) + (s.candidate_diag_count ?? s.overlap) - s.overlap}
                            {' '}= <span className="tii__math-final-score">{s.similarity} ({compPct}% Match)</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Toggle Button for Multi-Hot Feature Vectors */}
                  <button
                    type="button"
                    className={`tii__vector-toggle-btn ${isVectorExpanded ? 'tii__vector-toggle-btn--active' : ''}`}
                    onClick={() => toggleVector(s.id)}
                  >
                    <Binary size={13} />
                    <span>{isVectorExpanded ? 'Hide Multi-Hot Vectors' : 'Show Multi-Hot Vectors (Target vs Match)'}</span>
                    {isVectorExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>

                  {/* Vector Space Projection Details */}
                  {isVectorExpanded && (
                    <PatientVectorComparator
                      targetDiagnoses={data.diagnoses}
                      targetMedications={data.patient.medications || []}
                      candidateDiagnoses={s.diagnoses || s.shared_diagnoses || []}
                      candidateMedications={s.medications || s.shared_medications || []}
                      candidateRank={index + 1}
                      conditionWeights={data.calculation_meta?.condition_weights}
                      drugWeights={data.calculation_meta?.drug_weights}
                    />
                  )}

                  {/* Shared Diagnoses */}
                  <div className="tii__tags-section">
                    <span className="tii__tags-label">Shared Conditions ({s.shared_diagnoses?.length || s.overlap}):</span>
                    <div className="tii__tags-list">
                      {s.shared_diagnoses && s.shared_diagnoses.length > 0 ? (
                        s.shared_diagnoses.map((d) => (
                          <span className="tii__tag tii__tag--disease" key={d}>
                            {d}
                          </span>
                        ))
                      ) : (
                        <span className="tii__tag tii__tag--none">No direct condition overlap</span>
                      )}
                    </div>
                  </div>

                  {/* Shared Medications */}
                  <div className="tii__tags-section">
                    <span className="tii__tags-label">
                      Shared Pharmacotherapy ({s.shared_medications?.length || s.drug_overlap || 0}):
                    </span>
                    <div className="tii__tags-list">
                      {s.shared_medications && s.shared_medications.length > 0 ? (
                        s.shared_medications.map((m) => (
                          <span className="tii__tag tii__tag--med" key={m}>
                            <Pill size={10} style={{ display: 'inline', marginRight: 4 }} />
                            {m}
                          </span>
                        ))
                      ) : (
                        <span className="tii__tag tii__tag--none">No direct drug overlap</span>
                      )}
                    </div>
                  </div>

                  {/* Clinical Explainability Rationale */}
                  {s.rationale && (
                    <div className="tii__rationale-box">
                      <span className="tii__rationale-label">Clinical Rationale:</span>
                      <p className="tii__rationale-text">{s.rationale}</p>
                    </div>
                  )}

                  <div className="tii__card-actions">
                    <Link to={`/treatment-intelligence/${s.id}`} className="tii__inspect-btn">
                      Inspect Care Pathway →
                    </Link>
                    <Link to={`/patients/${s.id}`} className="tii__profile-link">
                      View EHR Profile
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* --- SECTION 2: Vis.js Interactive Pathway Graph (MOVED HERE AFTER TOP 3) --- */}
      <section className="tii__graph-card">
        <div className="tii__graph-header">
          <div className="tii__graph-title">
            <Share2 size={16} />
            <span>Interactive Care &amp; Treatment Pathway</span>
          </div>
          <span className="tii__graph-hint">
            Graph nodes: Target Patient • Ranked Conditions • Prescribed Therapies • Similar Cohort
          </span>
        </div>
        <div className="tii__graph-canvas">
          <LazyFeatureGraph
            nodes={pathwayGraph.nodes}
            edges={pathwayGraph.edges}
            centerId={data.patient.id}
            height={480}
          />
        </div>
      </section>

      {/* --- SECTION 3: Remaining Similar Cohort (#4 onwards) --- */}
      {remainingCohort.length > 0 && (
        <section className="tii__similar tii__similar--remaining">
          <div className="tii__similar-header-row">
            <div>
              <h2 className="tii__section-title">
                <Users size={16} /> Extended Cohort Matches ({remainingCohort.length} additional patients)
              </h2>
              <span className="tii__similar-sub">
                Lower-affinity matches indexed across clinical condition and medication dimensions.
              </span>
            </div>
            <span className="tii__cohort-counter">Rank #4 – #{data.similar_patients.length}</span>
          </div>

          <div className="tii__cohort-grid">
            {remainingCohort.map((s: SimilarPatient, rIdx: number) => {
              const compPct = Math.round(s.similarity * 100)
              const condPct = s.condition_similarity != null ? Math.round(s.condition_similarity * 100) : compPct
              const drugPct = s.drug_similarity != null ? Math.round(s.drug_similarity * 100) : 0
              const rankNum = rIdx + 4

              return (
                <div className="tii__patient-card" key={s.id}>
                  <div className="tii__card-top">
                    <div className="tii__card-identity">
                      <span className="tii__card-rank-badge tii__card-rank-badge--subtle">Rank #{rankNum}</span>
                      <Link to={`/treatment-intelligence/${s.id}`} className="tii__card-name">
                        {s.name}
                      </Link>
                      <span className="tii__card-id">ID: {s.id.slice(0, 8)}…</span>
                    </div>
                    <div className="tii__score-badge" title="Composite Similarity Score">
                      <span className="tii__score-num">{compPct}%</span>
                      <span className="tii__score-text">Match</span>
                    </div>
                  </div>

                  {/* Subscore meters for vector mode */}
                  {method === 'vector' && (
                    <div className="tii__subscores">
                      <div className="tii__subscore-item">
                        <div className="tii__subscore-info">
                          <span className="tii__subscore-name">
                            <Stethoscope size={12} /> Condition Vector
                          </span>
                          <span className="tii__subscore-val">{condPct}%</span>
                        </div>
                        <div className="tii__subscore-bar">
                          <div className="tii__subscore-fill tii__subscore-fill--cond" style={{ width: `${condPct}%` }} />
                        </div>
                      </div>

                      <div className="tii__subscore-item">
                        <div className="tii__subscore-info">
                          <span className="tii__subscore-name">
                            <Pill size={12} /> Drug Regimen Vector
                          </span>
                          <span className="tii__subscore-val">{drugPct}%</span>
                        </div>
                        <div className="tii__subscore-bar">
                          <div className="tii__subscore-fill tii__subscore-fill--drug" style={{ width: `${drugPct}%` }} />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Shared Diagnoses */}
                  <div className="tii__tags-section">
                    <span className="tii__tags-label">Shared Conditions ({s.shared_diagnoses?.length || s.overlap}):</span>
                    <div className="tii__tags-list">
                      {s.shared_diagnoses && s.shared_diagnoses.length > 0 ? (
                        s.shared_diagnoses.map((d) => (
                          <span className="tii__tag tii__tag--disease" key={d}>
                            {d}
                          </span>
                        ))
                      ) : (
                        <span className="tii__tag tii__tag--none">No direct condition overlap</span>
                      )}
                    </div>
                  </div>

                  {/* Shared Medications */}
                  <div className="tii__tags-section">
                    <span className="tii__tags-label">
                      Shared Pharmacotherapy ({s.shared_medications?.length || s.drug_overlap || 0}):
                    </span>
                    <div className="tii__tags-list">
                      {s.shared_medications && s.shared_medications.length > 0 ? (
                        s.shared_medications.map((m) => (
                          <span className="tii__tag tii__tag--med" key={m}>
                            <Pill size={10} style={{ display: 'inline', marginRight: 4 }} />
                            {m}
                          </span>
                        ))
                      ) : (
                        <span className="tii__tag tii__tag--none">No direct drug overlap</span>
                      )}
                    </div>
                  </div>

                  {/* Clinical Explainability Rationale */}
                  {s.rationale && (
                    <div className="tii__rationale-box">
                      <span className="tii__rationale-label">Clinical Rationale:</span>
                      <p className="tii__rationale-text">{s.rationale}</p>
                    </div>
                  )}

                  <div className="tii__card-actions">
                    <Link to={`/treatment-intelligence/${s.id}`} className="tii__inspect-btn">
                      Inspect Care Pathway →
                    </Link>
                    <Link to={`/patients/${s.id}`} className="tii__profile-link">
                      View EHR Profile
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* --- SECTION 4: Ranked Diagnoses by Biomarker Control --- */}
      <section className="tii__ranked">
        <div className="tii__ranked-header">
          <h2 className="tii__section-title">
            <Sparkles size={16} /> Ranked Diagnoses by Biomarker Control
          </h2>
          <span className="tii__ranked-sub">
            Rank 1 indicates the condition with highest verified therapeutic control in this cohort.
          </span>
        </div>

        {data.ranked.length === 0 && (
          <div className="tii__empty">This patient has no diagnoses to rank.</div>
        )}
        {data.ranked.map((r) => {
          const pct = Math.max(0, Math.min(100, (r.score / maxScore) * 100))
          return (
            <div className="tii__rank" key={r.disease}>
              <div className="tii__rank-top">
                <div className="tii__rank-rank">
                  <span className="tii__rank-num">{r.rank}</span>
                </div>
                <div className="tii__rank-main">
                  <div className="tii__rank-name">
                    {r.disease}
                    {r.confidence_low && <span className="tii__low">low confidence</span>}
                  </div>
                  <div className="tii__rank-bar">
                    <div className="tii__rank-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="tii__rank-note">{r.note}</div>
                </div>
                <div className="tii__rank-score-wrap">
                  <div className="tii__rank-score">{r.score.toFixed(2)}</div>
                  <div className="tii__rank-score-label">Control Score</div>
                </div>
              </div>
            </div>
          )
        })}
      </section>

      {/* --- SECTION 5: Recommended Treatments --- */}
      <section className="tii__treatments">
        <h2 className="tii__section-title">
          <Pill size={16} /> Recommended treatments &amp; medications
        </h2>
        {!data.treatments ? (
          <p className="tii__muted">Treatment recommendations are not available.</p>
        ) : !data.treatments.has_data || data.treatments.treatments.length === 0 ? (
          <div className="tii__treatments-note">
            {data.treatments.note ?? 'No treatment data available to rank.'}
          </div>
        ) : (
          <>
            {!data.treatments.has_outcome && data.treatments.note && (
              <div className="tii__treatments-note">{data.treatments.note}</div>
            )}
            <div className="tii__treatment-list">
              {data.treatments.treatments.map((tr) => {
                const pct = tr.success_rate == null
                  ? 0
                  : Math.max(0, Math.min(100, tr.success_rate * 100))
                return (
                  <div className="tii__treatment" key={`${tr.name}-${tr.rank ?? ''}-${tr.disease}`}>
                    <div className="tii__treatment-main">
                      <div className="tii__treatment-title">
                        <span className="tii__treatment-name">{tr.name}</span>
                        {tr.treatment_type ? (
                          <span className="tii__treatment-type">{tr.treatment_type}</span>
                        ) : null}
                        <span className="tii__treatment-disease">for {tr.disease}</span>
                      </div>
                      <div className="tii__treatment-meta">
                        {tr.cost ? <span>Cost: ${tr.cost}</span> : null}
                        {tr.success_rate != null && (
                          <span className="tii__treatment-rate">
                            <CheckCircle2 size={13} style={{ display: 'inline', marginRight: 3, verticalAlign: 'middle' }} />
                            {Math.round(pct)}% cohort efficacy
                          </span>
                        )}
                        {tr.description ? (
                          <span className="tii__treatment-desc">{tr.description}</span>
                        ) : null}
                      </div>
                      {tr.recovered_patients.length > 0 && (
                        <div className="tii__treatment-recovered">
                          <strong>Similar patients with controlled outcomes:</strong>{' '}
                          {tr.recovered_patients.map((r) => r.name).join(', ')}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </section>
    </div>
  )
}
