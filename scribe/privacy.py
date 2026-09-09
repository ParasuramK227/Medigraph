"""Local Privacy & De-Identification Gateway for Clinical Scribe.

Implements local, deterministic HIPAA Safe Harbor de-identification and reversible
token mapping so that zero Protected Health Information (PHI) leaves the server
when communicating with external LLMs.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Tuple


# Regex patterns for common direct identifiers
_PHONE_REGEX = re.compile(r"(?:(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\b\d{3})[-.\s]?\d{3}[-.\s]?\d{4})\b")
_EMAIL_REGEX = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_SSN_REGEX = re.compile(r"\b\d{3}[-.\s]\d{2}[-.\s]\d{4}\b")
_MRN_REGEX = re.compile(r"\b(?:MRN|Medical Record Number|Patient ID)[:#\s]*([A-Za-z0-9-]+)\b", re.IGNORECASE)
_DOB_REGEX = re.compile(r"\b(?:DOB|Date of birth|born on)[:\s]*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b", re.IGNORECASE)
_ZIP_REGEX = re.compile(r"\b\d{5}(?:-\d{4})?\b")
# Street addresses: a house/appt number followed by alpha-only street-name words
# ending in a standalone street-designator suffix. Alpha-only name words (no
# digits or periods) and a whitespace-joined suffix guarantee a match can never
# span a sentence or grab the tail of a larger word ("re**st**"), so clinical
# prose and dosages like "5 mg twice daily" are left untouched.
_STREET_REGEX = re.compile(
    r"\b\d{1,6}\s+(?:[A-Za-z][A-Za-z'\-]*\s+){0,3}[A-Za-z][A-Za-z'\-]*\s+"
    r"(?:Street|St\.|Avenue|Ave\.|Road|Rd\.|Boulevard|Blvd\.|Drive|Lane|Way|Court|Terrace|Place|Circle|Trail|Highway|Parkway)\b",
    re.IGNORECASE,
)
# Birth-year statements in prose ("born in 2006", "born in the year 2006",
# "was born in 2006", "birth year: 2006") not captured by the mm/dd/yyyy DOB form.
_BIRTH_YEAR_REGEX = re.compile(
    r"\b(?:born|was born)\s+in(?:\s+the\s+year)?\s+((?:19|20)\d{2})\b"
    r"|\b(?:birth\s+year|year\s+of\s+birth)\s*[:#]?\s*((?:19|20)\d{2})\b",
    re.IGNORECASE,
)
# Self-introduction phrases ("my name is Ansari", "my name's John", "I'm called
# John"): catches a patient's spoken name even when the EHR-known patient_name was
# not supplied by the caller.
_SELF_NAME_REGEX = re.compile(
    r"\b(?:my name is|my name's|i'?m called)\s+([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+)?)\b",
    re.IGNORECASE,
)
_TITLED_NAME_REGEX = re.compile(r"\b(?:Mr\.|Mrs\.|Ms\.|Miss)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b")
_DOCTOR_NAME_REGEX = re.compile(r"\b(?:Dr\.|Doctor)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b")
# Ages as proxies for direct identifiers: "age 45", "aged 45", "45-year-old",
# "45 years old", "45 y/o", "45yo". Deliberately excludes bare numbers and
# bare "years" so follow-up intervals ("in 2 years") and dosages are untouched.
_AGE_REGEX = re.compile(
    r"\b(?:age|aged)\s+\d{1,3}\b"
    r"|\b\d{1,3}\s*(?:yo|yr|y)\s*(?:/o)?\b"
    r"|\b\d{1,3}\s*[- ]?\s*(?:year|yr|yo)s?\s*[- ]?\s*(?:old|of age)\b",
    re.IGNORECASE,
)


def redact_phi(
    text: str,
    patient_name: str | None = None,
    doctor_name: str | None = None,
    extra_identifiers: list[str] | None = None,
) -> Tuple[str, Dict[str, str]]:
    """Sanitize all Protected Health Information (PHI) from clinical text.

    Replaces real-world identifiers with synthetic pseudonymous tokens and returns
    both the sanitized text and a reversible token mapping table.

    Parameters:
        text: Raw consultation transcript or clinical text.
        patient_name: Known patient name from active session/EHR (if available).
        doctor_name: Known attending clinician name (if available).
        extra_identifiers: Additional strings to explicitly redact.

    Returns:
        (sanitized_text, token_map)
    """
    if not text:
        return "", {}

    token_map: Dict[str, str] = {}
    redacted = text

    # 1. Redact known patient name (full and individual parts > 2 chars)
    if patient_name and patient_name.strip():
        clean_patient = patient_name.strip()
        token = "[PATIENT_SUBJECT]"
        token_map[token] = clean_patient
        redacted = re.sub(re.escape(clean_patient), token, redacted, flags=re.IGNORECASE)
        # Also redact individual names if multi-word (e.g. "Johnathan Smith" -> "Johnathan", "Smith")
        parts = clean_patient.split()
        if len(parts) > 1:
            for p in parts:
                if len(p) > 2 and p.lower() not in {"the", "and", "von", "van", "der"}:
                    redacted = re.sub(rf"\b{re.escape(p)}\b", token, redacted, flags=re.IGNORECASE)

    # 2. Redact known doctor name
    if doctor_name and doctor_name.strip():
        clean_doctor = doctor_name.strip()
        token = "[ATTENDING_PHYSICIAN]"
        token_map[token] = clean_doctor
        redacted = re.sub(re.escape(clean_doctor), token, redacted, flags=re.IGNORECASE)
        parts = clean_doctor.split()
        if len(parts) > 1:
            for p in parts:
                if len(p) > 2 and p.lower() not in {"the", "and", "dr", "doctor"}:
                    redacted = re.sub(rf"\b{re.escape(p)}\b", token, redacted, flags=re.IGNORECASE)

    # 3. Redact any doctor titles spoken dynamically: "Dr. Smith"
    for match in _DOCTOR_NAME_REGEX.finditer(redacted):
        full_match = match.group(0)
        token = "[ATTENDING_PHYSICIAN]"
        if token not in token_map:
            token_map[token] = full_match
        redacted = redacted.replace(full_match, token)

    # 4. Redact titled person names: "Mr. Davis", "Mrs. Gable"
    for match in _TITLED_NAME_REGEX.finditer(redacted):
        full_match = match.group(0)
        token = "[PATIENT_SUBJECT]"
        if token not in token_map:
            token_map[token] = full_match
        redacted = redacted.replace(full_match, token)

    # 5. Redact self-introduced names: "my name is Ansari", "I'm called John"
    # (catches a spoken name even when patient_name was unknown up front)
    for match in _SELF_NAME_REGEX.finditer(redacted):
        full_match = match.group(0)
        token = "[PATIENT_SUBJECT]"
        if token not in token_map:
            token_map[token] = full_match
        redacted = redacted.replace(full_match, token)

    # 6. Redact SSN
    for match in _SSN_REGEX.finditer(redacted):
        val = match.group(0)
        token = "[REDACTED_SSN]"
        token_map[token] = val
        redacted = redacted.replace(val, token)

    # 7. Redact Phone Numbers
    for match in _PHONE_REGEX.finditer(redacted):
        val = match.group(0)
        token = "[REDACTED_PHONE]"
        token_map[token] = val
        redacted = redacted.replace(val, token)

    # 8. Redact Emails
    for match in _EMAIL_REGEX.finditer(redacted):
        val = match.group(0)
        token = "[REDACTED_EMAIL]"
        token_map[token] = val
        redacted = redacted.replace(val, token)

    # 9. Redact MRNs
    for match in _MRN_REGEX.finditer(redacted):
        val = match.group(0)
        token = "[REDACTED_MRN]"
        token_map[token] = val
        redacted = redacted.replace(val, token)

    # 10. Redact DOB
    for match in _DOB_REGEX.finditer(redacted):
        val = match.group(0)
        token = "[REDACTED_DOB]"
        token_map[token] = val
        redacted = redacted.replace(val, token)

    # 11. Redact prose birth years: "born in 2006", "born in the year 2006"
    for match in _BIRTH_YEAR_REGEX.finditer(redacted):
        val = match.group(0)
        token = "[REDACTED_DOB]"
        token_map[token] = val
        redacted = redacted.replace(val, token)

    # 12. Redact Street Addresses
    for match in _STREET_REGEX.finditer(redacted):
        val = match.group(0)
        token = "[REDACTED_ADDRESS]"
        token_map[token] = val
        redacted = redacted.replace(val, token)

    # 13. Redact Ages ("45-year-old", "age 45", "45 y/o")
    for match in _AGE_REGEX.finditer(redacted):
        val = match.group(0)
        token = "[REDACTED_AGE]"
        token_map[token] = val
        redacted = redacted.replace(val, token)

    # 14. Extra custom identifiers
    if extra_identifiers:
        for idx, ident in enumerate(extra_identifiers, start=1):
            if ident and ident.strip():
                clean_ident = ident.strip()
                token = f"[IDENTIFIER_{idx}]"
                token_map[token] = clean_ident
                redacted = re.sub(re.escape(clean_ident), token, redacted, flags=re.IGNORECASE)

    return redacted, token_map


def rehydrate_phi(data: Any, token_map: Dict[str, str]) -> Any:
    """Recursively reverse token mappings to restore true identities in memory.

    Accepts strings, dicts, or lists, restoring any [PATIENT_SUBJECT],
    [ATTENDING_PHYSICIAN], etc., with their original local values.
    """
    if not token_map:
        return data

    if isinstance(data, str):
        result = data
        for token, original in token_map.items():
            result = result.replace(token, original)
        return result

    if isinstance(data, dict):
        return {k: rehydrate_phi(v, token_map) for k, v in data.items()}

    if isinstance(data, list):
        return [rehydrate_phi(item, token_map) for item in data]

    return data


# Readable, non-sensitive labels for the safe-harbor tokens so a scrubbed note
# reads naturally instead of leaking real identifiers or raw token names.
_PLACEHOLDER_LABELS = {
    "[PATIENT_SUBJECT]": "the patient",
    "[ATTENDING_PHYSICIAN]": "the attending physician",
    "[REDACTED_SSN]": "[REDACTED]",
    "[REDACTED_PHONE]": "[REDACTED]",
    "[REDACTED_EMAIL]": "[REDACTED]",
    "[REDACTED_MRN]": "[REDACTED]",
    "[REDACTED_DOB]": "[DATE REDACTED]",
    "[REDACTED_ADDRESS]": "[ADDRESS REDACTED]",
    "[REDACTED_AGE]": "[AGE REDACTED]",
}
_PLACEHOLDER_TOKEN_RE = re.compile(
    r"\[(?:PATIENT_SUBJECT|ATTENDING_PHYSICIAN|REDACTED_[A-Z]+|IDENTIFIER_\d+)\]"
)
_HONORIFIC_BEFORE_PLACEHOLDER_RE = re.compile(
    r"\b(?:Mr\.|Mrs\.|Ms\.|Miss|Dr\.|Doctor)\s+(?=the patient\b|the attending physician\b)",
    re.IGNORECASE,
)


def _placeholderize(text: str) -> str:
    """Replace safe-harbor tokens with readable non-sensitive placeholders."""
    if not text:
        return text

    text = _PLACEHOLDER_TOKEN_RE.sub(
        lambda m: _PLACEHOLDER_LABELS.get(m.group(0), "[REDACTED]"), text
    )

    # Grammar polish: drop an honorific left in front of a rendered placeholder
    # ("Mrs. the patient" -> "the patient", "Dr. the attending physician" -> "the attending physician")
    text = _HONORIFIC_BEFORE_PLACEHOLDER_RE.sub("", text)
    # "Patient the patient" -> "The patient" (LLM often echoes the subject noun)
    text = re.sub(r"\bPatient\s+the patient\b", "The patient", text)
    # "my name is the patient" -> "the patient" (self-introduction collapsed)
    text = re.sub(r"\bmy name (?:is|'s)\s+the patient\b", "the patient", text)
    return text


def clean_note_phi(
    data: Any,
    patient_name: str | None = None,
    doctor_name: str | None = None,
    extra_identifiers: list[str] | None = None,
) -> Any:
    """Mandatory, final PHI scrub for a structured clinical note.

    Recursively runs :func:`redact_phi` over every string field so that any
    direct identifiers (names, DOB, age, phone, SSN, MRN, email, address) the
    LLM produced are caught and replaced with safe-harbor tokens, then renders
    those tokens as readable, non-sensitive placeholders. Real identities are
    never restored, so the returned note contains zero PHI.
    """
    if isinstance(data, str):
        redacted, _ = redact_phi(
            data,
            patient_name=patient_name,
            doctor_name=doctor_name,
            extra_identifiers=extra_identifiers,
        )
        return _placeholderize(redacted)

    if isinstance(data, dict):
        return {
            k: clean_note_phi(
                v,
                patient_name=patient_name,
                doctor_name=doctor_name,
                extra_identifiers=extra_identifiers,
            )
            for k, v in data.items()
        }

    if isinstance(data, list):
        return [
            clean_note_phi(
                item,
                patient_name=patient_name,
                doctor_name=doctor_name,
                extra_identifiers=extra_identifiers,
            )
            for item in data
        ]

    return data
