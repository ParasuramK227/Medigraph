import { cleanPersonName } from './formatters'
import { apiFetch } from './api'
import type { FEdge, FNode } from '../components/feature/FeatureGraph'

export interface RawGraph {
  nodes: Array<{
    element_id: string
    labels: string[]
    properties: Record<string, unknown>
  }>
  relationships: Array<{ start: string; end: string; type: string }>
}

export function graphToFNode(raw: RawGraph['nodes'][number]): FNode {
  const prop = raw.properties ?? {}
  const name = pickDisplayName(prop, raw.labels[0] ?? 'Entity')
  return {
    id: raw.element_id,
    labels: raw.labels,
    label: name,
    properties: prop,
  }
}

export function rawGraphToF(nodes: RawGraph['nodes'], rels: RawGraph['relationships']): {
  nodes: FNode[]
  edges: FEdge[]
} {
  const n = nodes.map(graphToFNode)
  const edges: FEdge[] = rels.map((r, i) => ({
    id: `e${i}-${r.start}-${r.end}`,
    source: r.start,
    target: r.end,
    label: r.type,
  }))
  return { nodes: n, edges }
}

function pickDisplayName(prop: Record<string, unknown>, label: string): string {
  const nameCandidates = [
    'name',
    'treatment_type',
    'substance',
    'first_name',
    'drug_name',
    'disease_name',
    'treatment_name',
    'title',
    'description',
    'notes',
    'note_id',
    'id',
  ]
  for (const key of nameCandidates) {
    const v = prop[key]
    if (typeof v === 'string' && v) {
      if (key === 'first_name') {
        const last = prop['last_name']
        const raw = typeof last === 'string' && last ? `${v} ${last}` : v
        return cleanPersonName(raw)
      }
      return v
    }
  }
  return `${label} ${(prop['id'] as string) ?? ''}`.trim() || 'Unnamed'
}

// Add graph-aware wrappers around raw backend JSON.
export async function fetchPatientGraphRaw(id: string): Promise<RawGraph> {
  const json = await apiFetch<{ graph: RawGraph }>(`/api/graph/patients/${id}?with_graph=1`)
  return json.graph
}

/** Run a cypher query and convert any node/relationship cells into an FNode/FEdge graph. */
export function graphFromCypher(result: { rows: unknown[][] }): { nodes: FNode[]; edges: FEdge[] } {
  const nodeMap = new Map<string, RawGraph['nodes'][number]>()
  const rels: RawGraph['relationships'] = []
  for (const row of result.rows) {
    for (const cell of row) {
      const asNode = cell as {
        _type?: string
        _labels?: string[]
        element_id?: string
        properties?: Record<string, unknown>
      }
      if (asNode?._type === 'node' || Array.isArray(asNode?._labels)) {
        const id = asNode.element_id ?? `${asNode._labels?.join(',')}:${nodeMap.size}`
        if (!nodeMap.has(id)) nodeMap.set(id, { element_id: id, labels: asNode._labels ?? [], properties: asNode.properties ?? {} })
      }
      const asRel = cell as { _type?: string; _rel_type?: string; _start?: string; _end?: string }
      if (asRel?._type === 'relationship' && asRel._start && asRel._end) {
        rels.push({ start: asRel._start, end: asRel._end, type: asRel._rel_type ?? '' })
      }
    }
  }
  return rawGraphToF([...nodeMap.values()], rels)
}