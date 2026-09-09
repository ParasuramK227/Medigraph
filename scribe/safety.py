"""Clinical Dosage & Sound-Alike Safety Engine for Medical Scribe.

Detects 10-fold speech-to-text dosage multiplier errors (e.g., 50mg vs 5mg),
unit mismatches (g vs mg, mg vs mcg), and ISMP Look-Alike Sound-Alike (SALAD)
drug confusions before any clinical note is finalized or committed to Neo4j.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple


# Standard adult therapeutic dosage boundaries and approved tablet strengths
# (Doses in milligrams unless specified otherwise)
THERAPEUTIC_BOUNDS: Dict[str, Dict[str, Any]] = {
    "lisinopril": {
        "unit": "mg",
        "min_single": 2.5,
        "standard_initial": 5.0,
        "max_single": 40.0,
        "max_daily": 40.0,
        "approved_doses": [2.5, 5.0, 10.0, 20.0, 30.0, 40.0],
    },
    "metformin": {
        "unit": "mg",
        "min_single": 250.0,
        "standard_initial": 500.0,
        "max_single": 1000.0,
        "max_daily": 2550.0,
        "approved_doses": [500.0, 750.0, 850.0, 1000.0],
    },
    "amlodipine": {
        "unit": "mg",
        "min_single": 2.5,
        "standard_initial": 5.0,
        "max_single": 10.0,
        "max_daily": 10.0,
        "approved_doses": [2.5, 5.0, 10.0],
    },
    "atorvastatin": {
        "unit": "mg",
        "min_single": 10.0,
        "standard_initial": 10.0,
        "max_single": 80.0,
        "max_daily": 80.0,
        "approved_doses": [10.0, 20.0, 40.0, 80.0],
    },
    "losartan": {
        "unit": "mg",
        "min_single": 25.0,
        "standard_initial": 50.0,
        "max_single": 100.0,
        "max_daily": 100.0,
        "approved_doses": [25.0, 50.0, 100.0],
    },
    "levothyroxine": {
        "unit": "mcg",
        "min_single": 12.5,
        "standard_initial": 25.0,
        "max_single": 200.0,
        "max_daily": 300.0,
        "approved_doses": [25.0, 50.0, 75.0, 88.0, 100.0, 112.0, 125.0, 137.0, 150.0, 175.0, 200.0],
    },
    "metoprolol": {
        "unit": "mg",
        "min_single": 12.5,
        "standard_initial": 25.0,
        "max_single": 200.0,
        "max_daily": 400.0,
        "approved_doses": [25.0, 50.0, 100.0, 200.0],
    },
    "omeprazole": {
        "unit": "mg",
        "min_single": 10.0,
        "standard_initial": 20.0,
        "max_single": 40.0,
        "max_daily": 80.0,
        "approved_doses": [10.0, 20.0, 40.0],
    },
    "gabapentin": {
        "unit": "mg",
        "min_single": 100.0,
        "standard_initial": 300.0,
        "max_single": 1200.0,
        "max_daily": 3600.0,
        "approved_doses": [100.0, 300.0, 400.0, 600.0, 800.0],
    },
    "hydrochlorothiazide": {
        "unit": "mg",
        "min_single": 12.5,
        "standard_initial": 12.5,
        "max_single": 50.0,
        "max_daily": 50.0,
        "approved_doses": [12.5, 25.0, 50.0],
    },
    "glipizide": {
        "unit": "mg",
        "min_single": 2.5,
        "standard_initial": 5.0,
        "max_single": 20.0,
        "max_daily": 40.0,
        "approved_doses": [2.5, 5.0, 10.0],
    },
    "pantoprazole": {
        "unit": "mg",
        "min_single": 20.0,
        "standard_initial": 40.0,
        "max_single": 40.0,
        "max_daily": 80.0,
        "approved_doses": [20.0, 40.0],
    },
    "furosemide": {
        "unit": "mg",
        "min_single": 10.0,
        "standard_initial": 20.0,
        "max_single": 80.0,
        "max_daily": 160.0,
        "approved_doses": [20.0, 40.0, 80.0],
    },
    "insulin": {
        "unit": "units",
        "min_single": 2.0,
        "standard_initial": 10.0,
        "max_single": 50.0,
        "max_daily": 100.0,
        "approved_doses": [5.0, 10.0, 15.0, 20.0, 30.0, 40.0],
    },
}

# ISMP Look-Alike / Sound-Alike (SALAD) Drug Confusions
ISMP_SOUND_ALIKES: List[Dict[str, str]] = [
    {
        "pair": ("zyrtec", "zyprexa"),
        "warning": "Zyrtec (cetirizine) is an antihistamine; Zyprexa (olanzapine) is an antipsychotic.",
    },
    {
        "pair": ("celebrex", "celexa"),
        "warning": "Celebrex (celecoxib) is an NSAID; Celexa (citalopram) is an SSRI antidepressant.",
    },
    {
        "pair": ("hydralazine", "hydroxyzine"),
        "warning": "Hydralazine is an antihypertensive; Hydroxyzine is an antihistamine/anxiolytic.",
    },
    {
        "pair": ("clonidine", "clonazepam"),
        "warning": "Clonidine is an antihypertensive; Clonazepam is a benzodiazepine.",
    },
    {
        "pair": ("metformin", "metronidazole"),
        "warning": "Metformin is an antidiabetic; Metronidazole is an antimicrobial antibiotic.",
    },
    {
        "pair": ("pradaxa", "plavix"),
        "warning": "Pradaxa is a direct thrombin inhibitor; Plavix is an antiplatelet.",
    },
    {
        "pair": ("adderall", "inderal"),
        "warning": "Adderall is a stimulant; Inderal (propranolol) is a beta-blocker.",
    },
]


def _normalize_drug_name(name: str) -> str:
    """Normalize drug name for dictionary lookup."""
    clean = re.split(r"\s+(?:hcl|hydrochloride|tartrate|succinate|potassium|sodium)\b", name, flags=re.IGNORECASE)[0]
    clean = re.sub(r"[^\w\s-]", "", clean).strip().lower()
    return clean


def parse_dosage_string(raw: str) -> Dict[str, Any]:
    """Parse free-text medication string into structured dose fields."""
    result = {
        "name": raw.strip(),
        "dosage": None,
        "unit": "mg",
        "frequency": "daily",
        "route": "oral",
    }

    # Match numeric dosage and unit: e.g. "50mg", "5 mg", "100 mcg", "10 units"
    match = re.search(r"(\d+(?:\.\d+)?)\s*(mg|mcg|g|grams|ml|units|u|puffs|tablets)\b", raw, re.IGNORECASE)
    if match:
        result["dosage"] = float(match.group(1))
        unit = match.group(2).lower()
        if unit in ("g", "grams"):
            result["unit"] = "g"
        elif unit in ("u", "units"):
            result["unit"] = "units"
        else:
            result["unit"] = unit

        # Remove dosage from name
        name_part = raw[:match.start()] + raw[match.end():]
        result["name"] = name_part.strip(" ,-")

    # Match frequency
    freq_match = re.search(r"\b(once daily|twice daily|three times daily|daily|bid|tid|qid|prn|as needed|every \d+ hours)\b", raw, re.IGNORECASE)
    if freq_match:
        result["frequency"] = freq_match.group(1).lower()

    return result


def audit_medication(
    med_or_name: Any,
    dosage: Any = None,
    unit: str = "mg",
    frequency: Any = None,
    route: Any = None,
) -> List[Dict[str, Any]]:
    """Perform clinical dosage and sound-alike audit on a medication.

    Supports calling with a dictionary or with keyword arguments.
    Returns a list of standardized safety alert dicts.
    """
    if isinstance(med_or_name, dict):
        med = dict(med_or_name)
    else:
        med = {
            "name": str(med_or_name),
            "dosage": dosage,
            "unit": unit,
            "frequency": frequency,
            "route": route,
        }

    raw_name = str(med.get("name", "")).strip()
    norm_name = _normalize_drug_name(raw_name)
    raw_dose = med.get("dosage")
    unit = str(med.get("unit", "mg")).lower()

    # Parse numeric dose safely
    dosage_val = None
    if raw_dose is not None:
        try:
            dosage_val = float(raw_dose)
        except (ValueError, TypeError):
            dosage_val = None

    if dosage_val is None:
        parsed = parse_dosage_string(raw_name)
        if parsed["dosage"]:
            dosage_val = parsed["dosage"]
            unit = parsed["unit"]
            med["dosage"] = dosage_val
            med["unit"] = unit
            if parsed["name"]:
                med["name"] = parsed["name"].title()
                norm_name = _normalize_drug_name(parsed["name"])

    safety_flags = []

    # 1. Therapeutic Bounds & 10-Fold Error Check
    bounds = THERAPEUTIC_BOUNDS.get(norm_name)
    if bounds and dosage_val is not None:
        expected_unit = bounds["unit"]

        # Unit mismatch check
        if unit != expected_unit:
            if unit == "mg" and expected_unit == "mcg":
                safety_flags.append({
                    "severity": "CRITICAL",
                    "type": "UNIT_1000X_OVERDOSE",
                    "code": "UNIT_1000X_OVERDOSE",
                    "medication": raw_name.title(),
                    "message": f"Critical unit error: {raw_name.title()} is prescribed in micrograms (mcg), not milligrams (mg). 1mg = 1,000mcg!",
                    "quick_fix": {"dosage": str(dosage_val), "unit": "mcg", "reason": "Correct unit to micrograms (mcg)"},
                })
            elif unit == "g" and expected_unit == "mg":
                safety_flags.append({
                    "severity": "CRITICAL",
                    "type": "UNIT_GRAM_OVERDOSE",
                    "code": "UNIT_GRAM_OVERDOSE",
                    "medication": raw_name.title(),
                    "message": f"Dose in grams ({dosage_val}g) is dangerously high. Standard prescription unit is milligrams ({dosage_val * 1000}mg or lower).",
                    "quick_fix": {"dosage": str(bounds["standard_initial"]), "unit": "mg", "reason": "Standard initial dose"},
                })
        else:
            max_single = bounds["max_single"]
            initial_dose = bounds["standard_initial"]

            if dosage_val > max_single:
                ten_fold_candidate = dosage_val / 10.0
                if ten_fold_candidate in bounds["approved_doses"] or ten_fold_candidate <= max_single:
                    correction_val = ten_fold_candidate
                else:
                    correction_val = initial_dose

                clean_corr = f"{correction_val:g}"
                safety_flags.append({
                    "severity": "WARNING",
                    "type": "SUSPECTED_10X_DOSAGE_ERROR",
                    "code": "SUSPECTED_10X_DOSAGE_ERROR",
                    "medication": raw_name.title(),
                    "message": (
                        f"Dosage alert: {dosage_val:g}{unit} exceeds the typical single dose (max {max_single}{unit}). "
                        f"Did you mean {clean_corr}{unit}?"
                    ),
                    "quick_fix": {"dosage": clean_corr, "unit": unit, "reason": "Adjust to standard clinical starting dose"},
                })
            elif dosage_val < bounds["min_single"] and dosage_val > 0:
                safety_flags.append({
                    "severity": "INFO",
                    "type": "SUB_THERAPEUTIC_DOSE",
                    "code": "SUB_THERAPEUTIC_DOSE",
                    "medication": raw_name.title(),
                    "message": f"Low dose note: {dosage_val:g}{unit} is below standard initial therapeutic dose ({initial_dose}{unit}).",
                })

    # 2. General sanity check for arbitrary unlisted drugs
    if not bounds and dosage_val is not None:
        if unit == "g" and dosage_val > 2.0:
            safety_flags.append({
                "severity": "WARNING",
                "type": "HIGH_GRAM_DOSE",
                "code": "HIGH_GRAM_DOSE",
                "medication": raw_name.title(),
                "message": f"Unusually high dose in grams: {dosage_val}g. Please verify unit.",
            })
        elif unit == "units" and dosage_val > 100.0:
            safety_flags.append({
                "severity": "CRITICAL",
                "type": "HIGH_INSULIN_UNITS",
                "code": "HIGH_INSULIN_UNITS",
                "medication": raw_name.title(),
                "message": f"High dose alert: {dosage_val} units. Possible 10x speech multiplier error.",
                "quick_fix": {"dosage": str(dosage_val / 10.0), "unit": "units", "reason": "Correct 10x multiplier"},
            })

    # 3. ISMP Look-Alike / Sound-Alike (SALAD) check
    for salad in ISMP_SOUND_ALIKES:
        p1, p2 = salad["pair"]
        if norm_name == p1 or norm_name == p2:
            alt = p2 if norm_name == p1 else p1
            safety_flags.append({
                "severity": "INFO",
                "type": "ISMP_SOUND_ALIKE_WARNING",
                "code": "ISMP_SOUND_ALIKE_CONFUSION",
                "medication": raw_name.title(),
                "message": f"Sound-Alike Drug Alert ({raw_name.title()} vs {alt.title()}): {salad['warning']}",
            })
            break

    # If called with dictionary, mutate med to include alerts and return flags
    if isinstance(med_or_name, dict):
        med_or_name["safety_alerts"] = safety_flags
        med_or_name["safety_flags"] = safety_flags
        med_or_name["verified"] = len([f for f in safety_flags if f["severity"] in ("WARNING", "CRITICAL")]) == 0

    return safety_flags


def audit_extracted_note(note: Dict[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Audit all medications and diagnoses in an extracted consultation note.

    Returns:
        (audited_note, all_safety_alerts)
    """
    if not isinstance(note, dict):
        return note, []

    audited = dict(note)
    meds = audited.get("medications_discussed", [])
    audited_meds = []
    all_alerts: List[Dict[str, Any]] = []

    for item in meds:
        if isinstance(item, str):
            structured = parse_dosage_string(item)
            alerts = audit_medication(structured)
            audited_meds.append(structured)
            all_alerts.extend(alerts)
        elif isinstance(item, dict):
            structured = dict(item)
            alerts = audit_medication(structured)
            audited_meds.append(structured)
            all_alerts.extend(alerts)
        else:
            audited_meds.append({"name": str(item), "safety_alerts": [], "verified": True})

    audited["medications_discussed"] = audited_meds
    audited["safety_alerts"] = all_alerts
    return audited, all_alerts
