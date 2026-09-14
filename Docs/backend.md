# MediGraph — Backend API & Analytics Engine

Python 3.11 + Flask REST API and clinical analytics engine for MediGraph. Powers the AI clinical scribe pipeline, Neo4j knowledge graph queries, physiological treatment intelligence, and chatbot graph RAG.

---

## Technology Stack

- **Python 3.11**
- **Flask 3.1 & Flask-CORS** (REST API microframework)
- **Gunicorn WSGI** (production deployment on Render)
- **Neo4j AuraDB Cloud Driver (`neo4j` 5.x)** (Bolt connection via `neo4j+s://` protocol)
- **AssemblyAI Cloud SDK** (streaming WebSocket temporary tokens & REST transcription)
- **Groq Cloud API (`openai/gpt-oss-120b`)** (clinical note extraction, multilingual translation, and chatbot RAG)
- **Requests & Python-Dotenv** (HTTP client and environment variable configuration)

---

## Directory Structure

```
backend/
├── analysis/
│   ├── graph_fetch.py        # Graph data retrieval helpers for patients, diseases & treatments
│   └── treatment_intel.py    # Physiological biomarker control rate scoring & line-of-therapy ranking
├── routes/
│   ├── chat.py               # /api/chat — Clinical Assistant RAG with graph-grounded context
│   ├── graph.py              # /api/graph — Cypher query execution, schema introspection, sectors & cohorts
│   └── scribe.py             # /api/scribe — AssemblyAI token minting, transcription, translation & extraction
├── scripts/
│   ├── seed.py               # Standard database seeder (data/ CSVs)
│   └── synthea_seeder.py     # Comprehensive clinical seeder (synthea_sample_data_csv_latest/)
├── app.py                    # Flask application factory, CORS setup & static fallback
├── neo4j_connection.py       # Thread-safe Neo4j driver connection pooling & health checks
└── requirements.txt          # Python dependencies
```

---

## API Service Boundaries

### 1. Scribe Service (`/api/scribe/*`)
- `POST /api/scribe/start`: Initializes a new consultation session and generates a unique `session_id`.
- `GET /api/scribe/token`: Mints a temporary WebSocket token from AssemblyAI for in-browser live streaming transcription.
- `POST /api/scribe/transcribe`: Accepts an audio file upload (`.webm`, `.mp3`, `.wav`) and transcribes it via AssemblyAI REST API.
- `POST /api/scribe/translate`: Translates speech or transcripts in real time into English or target languages via Groq.
- `POST /api/scribe/extract`: Takes a doctor-reviewed transcript and extracts structured SOAP notes (summary, diagnoses, action items, medications) using Groq (`openai/gpt-oss-120b`) and `scribe/prompts/scribe_extraction.md`.
- `POST /api/scribe/save`: Persists the structured consultation note to Neo4j as a `:ConsultationNote` node, linked to `:Patient`, `:Disease`, and `:Medication` nodes.

### 2. Knowledge Graph API (`/api/graph/*`)
- `POST /api/graph/cypher`: Direct Cypher execution endpoint for the Neo4j Admin Console, returning formatted tabular and graph data.
- `GET /api/graph/schema`: Introspects database labels, property keys, and node/relationship counts.
- `GET /api/graph/patients`: Retrieves patient records, demographics, and active conditions.
- `GET /api/graph/patients/<id>`: Returns a comprehensive patient dossier including diagnoses, medications, lab tests, consultation history, and similar patient cohorts.
- `GET /api/graph/patients/<id>/graph`: Generates a patient-scoped sub-graph payload formatted for Vis.js force-directed rendering.
- `GET /api/graph/sectors`: Groups patients into disease cohorts, reporting patient counts and top treatment protocols.
- `GET /api/graph/sectors/<disease>`: Cohort-level clinical analytics, biomarker control rates, and line-of-therapy breakdown.
- `GET /api/graph/treatment-intelligence`: Population-level treatment intelligence, ranking therapies by clinical biomarker control rates.

### 3. Chatbot RAG (`/api/chat/*`)
- `POST /api/chat/message`: Graph-grounded conversational agent. Automatically detects patient context or cohort context, executes Cypher queries to build a clinical prompt, and streams response tokens from Groq.
- `GET /api/chat/prompts`: Generates dynamic suggested questions tailored to the selected patient's active conditions or the current cohort.

### 4. Health Check (`/api/health`)
- Returns `{"status": "ok", "neo4j": "connected"}` verifying live database connectivity and latency.

---

## Physiological Treatment Intelligence

Located in `backend/analysis/treatment_intel.py`, the scoring engine evaluates actual clinical control rates based on biomarker physiological thresholds:

- **Type 2 Diabetes / Prediabetes**: Evaluates Fasting Glucose ($\le 125\text{ mg/dL}$) and HbA1c ($\le 7.0\%$).
- **Hypertension**: Evaluates Systolic BP ($< 130\text{ mmHg}$) and Diastolic BP ($< 80\text{ mmHg}$).
- **Anemia**: Evaluates Hemoglobin ($\ge 12.0\text{ g/dL}$) and Hematocrit ($\ge 36\%$).
- **Obesity**: Evaluates BMI ($< 30.0\text{ kg/m}^2$).

Treatment options are ranked by:
1. **Control Rate %**: Percentage of patients on the therapy who achieved physiological control.
2. **Line of Therapy**: 1st Line (primary guideline recommendation) vs. 2nd/3rd Line.
3. **Cohort Evidence**: Total patient count receiving the regimen.

---

## Running Locally

```bash
# Activate virtual environment
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dependencies
pip install -r backend/requirements.txt

# Run development server
python -m backend.app
# Server runs at http://localhost:5000
```
