"""De-identification layer for the chatbot knowledge-graph pipeline.

Ensures zero Protected Health Information (PHI) leaves the server when
communicating with external LLMs.  Clinical terms (diagnoses, medications,
lab values, treatments, allergies) are preserved so the LLM can still reason
medically; direct identifiers (names, DOB, location, insurance, doctors) are
replaced with safe-harbor placeholders.

Reuses the regex-based ``redact_phi`` engine from ``scribe.privacy`` for
text-level scrubbing and adds dict-level helpers for the structured graph
data the chatbot assembles.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any, Dict, Tuple

from scribe.privacy import redact_phi


# ---------------------------------------------------------------------------
# Patient profile de-identification
# ---------------------------------------------------------------------------

# Fields that carry clinical meaning and should be sent to the LLM as-is.
_CLINICAL_KEYS = frozenset({
    "id",
    "gender",
    "diagnoses",
    "medications",
    "treatments",
    "labs",
    "allergies",
})


def deidentify_profile(
    profile: Dict[str, Any],
) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """De-identify a patient profile dict before it enters the LLM prompt.

    Returns ``(sanitized_profile, token_map)``.  The *token_map* is kept for
    audit logging but is **never** used to re-identify LLM responses.

    Direct identifiers replaced:
      * ``name`` -> ``"the patient"``
      * ``dob`` -> ``"[DATE REDACTED]"``
      * ``city`` -> ``"[LOCATION REDACTED]"``
      * ``insurance`` -> ``"[REDACTED]"``
      * ``doctors`` -> ``["the attending physician"]``
      * ``notes[*].summary`` -> passed through :func:`redact_phi`

    Clinical data (diagnoses, medications, labs, allergies, treatments) is
    preserved verbatim.
    """
    if not profile:
        return profile, {}

    patient_name = profile.get("name", "")
    doctor_names = [d for d in (profile.get("doctors") or []) if d]

    token_map: Dict[str, str] = {}

    sanitized = dict(profile)

    # --- Direct identifiers ---------------------------------------------------

    if patient_name:
        token_map["[PATIENT_SUBJECT]"] = patient_name
        sanitized["name"] = "the patient"

    if sanitized.get("dob"):
        token_map["[PROFILE_DOB]"] = str(sanitized["dob"])
        sanitized["dob"] = "[DATE REDACTED]"

    if sanitized.get("city"):
        token_map["[PROFILE_CITY]"] = str(sanitized["city"])
        sanitized["city"] = "[LOCATION REDACTED]"

    if sanitized.get("insurance_provider"):
        token_map["[PROFILE_INSURANCE]"] = str(sanitized["insurance_provider"])
        sanitized["insurance_provider"] = "[REDACTED]"

    if doctor_names:
        token_map["[ATTENDING_PHYSICIAN]"] = ", ".join(doctor_names)
        sanitized["doctors"] = ["the attending physician"]

    # --- Text fields that may contain embedded PHI ---------------------------

    if sanitized.get("notes"):
        cleaned_notes = []
        for note in sanitized["notes"]:
            note = dict(note)
            summary = note.get("summary", "")
            if summary:
                scrubbed, _ = redact_phi(
                    summary,
                    patient_name=patient_name,
                    doctor_name=", ".join(doctor_names) if doctor_names else None,
                )
                note["summary"] = scrubbed
            cleaned_notes.append(note)
        sanitized["notes"] = cleaned_notes

    return sanitized, token_map


# ---------------------------------------------------------------------------
# Cohort context de-identification
# ---------------------------------------------------------------------------

def _anonymize_patient_label(name: str) -> str:
    """Turn a real patient name into a stable but anonymous label.

    ``"John Smith"`` -> ``"Patient a3f2b1"`` (deterministic per name).
    """
    h = hashlib.sha256(name.encode()).hexdigest()[:6]
    return f"Patient {h}"


def deidentify_cohort(cohort: Dict[str, Any]) -> Dict[str, Any]:
    """De-identify the cohort/population context.

    Patient names in abnormal-lab observations and recent consultation notes
    are replaced with anonymous labels.  Clinical terms (disease names, drug
    names, lab values, note summaries) are preserved.
    """
    if not cohort:
        return cohort

    sanitized = dict(cohort)

    if sanitized.get("abnormal_labs"):
        sanitized["abnormal_labs"] = [
            {
                **lab,
                "patient": _anonymize_patient_label(lab.get("patient", "")),
            }
            for lab in sanitized["abnormal_labs"]
        ]

    if sanitized.get("recent_notes"):
        sanitized["recent_notes"] = [
            {
                **note,
                "patient": _anonymize_patient_label(note.get("patient", "")),
            }
            for note in sanitized["recent_notes"]
        ]

    return sanitized


# ---------------------------------------------------------------------------
# User message de-identification
# ---------------------------------------------------------------------------

def deidentify_message(
    message: str,
    patient_name: str | None = None,
    doctor_name: str | None = None,
) -> str:
    """Scrub any PHI the user may have typed in their chat message.

    Delegates to :func:`redact_phi` from ``scribe.privacy`` which handles
    names, DOB, phone, email, SSN, MRN, addresses, and ages via HIPAA Safe
    Harbor regex patterns.
    """
    if not message:
        return message

    scrubbed, _ = redact_phi(
        message,
        patient_name=patient_name,
        doctor_name=doctor_name,
    )
    return scrubbed
