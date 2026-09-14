import { useEffect, useMemo, useState } from 'react'
import {
  Play,
  Loader2,
  Share2,
  ChevronDown,
  ChevronRight,
  Network,
  LayoutGrid,
  Search,
  X,
  Download,
  Sparkles,
} from 'lucide-react'
import { runCypher, exploreGraph, fetchSchema, type GraphSchema } from '../lib/api'
import { graphFromCypher } from '../lib/graphData'
import { labelColor, chipTextContrast } from '../lib/graphColors'
import { LazyFeatureGraph, type FNode, type FEdge } from '../components/feature/LazyFeatureGraph'
import { useAuth } from '../hooks/useAuth'
import './GraphExplorerPage.css'

const PRESETS = [
  { key: 'all_connected', label: 'All Connected (Overview)', query: 'MATCH (a)-[r]->(b) RETURN a, r, b LIMIT 150' },
  { key: 'patients_diagnoses', label: 'Patients + Active Diagnoses', query: 'MATCH (p:Patient)-[r:HAS_DIAGNOSIS]->(d:Disease) RETURN p, r, d LIMIT 120' },
  { key: 'meds_diseases', label: 'Medications → Diseases Treated', query: 'MATCH (m:Medication)-[r:TREATS]->(d:Disease) RETURN m, r, d LIMIT 120' },
  { key: 'scribe_notes', label: 'AI Scribe Notes & Diagnoses', query: 'MATCH (p:Patient)-[r:HAS_CONSULTATION_NOTE]->(n:ConsultationNote) OPTIONAL MATCH (n)-[m:MENTIONS_DIAGNOSIS]->(d:Disease) RETURN p, r, n, m, d LIMIT 50' },
  { key: 'abnormal_labs', label: 'Abnormal Lab Biomarkers', query: 'MATCH (p:Patient)-[r:HAS_LAB_TEST]->(l:LabTest) WHERE toLower(l.status) = "abnormal" RETURN p, r, l LIMIT 80' },
  { key: 'treatments_outcomes', label: 'Clinical Treatments & Outcomes', query: 'MATCH (p:Patient)-[r:RECEIVED_TREATMENT]->(t:Treatment) RETURN p, r, t LIMIT 100' },
  { key: 'doctors_consultations', label: 'Doctors → Consultations', query: 'MATCH (doc:Doctor)-[r1:CONDUCTED]->(n:ConsultationNote), (p:Patient)-[r2:HAS_CONSULTATION_NOTE]->(n) RETURN doc, r1, n, r2, p LIMIT 50' },
]

// Properties we consider "identifying" (shown first / emphasised); everything
// else is treated as a secondary metadata property.
const PRIMARY_KEYS = new Set([
  'name', 'first_name', 'last_name', 'id', 'title', 'summary', 'treatment_type',
  'specialization', 'disease', 'drug_name', 'my_notes',
])

const HIDDEN_KEYS = new Set(['element_id'])

function displayName(node: FNode): string {
  const p = node.properties ?? {}
  for (const k of PRIMARY_KEYS) {
    const v = p[k]
    if (typeof v === 'string' && v) return v
  }
  return node.label || `${node.labels?.[0] ?? 'Node'} ${node.id}`
}

function primaryLabel(node: FNode): string {
  return node.labels?.[0] ?? 'Node'
}

