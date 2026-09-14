import type { ChatTraversal } from './api'

export interface TraversalHop {
  start: string
  rel: string
  end: string
  count: number
}

// Canonical label chosen when a node carries multiple Neo4j labels. Neo4j
// returns `labels` as an unordered set, so this guarantees stable rendering
// (e.g. ['Disease','Condition'] always renders as Disease).
const LABEL_PRIORITY = [
  'Patient',
  'Doctor',
  'Disease',
  'Medication',
  'Treatment',
  'Procedure',
  'LabTest',
  'Allergy',
  'ConsultationNote',
  'Encounter',
  'Symptom',
  'Condition',
  'Provider',
  'Observation',
]

export function pickPrimaryLabel(labels: string[] | undefined): string {
  if (!labels || labels.length === 0) return 'Node'
  for (const preferred of LABEL_PRIORITY) {
    if (labels.includes(preferred)) return preferred
  }
  return labels[0]
}

interface RawNodeCell {
  _type?: string
  _labels?: string[]
  element_id?: string
  properties?: Record<string, unknown>
}

interface RawRelCell {
  _type?: string
  _rel_type?: string
  _start?: string
  _end?: string
}

/** Deduplicate the raw Cypher rows into unique traversal hops with counts. */
export function buildTraversalHops(traversal: ChatTraversal): TraversalHop[] {
  const nodes = new Map<string, RawNodeCell>()
  const rels: RawRelCell[] = []

  for (const row of traversal.rows ?? []) {
    for (const cell of row) {
      if (cell === null || typeof cell !== 'object') continue
      const asNode = cell as RawNodeCell
      if (asNode._type === 'node' && asNode.element_id) {
        nodes.set(asNode.element_id, asNode)
      }
      const asRel = cell as RawRelCell
      if (asRel._type === 'relationship' && asRel._start && asRel._end) {
        rels.push(asRel)
      }
    }
  }

  const hopMap = new Map<string, TraversalHop>()
  for (const rel of rels) {
    const start = nodes.get(rel._start as string)
    const end = nodes.get(rel._end as string)
    if (!start || !end || !rel._rel_type) continue
    const startLabel = pickPrimaryLabel(start._labels)
    const endLabel = pickPrimaryLabel(end._labels)
    const key = `${startLabel}|${rel._rel_type}|${endLabel}`
    const existing = hopMap.get(key)
    if (existing) {
      existing.count += 1
    } else {
      hopMap.set(key, { start: startLabel, rel: rel._rel_type, end: endLabel, count: 1 })
    }
  }

  const hops = [...hopMap.values()]
  const rank = (label: string): number => {
    const idx = LABEL_PRIORITY.indexOf(label)
    return idx === -1 ? LABEL_PRIORITY.length : idx
  }
  hops.sort((a, b) => {
    const aStart = rank(a.start)
    const bStart = rank(b.start)
    if (aStart !== bStart) return aStart - bStart
    return b.count - a.count
  })
  return hops
}