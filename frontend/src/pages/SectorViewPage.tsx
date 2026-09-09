import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  FolderKanban,
  Loader2,
  Pill,
  Stethoscope,
  CheckCircle2,
  Activity,
  TrendingUp,
  Sparkles,
  Users,
} from 'lucide-react'
import { fetchSectorGraph, fetchSectorIntelligence, type SectorIntelligence } from '../lib/api'
import { graphFromCypher } from '../lib/graphData'
import { LazyFeatureGraph, type FEdge, type FNode } from '../components/feature/LazyFeatureGraph'
import './SectorViewPage.css'

export function SectorViewPage() {
  const { id } = useParams()
  const diseaseName = id ? id.replace(/-/g, ' ').trim() : ''
  const [graph, setGraph] = useState<{ nodes: FNode[]; edges: FEdge[] } | null>(null)
  const [intel, setIntel] = useState<SectorIntelligence | null>(null)
  const [loading, setLoading] = useState(true)
  const [intelLoading, setIntelLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [diseaseLabel, setDiseaseLabel] = useState<string | null>(null)

  useEffect(() => {
    if (!diseaseName) {
      setLoading(false)
      setError('No sector selected.')
      return
    }
    let cancelled = false
    setLoading(true)
    setIntelLoading(true)
    setError(null)
    setDiseaseLabel(null)

    // 1. Fetch cohort graph via the dedicated sector-graph endpoint
    fetchSectorGraph(diseaseName)
      .then((res) => {
        if (cancelled) return
        if (res.error) {
          setError(res.error)
          setGraph(null)
          return
        }
        setGraph(graphFromCypher(res))
        const diseaseNode = res.rows
          .flat()
          .find(
            (c) =>
              typeof c === 'object' &&
              c !== null &&
              (c as { _labels?: string[] })._labels?.includes('Disease'),
          )
        const name = (diseaseNode as { properties?: { name?: string } } | null)?.properties?.name
        if (name) setDiseaseLabel(name)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load cohort')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    // 2. Fetch sector treatment intelligence
    fetchSectorIntelligence(diseaseName)
      .then((data) => {
        if (cancelled) return
        setIntel(data)
        if (data?.disease && !diseaseLabel) {
          setDiseaseLabel(data.disease)
        }
      })
      .catch(() => {
        // Silently keep intel null if not available
      })
      .finally(() => {
        if (!cancelled) setIntelLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [diseaseName])

  const centerNodeId = graph?.nodes.find((n) => n.labels.includes('Disease'))?.id

  const displayName = diseaseLabel ?? (diseaseName || 'Sector')

  return (
    <div className="page sector-page">
      <div className="sector-view__header">
        <div className="sector-view__icon">
          <FolderKanban size={18} />
        </div>
        <div>
          <h1 className="page__heading">{displayName}</h1>
          <p className="sector-view__sub">
            Disease cohort intelligence: population outcomes, clinical biomarker response,
            and best treatments ranked by real-world efficacy.
          </p>
        </div>
      </div>

      {/* Cohort Key Metrics */}
      {intel && (
        <section className="sector-intel__kpis">
          <div className="sector-kpi-card">
            <div className="sector-kpi-card__label">
              <Users size={14} /> Cohort Population
            </div>
            <div className="sector-kpi-card__val">{intel.total_patients}</div>
            <div className="sector-kpi-card__sub">
              Diagnosed patients in active registry
            </div>
          </div>

          <div className="sector-kpi-card">
            <div className="sector-kpi-card__label">
              <Activity size={14} /> Biomarker Control Rate
            </div>
            <div className="sector-kpi-card__val">
              {Math.round(intel.control_rate * 100)}%
            </div>
            <div className="sector-kpi-card__sub">
              {intel.controlled_patients} of {intel.total_patients} controlled on labs
            </div>
          </div>

          {intel.best_option && (
            <div className="sector-kpi-card sector-kpi-card--highlight">
              <div className="sector-kpi-card__label">
                <Sparkles size={14} /> Top Treatment Choice
              </div>
              <div className="sector-kpi-card__val sector-kpi-card__val--sm">
                {intel.best_option.name}
              </div>
              <div className="sector-kpi-card__sub">
                {Math.round((intel.best_option.success_rate || 0.85) * 100)}% cohort efficacy • {intel.best_option.recommendation_level}
              </div>
            </div>
          )}

          {intel.biomarkers_monitored.length > 0 && (
            <div className="sector-kpi-card">
              <div className="sector-kpi-card__label">
                <TrendingUp size={14} /> Monitored Biomarkers
              </div>
              <div className="sector-kpi-card__tags">
                {intel.biomarkers_monitored.map((b) => (
                  <span key={b} className="sector-tag">
                    {b}
                  </span>
                ))}
              </div>
              <div className="sector-kpi-card__sub">Clinical diagnostic cutoff targets</div>
            </div>
          )}
        </section>
      )}

      {/* Cohort Vis.js Network Graph */}
      <section className="sector-view__graph-card">
        <div className="sector-view__graph-header">
          <h2 className="sector-view__section-title">Cohort Knowledge Graph</h2>
          <span className="sector-view__hint">
            Click any node to view clinical properties and connections
          </span>
        </div>
        {loading && (
          <div className="sector-view__loading">
            <Loader2 className="sector-view__spin" size={20} />
            Loading cohort graph…
          </div>
        )}
        {!loading && error && <div className="sector-view__error">{error}</div>}
        {!loading && !error && graph && (
          <LazyFeatureGraph
            nodes={graph.nodes}
            edges={graph.edges}
            centerId={centerNodeId}
            height={480}
          />
        )}
        {!loading && !error && graph && graph.nodes.length === 0 && (
          <div className="sector-view__error">No graph data found for this sector.</div>
        )}
      </section>

      {/* Best Treatments for this Disease */}
      <section className="sector-treatments-section">
        <div className="sector-treatments-section__header">
          <div className="sector-treatments-section__title-group">
            <h2 className="sector-view__section-title">
              <Sparkles size={18} className="sector-icon-gold" /> Best Treatments for {displayName}
            </h2>
            <p className="sector-treatments-section__sub">
              Evidence-based ranking across population outcomes, recovery rates, and real-world efficacy.
            </p>
          </div>
        </div>

        {intelLoading ? (
          <div className="sector-view__loading">
            <Loader2 className="sector-view__spin" size={20} />
            Evaluating clinical efficacy…
          </div>
        ) : !intel ? (
          <div className="sector-view__error">No treatment intelligence available for this sector.</div>
        ) : (
          <div className="sector-treatments-grid">
            {/* Pharmacotherapies Column */}
            <div className="sector-treatments-col">
              <div className="sector-col-header">
                <Pill size={16} />
                <h3>Recommended Pharmacotherapy (Medications)</h3>
              </div>

              {intel.medications.length === 0 ? (
                <div className="sector-empty-card">
                  No specific indicated medications found in registry for this condition.
                </div>
              ) : (
                <div className="sector-cards-list">
                  {intel.medications.map((m, idx) => (
                    <div className="sector-treatment-card" key={m.name}>
                      <div className="sector-treatment-card__top">
                        <span className="sector-badge sector-badge--rank">#{idx + 1}</span>
                        <span className="sector-treatment-card__name">{m.name}</span>
                        <span className="sector-badge sector-badge--level">{m.recommendation_level}</span>
                      </div>
                      <div className="sector-treatment-card__bar-wrap">
                        <div className="sector-bar-label">
                          <span>Efficacy / Control</span>
                          <span>{Math.round(m.success_rate * 100)}%</span>
                        </div>
                        <div className="sector-bar">
                          <div
                            className="sector-bar__fill"
                            style={{ width: `${Math.round(m.success_rate * 100)}%` }}
                          />
                        </div>
                      </div>
                      <div className="sector-treatment-card__footer">
                        <span className="sector-evidence-tag">{m.evidence_note}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Procedures & Interventions Column */}
            <div className="sector-treatments-col">
              <div className="sector-col-header">
                <Stethoscope size={16} />
                <h3>Clinical Interventions & Procedures</h3>
              </div>

              {intel.treatments.length === 0 ? (
                <div className="sector-empty-card">
                  No procedural treatments recorded for this disease cohort.
                </div>
              ) : (
                <div className="sector-cards-list">
                  {intel.treatments.map((t, idx) => (
                    <div className="sector-treatment-card" key={`${t.name}-${idx}`}>
                      <div className="sector-treatment-card__top">
                        <span className="sector-badge sector-badge--rank">#{idx + 1}</span>
                        <span className="sector-treatment-card__name">{t.name}</span>
                        <span className="sector-badge sector-badge--outcome">
                          <CheckCircle2 size={12} /> {t.outcome}
                        </span>
                      </div>
                      <div className="sector-treatment-card__bar-wrap">
                        <div className="sector-bar-label">
                          <span>Clinical Success</span>
                          <span>{Math.round(t.success_rate * 100)}%</span>
                        </div>
                        <div className="sector-bar">
                          <div
                            className="sector-bar__fill"
                            style={{ width: `${Math.round(t.success_rate * 100)}%` }}
                          />
                        </div>
                      </div>
                      <div className="sector-treatment-card__footer">
                        <span className="sector-evidence-tag">{t.evidence_note}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}