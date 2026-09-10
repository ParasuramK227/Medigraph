import time

from flask import Blueprint, request, jsonify

from backend.analysis import graph_fetch, treatment_intel
from backend.auth_utils import require_auth, require_role
from backend.neo4j_connection import get_session as neo4j_get_session

graph_bp = Blueprint("graph", __name__)

_NODE_TO_KEYS = {
    "Patient": [
        "id", "first_name", "last_name", "gender", "date_of_birth",
        "contact_number", "address", "city", "state", "zip", "income",
        "email", "insurance_provider",
    ],
    "Disease": ["name", "code"],
    "Condition": ["name", "code"],
    "Symptom": ["name"],
    "Treatment": ["id", "treatment_type", "description", "cost", "treatment_date", "outcome", "success"],
    "Procedure": ["id", "treatment_type", "description", "cost", "treatment_date", "outcome", "success"],
    "Medication": [
        "name", "code", "cost", "category", "dosage_form", "strength", "manufacturer",
        "indication", "classification",
    ],
    "Doctor": [
        "id", "name", "first_name", "last_name", "specialization", "years_experience",
        "hospital_branch", "email",
    ],
    "Provider": [
        "id", "name", "first_name", "last_name", "specialization", "years_experience",
        "hospital_branch", "email",
    ],
    "LabTest": ["id", "name", "result", "unit", "reference_range", "status", "date", "category"],
    "Observation": ["id", "name", "result", "unit", "reference_range", "status", "date", "category"],
    "Encounter": ["id", "start", "stop", "encounter_class", "description", "cost", "reason"],
    "Allergy": ["id", "substance", "type", "severity", "start"],
    "ConsultationNote": ["id", "title", "summary"],
}


def _clean_prop_val(v):
    if hasattr(v, "iso_format"):
        return v.iso_format()
    if hasattr(v, "isoformat"):
        return v.isoformat()
    if isinstance(v, (list, tuple)):
        return [_clean_prop_val(x) for x in v]
    if isinstance(v, dict):
        return {k: _clean_prop_val(x) for k, x in v.items()}
    return v


def _serialize(graph):
    """Serialize a driver Node/Relationship into a frontend-friendly dict."""
    if graph is None:
        return None

    items = {k: _clean_prop_val(v) for k, v in dict(graph.items()).items()}
    labels = list(graph.labels) if hasattr(graph, "labels") else None
    type_ = graph.type if hasattr(graph, "type") else None

    node = {
        "properties": items,
        "labels": labels,
        "element_id": graph.element_id,
    }
    return node


def _execute_read_query(session, query, params=None):
    """Run a read-only Cypher query and serialize the raw rows (same shape as
    the /cypher passthrough so the frontend graph tooling can consume it)."""
    result = session.run(query, **(params or {}))
    keys = None
    rows = []
    for rec in result:
        row = []
        for i, key in enumerate(rec.keys()):
            if keys is None:
                keys = list(rec.keys())
            row.append(_serialize_value(rec[i]))
        rows.append(row)
    return (keys or []), rows


def fetch_cypher_schema(session) -> str:
    """Return a compact plain-text schema description for LLM prompt injection."""
    node_result = session.run(
        "MATCH (n) WITH labels(n) AS l UNWIND l AS label "
        "WITH label, count(*) AS cnt RETURN label, cnt ORDER BY cnt DESC"
    )
    label_counts = [(rec["label"], rec["cnt"]) for rec in node_result]

    # Collect key properties per label
    label_props: dict[str, list[str]] = {}
    for label, _ in label_counts:
        # Labels come from db.labels() — safe for f-string interpolation
        safe_label = label.replace("`", "")
        props_result = session.run(
            f"MATCH (n:`{safe_label}`) RETURN DISTINCT keys(n) AS keys LIMIT 1",
        )
        rec = props_result.single()
        if rec:
            label_props[label] = rec["keys"]

    rel_result = session.run(
        "MATCH (a)-[r]->(b) RETURN type(r) AS type, "
        "head(labels(a)) AS from_label, head(labels(b)) AS to_label, "
        "count(r) AS cnt ORDER BY cnt DESC"
    )
    rels = [(rec["type"], rec["from_label"], rec["to_label"], rec["cnt"]) for rec in rel_result]

    lines = ["Node labels:"]
    for label, cnt in label_counts:
        props = label_props.get(label, [])
        props_str = ", ".join(props[:8])
        lines.append(f"  {label} ({props_str}) — {cnt} nodes")

    lines.append("\nRelationships:")
    for rel_type, from_l, to_l, cnt in rels:
        lines.append(f"  ({from_l})-[:{rel_type}]->({to_l}) — {cnt} edges")

    return "\n".join(lines)


