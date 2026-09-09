import os
import re
import tempfile
import uuid

from flask import Blueprint, request, jsonify, current_app

from backend.neo4j_connection import get_session as neo4j_get_session
from scribe import session as sess
from scribe.transcription import (
    transcribe,
    translate_text,
    TranscriptionError,
)
from scribe.extraction import extract, ExtractionError
from scribe.safety import audit_medication

scribe_bp = Blueprint("scribe", __name__)


def _new_session_id():
    return str(uuid.uuid4())


def _start_upload():
    """Initiate a new consultation session and return its id + upload endpoint."""
    session_id = _new_session_id()
    sess.set_state(session_id, "idle")
    return jsonify({"session_id": session_id})


@scribe_bp.route("/start", methods=["POST"])
def start_session():
    """Create a new consultation session. Returns a session_id used by all
    subsequent scribe endpoints."""
    return _start_upload()


@scribe_bp.route("/translate", methods=["POST"])
def live_translate():
    """Translate clinical speech/transcript in real-time into English or another target language."""
    data = request.get_json(silent=True) or {}
    text = data.get("text", "")
    target_lang = data.get("target_lang", "English")
    if not text:
        return jsonify({"error": "text is required"}), 400
    translated = translate_text(text, target_lang=target_lang)
    return jsonify({"translated_text": translated, "original_text": text})


@scribe_bp.route("/upload", methods=["POST"])
def upload_audio():
    """Accept a full audio file upload and transcribe via Groq Whisper Turbo or Local faster-whisper.

    The frontend first calls /start to get a session_id, then uploads the
    audio file as multipart form data with that session_id. On transcription
    failure, the consecutive-failure counter is incremented; after 3 failures
    the response flags that retry should no longer be offered.
    """
    session_id = request.form.get("session_id")
    if not session_id:
        return jsonify({"error": "missing session_id"}), 400

    provider = request.form.get("provider", "groq")
    model_size = request.form.get("model_size", "base")
    hf_endpoint = request.form.get("hf_endpoint")

    file = request.files.get("audio")
    if not file:
        file = request.files.get("file")
    if not file or not file.filename:
        return jsonify({"error": "missing audio upload"}), 400

    sess.set_state(session_id, "transcribing")

    suffix = os.path.splitext(file.filename)[1] or ".webm"
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=current_app.config.get("UPLOAD_TEMP_DIR") or tempfile.gettempdir(),
            suffix=suffix,
            delete=False,
        ) as tmp:
            file.save(tmp.name)
            tmp_path = tmp.name

        transcript = transcribe(tmp_path, provider=provider, model_size=model_size, hf_endpoint=hf_endpoint)

        # Success — reset failure counter, store transcript for doctor review.
        sess.set_transcript(session_id, transcript, approved=False)
        sess.set_state(session_id, "review")

        return jsonify({
            "session_id": session_id,
            "transcript": transcript,
            "status": "review",
            "provider": provider,
        })
    except TranscriptionError as e:
        failures = sess.record_failure(session_id)
        return jsonify({
            "error": str(e),
            "failure_count": failures,
            "retry_disabled": sess.retry_disabled(session_id),
        }), 422
    except Exception as e:
        failures = sess.record_failure(session_id)
        return jsonify({
            "error": f"Transcription failed: {e}",
            "failure_count": failures,
            "retry_disabled": sess.retry_disabled(session_id),
        }), 500
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


@scribe_bp.route("/transcript/<session_id>", methods=["GET"])
def get_transcript(session_id):
    """Retrieve current transcript for a session, plus whether it's been approved."""
    transcript, approved = sess.get_transcript(session_id)
    if transcript is None:
        return jsonify({"error": "no transcript for session"}), 404
    return jsonify({
        "session_id": session_id,
        "transcript": transcript,
        "approved": approved,
        "status": sess.get_state(session_id),
    })


@scribe_bp.route("/transcript/<session_id>", methods=["PUT"])
def edit_transcript(session_id):
    """Store the doctor-edited/approved transcript.

    This endpoint ONLY stores the edit — it never triggers extraction.
    Extraction is an explicit, separate call (/extract/<session_id>).
    """
    data = request.get_json(silent=True) or {}
    transcript = data.get("transcript")
    if not transcript or not isinstance(transcript, str):
        return jsonify({"error": "transcript must be a non-empty string"}), 400

    sess.set_transcript(session_id, transcript, approved=bool(data.get("approved", True)))
    sess.set_state(session_id, "approved" if data.get("approved", True) else "review")

    return jsonify({
        "session_id": session_id,
        "status": sess.get_state(session_id),
        "approved": sess.get_transcript(session_id)[1],
    })


