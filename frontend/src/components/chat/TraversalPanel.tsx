import { useMemo, useState } from 'react'
import { Network, Loader2, FileSearch, ArrowRight, ListTree, Code } from 'lucide-react'
import { buildTraversalHops } from '../../lib/traversalHops'
import { graphFromCypher } from '../../lib/graphData'
import { LazyFeatureGraph } from '../feature/LazyFeatureGraph'
import { labelColor, chipTextContrast } from '../../lib/graphColors'
import type { ChatTraversal } from '../../lib/api'
import './TraversalPanel.css'

export interface TraversalInstance {
  id: number
  query: string
  traversal: ChatTraversal | null
  patientName?: string | null
}

type TraversalView = 'path' | 'graph' | 'query'

interface Props {
  instances: TraversalInstance[]
  activeIndex: number
  onSelect: (index: number) => void
  loading?: boolean
}

function HopChip({ label }: { label: string }) {
  const bg = labelColor(label)
  return (
    <span
      className="traversal-hop__chip"
      style={{ backgroundColor: bg, color: chipTextContrast(bg) }}
    >
      {label}
    </span>
  )
}

export function TraversalPanel({ instances, activeIndex, onSelect, loading }: Props) {
  const [view, setView] = useState<TraversalView>('path')
  const active = instances[activeIndex]

  const hops = useMemo(() => {
    if (!active?.traversal || !active.traversal.rows || active.traversal.rows.length === 0) {
      return []
    }
    return buildTraversalHops(active.traversal)
  }, [active])

  const graph = useMemo(() => {
    if (!active?.traversal || !active.traversal.rows || active.traversal.rows.length === 0) {
      return null
    }
    return graphFromCypher(active.traversal)
  }, [active])

  const centerId = useMemo(() => {
    if (!graph || graph.nodes.length === 0) return undefined
    const preferred = ['Patient', 'Disease']
    const node =
      graph.nodes.find((n) => preferred.some((l) => n.labels.includes(l))) ?? graph.nodes[0]
    return node?.id
  }, [graph])

  const nodeTypes = useMemo(() => {
    const set = new Set<string>()
    for (const hop of hops) {
      set.add(hop.start)
      set.add(hop.end)
    }
    return set.size
  }, [hops])

  const hasData = hops.length > 0 || (graph !== null && graph.nodes.length > 0)

  return (
    <aside className="traversal-panel">
      <div className="traversal-panel__head">
        <div className="traversal-panel__title">
          <Network size={14} aria-hidden />
          <span>Knowledge Graph Traversal</span>
        </div>
        <div className="traversal-panel__head-right">
          {instances.length > 0 && (
            <div className="traversal-panel__view-toggle">
              <button
                type="button"
                className={`traversal-panel__view-btn ${view === 'path' ? 'traversal-panel__view-btn--active' : ''}`}
                onClick={() => setView('path')}
                title="Show traversal hops"
                aria-label="Show traversal hops"
              >
                <ListTree size={12} aria-hidden />
                Path
              </button>
              <button
                type="button"
                className={`traversal-panel__view-btn ${view === 'graph' ? 'traversal-panel__view-btn--active' : ''}`}
                onClick={() => setView('graph')}
                title="Show knowledge graph"
                aria-label="Show knowledge graph"
              >
                <Network size={12} aria-hidden />
                Graph
              </button>
              <button
                type="button"
                className={`traversal-panel__view-btn ${view === 'query' ? 'traversal-panel__view-btn--active' : ''}`}
                onClick={() => setView('query')}
                title="Show Cypher query used for traversal"
                aria-label="Show Cypher query"
              >
                <Code size={12} aria-hidden />
                Query
              </button>
            </div>
          )}
          {hops.length > 0 && (
            <span className="traversal-panel__counts">
              {hops.length} hops · {nodeTypes} node types
            </span>
          )}
        </div>
      </div>

      {instances.length > 0 ? (
        <div className="traversal-panel__history">
          {instances.map((inst, idx) => (
            <button
              key={inst.id}
              type="button"
              className={`traversal-panel__query ${idx === activeIndex ? 'traversal-panel__query--active' : ''}`}
              onClick={() => onSelect(idx)}
              title={inst.query}
            >
              <span className="traversal-panel__query-text">{inst.query}</span>
              <span className="traversal-panel__query-meta">
                {inst.traversal && inst.traversal.rows.length > 0
                  ? `${inst.traversal.rows.length} rows`
                  : 'no path'}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="traversal-panel__empty">
          <FileSearch size={26} aria-hidden />
          <span>Ask a question to see the traversal path used to answer it.</span>
        </div>
      )}

      <div className="traversal-panel__paths">
        {loading ? (
          <div className="traversal-panel__loading">
            <Loader2 className="traversal-panel__spin" size={18} aria-hidden />
            Tracing knowledge graph…
          </div>
        ) : active?.traversal?.cypher && view === 'query' ? (
            <div className="traversal-panel__query-view">
              <div className="traversal-panel__query-badge">
                <Code size={11} aria-hidden />
                <span>{active.traversal.cypher_source === 'static' ? 'Static fallback' : 'Generated by LLM'}</span>
              </div>
              <pre className="traversal-panel__cypher">{active.traversal.cypher}</pre>
            </div>
        ) : active && hasData ? (
          view === 'graph' && graph && graph.nodes.length > 0 ? (
            <div className="traversal-panel__graph-view">
              <div className="traversal-panel__paths-context">
                {active.patientName
                  ? `Context: ${active.patientName}`
                  : 'Context: Patient cohort (population)'}
              </div>
              <LazyFeatureGraph
                nodes={graph.nodes}
                edges={graph.edges}
                height="100%"
                centerId={centerId}
                freezeOnStabilize
              />
            </div>
          ) : (
            <>
              <div className="traversal-panel__paths-context">
                {active.patientName
                  ? `Context: ${active.patientName}`
                  : 'Context: Patient cohort (population)'}
              </div>
              <ul className="traversal-panel__hop-list">
                {hops.map((hop) => (
                  <li key={`${hop.start}|${hop.rel}|${hop.end}`} className="traversal-hop">
                    <HopChip label={hop.start} />
                    <span className="traversal-hop__arrow">
                      <span className="traversal-hop__rel">{hop.rel}</span>
                      {hop.count > 1 && <span className="traversal-hop__count">×{hop.count}</span>}
                      <ArrowRight size={13} aria-hidden />
                    </span>
                    <HopChip label={hop.end} />
                  </li>
                ))}
              </ul>
            </>
          )
        ) : (
          active && (
            <div className="traversal-panel__nopath">
              No graph traversal data was returned for this query.
            </div>
          )
        )}
      </div>
    </aside>
  )
}