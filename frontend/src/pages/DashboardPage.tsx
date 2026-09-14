import { useEffect, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { Users, Activity, Pill, FlaskConical, FileText, FolderKanban, Loader2 } from 'lucide-react'
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import { fetchSchema, fetchRecentNotes, fetchSectors, fetchTopSectors } from '../lib/api'
import { tokenColor } from '../lib/graphColors'
import './DashboardPage.css'

interface RecentNote {
  id: string
  name: string
  summary: string
  created: string
}

interface SectorRow {
  disease: string
  patients: number
}

interface RadarDatum {
  label: string
  patients: number
}

const statCards = [
  { label: 'Total Patients', key: 'Patient', icon: Users },
  { label: 'Diseases', key: 'Disease', icon: Activity },
  { label: 'Medications', key: 'Medication', icon: Pill },
  { label: 'Treatments', key: 'Treatment', icon: FlaskConical },
  { label: 'Consultations', key: 'ConsultationNote', icon: FileText },
] as const

export function DashboardPage() {
  const [schema, setSchema] = useState<{ labels: Array<{ label: string; count: number }>; node_count: number } | null>(null)
  const [recent, setRecent] = useState<RecentNote[]>([])
  const [sectors, setSectors] = useState<SectorRow[]>([])
  const [radarRows, setRadarRows] = useState<RadarDatum[]>([])
  const [sectorCount, setSectorCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([fetchSchema(), fetchRecentNotes(), fetchSectors(), fetchTopSectors()])
      .then(([sch, notesRes, sectorRows, topSectRes]) => {
        if (cancelled) return
        setSchema(sch)
        setRecent(notesRes)
        setRadarRows(
          sectorRows.slice(0, 6).map((s) => ({
            label: s.name,
            patients: s.patients,
          })),
        )
        setSectorCount(sectorRows.length)
        setSectors(topSectRes)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load dashboard')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="page">
      <h1 className="page__heading">Dashboard</h1>
      {loading && (
        <div className="dash-loading">
          <Loader2 className="dash-spin" size={18} /> Loading dashboard…
        </div>
      )}

      {!loading && error && <div className="dash-error">{error}</div>}

      {!loading && !error && schema && (
        <>
          <div className="dashboard-stats">
            {statCards.map((card) => {
              const live = schema.labels.find((l) => l.label === card.key)?.count ?? 0
              const color = tokenColor('--color-text')
              const contrast = tokenColor('--color-bg')
              return (
                <div
                  className="stat-card"
                  key={card.label}
                  style={{ '--card-color': color, '--card-contrast': contrast } as CSSProperties}
                >
                  <span className="stat-card__icon">
                    <card.icon size={16} />
                  </span>
                  <div className="stat-card__body">
                    <span className="stat-card__label">{card.label}</span>
                    <span className="stat-card__value">{live.toLocaleString()}</span>
                  </div>
                </div>
              )
            })}
          </div>

          <section className="dash-panel dash-panel--radar">
            <div className="dash-panel__head">
              <Activity size={16} className="dash-panel__icon" />
              <h2 className="dash-panel__title">Top Disease Sectors</h2>
            </div>
            <p className="dash-radar__sub">Top 6 diseases by patient count</p>
            {radarRows.length === 0 ? (
              <p className="dash-empty">No disease data available.</p>
            ) : (
              <DiseaseRadarChart data={radarRows} totalSectors={sectorCount} />
            )}
          </section>

          <div className="dash-grid">
            <section className="dash-panel">
              <div className="dash-panel__head">
                <FileText size={16} className="dash-panel__icon" />
                <h2 className="dash-panel__title">Recent consultations</h2>
              </div>
              {recent.length === 0 ? (
                <p className="dash-empty">No consultation notes yet.</p>
              ) : (
                <ul className="dash-notes">
                  {recent.map((n) => (
                    <li className="dash-note" key={n.id}>
                      <Link to={`/patients/${n.id}`} className="dash-note__name">
                        {n.name}
                      </Link>
                      <span className="dash-note__date">{n.created?.slice(0, 10)}</span>
                      <p className="dash-note__summary">{n.summary}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="dash-panel">
              <div className="dash-panel__head">
                <FolderKanban size={16} className="dash-panel__icon" />
                <h2 className="dash-panel__title">Top sectors</h2>
              </div>
              {sectors.length === 0 ? (
                <p className="dash-empty">No disease cohorts yet.</p>
              ) : (
                <ul className="dash-sectors">
                  {sectors.map((s) => (
                    <li key={s.disease}>
                      <Link className="dash-sector" to={`/sectors/${s.disease.toLowerCase()}`}>
                        <span className="dash-sector__name">{s.disease}</span>
                        <span className="dash-sector__count">{s.patients} patients</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}

/** Round the radial-axis step up to a "nice" value so ticks stay sensible. */
function niceStep(max: number): number {
  if (max <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(max)))
  const norm = max / pow
  let m = 10
  if (norm <= 1) m = 1
  else if (norm <= 2) m = 2
  else if (norm <= 2.5) m = 2.5
  else if (norm <= 5) m = 5
  return m * pow
}

/** Break a label into short lines so angled labels don't clip. */
function wrapLabel(label: string, max = 11): string[] {
  const words = label.split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w
    if (candidate.length <= max) {
      cur = candidate
    } else {
      if (cur) lines.push(cur)
      cur = w
    }
  }
  if (cur) lines.push(cur)
  return lines
}

interface AngleTickProps {
  x?: number
  y?: number
  textAnchor?: 'end' | 'middle' | 'start' | 'inherit'
  payload?: { value?: unknown }
}

function AngleTick(props: AngleTickProps) {
  const { x = 0, y = 0, textAnchor = 'middle', payload } = props
  const label = String(payload?.value ?? '')
  const lines = wrapLabel(label)
  const showFull = lines.length > 1
  return (
    <g>
      {showFull && <title>{label}</title>}
      <text x={x} y={y} textAnchor={textAnchor} className="dash-radar__label">
        {lines.map((line, i) => (
          <tspan key={line} x={x} dy={i === 0 ? 0 : 12}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  )
}

interface DiseaseTooltipProps {
  active?: boolean
  payload?: Array<{ value: number; payload: RadarDatum }>
}

function DiseaseTooltip({ active, payload }: DiseaseTooltipProps) {
  if (!active || !payload || payload.length === 0) return null
  const row = payload[0]
  return (
    <div className="dash-radar__tooltip">
      <span className="dash-radar__tooltip-label">Disease</span>
      <span className="dash-radar__tooltip-value">{row.payload.label}</span>
      <span className="dash-radar__tooltip-label">Patients</span>
      <span className="dash-radar__tooltip-value">{row.value.toLocaleString()}</span>
    </div>
  )
}

/** Recharts radar chart: one vertex per top disease, radial value = patient count. */
function DiseaseRadarChart({ data, totalSectors }: { data: RadarDatum[]; totalSectors: number }) {
  const brand = tokenColor('--color-brand')
  const grid = tokenColor('--color-border')
  const muted = tokenColor('--color-text-muted')
  const maxPatients = Math.max(...data.map((d) => d.patients), 1)
  const axisMax = niceStep(maxPatients / 4) * 4

  return (
    <div className="dash-radar" role="img" aria-label="Radar chart of the top six disease sectors by patient count">
      <ResponsiveContainer width="100%" height={400}>
        <RadarChart data={data} cx="50%" cy="50%" outerRadius="72%">
          <PolarGrid gridType="polygon" stroke={grid} />
          <PolarAngleAxis dataKey="label" tick={<AngleTick />} axisLine={{ stroke: grid }} />
          <PolarRadiusAxis
            domain={[0, axisMax]}
            tickCount={5}
            angle={90}
            stroke="none"
            tick={{ fill: muted, fontSize: 11 }}
          />
          <Radar
            dataKey="patients"
            stroke={brand}
            fill={brand}
            fillOpacity={0.15}
            strokeWidth={2}
            dot={{ r: 3, fill: brand, stroke: brand }}
          />
          <Tooltip cursor={false} content={<DiseaseTooltip />} />
        </RadarChart>
      </ResponsiveContainer>
      <p className="dash-radar__cap">
        Radial axis = patient count · top {data.length} of {totalSectors} disease sectors.
      </p>
    </div>
  )
}