@scribe_bp.route("/extract/<session_id>", methods=["POST"])
def extract_note(session_id):
    """Trigger Groq extraction against the approved transcript for this session.

    Returns 409 if no transcript exists yet, or 400 if the transcript has not
    been explicitly approved — extraction NEVER runs on an unreviewed transcript.
    Applies local HIPAA Safe Harbor de-identification before sending out and
    runs clinical dosage safety audits on extracted items.
    """
    transcript, approved = sess.get_transcript(session_id)
    if transcript is None:
        return jsonify({"error": "no transcript for session; upload first"}), 409
    if not approved:
        return jsonify({"error": "transcript not approved; doctor must approve before extraction"}), 400

    data = request.get_json(silent=True) or {}
    patient_name = data.get("patient_name")
    doctor_name = data.get("doctor_name")
    deidentify = data.get("deidentify", True)

    sess.set_state(session_id, "extracting")
    try:
        note = extract(
            transcript,
            patient_name=patient_name,
            doctor_name=doctor_name,
            deidentify=deidentify,
        )
        # Note is staged in the session store until the doctor confirms save.
        sess.set_state(session_id, "extracted")
        return jsonify({
            "session_id": session_id,
            "status": "extracted",
            "note": note,
        })
    except ExtractionError as e:
        sess.set_state(session_id, "extract_error")
        return jsonify({"error": str(e), "status": "extract_error"}), 502


@scribe_bp.route("/audit-medication", methods=["POST"])
def audit_single_medication():
    """Live audit a single medication for clinical safety, 10x dosage errors, and sound-alikes."""
    data = request.get_json(silent=True) or {}
    name = data.get("name", "")
    dosage = data.get("dosage")
    unit = data.get("unit")
    frequency = data.get("frequency")
    route = data.get("route")

    alerts = audit_medication(name=name, dosage=dosage, unit=unit, frequency=frequency, route=route)
    return jsonify({
        "medication": {"name": name, "dosage": dosage, "unit": unit, "frequency": frequency, "route": route},
        "alerts": alerts,
        "is_safe": len(alerts) == 0,
    })


def _clean_med_name(raw: str) -> str:
    """Extract a clean medication name from free-text discussed strings."""
    if not raw:
        return ""
    cleaned = re.split(
        r"\b(?:\d+|mg|mcg|ml|daily|twice|once|oral|tablet|inhaler|capsule|for|as needed)\b",
        raw,
        flags=re.IGNORECASE,
    )[0]
    cleaned = cleaned.strip(" -:,;")
    return cleaned.title() if cleaned else raw.strip().title()


def _canonicalize_disease(session, raw_name: str) -> str:
    """Resolve extracted disease name to existing canonical Disease node in Neo4j."""
    cleaned = re.sub(r"\s*\((?:disorder|finding|situation|procedure)\)", "", raw_name, flags=re.IGNORECASE).strip()
    rec = session.run(
        "MATCH (d:Disease) WHERE toLower(d.name) = toLower($name) RETURN d.name AS name LIMIT 1",
        name=cleaned,
    ).single()
    return rec["name"] if rec else cleaned.title()


