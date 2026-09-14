import { VisNetworkCanvas, type VNode, type VEdge } from '../graph/VisNetworkCanvas'

export type FNode = VNode
export type FEdge = VEdge

interface Props {
  nodes: FNode[]
  edges: FEdge[]
  height?: number | string
  centerId?: string
  edgeLabelZoom?: number
  showToolbar?: boolean
  freezeOnStabilize?: boolean
}

export function FeatureGraph({
  nodes,
  edges,
  height = 580,
  centerId,
  edgeLabelZoom = 1.0,
  showToolbar = true,
  freezeOnStabilize = false,
}: Props) {
  return (
    <VisNetworkCanvas
      nodes={nodes}
      edges={edges}
      height={height}
      centerId={centerId}
      edgeLabelZoom={edgeLabelZoom}
      showToolbar={showToolbar}
      freezeOnStabilize={freezeOnStabilize}
    />
  )
}