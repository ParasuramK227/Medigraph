import os
import re
import requests
from dotenv import load_dotenv
from flask import Blueprint, request, jsonify

from backend.analysis import graph_fetch, treatment_intel
from backend.auth_utils import require_auth
from backend.chat_privacy import deidentify_profile, deidentify_cohort, deidentify_message
from backend.neo4j_connection import get_session as neo4j_get_session
from backend.routes.graph import _serialize_value, fetch_cypher_schema

load_dotenv()

MODEL = "openai/gpt-oss-120b"

chat_bp = Blueprint("chat", __name__)

_SYSTEM_PROMPT = (
    "You are MediGraph Clinical Assistant, an advanced medical AI directly connected to a "
    "Neo4j healthcare knowledge graph and electronic health records.\n\n"
    "Your objective is to provide precise, professional, and clinically accurate answers to "
    "physicians, nurses, and healthcare researchers based on the provided Clinical Knowledge Graph Context.\n\n"
    "Clinical Guidelines:\n"
    "1. Ground all responses strictly in the provided graph context (diagnoses, medications, procedures, labs, allergies, and notes).\n"
    "2. For patient queries, clearly delineate: Active Diagnoses, Prescribed Medications (with indication), Recent Treatments (with outcomes), Abnormal Labs/Vitals, and Known Allergies.\n"
    "3. Explicitly highlight any abnormal lab test values or vital signs.\n"
    "4. When answering population/cohort questions, cite the patient counts, top conditions, and linked treatments present in the context.\n"
    "5. If requested information is absent from the graph, state so clearly and factually rather than speculating.\n"
    "6. Format your answer with clean markdown bullet points, bold headings, and concise clinical summaries."
)