@scribe_bp.route("/save/<session_id>", methods=["POST"])
def save_note(session_id):
    """Persist the structured note into Neo4j as a connected ConsultationNote
    attached to the patient, diagnosed diseases, discussed medications, and attending doctor.

    Accepts a patient_id plus the note JSON.
    """
    data = request.get_json(silent=True) or {}
    patient_id = data.get("patient_id")
    note = data.get("note")

    if not patient_id or not isinstance(patient_id, str):
        return jsonify({"error": "patient_id is required"}), 400
    if not note or not isinstance(note, dict):
        return jsonify({"error": "note must be a JSON object"}), 400

    title = (note.get("title") or "").strip()
    summary = note.get("summary", "")
    diagnoses = note.get("diagnoses", []) or []
    action_items = note.get("action_items", []) or []
    meds = note.get("medications_discussed", []) or []
    note_id = "CN-" + str(uuid.uuid4())[:8]

    # Convert meds to a list of primitive strings for the ConsultationNote node property
    meds_summary_strings = []
    for m in meds:
        if isinstance(m, dict):
            name = str(m.get("name") or "").strip()
            dose = str(m.get("dosage") or "").strip()
            unit = str(m.get("unit") or "").strip()
            freq = str(m.get("frequency") or "").strip()
            parts = [name]
            if dose:
                parts.append(f"{dose}{unit}")
            if freq:
                parts.append(freq)
            meds_summary_strings.append(" ".join(parts).strip())
        elif isinstance(m, str) and m.strip():
            meds_summary_strings.append(m.strip())

    if not title:
        if diagnoses and len(diagnoses) > 0:
            title = f"{str(diagnoses[0]).title()} Consultation"
        else:
            title = "Clinical Consultation Note"

    try:
        with neo4j_get_session() as s:
            # 1. Create ConsultationNote and attach to Patient and attending Doctor
            s.run(
                """
                MERGE (p:Patient {id: $patient_id})
                CREATE (n:ConsultationNote {
                    id: $note_id,
                    title: $title,
                    summary: $summary,
                    diagnoses: $diagnoses,
                    action_items: $action_items,
                    medications_discussed: $meds,
                    created_at: datetime(),
                    source: 'ai_scribe'
                })
                CREATE (p)-[:HAS_CONSULTATION_NOTE]->(n)
                WITH p, n
                OPTIONAL MATCH (doc:Doctor)-[:TREATS]->(p)
                FOREACH (_ IN CASE WHEN doc IS NOT NULL THEN [1] ELSE [] END |
                    MERGE (doc)-[:CONDUCTED]->(n)
                )
                """,
                patient_id=patient_id,
                note_id=note_id,
                title=title,
                summary=summary,
                diagnoses=diagnoses,
                action_items=action_items,
                meds=meds_summary_strings,
            )

            # 2. Canonicalize and link Diagnoses: (p)-[:HAS_DIAGNOSIS]->(d), (n)-[:MENTIONS_DIAGNOSIS]->(d)
            canonical_diseases = []
            for d in diagnoses:
                if not d or not str(d).strip():
                    continue
                can_name = _canonicalize_disease(s, str(d))
                canonical_diseases.append(can_name)
                s.run(
                    """
                    MATCH (n:ConsultationNote {id: $note_id})
                    MATCH (p:Patient {id: $patient_id})
                    MERGE (disease:Disease {name: $d_name})
                    MERGE (n)-[:MENTIONS_DIAGNOSIS]->(disease)
                    MERGE (n)-[:HAS_DIAGNOSIS]->(disease)
                    MERGE (p)-[:HAS_DIAGNOSIS]->(disease)
                    """,
                    note_id=note_id,
                    patient_id=patient_id,
                    d_name=can_name,
                )

            # 3. Clean and link Medications: (n)-[:DISCUSSES_MEDICATION]->(med), (p)-[:PRESCRIBED]->(med), (med)-[:TREATS]->(disease)
            for m in meds:
                if isinstance(m, dict):
                    raw_m = m.get("name", "")
                    dosage = m.get("dosage")
                    unit = m.get("unit")
                    freq = m.get("frequency")
                    route = m.get("route")
                    rationale = m.get("rationale")
                else:
                    raw_m = str(m)
                    dosage, unit, freq, route, rationale = None, None, None, None, None

                clean_m = _clean_med_name(raw_m)
                if not clean_m:
                    continue

                s.run(
                    """
                    MATCH (n:ConsultationNote {id: $note_id})
                    MATCH (p:Patient {id: $patient_id})
                    MERGE (med:Medication {name: $m_name})
                    MERGE (n)-[dm:DISCUSSES_MEDICATION]->(med)
                    SET dm.dosage = $dosage, dm.unit = $unit, dm.frequency = $freq, dm.route = $route, dm.rationale = $rationale
                    MERGE (p)-[pr:PRESCRIBED]->(med)
                    SET pr.dosage = coalesce($dosage, pr.dosage),
                        pr.unit = coalesce($unit, pr.unit),
                        pr.frequency = coalesce($freq, pr.frequency),
                        pr.route = coalesce($route, pr.route),
                        pr.status = 'Active'
                    WITH med
                    UNWIND $diseases AS d_name
                    MATCH (disease:Disease {name: d_name})
                    MERGE (med)-[:TREATS]->(disease)
                    """,
                    note_id=note_id,
                    patient_id=patient_id,
                    m_name=clean_m,
                    dosage=dosage,
                    unit=unit,
                    freq=freq,
                    route=route,
                    rationale=rationale,
                    diseases=canonical_diseases,
                )

        # Clear session store if active
        sess.clear(session_id)

        return jsonify({
            "status": "saved",
            "note_id": note_id,
            "patient_id": patient_id,
            "title": title,
            "connected_diagnoses": canonical_diseases,
        }), 201
    except Exception as e:
        import traceback
        traceback.print_exc()
        sess.set_state(session_id, "save_error")
        return jsonify({"error": f"Database save failed: {e}"}), 500


@scribe_bp.route("/status/<session_id>", methods=["GET"])
def session_status(session_id):
    """Return current pipeline state: idle, transcribing, review, approved,
    extracting, extracted, extract_error, save_error, saved (or None)."""
    failures = sess.failure_count(session_id)
    return jsonify({
        "session_id": session_id,
        "status": sess.get_state(session_id),
        "failure_count": failures,
        "retry_disabled": sess.retry_disabled(session_id),
    })
