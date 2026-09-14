# MediGraph — AI Clinical Scribe Pipeline

The AI Clinical Scribe transcribes doctor-patient consultations, offers real-time multilingual translation, enables doctor review, and extracts structured clinical records directly into the Neo4j healthcare knowledge graph.

---

## Pipeline Architecture

```
[Audio Capture + CAVA Visualizer]
               │
               ▼
[AssemblyAI Streaming / REST STT] ──► [Live Translation (Groq)]
               │
               ▼
[Doctor Verification & Review]  (Mandatory — Prevents Hallucination Compounding)
               │
               ▼
[SOAP Note Extraction (Groq gpt-oss-120b)]
               │
               ▼
[Save to Neo4j Knowledge Graph] (:ConsultationNote linked to :Patient, :Disease, :Medication)
```

---

## Pipeline Stages

### 1. Audio Capture & Live Visualizer
- Initiated from the **Patient Detail View** (`/patients/:id`) or **Admin Graph Panel** (`/admin/graph`).
- Integrated CAVA-style animated audio-level visualizer confirms microphone input in real time.

### 2. Speech-to-Text (AssemblyAI)
- **Live Streaming**: `/api/scribe/token` mints short-lived temporary WebSocket tokens from AssemblyAI, allowing secure browser-direct streaming.
- **REST Transcription**: Full audio uploads are processed via AssemblyAI Transcriber (`scribe/transcription.py`), returning complete clinical transcripts.

### 3. Real-Time Multilingual Translation
- Handled by `translate_text()` in `scribe/transcription.py`.
- Enables multilingual consultations (e.g. Spanish, Hindi, French, German) to be translated live into standardized English for EHR compatibility.

### 4. Human-in-the-Loop Review (Doctor Verification)
- **Essential Safety Feature**: Extraction is **never** triggered automatically upon speech completion.
- The physician reviews and edits the transcript directly in the UI.
- Prevents speech-recognition ambiguities from compounding into erroneous diagnoses or medication records.

### 5. Structured SOAP Extraction (Groq Cloud)
- Processed by `extract()` in `scribe/extraction.py` using Groq's `openai/gpt-oss-120b`.
- Governed by the versioned schema prompt in [`scribe_extraction.md`](./scribe_extraction.md).
- Extracts:
  - `title`: Short clinical summary title (e.g., "Hypertension & Glycemic Follow-Up").
  - `summary`: Comprehensive clinical summary.
  - `diagnoses`: Explicit medical conditions discussed (mapped to `:Disease`).
  - `action_items`: Clinical follow-ups, lifestyle instructions, and diagnostic orders.
  - `medications_discussed`: Pharmacotherapies, dosages, and treatment rationales (mapped to `:Medication`).

### 6. Reactive Graph Persistence
- Saves a `:ConsultationNote` node into Neo4j AuraDB.
- Automatically establishes:
  - `(:Patient)-[:HAS_CONSULTATION_NOTE]->(:ConsultationNote)`
  - `(:ConsultationNote)-[:MENTIONS_DIAGNOSIS]->(:Disease)`
  - `(:ConsultationNote)-[:DISCUSSES_MEDICATION]->(:Medication)`
- Newly saved consultations immediately appear in the patient's sub-graph and become queryable via the Clinical Chatbot.

---

## Failure Resilience

- **Retry vs. Manual Entry**: If microphone access is denied or audio transcription fails, physicians are provided an immediate fallback to typed notes.
- **Session State**: In-memory session tracking (`scribe/session.py`) maintains consultation state with automatic TTL expiration.