export function GraphExplorerPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [query, setQuery] = useState('MATCH (a)-[r]->(b) RETURN a, r, b LIMIT 150')
  const [nodes, setNodes] = useState<FNode[]>([])
  const [edges, setEdges] = useState<FEdge[]>([])
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [viewMode, setViewMode] = useState<'graph' | 'table'>('graph')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ran, setRan] = useState(false)
  const [schema, setSchema] = useState<GraphSchema | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchSchema()
      .then((s) => {
        if (!cancelled) setSchema(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const run = async (q: string, preset?: string) => {
    setLoading(true)
    setError(null)
    try {
      // Researchers never execute raw Cypher — they run the curated, read-only
      // presets via /api/graph/explore. Admin retains the free-form console.
      const res = isAdmin ? await runCypher(q) : await exploreGraph(preset ?? 'all_connected')
      if (res.error) {
        setError(res.error)
        setNodes([])
        setEdges([])
      } else {
        const g = graphFromCypher(res)
        setNodes(g.nodes)
        setEdges(g.edges)
        setExpanded(new Set())
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run query')
      setNodes([])
      setEdges([])
    } finally {
      setLoading(false)
      setRan(true)
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const promise = isAdmin
      ? runCypher('MATCH (a)-[r]->(b) RETURN a, r, b LIMIT 150')
      : exploreGraph('all_connected')
    promise
      .then((res) => {
        if (cancelled) return
        if (res.error) return
        const g = graphFromCypher(res)
        setNodes(g.nodes)
        setEdges(g.edges)
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
          setRan(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [isAdmin])

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of nodes) {
      const label = primaryLabel(n)
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [nodes])

  const filtered = useMemo(() => {
    let list = nodes
    if (typeFilter) {
      list = list.filter((n) => primaryLabel(n) === typeFilter)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      list = list.filter((n) => {
        const name = displayName(n).toLowerCase()
        const id = n.id.toLowerCase()
        const p = JSON.stringify(n.properties || {}).toLowerCase()
        return name.includes(q) || id.includes(q) || p.includes(q)
      })
    }
    return list
  }, [nodes, typeFilter, searchQuery])

  const filteredNodeIds = useMemo(() => new Set(filtered.map((n) => n.id)), [filtered])
  const filteredEdges = useMemo(
    () => edges.filter((e) => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target)),
    [edges, filteredNodeIds],
  )

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const nodeRelationships = (id: string) =>
    edges.filter((e) => e.source === id || e.target === id)

  const exportJson = () => {
    const data = JSON.stringify({ nodes: filtered, edges: filteredEdges }, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `medigraph_export_${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportCsv = () => {
    if (!filtered.length) return
    const headers = ['id', 'name', 'type', 'properties']
    const rows = filtered.map((n) => [
      n.id,
      `"${displayName(n).replace(/"/g, '""')}"`,
      `"${primaryLabel(n).replace(/"/g, '""')}"`,
      `"${JSON.stringify(n.properties || {}).replace(/"/g, '""')}"`,
    ])
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `medigraph_nodes_${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="page graph-explorer-page">
      <div className="graph-explorer__head">
        <div className="graph-explorer__icon">
          <Share2 size={18} />
        </div>
        <div>
          <h1 className="page__heading">Knowledge Graph Explorer</h1>
          <p className="graph-explorer__sub">
            Explore and visualize the clinical knowledge graph with real-time Cypher execution,
            interactive 2D force-directed network graph, and structured inspection.
          </p>
          {schema && schema.relationship_count > 0 && (
            <div className="graph-explorer__rel-banner">
              <span className="graph-explorer__rel-banner-label">Active Graph:</span>
              <strong>{schema.node_count.toLocaleString()}</strong> nodes •{' '}
              <strong>{schema.relationship_count.toLocaleString()}</strong> relationships
              <span className="graph-explorer__rel-banner-chips">
                {schema.relationships.slice(0, 7).map((r) => (
                  <span key={r.type} className="graph-explorer__rel-banner-chip">
                    {r.type} ({r.count.toLocaleString()})
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="graph-explorer__query card">
        <div className="graph-explorer__input">
          <textarea
            className="graph-explorer__text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={2}
            placeholder="MATCH (a)-[r]->(b) RETURN a, r, b LIMIT 150"
            readOnly={!isAdmin}
            title={isAdmin ? 'Run Cypher query (Ctrl/Cmd+Enter)' : 'Researchers run curated presets below — raw Cypher is admin-only'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && isAdmin) {
                e.preventDefault()
                void run(query)
              }
            }}
          />
          {isAdmin && (
            <button
              type="button"
              className="graph-explorer__run"
              title="Run Cypher query (Ctrl/Cmd+Enter)"
              onClick={() => void run(query)}
            >
              <Play size={16} />
            </button>
          )}
        </div>
        {!isAdmin && (
          <p className="graph-explorer__presets-note">
            Curated read-only graphs only — free-form Cypher is restricted to administrators.
          </p>
        )}
        <div className="graph-explorer__presets">
          <span className="graph-explorer__presets-title">
            <Sparkles size={13} /> Presets:
          </span>
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className="graph-explorer__preset"
              onClick={() => {
                setQuery(p.query)
                void run(p.query, p.key)
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="graph-explorer__card card">
        {loading && (
          <div className="graph-explorer__state">
            <Loader2 className="graph-explorer__spin" size={20} />
            Running graph query and streaming topology…
          </div>
        )}
        {!loading && error && (
          <div className="graph-explorer__state graph-explorer__state--error">{error}</div>
        )}
        {!loading && !error && ran && nodes.length === 0 && (
          <div className="graph-explorer__state">No nodes found in this query result.</div>
        )}
        {!loading && !error && nodes.length > 0 && (
          <>
            {/* Top Toolbar: View mode, Search, Export */}
            <div className="graph-explorer__toolbar">
              <div className="graph-explorer__view-switch">
                <button
                  type="button"
                  className={`graph-explorer__switch-btn ${viewMode === 'graph' ? 'is-active' : ''}`}
                  onClick={() => setViewMode('graph')}
                >
                  <Network size={15} /> Graph View
                </button>
                <button
                  type="button"
                  className={`graph-explorer__switch-btn ${viewMode === 'table' ? 'is-active' : ''}`}
                  onClick={() => setViewMode('table')}
                >
                  <LayoutGrid size={15} /> Table View
                </button>
              </div>

              <div className="graph-explorer__search-wrap">
                <Search size={14} className="graph-explorer__search-icon" />
                <input
                  type="text"
                  className="graph-explorer__search-field"
                  placeholder="Filter nodes in result..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button
                    className="graph-explorer__search-clear"
                    onClick={() => setSearchQuery('')}
                    title="Clear filter"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>

              <div className="graph-explorer__actions">
                <button
                  type="button"
                  className="graph-explorer__export-btn"
                  onClick={exportJson}
                  title="Export graph as JSON"
                >
                  <Download size={13} /> JSON
                </button>
                <button
                  type="button"
                  className="graph-explorer__export-btn"
                  onClick={exportCsv}
                  title="Export nodes as CSV"
                >
                  <Download size={13} /> CSV
                </button>
              </div>
            </div>

            {/* Type filters */}
            <div className="graph-explorer__filters">
              <button
                type="button"
                className={`graph-explorer__filter ${typeFilter === '' ? 'is-active' : ''}`}
                onClick={() => setTypeFilter('')}
              >
                All <span className="graph-explorer__count">{nodes.length}</span>
              </button>
              {typeCounts.map(([label, count]) => (
                <button
                  key={label}
                  type="button"
                  className={`graph-explorer__filter ${typeFilter === label ? 'is-active' : ''}`}
                  onClick={() => setTypeFilter(typeFilter === label ? '' : label)}
                >
                  <span
                    className="graph-explorer__dot"
                    style={{ background: labelColor(label) }}
                  />
                  {label} <span className="graph-explorer__count">{count}</span>
                </button>
              ))}
            </div>

            {/* Content: Graph View or Table View */}
            {viewMode === 'graph' ? (
              <div className="graph-explorer__canvas-wrap">
                <LazyFeatureGraph
                  nodes={filtered}
                  edges={filteredEdges}
                  height={560}
                />
              </div>
            ) : (

            <div className="graph-explorer__table">
              <div className="graph-explorer__row graph-explorer__row--head">
                <div className="graph-explorer__col-chev" />
                <div className="graph-explorer__col-type">Type</div>
                <div className="graph-explorer__col-name">Name</div>
                <div className="graph-explorer__col-info">Details</div>
              </div>
              {filtered.map((n) => {
                const p = n.properties ?? {}
                const isOpen = expanded.has(n.id)
                const rels = nodeRelationships(n.id)
                const infoKeys = Object.keys(p).filter((k) => !PRIMARY_KEYS.has(k) && !HIDDEN_KEYS.has(k))
                const color = labelColor(primaryLabel(n))
                const textColor = chipTextContrast(color)
                return (
                  <div className="graph-explorer__node" key={n.id}>
                    <button
                      type="button"
                      className="graph-explorer__row graph-explorer__row--body"
                      onClick={() => toggleExpanded(n.id)}
                    >
                      <div className="graph-explorer__col-chev">
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </div>
                      <div className="graph-explorer__col-type">
                        <span
                          className="graph-explorer__badge"
                          style={{ background: color, color: textColor }}
                        >
                          {primaryLabel(n)}
                        </span>
                      </div>
                      <div className="graph-explorer__col-name">{displayName(n)}</div>
                      <div className="graph-explorer__col-info">
                        <span className="graph-explorer__rel-count">
                          {rels.length} relationship{rels.length === 1 ? '' : 's'}
                        </span>
                        {infoKeys.slice(0, 3).map((k) => (
                          <span className="graph-explorer__prop" key={k}>
                            {k}: {String(p[k] ?? '')}
                          </span>
                        ))}
                      </div>
                    </button>

                    {isOpen && (
                      <div className="graph-explorer__expanded">
                        <div className="graph-explorer__relationships">
                          {rels.length === 0 && <p className="graph-explorer__muted">No relationships in this result.</p>}
                          {rels.map((e, i) => {
                            const isSource = e.source === n.id
                            const otherId = isSource ? e.target : e.source
                            const other = nodes.find((x) => x.id === otherId)
                            return (
                              <div className="graph-explorer__rel" key={`${e.id}-${i}`}>
                                <span className="graph-explorer__rel-arrow">
                                  {isSource ? '→' : '←'}
                                </span>
                                <span className="graph-explorer__rel-type">{e.label || 'REL'}</span>
                                <span className="graph-explorer__rel-other">
                                  {other ? `${primaryLabel(other)} · ${displayName(other)}` : otherId}
                                </span>
                              </div>
                            )
                          })}
                        </div>

                        {infoKeys.length > 0 && (
                          <div className="graph-explorer__props">
                            <div className="graph-explorer__props-title">Properties</div>
                            <div className="graph-explorer__props-grid">
                              {infoKeys.map((k) => (
                                <div className="graph-explorer__prop-cell" key={k}>
                                  <span className="graph-explorer__prop-key">{k}</span>
                                  <span className="graph-explorer__prop-val">{String(p[k] ?? '')}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          </>
        )}
      </div>
    </div>
  )
}

