"""Neo4j data-fetching helpers for the patient/treatment intelligence features.

These functions return plain python dicts that the pure analysis module
(analysis/treatment_intel.py) consumes. No scoring happens here — only data
retrieval and light reshaping.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Dict, List, Optional


def _rows(session, query: str, **params) -> List[Dict[str, Any]]:
    return [dict(r) for r in session.run(query, **params)]


def fetch_all_patients_with_diags(session) -> List[Dict[str, Any]]:
    """Fetch every patient with their id/name/gender + list of diagnosis names + prescribed medications."""
    rows = _rows(
        session,
        """
        MATCH (p:Patient)
        OPTIONAL MATCH (p)-[:HAS_DIAGNOSIS]->(d:Disease)
        OPTIONAL MATCH (p)-[:HAD_ENCOUNTER]->(:Encounter)-[:PRESCRIBED]->(m:Medication)
        RETURN p.id AS id, p.first_name AS first_name, p.last_name AS last_name,
               p.gender AS gender, collect(DISTINCT d.name) AS diagnoses,
               collect(DISTINCT m.name) AS medications
        """,
    )
    out = []
    for r in rows:
        out.append({
            "id": r.get("id"),
            "first_name": r.get("first_name"),
            "last_name": r.get("last_name"),
            "gender": r.get("gender"),
            "diagnoses": [d for d in (r.get("diagnoses") or []) if d is not None],
            "medications": [m for m in (r.get("medications") or []) if m is not None],
        })
    return out


def fetch_patient_intelligence(session, patient_id: str) -> Optional[Dict[str, Any]]:
    """Return enriched data for a single patient:
    baseline info, diagnoses, prescribed medications, treatments, lab tests, consultation notes,
    and medication coverage for their diagnoses.

    Returns None if the patient does not exist.
    """
    rows = _rows(
        session,
        """
        MATCH (p:Patient {id: $id})
        OPTIONAL MATCH (p)-[:HAS_DIAGNOSIS]->(d:Disease)
        OPTIONAL MATCH (p)-[:RECEIVED_TREATMENT]->(t:Treatment)
        OPTIONAL MATCH (p)-[:HAS_LAB_TEST]->(l:LabTest)
        OPTIONAL MATCH (p)-[:HAS_CONSULTATION_NOTE]->(n:ConsultationNote)
        OPTIONAL MATCH (p)-[:HAS_ALLERGY]->(a:Allergy)
        OPTIONAL MATCH (p)-[:HAD_ENCOUNTER]->(:Encounter)-[:PRESCRIBED]->(m:Medication)
        RETURN p.id AS id, p.first_name AS first_name, p.last_name AS last_name,
               p.gender AS gender, p.date_of_birth AS date_of_birth,
               p.email AS email, p.contact_number AS contact_number,
               p.address AS address, p.insurance_provider AS insurance_provider,
               collect(DISTINCT d.name) AS diagnoses,
               collect(DISTINCT m.name) AS medications,
               collect(DISTINCT {id: t.id, type: t.treatment_type,
                                 cost: t.cost, date: t.treatment_date,
                                 description: t.description,
                                 outcome: t.outcome}) AS treatments,
               collect(DISTINCT {id: l.id, name: l.name, result: l.result,
                                 status: l.status, unit: l.unit, date: l.date}) AS labs,
               collect(DISTINCT {id: n.id, title: n.title, summary: n.summary,
                                 created_at: n.created_at,
                                 diagnoses: n.diagnoses,
                                 medications: n.medications_discussed,
                                 action_items: n.action_items}) AS notes,
               collect(DISTINCT {id: a.id, substance: a.substance,
                                 type: a.type, severity: a.severity}) AS allergies
        """,
        id=patient_id,
    )
    if not rows:
        return None
    r = rows[0]
    return {
        "id": r.get("id"),
        "first_name": r.get("first_name"),
        "last_name": r.get("last_name"),
        "gender": r.get("gender"),
        "date_of_birth": r.get("date_of_birth"),
        "email": r.get("email"),
        "contact_number": r.get("contact_number"),
        "address": r.get("address"),
        "insurance_provider": r.get("insurance_provider"),
        "diagnoses": [d for d in (r.get("diagnoses") or []) if d],
        "medications": [m for m in (r.get("medications") or []) if m],
        "treatments": [t for t in (r.get("treatments") or []) if t.get("id")],
        "labs": [l for l in (r.get("labs") or []) if l.get("id")],
        "notes": [n for n in (r.get("notes") or []) if n.get("id")],
        "allergies": [a for a in (r.get("allergies") or []) if a.get("id") or a.get("substance")],
    }


def fetch_labs_by_patient(session, patient_ids: List[str]) -> Dict[str, List[Dict[str, Any]]]:
    """Fetch lab tests for a set of patients, keyed by patient id."""
    if not patient_ids:
        return {}
    rows = _rows(
        session,
        """
        MATCH (p:Patient)-[:HAS_LAB_TEST]->(l:LabTest)
        WHERE p.id IN $ids
        RETURN p.id AS pid, l.id AS id, l.name AS name, l.result AS result,
               l.status AS status, l.unit AS unit, l.date AS date
        """,
        ids=list(patient_ids),
    )
    labs_by_patient: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        pid = r.get("pid")
        if pid:
            labs_by_patient[pid].append({
                "id": r.get("id"),
                "name": r.get("name"),
                "result": r.get("result"),
                "status": r.get("status"),
                "unit": r.get("unit"),
                "date": r.get("date"),
            })
    return dict(labs_by_patient)


def fetch_diseases(session, names: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """Fetch Disease nodes (optionally filtered to a set of names)."""
    query = "MATCH (d:Disease) RETURN d.name AS name"
    params: Dict[str, Any] = {}
    if names:
        query = (
            "MATCH (d:Disease) WHERE d.name IN $names "
            "RETURN d.name AS name"
        )
        params["names"] = list(names)
    rows = _rows(session, query, **params)
    return [{"name": r.get("name")} for r in rows if r.get("name")]


def fetch_medications_for_diseases(
    session, names: List[str]
) -> Dict[str, List[str]]:
    """Map disease name -> list of medication names that TREAT it."""
    if not names:
        return {}
    rows = _rows(
        session,
        """
        MATCH (m:Medication)-[:TREATS]->(d:Disease)
        WHERE d.name IN $names
        RETURN d.name AS disease, COLLECT(DISTINCT m.name) AS meds
        """,
        names=list(names),
    )
    return {r["disease"]: (r.get("meds") or []) for r in rows}


def fetch_treatments_for_diseases(
    session, names: List[str]
) -> Dict[str, List[Dict[str, Any]]]:
    """Map disease name -> list of Treatment nodes that TREAT it.

    Uses the (Treatment)-[:TREATS]->(Disease) relationship. Treatment may carry
    an 'outcome' property ('resolved'/'cured'/'improved'/...) and an optional
    'success' rate (0..1). Returns an empty map when no edges exist yet, so
    callers can degrade gracefully without outcome data.
    """
    if not names:
        return {}
    rows = _rows(
        session,
        """
        MATCH (t:Treatment)-[:TREATS]->(d:Disease)
        WHERE d.name IN $names
        RETURN d.name AS disease,
               collect(DISTINCT {id: t.id, name: t.treatment_type,
                                 treatment_type: t.treatment_type,
                                 cost: t.cost, description: t.description,
                                 outcome: t.outcome, success: t.success}) AS treatments
        """,
        names=list(names),
    )
    out: Dict[str, List[Dict[str, Any]]] = {}
    for r in rows:
        disease = r.get("disease")
        if not disease:
            continue
        treats = [t for t in (r.get("treatments") or []) if t.get("id") or t.get("name")]
        out[disease] = treats
    return out


def fetch_patient_treatments(session, patient_ids: List[str]) -> Dict[str, List[Dict[str, Any]]]:
    """Fetch RECEIVED_TREATMENT records for a set of patients, keyed by id.

    Each treatment record carries the treatment's name/type, cost and any
    'outcome'/'success' fields, so recovery can be attributed to a treatment.
    """
    if not patient_ids:
        return {}
    rows = _rows(
        session,
        """
        MATCH (p:Patient)-[:RECEIVED_TREATMENT]->(t:Treatment)
        WHERE p.id IN $ids
        RETURN p.id AS pid, t.id AS id, t.treatment_type AS name,
               t.treatment_type AS treatment_type, t.cost AS cost,
               t.description AS description, t.outcome AS outcome,
               t.success AS success
        """,
        ids=list(patient_ids),
    )
    treats_by_patient: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        pid = r.get("pid")
        if not pid:
            continue
        treats_by_patient[pid].append({
            "id": r.get("id"),
            "name": r.get("name"),
            "treatment_type": r.get("treatment_type"),
            "cost": r.get("cost"),
            "description": r.get("description"),
            "outcome": r.get("outcome"),
            "success": r.get("success"),
        })
    return dict(treats_by_patient)


def get_patient_intelligence(session, patient_id: str) -> Optional[Dict[str, Any]]:
    """Enriched summary for the patient detail page.

    Returns None if the patient does not exist. Result contains:
      - patient baseline info
      - medical_history (diagnoses, treatments, labs, notes)
      - similar_patients (computed on real shared diagnoses)
      - medications (diagnosis -> treating med list)
      - summary (auto-built from notes + diagnoses, no LLM)
    """
    target = fetch_patient_intelligence(session, patient_id)
    if target is None:
        return None

    # Real similarity from all patients' shared diagnoses
    all_patients = fetch_all_patients_with_diags(session)
    from . import treatment_intel
    similar = treatment_intel.compute_similar_patients(target, all_patients)

    # Attach labs to similar patients for cohort scoring
    sim_ids = [s["id"] for s in similar if s.get("id")]
    labs_by_sim = fetch_labs_by_patient(session, sim_ids)
    for s in similar:
        s["labs"] = labs_by_sim.get(s.get("id"), [])

    medical_history = {
        "diagnoses": target.get("diagnoses") or [],
        "treatments": target.get("treatments") or [],
        "labs": target.get("labs") or [],
        "notes": target.get("notes") or [],
        "allergies": target.get("allergies") or [],
    }

    # Medication coverage for this patient's diagnoses
    medications = fetch_medications_for_diseases(session, target.get("diagnoses") or [])

    # Deterministic summary from the patient's own notes + diagnoses
    summary = _build_summary(target)

    similar_out = [
        {
            "id": s.get("id"),
            "patient_id": s.get("id"),
            "name": ((s.get("first_name") or "") + " " + (s.get("last_name") or "")).strip(),
            "gender": s.get("gender"),
            "similarity": s.get("similarity"),
            "overlap": s.get("overlap"),
            "shared_diagnoses": s.get("shared_diagnoses") or [],
        }
        for s in similar
    ]

    return {
        "patient": {
            "id": target["id"],
            "first_name": target["first_name"],
            "last_name": target["last_name"],
            "gender": target.get("gender"),
            "date_of_birth": target.get("date_of_birth"),
            "email": target.get("email"),
            "contact_number": target.get("contact_number"),
            "address": target.get("address"),
            "insurance_provider": target.get("insurance_provider"),
        },
        "summary": summary,
        "medical_history": medical_history,
        "similar_patients": similar_out,
        "medications": medications,
    }


def get_treatment_intel(session, patient_id: str, method: str = "vector") -> Optional[Dict[str, Any]]:
    """Per-patient ranked diagnoses (1 = highest success likelihood).

    Pure-python scoring: success = lab-normalized outcome among similar
    patients sharing each diagnosis. Returns None if the patient is missing.
    
    method: 'vector' (Multimodal Phenotype Vector Space) or 'cypher' (Legacy Jaccard graph join)
    """
    target = fetch_patient_intelligence(session, patient_id)
    if target is None:
        return None
    all_patients = fetch_all_patients_with_diags(session)
    from . import treatment_intel

    if method in ("cypher", "jaccard"):
        similar = treatment_intel.compute_similar_patients(target, all_patients)
        calc_meta = {
            "methodology": "Legacy Cypher Graph Overlap (Discrete Jaccard)",
            "formula": "Jaccard = |Diags_A ∩ Diags_B| / |Diags_A ∪ Diags_B|",
            "weight_condition": 1.0,
            "weight_drug": 0.0,
            "condition_vocab_size": len(set(target.get("diagnoses") or [])),
            "drug_vocab_size": 0,
            "target_conditions_count": len(target.get("diagnoses") or []),
            "target_drugs_count": len(target.get("medications") or []),
        }
    else:
        similar, calc_meta = treatment_intel.compute_multimodal_patient_similarity(target, all_patients)

    sim_ids = [s["id"] for s in similar if s.get("id")]
    labs_by_sim = fetch_labs_by_patient(session, sim_ids)
    for s in similar:
        s["labs"] = labs_by_sim.get(s.get("id"), [])

    ranked = treatment_intel.rank_diagnoses(target, similar)

    # --- Ranked treatments (recommended therapy) with success + recovery ---
    targets_diags = target.get("diagnoses") or []
    treatments_by_disease = fetch_treatments_for_diseases(session, targets_diags)
    meds_by_disease = fetch_medications_for_diseases(session, targets_diags)
    for d, meds in meds_by_disease.items():
        if d not in treatments_by_disease:
            treatments_by_disease[d] = []
        for m in meds:
            treatments_by_disease[d].append({
                "id": f"MED-{m}",
                "name": m,
                "treatment_type": "Pharmacotherapy",
                "category": "Medication",
                "description": f"Indicated pharmacotherapy for {d}",
                "outcome": "improved",
                "success": 0.88,
                "cost": "35.00",
            })

    # Attribute recovery to a treatment for similar patients
    recovered_patients_by_treatment: Dict[str, List[Dict[str, Any]]] = {}
    if treatments_by_disease and similar:
        sim_treatments = fetch_patient_treatments(session, sim_ids)
        for s in similar:
            pid = s.get("id")
            for rec in sim_treatments.get(pid, []):
                if treatment_intel._treatment_success(rec) != 1.0:
                    continue
                # match by treatment name/id across this patient's diagnoses
                name = rec.get("name")
                tid = rec.get("id")
                matched = any(
                    name and t.get("name") == name or (tid and t.get("id") == tid)
                    for treats in treatments_by_disease.values()
                    for t in treats
                )
                if not matched:
                    continue
                entry = {"id": pid, "name": ((s.get("first_name") or "") + " " + (s.get("last_name") or "")).strip()}
                bucket = recovered_patients_by_treatment.setdefault(name or "", [])
                if entry not in bucket:
                    bucket.append(entry)

    treatments = treatment_intel.rank_treatments(
        target, treatments_by_disease, recovered_patients_by_treatment, top=5
    )

    return {
        "patient": {
            "id": target["id"],
            "first_name": target["first_name"],
            "last_name": target["last_name"],
            "gender": target.get("gender"),
            "medications": target.get("medications", []),
        },
        "method": method,
        "calculation_meta": calc_meta,
        "diagnoses": targets_diags,
        "ranked": ranked,
        "treatments": treatments,
        "recovered_patients_by_treatment": recovered_patients_by_treatment,
        "similar_patients": [
            {
                "id": s.get("id"),
                "name": (s.get("name") or (s.get("first_name") or "") + " " + (s.get("last_name") or "")).strip(),
                "similarity": s.get("similarity", 0.0),
                "condition_similarity": s.get("condition_similarity", s.get("similarity", 0.0)),
                "drug_similarity": s.get("drug_similarity", 0.0),
                "overlap": s.get("overlap", 0),
                "drug_overlap": s.get("drug_overlap", 0),
                "shared_diagnoses": s.get("shared_diagnoses", []),
                "shared_medications": s.get("shared_medications", []),
                "target_diag_count": s.get("target_diag_count", 0),
                "candidate_diag_count": s.get("candidate_diag_count", 0),
                "shared_diag_count": s.get("shared_diag_count", s.get("overlap", 0)),
                "target_drug_count": s.get("target_drug_count", 0),
                "candidate_drug_count": s.get("candidate_drug_count", 0),
                "shared_drug_count": s.get("shared_drug_count", s.get("drug_overlap", 0)),
                "diagnoses": s.get("diagnoses", []),
                "medications": s.get("medications", []),
                "rationale": s.get("rationale", ""),
            }
            for s in similar
        ],
    }


def _build_summary(target: Dict[str, Any]) -> str:
    """Build a structured clinical summary deterministically (no LLM)."""
    name = ((target.get("first_name") or "") + " " + (target.get("last_name") or "")).strip() or (target.get("id") or "Patient")
    gender = target.get("gender") or "unknown"
    dob = target.get("date_of_birth") or "unknown"
    diags = target.get("diagnoses") or []
    notes = target.get("notes") or []

    lines = [f"{name} ({gender}, DOB {dob})"]
    if diags:
        lines.append(f"Diagnoses: {', '.join(sorted(diags)[:5])}")
    else:
        lines.append("No active diagnoses recorded.")

    allergies = target.get("allergies") or []
    if allergies:
        substances = [a.get("substance") for a in allergies if a.get("substance")]
        if substances:
            lines.append(f"Allergies: {', '.join(substances[:3])}")

    treatments = target.get("treatments") or []
    if treatments:
        t_types = list(dict.fromkeys([t.get("treatment_type") or t.get("name") for t in treatments if t.get("treatment_type") or t.get("name")]))
        lines.append(f"Treatments: {', '.join(t_types[:3])}")

    labs = target.get("labs") or []
    if labs:
        abnormal = [l.get("name") for l in labs if str(l.get("status", "")).lower() == "abnormal"]
        if abnormal:
            lines.append(f"Abnormal Labs: {', '.join(list(dict.fromkeys(abnormal))[:3])}")

    if notes:
        latest = sorted(notes, key=lambda n: n.get("created_at") or "", reverse=True)[0]
        lines.append(f"Latest Note: {latest.get('summary') or 'Consultation recorded.'}")

    return " • ".join(lines)
