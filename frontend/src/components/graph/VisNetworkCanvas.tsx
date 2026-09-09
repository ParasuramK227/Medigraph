import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Network, type Options, type Node as VisNode, type Edge as VisEdge } from 'vis-network'
import 'vis-network/styles/vis-network.css'
import { ZoomIn, ZoomOut, Maximize2, Pause, Play, Search, X } from 'lucide-react'
import { labelColor, relColor } from '../../lib/graphColors'
import { NodePropertiesSidebar, type SelectedNodeInfo, type ConnectedEdgeInfo } from './NodePropertiesSidebar'
import './VisNetworkCanvas.css'

export interface VNode {
  id: string
  label: string
  labels: string[]
  properties: Record<string, unknown>
}

export interface VEdge {
  id: string
  source: string
  target: string
  label: string
}

interface Props {
  nodes: VNode[]
  edges: VEdge[]
  height?: number | string
  centerId?: string
  edgeLabelZoom?: number
  onNodeClick?: (nodeId: string) => void
  showToolbar?: boolean
}

export function VisNetworkCanvas({
  nodes,
  edges,
  height = 460,
  centerId,
  onNodeClick,
  showToolbar = true,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const networkRef = useRef<Network | null>(null)

  const [physicsEnabled, setPhysicsEnabled] = useState(true)
  const [selectedNode, setSelectedNode] = useState<SelectedNodeInfo | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Map for fast node lookups
  const nodeMap = useMemo(() => {
    const map = new Map<string, VNode>()
    for (const n of nodes) {
      map.set(n.id, n)
    }
    return map
  }, [nodes])

  // Compute node size based on importance/label
  const getNodeSize = (labels: string[]): number => {
    if (labels.includes('Patient')) return 22
    if (labels.includes('Disease') || labels.includes('Condition')) return 18
    if (labels.includes('Medication')) return 16
    if (labels.includes('Doctor') || labels.includes('Provider')) return 17
    if (labels.includes('Treatment') || labels.includes('Procedure')) return 15
    return 14
  }

  // Active search match
  const matchId = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return null
    for (const n of nodes) {
      if (n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) {
        return n.id
      }
    }
    return null
  }, [searchQuery, nodes])

  // Select node and prepare connected edges details for properties sidebar
  const handleSelectNode = useCallback(
    (nodeId: string | null) => {
      if (!nodeId) {
        setSelectedNode(null)
        return
      }
      const rawNode = nodeMap.get(nodeId)
      if (!rawNode) {
        setSelectedNode(null)
        return
      }

      const connectedEdges: ConnectedEdgeInfo[] = []
      for (const e of edges) {
        if (e.source === nodeId) {
          const other = nodeMap.get(e.target)
          connectedEdges.push({
            id: e.id,
            source: e.source,
            target: e.target,
            label: e.label,
            otherNodeId: e.target,
            otherNodeLabel: other ? other.label : e.target,
            isOutgoing: true,
          })
        } else if (e.target === nodeId) {
          const other = nodeMap.get(e.source)
          connectedEdges.push({
            id: e.id,
            source: e.source,
            target: e.target,
            label: e.label,
            otherNodeId: e.source,
            otherNodeLabel: other ? other.label : e.source,
            isOutgoing: false,
          })
        }
      }

      setSelectedNode({
        id: rawNode.id,
        label: rawNode.label,
        labels: rawNode.labels,
        properties: rawNode.properties,
        connectedEdges,
      })

      if (onNodeClick) {
        onNodeClick(nodeId)
      }
    },
    [nodeMap, edges, onNodeClick],
  )

  // Initialize and update the Vis.js Network instance
  useEffect(() => {
    if (!containerRef.current) return

    const visNodes: VisNode[] = nodes.map((n) => {
      const primary = n.labels[0] || 'default'
      const baseColor = labelColor(primary)
      const isDimmed = matchId !== null && matchId !== n.id
      const isHit = matchId !== null && matchId === n.id

      return {
        id: n.id,
        label: n.label,
        title: `${n.labels.join(', ')}: ${n.label}`,
        shape: 'dot',
        size: isHit ? getNodeSize(n.labels) + 6 : getNodeSize(n.labels),
        color: {
          background: isDimmed ? '#333842' : baseColor,
          border: isHit ? '#ffffff' : isDimmed ? '#242830' : '#ffffff',
          highlight: {
            background: baseColor,
            border: '#ffffff',
          },
          hover: {
            background: baseColor,
            border: '#ffffff',
          },
        },
        borderWidth: isHit ? 3 : 1.5,
        shadow: isHit
          ? { enabled: true, color: '#ffffff', size: 10, x: 0, y: 0 }
          : { enabled: true, color: 'rgba(0,0,0,0.4)', size: 4, x: 1, y: 2 },
        font: {
          color: isDimmed ? '#666e7a' : '#f0f3f6',
          size: 11,
          face: 'Inter, system-ui, sans-serif',
          background: 'rgba(10, 14, 20, 0.75)',
          strokeWidth: 0,
        },
      }
    })

    const visEdges: VisEdge[] = edges.map((e) => {
      const isDimmed = matchId !== null && (e.source !== matchId && e.target !== matchId)
      const edgeColor = relColor(e.label)

      return {
        id: e.id,
        from: e.source,
        to: e.target,
        label: e.label,
        arrows: {
          to: { enabled: true, scaleFactor: 0.55 },
        },
        color: {
          color: isDimmed ? 'rgba(70, 75, 85, 0.4)' : edgeColor || 'rgba(130, 145, 170, 0.65)',
          highlight: '#7ba1ff',
          hover: '#9bb8ff',
          opacity: isDimmed ? 0.2 : 0.8,
        },
        width: 1.5,
        smooth: {
          enabled: true,
          type: 'continuous',
          roundness: 0.2,
        },
        font: {
          color: isDimmed ? '#505660' : '#b0b8c4',
          size: 9,
          align: 'middle',
          background: 'rgba(13, 17, 23, 0.8)',
          strokeWidth: 0,
        },
      }
    })

    const options: Options = {
      nodes: {
        scaling: {
          min: 10,
          max: 30,
        },
      },
      edges: {
        selectionWidth: 2,
      },
      physics: {
        enabled: physicsEnabled,
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
          gravitationalConstant: -40,
          centralGravity: 0.008,
          springLength: 95,
          springConstant: 0.06,
          damping: 0.45,
          avoidOverlap: 0.85,
        },
        stabilization: {
          enabled: true,
          iterations: 120,
          updateInterval: 25,
        },
      },
      interaction: {
        hover: true,
        tooltipDelay: 180,
        hideEdgesOnDrag: false,
        hideEdgesOnZoom: false,
        multiselect: false,
        navigationButtons: false,
        zoomView: true,
        dragView: true,
      },
    }

    const network = new Network(containerRef.current, { nodes: visNodes, edges: visEdges }, options)
    networkRef.current = network

    // Events
    network.on('selectNode', (params) => {
      if (params.nodes && params.nodes.length > 0) {
        handleSelectNode(String(params.nodes[0]))
      }
    })

    network.on('deselectNode', () => {
      handleSelectNode(null)
    })

    network.on('click', (params) => {
      if (!params.nodes || params.nodes.length === 0) {
        handleSelectNode(null)
      }
    })

    // Center on requested node if provided
    let focusTimer: ReturnType<typeof setTimeout> | null = null
    if (centerId && nodeMap.has(centerId)) {
      focusTimer = setTimeout(() => {
        try {
          if (networkRef.current && nodeMap.has(centerId)) {
            network.focus(centerId, {
              scale: 1.15,
              animation: { duration: 600, easingFunction: 'easeInOutQuad' },
            })
          }
        } catch {
          // Ignore focus if node or network unmounted
        }
      }, 350)
    }

    return () => {
      if (focusTimer) clearTimeout(focusTimer)
      try {
        network.destroy()
      } catch {}
      networkRef.current = null
    }
  }, [nodes, edges, matchId, physicsEnabled, centerId, nodeMap, handleSelectNode])

  // Center on searched node
  useEffect(() => {
    if (matchId && networkRef.current) {
      try {
        networkRef.current.focus(matchId, {
          scale: 1.2,
          animation: { duration: 500, easingFunction: 'easeInOutQuad' },
        })
        handleSelectNode(matchId)
      } catch {
        // Ignore focus error
      }
    }
  }, [matchId, handleSelectNode])

  // Toolbar actions
  const handleZoomIn = () => {
    if (!networkRef.current) return
    const scale = networkRef.current.getScale()
    networkRef.current.moveTo({ scale: scale * 1.3, animation: { duration: 250, easingFunction: 'easeInOutQuad' } })
  }

  const handleZoomOut = () => {
    if (!networkRef.current) return
    const scale = networkRef.current.getScale()
    networkRef.current.moveTo({ scale: scale * 0.7, animation: { duration: 250, easingFunction: 'easeInOutQuad' } })
  }

  const handleFit = () => {
    if (!networkRef.current) return
    networkRef.current.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } })
  }

  const togglePhysics = () => {
    const next = !physicsEnabled
    setPhysicsEnabled(next)
    if (networkRef.current) {
      networkRef.current.setOptions({ physics: { enabled: next } })
    }
  }

  const containerHeight = typeof height === 'number' ? `${height}px` : height

  return (
    <div className="vis-graph-root" style={{ height: containerHeight }}>
      {/* Canvas container for Vis.js */}
      <div ref={containerRef} className="vis-graph-canvas" />

      {/* Floating Toolbar */}
      {showToolbar && (
        <div className="vis-graph-toolbar">
          <button
            type="button"
            className="vis-tool-btn"
            onClick={handleZoomIn}
            title="Zoom In"
            aria-label="Zoom in"
          >
            <ZoomIn size={15} />
          </button>
          <button
            type="button"
            className="vis-tool-btn"
            onClick={handleZoomOut}
            title="Zoom Out"
            aria-label="Zoom out"
          >
            <ZoomOut size={15} />
          </button>
          <button
            type="button"
            className="vis-tool-btn"
            onClick={handleFit}
            title="Fit to Screen"
            aria-label="Fit to screen"
          >
            <Maximize2 size={14} />
          </button>
          <div className="vis-tool-divider" />
          <button
            type="button"
            className={`vis-tool-btn ${physicsEnabled ? 'vis-tool-btn--active' : ''}`}
            onClick={togglePhysics}
            title={physicsEnabled ? 'Pause Force Simulation' : 'Run Force Simulation'}
            aria-label="Toggle Physics"
          >
            {physicsEnabled ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            type="button"
            className={`vis-tool-btn ${searchOpen ? 'vis-tool-btn--active' : ''}`}
            onClick={() => {
              setSearchOpen(!searchOpen)
              if (searchOpen) setSearchQuery('')
            }}
            title="Search Nodes"
            aria-label="Search"
          >
            <Search size={14} />
          </button>
        </div>
      )}

      {/* Search Bar Overlay */}
      {searchOpen && (
        <div className="vis-search-box">
          <Search size={14} className="vis-search-icon" />
          <input
            type="text"
            className="vis-search-input"
            placeholder="Search node by name or ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
          />
          {searchQuery && (
            <button
              type="button"
              className="vis-search-clear"
              onClick={() => setSearchQuery('')}
            >
              <X size={13} />
            </button>
          )}
          {matchId && <span className="vis-search-match">Found</span>}
          {searchQuery && !matchId && <span className="vis-search-nomatch">No match</span>}
        </div>
      )}

      {/* Node & Edge counts badge */}
      <div className="vis-graph-meta">
        <span>{nodes.length} nodes</span>
        <span>•</span>
        <span>{edges.length} relationships</span>
      </div>

      {/* Properties Sidebar on Node Click */}
      <NodePropertiesSidebar
        node={selectedNode}
        onClose={() => handleSelectNode(null)}
        onSelectNodeById={(id) => {
          if (networkRef.current) {
            networkRef.current.selectNodes([id])
            networkRef.current.focus(id, {
              scale: 1.1,
              animation: { duration: 400, easingFunction: 'easeInOutQuad' },
            })
          }
          handleSelectNode(id)
        }}
      />
    </div>
  )
}
