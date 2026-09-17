# MediGraph — AI Clinical Scribe & Safety Pipeline

A privacy-first, on-device clinical speech-to-text pipeline that transcribes consultations, enforces local HIPAA Safe Harbor de-identification, audits medications against lethal 10x dosage errors, and extracts structured clinical records directly into Neo4j AuraDB.

[![On-Device Moonshine](https://img.shields.io/badge/Edge%20STT-Moonshine%20WASM-7952b3.svg)](https://github.com/moonshine-ai/moonshine)
[![HIPAA De-ID](https://img.shields.io/badge/Privacy-HIPAA%20Safe%20Harbor-10b981.svg)](#1-local-hipaa-safe-harbor-de-identification)
[![Medication Safety](https://img.shields.io/badge/Safety-ISMP%20SALAD%20%2B%2010x%20Dosage-ef4444.svg)](#2-clinical-medication-safety--10x-dosage-audit-engine)
[![Groq LLM](https://img.shields.io/badge/Extraction-Groq%20gpt--oss--120b-f55036.svg)](https://groq.com/)
[![Neo4j](https://img.shields.io/badge/Graph-Neo4j%20AuraDB-008cc1.svg)](https://neo4j.com/)

---

## 🔄 End-to-End Pipeline Workflow

```
[ Microphone Audio Input ]
            │
            ▼
[ On-Device Edge STT (Moonshine WASM 245M / Browser Whisper) ]
  • 100% In-Browser WebAssembly
  • Zero audio bytes leave the physician's computer
            │
            ▼
[ Doctor Verification & Editing ]
  • Human-in-the-Loop review is MANDATORY
  • Eliminates compounding speech-recognition hallucinations
  • Real-time multilingual translation into clinical English
            │
            ▼
[ Local HIPAA Safe Harbor PHI De-Identification ] (scribe/privacy.py)
  • Deterministic regex & entity scrubbing
  • Strips names, MRN, DOB, phone, email, address -> [PATIENT_SUBJECT]
  • Zero PHI leaves the server
            │
            ▼
[ Structured SOAP Extraction ] (Groq openai/gpt-oss-120b)
  • Extracts: Summary, Diagnoses, Action Items, Medications Discussed
            │
            ▼
[ Clinical Medication Safety & 10x Dosage Audit ] (scribe/safety.py)
  • Catches 10x multiplier errors (e.g. 50mg vs 5mg)
  • Checks therapeutic boundaries & approved tablet strengths
  • Flags ISMP Look-Alike Sound-Alike (SALAD) drug substitutions
            │
            ▼
[ Neo4j Knowledge Graph Persistence ] (backend/routes/scribe.py)
  • Creates (:ConsultationNote) attached to (:Patient)
  • Canonicalizes and links (:Disease) and (:Medication) nodes
  • Refreshes patient sub-graph and enables Chatbot RAG
```

---

## 🛡️ 1. Local HIPAA Safe Harbor De-Identification

Located in `scribe/privacy.py`, this module guarantees that **zero Protected Health Information (PHI) is ever transmitted to external LLM APIs**.

### Scrubbed Direct Identifiers
* **Known EHR Identifiers**: Exact and word-boundary matching on known patient and physician names.
* **Self-Introductions**: Matches spoken conversational phrases (`"my name is..."`, `"I'm called..."`).
* **Medical Record Numbers (MRN)**: Catches alphanumeric identifiers associated with patient IDs.
* **Contact Details**: Phone numbers (`_PHONE_REGEX`), email addresses (`_EMAIL_REGEX`).
* **Dates & Ages**: Full dates of birth (`_DOB_REGEX`), birth year phrases (`_BIRTH_YEAR_REGEX`), and patient ages (`_AGE_REGEX`).
* **Geographic Data**: Street addresses (`_STREET_REGEX`) and 5/9-digit ZIP codes (`_ZIP_REGEX`).

### Reversible Pseudonymous Token Map
```text
Raw:        "Patient Robert Vance, DOB 11/04/1962, seen by Dr. Emily Watson at 450 Elm Street..."
Sanitized:  "[PATIENT_SUBJECT], DOB [DATE REDACTED], seen by [ATTENDING_PHYSICIAN] at [LOCATION REDACTED]..."
```
Token mappings are stored temporarily in session memory for local display and auditing but are **strictly excluded** from LLM prompts.

---

## 💊 2. Clinical Medication Safety & 10x Dosage Audit Engine

Located in `scribe/safety.py`, this engine prevents fatal prescription errors resulting from acoustic misinterpretations:

### 10-Fold Dosage Multiplier Detection
Speech recognition frequently confuses single-digit and double-digit numbers (e.g., hearing *"fifty"* instead of *"fifteen"*, or adding an extra zero). The engine maintains adult therapeutic boundaries for common chronic medications:

| Medication | Standard Initial Dose | Approved Tablet Strengths | Flagged Dangerous 10x Errors |
| :--- | :---: | :--- | :--- |
| **Lisinopril** | 5.0 mg | 2.5, 5, 10, 20, 30, 40 mg | $\ge 50	ext{ mg}$ (Severe hypotension / renal failure risk) |
| **Amlodipine** | 5.0 mg | 2.5, 5, 10 mg | $\ge 25	ext{ mg}$ (Severe peripheral edema / hypotension) |
| **Metformin** | 500.0 mg | 500, 750, 850, 1000 mg | $\ge 3000	ext{ mg}$ (Lactic acidosis risk) |
| **Atorvastatin** | 10.0 mg | 10, 20, 40, 80 mg | $\ge 100	ext{ mg}$ (Rhabdomyolysis / hepatotoxicity risk) |
| **Levothyroxine** | 25.0 mcg | 25, 50, 75, 88, 100... mcg | Confusing `mg` with `mcg` (1000x overdose!) |

### ISMP Look-Alike Sound-Alike (SALAD) Drug Confusions
Detects phonetically overlapping drug pairs identified by the Institute for Safe Medication Practices:
* **Hydralazine** (vasodilator) vs. **Hydroxyzine** (first-generation antihistamine)
* **Clonidine** (antihypertensive) vs. **Klonopin / Clonazepam** (benzodiazepine)
* **Celebrex** (NSAID) vs. **Celexa** (citalopram antidepressant)
* **Metformin** (antidiabetic) vs. **Metronidazole** (antibacterial/antiprotozoal)

---

## 📋 3. Structured SOAP Note Extraction

Governed by `scribe/prompts/scribe_extraction.md` and executed via Groq Cloud (`openai/gpt-oss-120b`):
* **`title`**: Concise clinical encounter title (e.g., *"Hypertension & Glycemic Management Follow-Up"*).
* **`summary`**: Comprehensive narrative summary preserving medical chronology.
* **`diagnoses`**: Explicit medical conditions discussed, canonicalized to standard medical nomenclature.
* **`action_items`**: Clinical follow-ups, diagnostic orders, and lifestyle recommendations.
* **`medications_discussed`**: Specific pharmacotherapies, dosages, frequencies, and clinical rationales.

---

## 🌐 4. Neo4j Knowledge Graph Persistence

When a physician confirms a consultation note (`POST /api/scribe/save/<session_id>`):
1. **Creates `:ConsultationNote` node** with timestamps and clinical properties.
2. **Establishes Edges**:
   * `(:Patient)-[:HAS_CONSULTATION_NOTE]->(:ConsultationNote)`
   * `(:Doctor)-[:CONDUCTED]->(:ConsultationNote)`
   * `(:ConsultationNote)-[:MENTIONS_DIAGNOSIS]->(:Disease)`
   * `(:ConsultationNote)-[:DISCUSSES_MEDICATION]->(:Medication)`
   * `(:Medication)-[:TREATS]->(:Disease)`
3. **Graph Sub-graph Refresh**: The patient's Vis.js graph and Chatbot RAG context update dynamically.\n