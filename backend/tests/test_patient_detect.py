"""Regression tests for patient name -> PID detection (_detect_patient_id).

Runs against the live Neo4j database, seeding temporary patients whose ids
start with ``rbac-patient-det-`` so the autouse ``clean_rbac_data`` fixture
removes them before and after every test. All fixture names are verified
absent from the demo dataset so assertions are unambiguous.
"""

import uuid

from backend.neo4j_connection import get_session
from backend.routes.chat import _damerau_levenshtein, _detect_patient_id


def _seed(first, last):
    pid = f"rbac-patient-det-{uuid.uuid4()}"
    with get_session() as s:
        s.run(
            "CREATE (p:Patient {id: $id, first_name: $first, last_name: $last})",
            id=pid, first=first, last=last,
        )
    return pid


def test_confusable_names_choose_intended_patient():
    intended = _seed("Zephyr", "Larkspur")
    decoy = _seed("Zephyrine", "Nightingale")
    with get_session() as s:
        assert _detect_patient_id(s, "Tell me about Zephyr Larkspur") == intended
        assert _detect_patient_id(s, "patient Zephyr Larkspur's diabetes") == intended
    assert decoy != intended


def test_substring_shared_with_decoy_resolves_to_exact_name():
    intended = _seed("Anders", "Calyx")
    decoy = _seed("Anderson", "Aurora")
    with get_session() as s:
        assert _detect_patient_id(s, "What about Anders Calyx") == intended
    assert decoy != intended


def test_typo_resolved_via_fuzzy_fallback():
    intended = _seed("Quill", "Fable")
    with get_session() as s:
        assert _detect_patient_id(s, "Qull treatment history") == intended


def test_uuid_in_message_returns_exact_id():
    pid = str(uuid.uuid4())
    with get_session() as s:
        assert _detect_patient_id(s, f"show records for {pid}") == pid


def test_cohort_message_without_patient_returns_none():
    with get_session() as s:
        assert _detect_patient_id(s, "Show diabetes treatment trends") is None


def test_damerau_levenshtein_reorders_pair():
    assert _damerau_levenshtein("marz", "mraz") == 1
    assert _damerau_levenshtein("west", "wst") == 1
    assert _damerau_levenshtein("west", "west") == 0
    assert _damerau_levenshtein("", "abc") == 3