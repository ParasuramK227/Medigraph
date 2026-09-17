# MediGraph — Backend API & Analytics Engine

Python 3.11 + Flask REST API and clinical analytics engine for MediGraph. Powers the AI clinical scribe pipeline, Neo4j knowledge graph queries, physiological treatment intelligence, multimodal phenotype vector similarity, and chatbot graph RAG.

[![Python 3.11](https://img.shields.io/badge/Python-3.11-blue.svg)](https://www.python.org/)
[![Flask 3.1](https://img.shields.io/badge/Flask-3.1-black.svg)](https://flask.palletsprojects.com/)
[![Neo4j 5.x](https://img.shields.io/badge/Neo4j-5.x-008cc1.svg)](https://neo4j.com/)
[![PyJWT](https://img.shields.io/badge/Auth-PyJWT%20(HMAC--SHA256)-green.svg)](https://pyjwt.readthedocs.io/)
[![Groq LLM](https://img.shields.io/badge/LLM-Groq%20Cloud%20(gpt--oss--120b)-f55036.svg)](https://groq.com/)

---

## 🏗️ Architecture & Boundaries

The backend coordinates four distinct service boundaries with strict security and data governance:

1. **Authentication & RBAC (`/api/auth/*`)**: Stateless JWT issuance, Werkzeug PBKDF2 password hashing, and user role management (`admin`, `doctor`, `researcher`).
2. **Clinical Scribe & Safety (`/api/scribe/*`)**: Consultation session management, multilingual translation, mandatory local HIPAA Safe Harbor de-identification, Groq structured extraction, 10x dosage error detection, and Neo4j graph persistence.
3. **Knowledge Graph & Treatment Intelligence (`/api/graph/*`)**: Graph introspection, curated explorer presets, patient EHR CRUD, cohort sectors, and the deterministic Multimodal Phenotype Vector Space.
4. **Clinical Chatbot RAG (`/api/chat/*`)**: Typo-tolerant entity resolution, schema-grounded Cypher query generation, and de-identified LLM clinical reasoning.

---

## 📁 Directory Structure

```
backend/
├── analysis/
│   ├── graph_fetch.py        # Cypher retrieval helpers for patients, diseases, labs, notes
│   └── treatment_intel.py    # Multimodal IDF Vector Engine & Physiological Threshold Scoring
├── routes/
│   ├── auth.py               # /api/auth — Login, register, me, users, role updates
│   ├── chat.py               # /api/chat — Graph-grounded conversational RAG
│   ├── graph.py              # /api/graph — Schema, patients, sectors, presets, Cypher console
│   └── scribe.py             # /api/scribe — Translation, extraction, safety audits, note saving
├── scripts/
│   ├── seed.py               # Standard database seeder (data/ CSVs)
│   └── synthea_seeder.py     # Synthea clinical data graph seeder
├── app.py                    # Flask application factory, CORS, static fallback & health
├── auth_utils.py             # Centralized JWT decorators (@require_auth, @require_role)
├── chat_privacy.py           # Chatbot profile PHI sanitization
├── neo4j_connection.py       # Thread-safe Neo4j driver connection pooling & health checks
├── user_cache.json           # Offline mirrored user storage
├── user_store.py             # Neo4j user persistence & demo bootstrap
└── requirements.txt          # Python dependencies
```

---

## 🔌 API Service Specifications

### 1. Authentication & User Management (`/api/auth/*`)

| Endpoint | Method | Role Required | Description |
| :--- | :---: | :---: | :--- |
| `/api/auth/login` | `POST` | *Public* | Authenticates with `username`/`email` and `password`. Returns JWT token and user profile. |
| `/api/auth/register` | `POST` | *Public* | Registers a new account (default role: `researcher`). |
| `/api/auth/me` | `GET` | Authenticated | Validates JWT token and returns current user profile. |
| `/api/auth/users` | `GET` | `admin` | Lists all registered accounts (public safe fields only). |
| `/api/auth/users/<id>/role` | `PUT` | `admin` | Updates a user's role (`admin`, `doctor`, `researcher`). Prevents self-demotion. |

### 2. Clinical Scribe Pipeline (`/api/scribe/*`)

*All scribe operations are restricted to `admin` and `doctor`.*

| Endpoint | Method | Description |
| :--- | :---: | :--- |
| `/api/scribe/start` | `POST` | Initializes a new consultation session and generates a unique `session_id`. |
| `/api/scribe/translate` | `POST` | Translates consultation transcripts in real time into standardized clinical English via Groq. |
| `/api/scribe/transcript/<id>` | `GET` | Retrieves the stored transcript and approval status for a session. |
| `/api/scribe/transcript/<id>` | `PUT` | Stores physician-edited and approved transcript (*mandatory prior to extraction*). |
| `/api/scribe/extract/<id>` | `POST` | Executes Groq structured SOAP extraction on approved transcript after HIPAA de-identification. |
| `/api/scribe/audit-medication` | `POST` | Audits a single prescription for 10x dosage multiplier errors, therapeutic ranges, and ISMP SALAD confusions. |
| `/api/scribe/save/<id>` | `POST` | Commits structured note to Neo4j as `:ConsultationNote`, auto-linking `:Disease` and `:Medication` nodes. |
| `/api/scribe/status/<id>` | `GET` | Returns current session pipeline state (`idle`, `review`, `extracting`, `extracted`, `saved`). |

### 3. Knowledge Graph & Analytics (`/api/graph/*`)

| Endpoint | Method | Role Required | Description |
| :--- | :---: | :---: | :--- |
| `/api/graph/patients` | `GET` | Authenticated | Lists all patients ordered by name. |
| `/api/graph/patients/<id>` | `GET` | Authenticated | Fetches single patient dossier; optionally includes Vis.js graph (`?with_graph=1`). |
| `/api/graph/patients` | `POST` | `admin`, `doctor` | Creates a new patient node. |
| `/api/graph/patients/<id>` | `PUT` | `admin`, `doctor` | Updates demographic and clinical properties of a patient. |
| `/api/graph/patients/<id>` | `DELETE` | `admin` | Detaches and deletes a patient node. |
| `/api/graph/patients/<id>/intelligence` | `GET` | Authenticated | Enriched patient view: medical history, active conditions, similar patients. |
| `/api/graph/patients/<id>/treatment-intel` | `GET` | Authenticated | Multimodal Phenotype Vector similarity ranking and proof vectors. |
| `/api/graph/sectors` | `GET` | Authenticated | Disease cohorts with patient and medication counts. |
| `/api/graph/sectors/<disease>/graph` | `GET` | Authenticated | Scoped sub-graph for a specific disease cohort. |
| `/api/graph/sectors/<disease>/intelligence` | `GET` | Authenticated | Cohort treatment intelligence, top medications, recovery rates, biomarker control. |
| `/api/graph/schema` | `GET` | Authenticated | Database metadata for admin console: labels, relationship counts, property keys. |
| `/api/graph/explore` | `POST` | `admin`, `researcher` | Executes curated read-only Cypher presets for graph exploration. |
| `/api/graph/cypher` | `POST` | `admin` | Arbitrary Cypher execution endpoint for the Neo4j Admin Console. |
| `/api/graph/dashboard/*` | `GET` | Authenticated | Endpoints for recent notes, top sectors, and 18-month treatment trends. |

### 4. Chatbot RAG (`/api/chat/*`)

| Endpoint | Method | Role Required | Description |
| :--- | :---: | :---: | :--- |
| `/api/chat/message` | `POST` | Authenticated | Graph-grounded conversational agent. Executes entity resolution, Cypher traversal, de-identification, and Groq LLM inference. |
| `/api/chat/prompts` | `GET` | Authenticated | Generates dynamic, context-aware prompt recommendations tailored to active patient or cohort conditions. |

### 5. System Health (`/api/health`)

| Endpoint | Method | Role Required | Description |
| :--- | :---: | :---: | :--- |
| `/api/health` | `GET` | *Public* | Returns `{"status": "ok", "neo4j": "connected"}` verifying live database connectivity. |

---

## 🧬 Multimodal Clinical Vector Similarity Engine

Located in `backend/analysis/treatment_intel.py`, the engine computes mathematically grounded similarity across patients without relying on LLM judgments:

1. **Inverse Patient Frequency (IDF) Formulation**:
   $$\text{IDF}(t) = \ln\left(1 + \frac{N}{1 + \text{DF}(t)}\right)$$
   Rare conditions and high-impact medications receive weights up to $1.0$, while common baselines receive lower weights down to $0.15$.
2. **Weighted Cosine Vector Distance**:
   Calculates similarity over aligned binary feature vectors:
   $$\text{Cosine}(\vec{u}, \vec{v}) = \frac{\sum_{i} w_i^2 \cdot u_i \cdot v_i}{\|\vec{u}\|_{w} \cdot \|\vec{v}\|_{w}}$$
3. **Deterministic Physiological Biomarker Scoring**:
   * **Diabetes / Prediabetes**: Fasting Glucose $\le 125\text{ mg/dL}$ & $\text{HbA1c} \le 7.0\%$.
   * **Hypertension**: Systolic BP $< 130\text{ mmHg}$ & Diastolic BP $< 80\text{ mmHg}$.
   * **Anemia**: Hemoglobin $\ge 12.0\text{ g/dL}$ & Hematocrit $\ge 36.0\%$.
   * **Obesity**: BMI $< 30.0\text{ kg/m}^2$.

---

## 🔒 Security & Offline Resilience

* **JWT Secret Management**: Strong HMAC-SHA256 signature verification via `JWT_SECRET_KEY` (minimum 32 characters in production).
* **PBKDF2 Password Hashing**: Passwords are never stored in plaintext and never transmitted across API responses.
* **Offline Mirroring**: Every user authentication read/write is cached in `backend/user_cache.json`. If Neo4j AuraDB becomes unreachable, local authentication continues working seamlessly so on-device scribing is never blocked.

---

## 🏃 Running Locally

```bash
# Navigate to project root and activate virtual environment
source .venv/bin/activate  # On Windows: .venv\Scripts\Activate.ps1

# Install dependencies
pip install -r requirements.txt

# Run development server
python -m backend.app
# Server listens at http://localhost:5000
```\n