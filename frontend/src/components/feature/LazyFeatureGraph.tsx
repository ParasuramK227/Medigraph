import * as React from 'react'
import type { FEdge, FNode } from './FeatureGraph'
import './LazyFeatureGraph.css'

const FeatureGraph = React.lazy(() =>
  import('./FeatureGraph').then((m) => ({ default: m.FeatureGraph })),
)

interface Props {
  nodes: FNode[]
  edges: FEdge[]
  height?: number | string
  centerId?: string
  edgeLabelZoom?: number
  showToolbar?: boolean
  freezeOnStabilize?: boolean
}

export function LazyFeatureGraph(props: Props) {
  return (
    <React.Suspense fallback={<div className="lazy-fg">Loading graph…</div>}>
      <FeatureGraph {...props} />
    </React.Suspense>
  )
}

export type { FEdge, FNode } from './FeatureGraph'