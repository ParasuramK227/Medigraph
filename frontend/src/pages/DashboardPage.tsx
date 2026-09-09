import { useEffect, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { Users, Activity, Pill, FlaskConical, FileText, FolderKanban, TrendingUp, Loader2 } from 'lucide-react'
import { fetchSchema, runCypher } from '../lib/api'
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

interface TrendPoint {
  month: string
  count: number
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
  const [trend, setTrend] = useState<TrendPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      fetchSchema(),
      runCypher(
        `MATCH (p:Patient)-[:HAS_CONSULTATION_NOTE]->(n:ConsultationNote)
         RETURN p.id AS id, p.first_name + ' ' + p.last_name AS name, n.summary AS summary, n.created_at AS created
         ORDER BY n.created_at DESC LIMIT 6`,
      ),
      runCypher(
        `MATCH (p:Patient)-[:HAS_DIAGNOSIS]->(d:Disease)
         RETURN d.name AS disease, count(p) AS patients
         ORDER BY patients DESC LIMIT 8`,
      ),
      runCypher(`MATCH (t:Treatment) RETURN t.treatment_date AS d ORDER BY d`),
    ])
      .then(([sch, notesRes, sectRes, trendRes]) => {
        if (cancelled) return
        setSchema(sch)
        if (!notesRes.error) {
          setRecent(
            notesRes.rows.map((r) => ({
              id: String(r[0] ?? ''),
              name: String(r[1] ?? ''),
              summary: String(r[2] ?? ''),
              created: String(r[3] ?? ''),
            })),
          )
        }
        if (!sectRes.error) {
          setSectors(
            sectRes.rows.map((r) => ({ disease: String(r[0] ?? ''), patients: Number(r[1] ?? 0) })),
          )
        }
        if (!trendRes.error) {
          const byMonth = new Map<string, number>()
          for (const r of trendRes.rows) {
            const d = String(r[0] ?? '')
            if (!d) continue
            const key = d.slice(0, 7)
            byMonth.set(key, (byMonth.get(key) ?? 0) + 1)
          }
          setTrend([...byMonth.entries()].sort().map(([month, count]) => ({ month, count })))
        }
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

          <section className="dash-panel dash-panel--trend">
            <div className="dash-panel__head">
              <TrendingUp size={16} className="dash-panel__icon" />
              <h2 className="dash-panel__title">Treatment activity</h2>
            </div>
            {trend.length === 0 ? (
              <p className="dash-empty">No treatment activity yet.</p>
            ) : (
              <TrendChart data={trend} />
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

/** Hand-rolled SVG XY line chart (no external chart lib; token colors only). */
function TrendChart({ data }: { data: TrendPoint[] }) {
  // Focus on the most recent 18 months of treatment data to maintain legibility
  const chartData = data.length > 18 ? data.slice(-18) : data

  const W = 620
  const H = 260
  const padL = 36
  const padB = 30
  const padT = 16
  const padR = 16
  const lineColor = tokenColor('--color-brand')
  const gridColor = tokenColor('--color-border')
  const textColor = tokenColor('--color-text-muted')
  const valueColor = tokenColor('--color-text')

  if (chartData.length === 0) {
    return <p className="dash-empty">No treatment activity data recorded.</p>
  }

  const max = Math.max(...chartData.map((d) => d.count), 1)
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const stepX = chartData.length > 1 ? plotW / (chartData.length - 1) : 0
  const x = (i: number) => padL + i * stepX
  const y = (v: number) => padT + plotH - (v / max) * plotH

  const pts = chartData.map((d, i) => `${x(i).toFixed(1)},${y(d.count).toFixed(1)}`)
  const line = pts.join(' ')
  // 4 horizontal gridlines.
  const gridCount = 4
  const gridLines = Array.from({ length: gridCount + 1 }, (_, i) => {
    const val = (max / gridCount) * i
    const yy = y(val)
    return { yy, val: Math.round(val) }
  })

  const areaPath = `M ${x(0)} ${padT + plotH} L ${pts.join(' L ')} L ${x(chartData.length - 1)} ${padT + plotH} Z`

  const monthLabel = (k: string) => {
    const [y2, m] = k.split('-')
    const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${names[Number(m)] || m} '${y2.slice(2)}`
  }

  // Show at most 6 nicely spaced labels on the X-axis
  const labelInterval = Math.max(1, Math.ceil(chartData.length / 6))

  return (
    <div className="dash-trend">
      <svg viewBox={`0 0 ${W} ${H}`} className="dash-trend__svg" role="img" aria-label="Treatment activity trend">
        <defs>
          <linearGradient id="dashTrendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.25" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {gridLines.map((g, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={g.yy} y2={g.yy} stroke={gridColor} strokeWidth={1} />
            <text x={padL - 6} y={g.yy + 3} textAnchor="end" className="dash-trend__axis" fill={textColor}>
              {g.val}
            </text>
          </g>
        ))}

        <path d={areaPath} fill="url(#dashTrendFill)" />
        <polyline points={line} fill="none" stroke={lineColor} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />

        {chartData.map((d, i) => {
          const isKeyPoint = i % labelInterval === 0 || i === chartData.length - 1
          return (
            <g key={d.month}>
              <circle
                cx={x(i)}
                cy={y(d.count)}
                r={isKeyPoint ? 4 : 2.5}
                fill="#ffffff"
                stroke={lineColor}
                strokeWidth={isKeyPoint ? 2 : 1.5}
              >
                <title>{`${d.month}: ${d.count} treatments`}</title>
              </circle>
              {isKeyPoint && (
                <>
                  <text x={x(i)} y={y(d.count) - 9} textAnchor="middle" className="dash-trend__value" fill={valueColor}>
                    {d.count}
                  </text>
                  <text x={x(i)} y={H - 8} textAnchor="middle" className="dash-trend__axis" fill={textColor}>
                    {monthLabel(d.month)}
                  </text>
                </>
              )}
            </g>
          )
        })}
      </svg>
      <p className="dash-trend__cap">
        Showing recent {chartData.length} months of treatment volume ({chartData[0]?.month} to {chartData[chartData.length - 1]?.month}).
      </p>
    </div>
  )
}