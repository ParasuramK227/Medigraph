# MediGraph Cloud Deployment Guide (Render)

This guide walks you through deploying **MediGraph** on [Render](https://render.com) using your GitHub repository (`ParasuramK227/Medigraph.`).

---

## Architecture Overview

* **Frontend**: React 19 + TypeScript + Vite + Vis.js (SPA)
* **Backend**: Python 3.11 + Flask + Gunicorn WSGI
* **Database**: Neo4j AuraDB Cloud (`neo4j+s://05b7caea.databases.neo4j.io`)
* **AI Engine**: Groq Cloud (`gpt-oss-120b`) + AssemblyAI

---

## Method 1: Automatic 1-Click Blueprint (Recommended)

Render Blueprints automatically configure both the **Backend Web Service** and the **Frontend Static Site** using the [`render.yaml`](../render.yaml) file in the repository.

### Step-by-Step Instructions:

1. **Sign in to Render**:
   - Go to [dashboard.render.com](https://dashboard.render.com) and sign in (using GitHub).

2. **Create New Blueprint**:
   - Click the **"New +"** button at the top right.
   - Select **"Blueprint"**.
   - Connect your GitHub repository: `ParasuramK227/Medigraph.`.

3. **Configure Environment Variables**:
   Render will automatically detect `render.yaml` and prompt you for the backend secret variables:
   | Key | Description | Example / Location |
   | :--- | :--- | :--- |
   | `NEO4J_URI` | Neo4j AuraDB Bolt URI | `neo4j+s://05b7caea.databases.neo4j.io` |
   | `NEO4J_USER` | Neo4j Username | `neo4j` |
   | `NEO4J_PASSWORD` | Neo4j Password | From your AuraDB credentials |
   | `GROQ_API_KEY` | Groq API Key | `gsk_...` (from console.groq.com) |
   | `ASSEMBLYAI_API_KEY` | AssemblyAI API Key | From assemblyai.com |
   | `CORS_ORIGINS` | Allowed CORS origins | `*` (or leave default `*`) |

4. **Click "Apply"**:
   - Render will build and deploy both services simultaneously:
     * **`medigraph-backend`**: Runs Gunicorn Python server on the free tier.
     * **`medigraph-frontend`**: Builds the Vite React SPA and deploys it on Render's global static CDN with free SSL.
     * Render automatically links `VITE_API_BASE` from the backend to the frontend.

---

## Method 2: Single Unified Web Service (All-in-One Free Tier)

If you prefer having **one single URL** (e.g. `https://medigraph.onrender.com`) where the Python server serves both the React UI and the REST API:

1. In Render, click **"New +"** $\to$ **"Web Service"**.
2. Connect your repo: `ParasuramK227/Medigraph.`.
3. Configure the service:
   * **Name**: `medigraph`
   * **Language**: `Python`
   * **Branch**: `main`
   * **Build Command**:
     ```bash
     npm --prefix frontend install && npm --prefix frontend run build && pip install -r requirements.txt
     ```
   * **Start Command**:
     ```bash
     gunicorn --workers=2 --threads=4 --timeout=120 "backend.app:create_app()"
     ```
   * **Instance Type**: `Free`
4. Add the Environment Variables under **Environment**:
   * `PYTHON_VERSION`: `3.11.0`
   * `NEO4J_URI`: `neo4j+s://05b7caea.databases.neo4j.io`
   * `NEO4J_USER`: `neo4j`
   * `NEO4J_PASSWORD`: `<your-neo4j-password>`
   * `GROQ_API_KEY`: `<your-groq-api-key>`
   * `ASSEMBLYAI_API_KEY`: `<your-assemblyai-key>`
5. Click **"Create Web Service"**.

---

## Verifying the Deployment

Once deployed:
1. Open your frontend URL (`https://medigraph-frontend.onrender.com`).
2. Verify:
   - **Dashboard**: KPI statistics and patient counts load from Neo4j.
   - **Health Check**: Check `https://<backend-url>/api/health` — it should return `{"status": "ok", "neo4j": "connected"}`.
   - **Chatbot**: Send a question in the Clinical Assistant to verify the Groq `gpt-oss-120b` response.
   - **Graph Explorer**: Run a preset query to confirm Vis.js graph rendering.