# Presets exposed to admin + researcher via /explore. Always read-only and
# server-authored — arbitrary Cypher remains admin-only (/cypher).
_GRAPH_PRESETS = {
    "all_connected": "MATCH (a)-[r]->(b) RETURN a, r, b LIMIT 150",
    "patients_diagnoses": "MATCH (p:Patient)-[r:HAS_DIAGNOSIS]->(d:Disease) RETURN p, r, d LIMIT 120",
    "meds_diseases": "MATCH (m:Medication)-[r:TREATS]->(d:Disease) RETURN m, r, d LIMIT 120",
    "scribe_notes": (
        "MATCH (p:Patient)-[r:HAS_CONSULTATION_NOTE]->(n:ConsultationNote) "
        "OPTIONAL MATCH (n)-[m:MENTIONS_DIAGNOSIS]->(d:Disease) RETURN p, r, n, m, d LIMIT 50"
    ),
    "abnormal_labs": (
        'MATCH (p:Patient)-[r:HAS_LAB_TEST]->(l:LabTest) WHERE toLower(l.status) = "abnormal" '
        "RETURN p, r, l LIMIT 80"
    ),
    "treatments_outcomes": "MATCH (p:Patient)-[r:RECEIVED_TREATMENT]->(t:Treatment) RETURN p, r, t LIMIT 100",
    "doctors_consultations": (
        "MATCH (doc:Doctor)-[r1:CONDUCTED]->(n:ConsultationNote), "
        "(p:Patient)-[r2:HAS_CONSULTATION_NOTE]->(n) RETURN doc, r1, n, r2, p LIMIT 50"
    ),
}


@graph_bp.route("/patients", methods=["GET"])
@require_auth
def list_patients():
    """List all patients."""
    try:
        with neo4j_get_session() as s:
            result = s.run(
                """
                MATCH (p:Patient)
                RETURN p ORDER BY p.first_name, p.last_name
                """
            )
            patients = [_serialize(rec["p"]) for rec in result if rec["p"] is not None]
        return jsonify(patients), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@graph_bp.route("/patients/<patient_id>", methods=["GET"])
