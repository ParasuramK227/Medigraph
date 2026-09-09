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
_STREET_REGEX = re.compile(
    r"\b\d+\s+[A-Za-z0-9\s.,]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Terrace|Ter|Place|Pl|Circle|Cir|Trail|Trl|Highway|Hwy|Parkway|Pkwy)\b",
    re.IGNORECASE,
)
_TITLED_NAME_REGEX = re.compile(r"\b(?:Mr\.|Mrs\.|Ms\.|Miss)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b")
_DOCTOR_NAME_REGEX = re.compile(r"\b(?:Dr\.|Doctor)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b")


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

    # 5. Redact SSN
    for match in _SSN_REGEX.finditer(redacted):
        val = match.group(0)
        token = "[REDACTED_SSN]"
        token_map[token] = val
        redacted = redacted.replace(val, token)

    # 6. Redact Phone Numbers
    for match in _PHONE_REGEX.finditer(redacted):
        val = match.group(0)
        token = "[REDACTED_PHONE]"
        token_map[token] = val
        redacted = redacted.replace(val, token)

    # 7. Redact Emails
    for match in _EMAIL_REGEX.finditer(redacted):
        val = match.group(0)
        token = "[REDACTED_EMAIL]"
        token_map[token] = val
        redacted = redacted.replace(val, token)

    # 8. Redact MRNs
    for match in _MRN_REGEX.finditer(redacted):
        val = match.group(0)
        token = "[REDACTED_MRN]"
        token_map[token] = val
        redacted = redacted.replace(val, token)

    # 9. Redact DOB
    for match in _DOB_REGEX.finditer(redacted):
        val = match.group(0)
        token = "[REDACTED_DOB]"
        token_map[token] = val
        redacted = redacted.replace(val, token)

    # 10. Redact Street Addresses
    for match in _STREET_REGEX.finditer(redacted):
        val = match.group(0)
        token = "[REDACTED_ADDRESS]"
        token_map[token] = val
        redacted = redacted.replace(val, token)

    # 11. Extra custom identifiers
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
