import json
import os
import re

import requests
from dotenv import load_dotenv

from scribe.privacy import redact_phi, rehydrate_phi
from scribe.safety import audit_extracted_note

load_dotenv()

_MODEL = os.environ.get("GROQ_EXTRACTION_MODEL", "openai/gpt-oss-120b")

_SCHEMA_KEYS = ("summary", "diagnoses", "action_items", "medications_discussed")

_PROMPT_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "scribe",
    "prompts",
    "scribe_extraction.md",
)


class ExtractionError(Exception):
    """Raised when extraction fails or the LLM output can't be parsed
    against the documented schema. Never silently pass through malformed data."""


def _load_prompt_and_schema():
    """Load the versioned system prompt + output schema from scribe_extraction.md."""
    with open(_PROMPT_FILE, "r", encoding="utf-8") as f:
        content = f.read()

    prompt_match = re.search(r"```\n(.*?)\n```", content, re.DOTALL)
    schema_match = re.search(r"```json\n(.*?)\n```", content, re.DOTALL)

    if not prompt_match:
        raise ExtractionError("Could not locate the system prompt in scribe_extraction.md")

    system_prompt = prompt_match.group(1).strip()
    schema = None
    if schema_match:
        try:
            schema = json.loads(schema_match.group(1))
        except (json.JSONDecodeError, ValueError):
            schema = None

    return system_prompt, schema


def _build_prompt(transcript):
    system_prompt, schema = _load_prompt_and_schema()

    user_prompt = (
        "Doctor-reviewed consultation transcript:\n\n"
        f"\"\"\"\n{transcript}\n\"\"\"\n\n"
        "Return ONLY valid JSON matching the schema, nothing else."
    )
    if schema is not None:
        user_prompt = (
            f"Expected output JSON schema:\n```json\n{json.dumps(schema, indent=2)}\n```\n\n"
            + user_prompt
        )

    return system_prompt, user_prompt


def _extract_json(text):
    """Robustly pull a JSON object out of the LLM response (may be wrapped in fences)."""
    text = text.strip()
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        parsed = None
    if isinstance(parsed, dict):
        return parsed

    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group(0))
        except (json.JSONDecodeError, ValueError):
            parsed = None
    if isinstance(parsed, dict):
        return parsed

    raise ExtractionError("Could not parse JSON object from LLM response.")


def _validate(data):
    """Validate parsed JSON against the documented schema.

    Returns a dict with schema keys including title. Raises ExtractionError on
    any malformed/missing content rather than passing bad data through.
    """
    if not isinstance(data, dict):
        raise ExtractionError("LLM output was not a JSON object.")

    missing = [k for k in _SCHEMA_KEYS if k not in data]
    if missing:
        raise ExtractionError(f"LLM output missing required key(s): {', '.join(missing)}")

    for key in ("diagnoses", "action_items", "medications_discussed"):
        if not isinstance(data[key], list):
            raise ExtractionError(f"LLM output field '{key}' was not a list.")

    title = data.get("title")
    if not title or not isinstance(title, str) or not title.strip():
        # Fallback title if LLM omitted it
        if data["diagnoses"] and len(data["diagnoses"]) > 0:
            first_d = data["diagnoses"][0]
            d_name = first_d.get("name", str(first_d)) if isinstance(first_d, dict) else str(first_d)
            title = f"{d_name.title()} Consultation"
        else:
            title = "Clinical Consultation Note"

    # Normalize medications discussed to ensure uniform object representation
    normalized_meds = []
    for item in data["medications_discussed"]:
        if isinstance(item, dict):
            normalized_meds.append(item)
        elif isinstance(item, str) and item.strip():
            normalized_meds.append({"name": item.strip()})

    return {
        "title": title.strip(),
        "summary": data["summary"],
        "diagnoses": data["diagnoses"],
        "action_items": data["action_items"],
        "medications_discussed": normalized_meds,
    }


def extract(transcript, patient_name=None, doctor_name=None, deidentify=True):
    """Send an approved transcript to Groq and return a validated structured note.

    Applies local HIPAA Safe Harbor PHI scrubbing before calling Groq, rehydrates
    local tokens, and executes clinical safety bounds validation on dosages.
    """
    api_key = os.environ.get("GROQ_API_KEY_EXTRACTION") or os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise ExtractionError("GROQ_API_KEY_EXTRACTION not configured.")

    token_map = {}
    prompt_transcript = transcript
    if deidentify:
        prompt_transcript, token_map = redact_phi(
            transcript,
            patient_name=patient_name,
            doctor_name=doctor_name,
        )

    system_prompt, user_prompt = _build_prompt(prompt_transcript)

    resp = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": _MODEL,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        },
        timeout=90,
    )

    if resp.status_code != 200:
        raise ExtractionError(f"Groq API returned status {resp.status_code}: {resp.text}")

    content = resp.json()["choices"][0]["message"]["content"]
    parsed_note = _validate(_extract_json(content))

    # Rehydrate local tokens if de-identification was used
    if token_map:
        parsed_note = rehydrate_phi(parsed_note, token_map)

    # Perform clinical dosage & sound-alike audit
    audited_note, safety_alerts = audit_extracted_note(parsed_note)
    audited_note["safety_alerts"] = safety_alerts
    audited_note["deidentified"] = deidentify

    return audited_note
