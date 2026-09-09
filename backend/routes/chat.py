import os
import re
import requests
from dotenv import load_dotenv
from flask import Blueprint, request, jsonify

from backend.auth_utils import require_auth
from backend.neo4j_connection import get_session as neo4j_get_session

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


def _detect_patient_id(session, message: str) -> str | None:
    """Detect if a user mentioned a specific patient's name or UUID in the prompt."""
    if not message:
        return None
    cleaned = message.strip()

    # Check for UUID pattern
    uuid_match = re.search(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", cleaned)
    if uuid_match:
        return uuid_match.group(0)

    # Check for partial name match against Patient nodes
    tokens = [t.lower() for t in re.findall(r"\b[A-Za-z]{3,}\b", cleaned)]
    if not tokens:
        return None

    query = """
    MATCH (p:Patient)
    WHERE any(t IN $tokens WHERE toLower(p.first_name) CONTAINS t OR toLower(p.last_name) CONTAINS t)
    RETURN p.id AS id
    LIMIT 1
    """
    rec = session.run(query, tokens=tokens).single()
    return rec["id"] if rec else None


def _fetch_patient_profile(session, patient_id: str) -> dict | None:
    """Fetch complete clinical profile for a specific patient."""
    query = """
    MATCH (p:Patient {id: $pid})
    OPTIONAL MATCH (p)-[:HAS_DIAGNOSIS]->(d:Disease)
    OPTIONAL MATCH (m:Medication)-[:TREATS]->(d)
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
    return dict(rec)


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

            cohort = _fetch_cohort_context(session, message)
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
    })