def _damerau_levenshtein(a: str, b: str) -> int:
    """Damerau–Levenshtein edit distance (insert/delete/substitute/transpose)."""
    n, m = len(a), len(b)
    if n == 0:
        return m
    if m == 0:
        return n
    prev2 = list(range(-1, n))
    prev1 = list(range(0, n + 1))
    for j in range(1, m + 1):
        cur = [0] * (n + 1)
        cur[0] = j
        for i in range(1, n + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            cur[i] = min(
                cur[i - 1] + 1,           # deletion
                prev1[i] + 1,             # insertion
                prev1[i - 1] + cost,      # substitution
            )
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                cur[i] = min(cur[i], prev2[i - 2] + 1)  # transposition
        prev2, prev1 = prev1, cur
    return prev1[n]


def _detect_patient_id(session, message: str) -> str | None:
    """Detect if a user mentioned a specific patient's name or UUID in the prompt."""
    if not message:
        return None
    cleaned = message.strip()

    # Check for UUID pattern
    uuid_match = re.search(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", cleaned)
    if uuid_match:
        return uuid_match.group(0)

    tokens = [t.lower() for t in re.findall(r"\b[A-Za-z]{3,}\b", cleaned)]
    if not tokens:
        return None

    # Scored match: exact word hits rank above substring hits so the intended
    # patient beats lookalike names (e.g. "Angel" over "Angelina").
    query = """
    MATCH (p:Patient)
    WITH p,
         [w IN split(toLower(coalesce(p.first_name, '') + ' ' + coalesce(p.last_name, '')), ' ') WHERE w <> ''] AS name_words
    WHERE any(t IN $tokens WHERE any(w IN name_words WHERE w CONTAINS t OR t CONTAINS w))
    RETURN p.id AS id,
           size([t IN $tokens WHERE any(w IN name_words WHERE w = t)]) AS exact_hits,
           size([t IN $tokens WHERE any(w IN name_words WHERE w CONTAINS t OR t CONTAINS w)]) AS token_hits
    ORDER BY exact_hits DESC, token_hits DESC, p.id
    LIMIT 1
    """
    top = session.run(query, tokens=tokens).single()
    if top and top["token_hits"] >= 1 and (top["exact_hits"] >= 1 or top["token_hits"] >= 2):
        return top["id"]

    # Typo-tolerant fallback over the full (small) patient name list.
    rows = list(session.run(
        "MATCH (p:Patient) WHERE p.first_name IS NOT NULL OR p.last_name IS NOT NULL "
        "RETURN p.id AS id, coalesce(toLower(p.first_name), '') AS first, coalesce(toLower(p.last_name), '') AS last"
    ))
    best: tuple | None = None
    for row in rows:
        name_words = [w for w in (row["first"], row["last"]) if w]
        hit_count = 0
        total_dist = 0
        for tok in tokens:
            d = min((_damerau_levenshtein(tok, w) for w in name_words), default=99)
            if d <= 1:
                hit_count += 1
                total_dist += d
        if hit_count > 0:
            cand = (-hit_count, total_dist, row["id"])
            if best is None or cand < best:
                best = cand
    return best[2] if best else None


def _fetch_patient_profile(session, patient_id: str) -> dict | None:
    """Fetch complete clinical profile for a specific patient."""
    query = """
    MATCH (p:Patient {id: $pid})
    OPTIONAL MATCH (p)-[:HAS_DIAGNOSIS]->(d:Disease)
    OPTIONAL MATCH (m:Medication)-[:TREATS]->(d)
    OPTIONAL MATCH (p)-[:HAD_ENCOUNTER]->(:Encounter)-[:PRESCRIBED]->(pm:Medication)
    OPTIONAL MATCH (p)-[:RECEIVED_TREATMENT]->(t:Treatment)
    OPTIONAL MATCH (p)-[:HAS_LAB_TEST]->(l:LabTest)
    OPTIONAL MATCH (p)-[:HAS_ALLERGY]->(a:Allergy)
    OPTIONAL MATCH (doc:Doctor)-[:TREATS]->(p)
    OPTIONAL MATCH (p)-[:HAS_CONSULTATION_NOTE]->(n:ConsultationNote)
    RETURN p.id AS id,
           coalesce(p.first_name + ' ' + p.last_name, p.id) AS name,
           p.gender AS gender,
           p.date_of_birth AS dob,
           p.city AS city,
           p.insurance_provider AS insurance,
           collect(DISTINCT d.name) AS diagnoses,
           collect(DISTINCT pm.name) AS prescribed_medications,
           collect(DISTINCT {med: m.name, for_disease: d.name})[0..10] AS medications,
           collect(DISTINCT {type: t.treatment_type, outcome: t.outcome, cost: t.cost, date: t.treatment_date})[0..8] AS treatments,
           collect(DISTINCT {name: l.name, val: l.result + ' ' + coalesce(l.unit, ''), status: l.status, date: l.date})[0..12] AS labs,
           collect(DISTINCT {substance: a.substance, severity: a.severity}) AS allergies,
           collect(DISTINCT doc.name)[0..2] AS doctors,
           collect(DISTINCT {title: n.title, summary: n.summary, date: toString(n.created_at)}) AS notes
    """
    rec = session.run(query, pid=patient_id).single()
    if not rec or not rec["name"]:
        return None
    d = dict(rec)
    d["medications_list"] = d.get("prescribed_medications") or [m["med"] for m in d.get("medications", []) if m.get("med")]
    return d


def _fetch_cohort_context(session, message: str) -> dict:
    """Fetch relevant population knowledge graph data based on terms in the query."""
    # 1. Top diseases and their treating medications
    top_diseases_query = """
    MATCH (d:Disease)
    MATCH (p:Patient)-[:HAS_DIAGNOSIS]->(d)
    OPTIONAL MATCH (m:Medication)-[:TREATS]->(d)
    OPTIONAL MATCH (t:Treatment)-[:TREATS]->(d)
    RETURN d.name AS disease,
           count(DISTINCT p) AS patient_count,
           collect(DISTINCT m.name)[0..3] AS meds,
           collect(DISTINCT t.treatment_type)[0..3] AS treatments
    ORDER BY patient_count DESC LIMIT 8
    """
    diseases = [dict(r) for r in session.run(top_diseases_query)]

    # 2. Patients with abnormal vitals or high-risk findings
    abnormal_labs_query = """
    MATCH (p:Patient)-[:HAS_LAB_TEST]->(l:LabTest {status: 'abnormal'})
    RETURN coalesce(p.first_name + ' ' + p.last_name, p.id) AS patient,
           l.name AS test,
           l.result + ' ' + coalesce(l.unit, '') AS value,
           l.date AS date
    LIMIT 6
    """
    abnormal_labs = [dict(r) for r in session.run(abnormal_labs_query)]

    # 3. Recent consultation notes
    notes_query = """
    MATCH (p:Patient)-[:HAS_CONSULTATION_NOTE]->(n:ConsultationNote)
    RETURN coalesce(p.first_name + ' ' + p.last_name, p.id) AS patient,
           n.title AS title,
           n.summary AS summary,
           n.diagnoses AS diagnoses,
           n.medications_discussed AS meds,
           n.action_items AS actions,
           toString(n.created_at) AS date
    ORDER BY n.created_at DESC LIMIT 5
    """
    notes = [dict(r) for r in session.run(notes_query)]

    return {
        "top_diseases": diseases,
        "abnormal_labs": abnormal_labs,
        "recent_notes": notes,
    }


def _fetch_traversal(session, has_patient: bool, patient_id: str | None) -> dict:
    """Return the raw graph nodes/relationships the chatbot actually consulted.

    Scoped identically to the context queries so the side panel reflects the
    real traversal path used to answer the current question. Serialized in the
    same shape as /graph/cypher so the frontend can reuse graphFromCypher().
    """
    if has_patient:
        query = """
        MATCH (p:Patient {id: $pid})
        OPTIONAL MATCH (p)-[hd:HAS_DIAGNOSIS]->(d:Disease)
        OPTIONAL MATCH (m:Medication)-[tr:TREATS]->(d)
        OPTIONAL MATCH (p)-[tt:RECEIVED_TREATMENT]->(t:Treatment)
        OPTIONAL MATCH (p)-[hl:HAS_LAB_TEST]->(l:LabTest)
        OPTIONAL MATCH (p)-[ha:HAS_ALLERGY]->(a:Allergy)
        OPTIONAL MATCH (doc:Doctor)-[dt:TREATS]->(p)
        OPTIONAL MATCH (p)-[hc:HAS_CONSULTATION_NOTE]->(n:ConsultationNote)
        OPTIONAL MATCH (n)-[md:MENTIONS_DIAGNOSIS]->(md_d:Disease)
        OPTIONAL MATCH (n)-[dm:DISCUSSES_MEDICATION]->(dm_m:Medication)
        RETURN p, hd, d, m, tr, tt, t, hl, l, ha, a, doc, dt, hc, n, md, md_d, dm, dm_m
        LIMIT 120
        """
        params = {"pid": patient_id}
    else:
        query = """
        MATCH (d:Disease)
        MATCH (p:Patient)-[hd:HAS_DIAGNOSIS]->(d)
        OPTIONAL MATCH (m:Medication)-[tr:TREATS]->(d)
        OPTIONAL MATCH (t:Treatment)-[tt:TREATS]->(d)
        OPTIONAL MATCH (pl:Patient)-[hl:HAS_LAB_TEST]->(l:LabTest {status: 'abnormal'})
        OPTIONAL MATCH (nl:Patient)-[nc:HAS_CONSULTATION_NOTE]->(n:ConsultationNote)
        RETURN p, hd, d, m, tr, t, tt, pl, hl, l, nl, nc, n
        LIMIT 150
        """
        params = {}

    result = session.run(query, **params)
    keys = None
    rows = []
    for rec in result:
        row_keys = list(rec.keys())
        if keys is None:
            keys = row_keys
        rows.append([_serialize_value(rec[k]) for k in row_keys])

    return {
        "columns": keys or [],
        "rows": rows,
        "row_count": len(rows),
        "cypher": query.strip(),
        "cypher_source": "static",
    }


_CYPHER_SYSTEM_PROMPT = (
    "You are a Neo4j Cypher query generator for a medical knowledge graph.\n\n"
    "Given the user's clinical question and the graph schema below, generate a single\n"
    "read-only Cypher query that retrieves the most relevant graph data to answer the\n"
    "question.\n\n"
    "Rules:\n"
    "1. Only use MATCH and OPTIONAL MATCH — never CREATE, DELETE, MERGE, SET, or DROP.\n"
    "2. RETURN full node and relationship objects (e.g. RETURN p, d, hd) so the\n"
    "   frontend can render them as a graph. Do NOT return only aggregated property\n"
    "   values like count() or collect() — include the raw nodes/relationships.\n"
    "3. Include a LIMIT of 150 rows.\n"
    "4. Output ONLY the raw Cypher query. No explanation, no markdown fences, no commentary.\n"
)

# Blocklist patterns for generated Cypher validation
_CYPHER_BLOCKLIST = re.compile(
    r"\b(CREATE|DELETE|MERGE|SET|DROP|REMOVE|DETACH|"
    r"LOAD\s+CSV|CALL|START|INDEX|CONSTRAINT|GRANT|REVOKE|"
    r"USING\s+PERIODIC\s+COMMIT)\b",
    re.IGNORECASE,
)


def _validate_cypher(cypher: str) -> bool:
    """Return True if the generated Cypher is safe to execute (read-only MATCH only)."""
    if not cypher or len(cypher) > 500:
        return False
    if _CYPHER_BLOCKLIST.search(cypher):
        return False
    stripped = cypher.lstrip()
    if not re.match(r"(?:MATCH|OPTIONAL\s+MATCH)\b", stripped, re.IGNORECASE):
        return False
    if not re.search(r"\bRETURN\b", cypher, re.IGNORECASE):
        return False
    return True


def _generate_cypher_for_cohort(
    session, user_message: str, patient_id: str | None = None,
) -> str | None:
    """LLM Call 1: generate a Cypher query scoped to the user's question."""
    api_key = os.environ.get("GROQ_API_KEY_CHATBOT") or os.environ.get("GROQ_API_KEY")
    if not api_key:
        return None

    try:
        schema = fetch_cypher_schema(session)
    except Exception:
        return None

    context = f"Graph Schema:\n{schema}\n\n"
    if patient_id:
        context += f"The question is about patient ID {patient_id}. "
        context += "Generate a Cypher query that starts from this patient and "
        context += "traverses their clinical connections.\n\n"
    context += f"User Question: {user_message}"

    try:
        resp = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": MODEL,
                "temperature": 0.0,
                "max_tokens": 300,
                "messages": [
                    {"role": "system", "content": _CYPHER_SYSTEM_PROMPT},
                    {"role": "user", "content": context},
                ],
            },
            timeout=30,
        )
        if resp.status_code != 200:
            return None
        raw = resp.json()["choices"][0]["message"]["content"].strip()
        # Strip markdown fences if the LLM wraps them anyway
        raw = re.sub(r"^```(?:cypher)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
        return raw.strip()
    except Exception:
        return None


def _fetch_dynamic_traversal(
    session, user_message: str, patient_id: str | None = None,
) -> dict | None:
    """Generate a question-scoped Cypher, validate, execute, and return traversal rows.

    Returns None if generation, validation, or execution fails — caller should
    fall back to the static traversal.
    """
    cypher = _generate_cypher_for_cohort(session, user_message, patient_id=patient_id)
    if not cypher or not _validate_cypher(cypher):
        return None

    try:
        keys, rows = None, []
        result = session.run(cypher)
        for rec in result:
            if keys is None:
                keys = list(rec.keys())
            rows.append([_serialize_value(rec[k]) for k in rec.keys()])
        if not rows:
            return None
        return {"columns": keys or [], "rows": rows, "row_count": len(rows), "cypher": cypher, "cypher_source": "llm"}
    except Exception:
        return None


def _build_context_text(profile: dict | None, cohort: dict | None) -> str:
    """Serialize clinical graph data into clear Markdown for LLM prompt."""
    sections = []

    if profile:
        lines = [
            f"### Selected Patient Profile: {profile['name']} (ID: {profile['id']})",
            f"- Demographics: Gender: {profile.get('gender')}, DOB: {profile.get('dob')}, Location: {profile.get('city')}, Insurance: {profile.get('insurance')}",
        ]
        if profile.get("diagnoses"):
            lines.append(f"- Active Diagnoses: {', '.join(profile['diagnoses'])}")
        if profile.get("medications"):
            med_strs = [f"{m['med']} (for {m['for_disease']})" for m in profile["medications"] if m.get("med")]
            if med_strs:
                lines.append(f"- Indicated Medications: {'; '.join(med_strs)}")
        if profile.get("prescribed_medications"):
            lines.append(f"- Active Prescribed Medications (Encounters): {'; '.join(profile['prescribed_medications'][:8])}")
        if profile.get("similar_cohort"):
            lines.append("- Similar Patient Cohort (Multimodal Phenotype Vector Space - Conditions & Drug Regimens):")
            for sp in profile["similar_cohort"]:
                m_list = ", ".join(sp.get("shared_medications", [])[:2]) or "None"
                d_list = ", ".join(sp.get("shared_diagnoses", [])[:2]) or "None"
                lines.append(f"  * {sp['name']} (Match: {int(sp['similarity']*100)}% | Conditions: {d_list} | Shared Drugs: {m_list})")
        if profile.get("treatments"):
            treat_strs = [f"{t['type']} [Outcome: {t.get('outcome', 'completed')}, Cost: ${t.get('cost', 'N/A')}]" for t in profile["treatments"] if t.get("type")]
            if treat_strs:
                lines.append(f"- Recorded Procedures/Treatments: {'; '.join(treat_strs)}")
        if profile.get("labs"):
            lab_strs = [f"{l['name']}: {l['val']} ({l.get('status', 'normal')})" for l in profile["labs"] if l.get("name")]
            if lab_strs:
                lines.append(f"- Recent Lab Tests & Vitals: {'; '.join(lab_strs)}")
        if profile.get("allergies"):
            alg_strs = [f"{a['substance']} ({a.get('severity', 'recorded')})" for a in profile["allergies"] if a.get("substance")]
            if alg_strs:
                lines.append(f"- Known Allergies: {', '.join(alg_strs)}")
        if profile.get("doctors"):
            lines.append(f"- Attending Doctors: {', '.join(profile['doctors'])}")
        if profile.get("notes"):
            note_strs = [f"[{n.get('date', 'Recent')}] {n.get('title', 'Note')}: {n.get('summary')}" for n in profile["notes"] if n.get("summary")]
            if note_strs:
                lines.append(f"- Consultation Notes: {' | '.join(note_strs)}")
        sections.append("\n".join(lines))

    if cohort:
        lines = ["### Clinical Knowledge Graph Population Context:"]
        if cohort.get("top_diseases"):
            lines.append("Top Diagnoses & Treatments in Population:")
            for d in cohort["top_diseases"]:
                med_list = ", ".join(d.get("meds") or []) or "No specific drug"
                lines.append(f"  * {d['disease']}: {d['patient_count']} patients diagnosed. Indicated meds: {med_list}")
        if cohort.get("abnormal_labs"):
            lines.append("\nSample Abnormal Lab Observations:")
            for l in cohort["abnormal_labs"]:
                lines.append(f"  * {l['patient']}: {l['test']} = {l['value']} ({l.get('date', '')})")
        if cohort.get("recent_notes"):
            lines.append("\nRecent Consultation Notes:")
            for n in cohort["recent_notes"]:
                lines.append(f"  * {n['patient']} ({n.get('date', '')}): {n['summary']}")
        sections.append("\n".join(lines))

    return "\n\n".join(sections)


@chat_bp.route("/suggestions", methods=["GET"])
@require_auth
def chat_suggestions():
    """Return smart, dynamic demo questions based on selected patient or cohort data."""
    patient_id = request.args.get("patient_id")
    try:
        with neo4j_get_session() as session:
            if patient_id:
                profile = _fetch_patient_profile(session, patient_id)
                if profile:
                    name = profile["name"]
                    diags = profile.get("diagnoses") or []
                    primary_diag = diags[0] if diags else "conditions"
                    return jsonify({
                        "patient_id": patient_id,
                        "patient_name": name,
                        "suggestions": [
                            {
                                "category": "Summary",
                                "prompt": f"Summarize {name}'s medical history and current active diagnoses.",
                            },
                            {
                                "category": "Medications",
                                "prompt": f"What medications are prescribed for {name}, and what are their clinical indications?",
                            },
                            {
                                "category": "Lab Results",
                                "prompt": f"Does {name} have any abnormal lab test results or abnormal vital signs?",
                            },
                            {
                                "category": "Treatments",
                                "prompt": f"What procedures or treatments has {name} received, and what were the outcomes?",
                            },
                        ],
                    }), 200

            # Global / cohort mode suggestions
            top_query = "MATCH (d:Disease) MATCH (p:Patient)-[:HAS_DIAGNOSIS]->(d) RETURN d.name AS name ORDER BY count(p) DESC LIMIT 2"
            top_diags = [r["name"] for r in session.run(top_query)]
            d1 = top_diags[0] if len(top_diags) > 0 else "Hypertension"
            d2 = top_diags[1] if len(top_diags) > 1 else "Diabetes"

            return jsonify({
                "patient_id": None,
                "suggestions": [
                    {
                        "category": "Population",
                        "prompt": "What are the most frequent diagnoses and top conditions in the patient cohort?",
                    },
                    {
                        "category": "Therapies",
                        "prompt": f"Which medications are indicated and prescribed for {d1} and {d2}?",
                    },
                    {
                        "category": "Lab Alerts",
                        "prompt": "Which patients in our database have abnormal lab tests or high blood pressure readings?",
                    },
                    {
                        "category": "Consultations",
                        "prompt": "Summarize the recent doctor consultation notes and key clinical action items.",
                    },
                    {
                        "category": "Outcomes",
                        "prompt": "What treatments and procedures have the highest success rates in the knowledge graph?",
                    },
                ],
            }), 200
    except Exception as e:
        return jsonify({
            "suggestions": [
                {"category": "Overview", "prompt": "What are the most common diagnoses across all patients?"},
                {"category": "Medications", "prompt": "Which medications are discussed in recent consultations?"},
                {"category": "Vitals", "prompt": "Are there any patients with abnormal lab test results?"},
            ],
            "error": str(e),
        }), 200


@chat_bp.route("/query", methods=["POST"])
@require_auth
def chat_query():
    """Accept a natural-language clinical question grounded in the Neo4j knowledge graph."""
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    patient_id = data.get("patient_id")

    if not message:
        return jsonify({"error": "message is required"}), 400

    api_key = os.environ.get("GROQ_API_KEY_CHATBOT") or os.environ.get("GROQ_API_KEY")

    try:
        with neo4j_get_session() as session:
            # If no explicit patient_id passed, see if one was mentioned by name in message
            if not patient_id:
                detected_id = _detect_patient_id(session, message)
                if detected_id:
                    patient_id = detected_id

            profile = None
            if patient_id:
                profile = _fetch_patient_profile(session, patient_id)
                if profile:
                    try:
                        all_pts = graph_fetch.fetch_all_patients_with_diags(session)
                        sim_pts, _ = treatment_intel.compute_multimodal_patient_similarity(profile, all_pts)
                        profile["similar_cohort"] = sim_pts[:3]
                    except Exception:
                        profile["similar_cohort"] = []

            cohort = _fetch_cohort_context(session, message)

            # Dynamic traversal (LLM-generated Cypher) with fallback to static.
            traversal = _fetch_dynamic_traversal(session, message, patient_id=patient_id)
            if traversal is None:
                traversal = _fetch_traversal(
                    session,
                    has_patient=patient_id is not None,
                    patient_id=patient_id,
                )

            # --- PHI de-identification before LLM call -----------------------
            patient_name_for_msg = None
            if profile:
                patient_name_for_msg = profile.get("name")
                profile, _ = deidentify_profile(profile)
            cohort = deidentify_cohort(cohort)
            message = deidentify_message(
                message,
                patient_name=patient_name_for_msg,
            )

            context = _build_context_text(profile, cohort)
    except Exception as e:
        return jsonify({"error": f"Could not query clinical knowledge graph: {e}"}), 500

    if not api_key:
        # Factual fallback if API key is not configured
        fallback_lines = ["(No Groq API key configured — displaying graph summary directly)"]
        if profile:
            fallback_lines.append(f"Patient: {profile['name']}")
            fallback_lines.append(f"Diagnoses: {', '.join(profile.get('diagnoses', []))}")
            fallback_lines.append(f"Medications: {len(profile.get('medications', []))} active")
        else:
            fallback_lines.append("Top conditions in cohort:")
            for d in cohort.get("top_diseases", [])[:4]:
                fallback_lines.append(f"- {d['disease']}: {d['patient_count']} patients")
        return jsonify({
            "answer": "\n".join(fallback_lines),
            "candidate_count": 1,
            "source_count": 1,
            "traversal": traversal,
        })

    try:
        user_prompt = (
            f"Clinical Knowledge Graph Context:\n\n{context}\n\n"
            f"User Question: {message}"
        )
        resp = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": MODEL,
                "temperature": 0.1,
                "messages": [
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
            },
            timeout=90,
        )
        if resp.status_code != 200:
            return jsonify({"error": f"Groq LLM returned status {resp.status_code}: {resp.text}"}), 502

        answer = resp.json()["choices"][0]["message"]["content"].strip()
    except requests.RequestException as e:
        return jsonify({"error": f"Chatbot request failed: {e}"}), 502

    return jsonify({
        "answer": answer,
        "patient_id": patient_id,
        "patient_name": profile["name"] if profile else None,
        "candidate_count": len(cohort.get("top_diseases", [])) + (1 if profile else 0),
        "source_count": len(cohort.get("recent_notes", [])) + (len(profile.get("labs", [])) if profile else 0),
        "traversal": traversal,
    })