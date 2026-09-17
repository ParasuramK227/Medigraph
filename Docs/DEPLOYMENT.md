# MediGraph Cloud Deployment Guide (Render)

This guide walks you through deploying **MediGraph** on [Render](https://render.com) using your GitHub repository.

---

## 🏗️ Architecture Overview

* **Frontend**: React 19 + TypeScript + Vite Static Site on global CDN with `COOP` / `COEP` WebAssembly multithreading headers.
* **Backend**: Python 3.11 + Flask 3.1 + Gunicorn WSGI Web Service.
* **Database**: Neo4j AuraDB Cloud Enterprise (`neo4j+s://...`).
* **Edge STT**: 100% Client-side Moonshine Medium Streaming WASM (Zero cloud audio streaming costs).
* **Inference**: Groq Cloud (`openai/gpt-oss-120b`) for structured SOAP extraction and Chatbot RAG.

---

## 🚀 Method 1: Automatic 1-Click Blueprint (Recommended)

Render Blueprints automatically configure both the **Backend Web Service** and the **Frontend Static Site** using the [`render.yaml`](../render.yaml) blueprint specification in the root directory.

### Step-by-Step Instructions:

1. **Sign in to Render**:
   - Navigate to [dashboard.render.com](https://dashboard.render.com) and log in with your GitHub account.

2. **Create New Blueprint**:
   - Click the **"New +"** button at the top right.
   - Select **"Blueprint"**.
   - Connect your GitHub repository: `ParasuramK227/Medigraph`.

3. **Configure Secret Environment Variables**:
   Render will detect `render.yaml` and prompt you for required secrets:

   | Variable | Description | Example / Location |
   | :--- | :--- | :--- |
   | `NEO4J_URI` | Neo4j AuraDB Bolt URI | `neo4j+s://<id>.databases.neo4j.io` |
   | `NEO4J_USER` | Neo4j Username | `neo4j` |
   | `NEO4J_PASSWORD` | Neo4j AuraDB Password | From your AuraDB credentials file |
   | `GROQ_API_KEY` | Groq API Key | From [console.groq.com](https://console.groq.com) |
   | `JWT_SECRET_KEY` | JWT Signing Secret | Random string ($\ge 32$ chars) |
   | `JWT_EXPIRATION_MINUTES` | Access Token Lifetime | `480` |
   | `CORS_ORIGINS` | Allowed Origins | `*` |

4. **Click "Apply"**:
   Render will deploy:
   * **`medigraph-backend`**: Builds with `pip install -r requirements.txt` and starts Gunicorn.
   * **`medigraph-frontend`**: Builds the React Vite SPA and deploys it on Render's global CDN with mandatory `COOP` and `COEP` headers.

---

## 🔒 WebAssembly Multithreading Header Verification

Moonshine WASM requires `SharedArrayBuffer`, which browsers only enable if these HTTP response headers are present on the frontend:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These headers are pre-configured in [`render.yaml`](../render.yaml) under the `medigraph-frontend` static service specification:

```yaml
    headers:
      - path: /*
        name: Cross-Origin-Opener-Policy
        value: same-origin
      - path: /*
        name: Cross-Origin-Embedder-Policy
        value: require-corp
```

---

## 🔍 Verifying the Deployment

1. **Health Check**:
   Open `https://<backend-url>/api/health` — it should return:
   ```json
   {"status": "ok", "neo4j": "connected"}
   ```
2. **Demo Sign-In**:
   Open `https://<frontend-url>/login` and sign in with:
   * Username: `admin`
   * Password: `AdminPassword123!`
3. **Audio Transcription**:
   Open any patient (`/patients/<id>`) and click **"Start Dictation"** in the Scribe widget. Ensure microphone audio animates the CAVA visualizer and streams live text.
4. **Treatment Intelligence**:
   Navigate to `/treatment-intelligence/<id>` and verify that the **Multi-Hot Vector Comparator** displays aligned clinical feature vectors.\n