@require_auth
def get_patient(patient_id):
    """Get a single patient by ID, with optionally scoped graph neighbors."""
    include_graph = request.args.get("with_graph") == "1"
    try:
        with neo4j_get_session() as s:
            result = s.run(
                """
                MATCH (p:Patient {id: $id})
                RETURN p
                """,
                id=patient_id,
            )
            rec = result.single()
            if rec is None or rec["p"] is None:
                return jsonify({"error": f"patient {patient_id} not found"}), 404
            patient = _serialize(rec["p"])

            graph_data = {"nodes": [], "relationships": []}
            if include_graph:
                result2 = s.run(
                    """
                    MATCH (p:Patient {id: $id})
                    OPTIONAL MATCH (p)-[r_diag:HAS_DIAGNOSIS]->(d:Disease)
                    OPTIONAL MATCH (m:Medication)-[r_med_treats:TREATS]->(d)
                    OPTIONAL MATCH (p)-[r_treat:RECEIVED_TREATMENT]->(t:Treatment)
                    OPTIONAL MATCH (t)-[r_proc_treats:TREATS]->(d)
                    OPTIONAL MATCH (p)-[r_lab:HAS_LAB_TEST]->(l:LabTest)
                    OPTIONAL MATCH (p)-[r_alg:HAS_ALLERGY]->(a:Allergy)
                    OPTIONAL MATCH (doc:Doctor)-[r_doc:TREATS]->(p)
                    OPTIONAL MATCH (p)-[r_note:HAS_CONSULTATION_NOTE]->(n:ConsultationNote)
                    OPTIONAL MATCH (n)-[r_note_diag:MENTIONS_DIAGNOSIS|HAS_DIAGNOSIS]->(d_note:Disease)
                    OPTIONAL MATCH (n)-[r_note_med:DISCUSSES_MEDICATION]->(m_note:Medication)
                    OPTIONAL MATCH (doc_cond:Doctor)-[r_doc_cond:CONDUCTED]->(n)
                    RETURN p,
                           collect(DISTINCT d) AS diseases,
                           collect(DISTINCT r_diag) AS r_diag,
                           collect(DISTINCT m)[0..6] AS meds,
                           collect(DISTINCT r_med_treats) AS r_med_treats,
                           collect(DISTINCT t)[0..6] AS treatments,
                           collect(DISTINCT r_treat)[0..6] AS r_treat,
                           collect(DISTINCT r_proc_treats) AS r_proc_treats,
                           collect(DISTINCT l)[0..6] AS labs,
                           collect(DISTINCT r_lab)[0..6] AS r_labs,
                           collect(DISTINCT a) AS allergies,
                           collect(DISTINCT r_alg) AS r_alg,
                           collect(DISTINCT doc)[0..2] AS doctors,
                           collect(DISTINCT r_doc)[0..2] AS r_doc,
                           collect(DISTINCT n)[0..5] AS notes,
                           collect(DISTINCT r_note)[0..5] AS r_notes,
                           collect(DISTINCT d_note) AS note_diseases,
                           collect(DISTINCT r_note_diag) AS r_note_diags,
                           collect(DISTINCT m_note) AS note_meds,
                           collect(DISTINCT r_note_med) AS r_note_meds,
                           collect(DISTINCT r_doc_cond) AS r_doc_cond
                    """,
                    id=patient_id,
                )
                rec2 = result2.single()
                node_map = {patient["element_id"]: patient}
                edges = []
                if rec2:
                    node_lists = [
                        rec2["diseases"] or [],
                        rec2["meds"] or [],
                        rec2["treatments"] or [],
                        rec2["labs"] or [],
                        rec2["allergies"] or [],
                        rec2["doctors"] or [],
                        rec2["notes"] or [],
                        rec2["note_diseases"] or [],
                        rec2["note_meds"] or [],
                    ]
                    for group in node_lists:
                        for n in group:
                            if n is not None and n.element_id not in node_map:
                                node_map[n.element_id] = _serialize(n)

                    rel_lists = [
                        rec2["r_diag"] or [],
                        rec2["r_med_treats"] or [],
                        rec2["r_treat"] or [],
                        rec2["r_proc_treats"] or [],
                        rec2["r_labs"] or [],
                        rec2["r_alg"] or [],
                        rec2["r_doc"] or [],
                        rec2["r_notes"] or [],
                        rec2["r_note_diags"] or [],
                        rec2["r_note_meds"] or [],
                        rec2["r_doc_cond"] or [],
                    ]
                    for r_group in rel_lists:
                        for r in r_group:
                            if r is not None:
                                s_id = r.start_node.element_id
                                e_id = r.end_node.element_id
                                if s_id in node_map and e_id in node_map:
                                    edges.append({
                                        "start": s_id,
                                        "end": e_id,
                                        "type": r.type,
                                    })

                graph_data = {
                    "nodes": list(node_map.values()),
                    "relationships": edges,
                }
            return jsonify({
                "patient": patient,
                "graph": graph_data if include_graph else None,
            }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@graph_bp.route("/patients", methods=["POST"])
@require_role("admin", "doctor")
def create_patient():
    """Create a new patient node (fields other than id are optional)."""
    data = request.get_json(silent=True) or {}
    pid = data.get("id")
    if not pid or not isinstance(pid, str):
        return jsonify({"error": "patient id is required"}), 400
    props = {k: data.get(k) for k in _NODE_TO_KEYS["Patient"] if k in data and data.get(k) is not None}
    props["id"] = pid
    try:
        with neo4j_get_session() as s:
            result = s.run(
                "MERGE (p:Patient {id: $id}) SET p += $props RETURN p",
                id=pid,
                props=props,
            )
            rec = result.single()
        return jsonify(_serialize(rec["p"])), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@graph_bp.route("/patients/<patient_id>", methods=["PUT"])
@require_role("admin", "doctor")
def update_patient(patient_id):
    """Update an existing patient node."""
    data = request.get_json(silent=True) or {}
    props = {k: data[k] for k in data if k in _NODE_TO_KEYS["Patient"] or k == "id"}
    if "id" in props:
        props.pop("id")
    if not props:
        return jsonify({"error": "no updatable fields provided"}), 400
    try:
        with neo4j_get_session() as s:
            result = s.run(
                "MATCH (p:Patient {id: $id}) SET p += $props RETURN p",
                id=patient_id,
                props=props,
            )
            rec = result.single()
            if rec is None:
                return jsonify({"error": f"patient {patient_id} not found"}), 404
        return jsonify(_serialize(rec["p"])), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@graph_bp.route("/patients/<patient_id>", methods=["DELETE"])
@require_role("admin")
def delete_patient(patient_id):
    """Delete a patient node and its relationships."""
    try:
        with neo4j_get_session() as s:
            result = s.run(
                "MATCH (p:Patient {id: $id}) DETACH DELETE p RETURN count(p) AS n",
                id=patient_id,
            )
            rec = result.single()
            if rec is None or rec["n"] == 0:
                return jsonify({"error": f"patient {patient_id} not found"}), 404
        return jsonify({"deleted": True, "id": patient_id}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@graph_bp.route("/patients/<patient_id>/intelligence", methods=["GET"])
@require_auth
def patient_intelligence(patient_id):
    """Enriched patient view: summary, medical history, similar patients.

    All derived data is computed deterministically in python (no LLM).
    """
    try:
        with neo4j_get_session() as s:
            data = graph_fetch.get_patient_intelligence(s, patient_id)
        if data is None:
            return jsonify({"error": f"patient {patient_id} not found"}), 404
        return jsonify(_clean_prop_val(data)), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@graph_bp.route("/patients/<patient_id>/treatment-intel", methods=["GET"])
@require_auth
def patient_treatment_intel(patient_id):
    """Per-patient ranked diagnoses (1..N by success likelihood).

    Supports method='vector' (Multimodal Phenotype Vector Space) or 'cypher' (Legacy Jaccard graph join).
    """
    method = request.args.get("method", "vector")
    try:
        with neo4j_get_session() as s:
            data = graph_fetch.get_treatment_intel(s, patient_id, method=method)
        if data is None:
            return jsonify({"error": f"patient {patient_id} not found"}), 404
        return jsonify(_clean_prop_val(data)), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@graph_bp.route("/sectors/<path:disease_name>/intelligence", methods=["GET"])
@require_auth
def sector_treatment_intelligence(disease_name):
    """Return cohort-level treatment intelligence for a disease.
    
    Answers 'What is the best treatment for a given disease?':
    - Top indicated pharmacotherapies (medications) with efficacy and cost
    - Top interventional clinical procedures with recovery rates
    - Overall cohort biomarker control rate and monitored metrics
    """
    try:
        # If the parameter has dashes from slugification, replace with spaces
        name_clean = disease_name.replace("-", " ").strip()
        with neo4j_get_session() as s:
            data = treatment_intel.get_disease_treatment_intel(s, name_clean)
        if data is None:
            return jsonify({"error": f"Disease '{disease_name}' not found"}), 404
        return jsonify(_clean_prop_val(data)), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500




@graph_bp.route("/schema", methods=["GET"])
@require_auth
def schema():
    """Return DB meta for the admin panel: node labels + counts, relationship
    types + counts, property keys, and a 'last update' timestamp."""
    try:
        with neo4j_get_session() as s:
            node_result = s.run(
                "MATCH (n) WITH labels(n) AS l UNWIND l AS label "
                "WITH label, count(*) AS count RETURN label, count ORDER BY count DESC"
            )
            nodes = [{"label": rec["label"], "count": rec["count"]} for rec in node_result]

            rel_result = s.run(
                "MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS count "
                "ORDER BY count DESC"
            )
            rels = [{"type": rec["type"], "count": rec["count"]} for rec in rel_result]

            prop_result = s.run(
                "MATCH (n) UNWIND keys(n) AS k WITH DISTINCT k AS key ORDER BY key RETURN key"
            )
            prop_keys = [rec["key"] for rec in prop_result]

        import datetime
        last_update = datetime.datetime.now(datetime.timezone.utc).isoformat()
        node_count = sum(n["count"] for n in nodes)
        rel_count = sum(r["count"] for r in rels)
        return jsonify({
            "labels": nodes,
            "relationships": rels,
            "property_keys": prop_keys,
            "node_count": node_count,
            "relationship_count": rel_count,
            "last_update": last_update,
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@graph_bp.route("/cypher", methods=["POST"])
@require_role("admin")
def cypher_passthrough():
    """Run an arbitrary read-only Cypher query against AuraDB.

    Body: {"query": "...", "params": {...}}
    Returns columns, rows (values serialized), and timing metadata for the
    admin graph panel (Graph/Table/RAW tabs + "started streaming..." footer).
    """
    data = request.get_json(silent=True) or {}
    query = data.get("query") or data.get("cypher")
    params = data.get("params") or {}
    if not query or not isinstance(query, str):
        return jsonify({"error": "query is required"}), 400

    start = time.perf_counter()
    try:
        with neo4j_get_session() as s:
            keys, rows = _execute_read_query(s, query, params)
        elapsed_ms = (time.perf_counter() - start) * 1000
        return jsonify({
            "columns": keys,
            "rows": rows,
            "timing": {"elapsed_ms": round(elapsed_ms, 1)},
            "row_count": len(rows),
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@graph_bp.route("/explore", methods=["POST"])
@require_role("admin", "researcher")
def explore_preset():
    """Execute a server-authored, read-only graph preset.

    Researchers (who have Graph Explorer but never raw Cypher access) run the
    same curated queries via this endpoint. Any client-supplied query is ignored.
    """
    data = request.get_json(silent=True) or {}
    preset = (data.get("preset") or "").strip()
    query = _GRAPH_PRESETS.get(preset)
    if not query:
        return jsonify({"error": "unknown preset; allowed: " + ", ".join(_GRAPH_PRESETS.keys())}), 400

    start = time.perf_counter()
    try:
        with neo4j_get_session() as s:
            keys, rows = _execute_read_query(s, query)
        elapsed_ms = (time.perf_counter() - start) * 1000
        return jsonify({
            "preset": preset,
            "columns": keys,
            "rows": rows,
            "timing": {"elapsed_ms": round(elapsed_ms, 1)},
            "row_count": len(rows),
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@graph_bp.route("/sectors", methods=["GET"])
@require_auth
def list_sectors():
    """Disease cohorts with patient + medication counts (replaces the raw Cypher
    the Sectors page used to run against /cypher)."""
    try:
        with neo4j_get_session() as s:
            result = s.run(
                """
                MATCH (d:Disease)
                OPTIONAL MATCH (p:Patient)-[:HAS_DIAGNOSIS]->(d)
                OPTIONAL MATCH (med:Medication)-[:TREATS]->(d)
                RETURN d.name AS name, count(DISTINCT p) AS patients,
                       count(DISTINCT med) AS medications
                ORDER BY patients DESC
                """
            )
            sectors = [
                {
                    "name": r["name"],
                    "patients": r["patients"] or 0,
                    "medications": r["medications"] or 0,
                }
                for r in result
            ]
        return jsonify(sectors), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@graph_bp.route("/sectors/<disease>/graph", methods=["GET"])
@require_auth
def sector_graph(disease):
    """Cohort knowledge-graph for a disease (replaces the raw Cypher the sector
    view page used to run against /cypher)."""
    name_clean = disease.replace("-", " ").strip()
    if not name_clean:
        return jsonify({"error": "disease name is required"}), 400
    try:
        with neo4j_get_session() as s:
            keys, rows = _execute_read_query(
                s,
                """
                MATCH (d:Disease) WHERE toLower(d.name) = toLower($name)
                MATCH (p:Patient)-[hd:HAS_DIAGNOSIS]->(d)
                OPTIONAL MATCH (m:Medication)-[tr:TREATS]->(d)
                OPTIONAL MATCH (t:Treatment)-[tt:TREATS]->(d)
                RETURN d, p, m, t, hd, tr, tt LIMIT 120
                """,
                {"name": name_clean},
            )
        return jsonify({"columns": keys, "rows": rows, "row_count": len(rows)}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@graph_bp.route("/patient-summaries", methods=["GET"])
@require_auth
def patient_summaries():
    """Per-patient diagnosis / treatment / lab counts for the Treatment
    Intelligence dashboard (replaces the raw Cypher dependency)."""
    try:
        with neo4j_get_session() as s:
            result = s.run(
                """
                MATCH (p:Patient)
                OPTIONAL MATCH (p)-[:HAS_DIAGNOSIS]->(d:Disease)
                OPTIONAL MATCH (p)-[:RECEIVED_TREATMENT]->(t:Treatment)
                OPTIONAL MATCH (p)-[:HAS_LAB_TEST]->(l:LabTest)
                RETURN p.id AS id,
                       collect(DISTINCT d.name) AS diagnoses,
                       count(DISTINCT t) AS treatmentCount,
                       count(DISTINCT l) AS labCount
                """
            )
            summaries = [
                {
                    "id": r["id"],
                    "diagnoses": _clean_prop_val(r["diagnoses"] or []),
                    "treatmentCount": r["treatmentCount"] or 0,
                    "labCount": r["labCount"] or 0,
                }
                for r in result
            ]
        return jsonify(summaries), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@graph_bp.route("/dashboard/recent-notes", methods=["GET"])
@require_auth
def dashboard_recent_notes():
    """Most recent consultation notes (replaces the Dashboard raw Cypher call)."""
    try:
        with neo4j_get_session() as s:
            result = s.run(
                """
                MATCH (p:Patient)-[:HAS_CONSULTATION_NOTE]->(n:ConsultationNote)
                RETURN p.id AS id,
                       p.first_name + ' ' + p.last_name AS name,
                       n.summary AS summary,
                       toString(n.created_at) AS created
                ORDER BY n.created_at DESC LIMIT 6
                """
            )
            notes = [
                {
                    "id": r["id"],
                    "name": r["name"],
                    "summary": r["summary"],
                    "created": r["created"],
                }
                for r in result
            ]
        return jsonify(notes), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@graph_bp.route("/dashboard/top-sectors", methods=["GET"])
@require_auth
def dashboard_top_sectors():
    """Largest disease cohorts (replaces the Dashboard raw Cypher call)."""
    try:
        with neo4j_get_session() as s:
            result = s.run(
                """
                MATCH (p:Patient)-[:HAS_DIAGNOSIS]->(d:Disease)
                RETURN d.name AS disease, count(p) AS patients
                ORDER BY patients DESC LIMIT 8
                """
            )
            sectors = [
                {"disease": r["disease"], "patients": r["patients"] or 0}
                for r in result
            ]
        return jsonify(sectors), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@graph_bp.route("/dashboard/treatment-trend", methods=["GET"])
@require_auth
def dashboard_treatment_trend():
    """Treatment date series for the activity trend chart (replaces the raw
    Cypher dependency). Returns ISO-ish date strings, oldest first."""
    try:
        with neo4j_get_session() as s:
            result = s.run(
                "MATCH (t:Treatment) RETURN toString(t.treatment_date) AS d ORDER BY d"
            )
            dates = [r["d"] for r in result if r["d"]]
        return jsonify({"dates": dates}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _serialize_value(value):
    """Convert a Neo4j driver value into JSON-friendly primitives."""
    if value is None:
        return None

    # Nodes
    if hasattr(value, "element_id") and hasattr(value, "labels"):
        return {
            "_type": "node",
            "_labels": list(value.labels),
            "element_id": value.element_id,
            "properties": {k: _serialize_value(v) for k, v in value.items()},
        }
    # Relationships
    if hasattr(value, "type") and hasattr(value, "start_node"):
        return {
            "_type": "relationship",
            "_rel_type": value.type,
            "_start": value.start_node.element_id,
            "_end": value.end_node.element_id,
        }
    # Rich temporal/spatial types
    try:
        import datetime
        if hasattr(value, "isoformat"):
            return value.isoformat()
    except Exception:
        pass

    if isinstance(value, (list, tuple)):
        return [_serialize_value(v) for v in value]
    if isinstance(value, dict):
        return {k: _serialize_value(v) for k, v in value.items()}
    return value