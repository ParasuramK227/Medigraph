# MediGraph — Frontend Web Application

React 19 + TypeScript + Vite modern clinical web interface for MediGraph. Features 100% in-browser on-device audio transcription, interactive force-directed Vis.js graph physics, multimodal vector comparison tools, and a Neo4j Browser replica console.

[![React 19](https://img.shields.io/badge/React-19.2-61dafb.svg?logo=react)](https://react.dev/)
[![Vite 8](https://img.shields.io/badge/Vite-8.2-646cff.svg?logo=vite)](https://vitejs.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg?logo=typescript)](https://www.typescriptlang.org/)
[![Vis.js](https://img.shields.io/badge/Graph-Vis.js%20Network-orange.svg)](https://visjs.github.io/vis-network/docs/network/)
[![WASM Multithreading](https://img.shields.io/badge/Edge%20AI-WASM%20SharedArrayBuffer-purple.svg)](https://webassembly.org/)

---

## 🌟 Key Highlights

- **100% In-Browser Speech-to-Text**: Powered by **Moonshine Medium Streaming WASM** and **Browser Whisper Tiny**. Zero acoustic data leaves the client machine.
- **Multimodal Vector Comparator**: Interactive bit-by-bit feature vector projection component displaying aligned condition/drug bits and clinical IDF specificity tags.
- **Role-Based Routing**: Strict client-side route protection (`<ProtectedRoute allowedRoles={['admin', ...]}>`) backed by React Context (`AuthContext.tsx`).
- **Interactive Knowledge Graph**: Vis.js force-directed canvas with Barnes-Hut repulsion, collision stabilization, and animated node property drawers.
- **Neo4j Admin Console**: In-app replica of Neo4j Browser with Cypher prompt, query history, live latency ping, schema inspector, and CSV/JSON export.
- **Performance & Isolation**: Configured with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers for high-performance WebAssembly multithreading.

---

## 📁 Directory Structure

```
frontend/
├── public/
│   ├── fonts/                # Departure Mono & custom clinical monospace fonts
│   └── models/moonshine/     # Self-hosted Moonshine WASM model weights
├── src/
│   ├── components/
│   │   ├── admin/            # AdminGraphPanel (Neo4j Browser replica)
│   │   ├── auth/             # ProtectedRoute & Role Guards
│   │   ├── chat/             # Clinical Chatbot Floating Widget & Panel
│   │   ├── feature/          # LazyFeatureGraph (Cytoscape overlay)
│   │   ├── graph/            # VisNetworkCanvas & NodePropertiesSidebar
│   │   ├── layout/           # AppLayout, SideNav, TopBar, ThemeToggle
│   │   └── scribe/           # ScribeWidget & CAVA Audio Visualizer
│   ├── context/
│   │   └── AuthContext.tsx   # React AuthProvider, session restoration & JWT handling
│   ├── lib/
│   │   ├── api.ts            # Typed REST API client with auto-injected Bearer tokens
│   │   ├── auth-storage.ts   # LocalStorage session persistence helpers
│   │   ├── browserMoonshine.ts # Moonshine WASM streaming engine
│   │   ├── browserWhisper.ts   # HuggingFace Transformers.js Whisper Tiny pipeline
│   │   └── graphColors.ts    # Centralized medical entity color taxonomy
│   ├── pages/                # Application Page Components (Dashboard, Patients, Sectors, Intel)
│   ├── styles/               # CSS design tokens, typography, dark/light themes
│   ├── App.tsx               # Main routing tree and role permissions
│   └── main.tsx              # React DOM root mounting
├── package.json              # Frontend dependencies
└── vite.config.ts            # Vite build configuration with isolation headers
```

---

## 🗺️ Application Routes

| Route | Component | Permitted Roles | Description |
| :--- | :--- | :--- | :--- |
| `/login` | `LoginPage` | *Public* | User authentication with demo account quick-selection. |
| `/unauthorized` | `UnauthorizedPage` | *Public* | Access denied screen when role permissions are insufficient. |
| `/` | `DashboardPage` | Authenticated | Clinical KPIs, 18-month activity trend SVG, recent consultations. |
| `/patients` | `PatientsPage` | Authenticated | Patient registry with search, demographic badges, and condition tags. |
| `/patients/:id` | `PatientDetailPage` | Authenticated | Complete EHR dossier, embedded Scribe, Vis.js graph, similar cohort. |
| `/treatment-intelligence` | `TreatmentIntelligencePage` | Authenticated | Population treatment summary table with diagnosis and lab counts. |
| `/treatment-intelligence/:id` | `TreatmentIntelPatientPage`| Authenticated | **Multi-Hot Vector Comparator**, IDF weights, similarity proofs. |
| `/sectors` | `SectorsPage` | Authenticated | Disease cohort directory with patient and medication distributions. |
| `/sectors/:id` | `SectorViewPage` | Authenticated | Sector intelligence, biomarker control rates, 1st-line therapies. |
| `/graph` | `GraphExplorerPage` | `admin`, `researcher`| Interactive Vis.js canvas with curated read-only Cypher presets. |
| `/admin/graph` | `AdminGraphPage` | `admin` | Full Neo4j Browser replica with Cypher prompt, latency ping, CSV export. |
| `/chatbot` | `ChatbotPage` | Authenticated | Full-page clinical conversational assistant grounded in graph context. |

---

## 🎙️ On-Device Scribe Engine

Located in `src/components/scribe/ScribeWidget.tsx` and `src/lib/browserMoonshine.ts`:

1. **WASM Audio Streaming**:
   Captures audio via standard browser `navigator.mediaDevices.getUserMedia`. Passes 16 kHz audio chunks into the `@moonshine-ai/moonshine-wasm` multithreaded worker.
2. **CAVA-Inspired Real-Time Equalizer**:
   Uses the Web Audio API `AnalyserNode` to compute real-time Fast Fourier Transform (FFT) frequencies, animating a multi-bar canvas visualizer.
3. **Doctor Verification Stage**:
   Transcription renders in an editable text area. Physicians review, correct, and click **Approve** before extraction can proceed—eliminating compounding hallucinations.
4. **Multilingual Translation**:
   Provides one-click translation into standardized clinical English for non-English consultations.
5. **Medication Safety Warning**:
   Displays real-time dosage warnings and ISMP sound-alike alerts during review.

---

## 🎨 Design Tokens & Theming

MediGraph uses pure CSS variables without CSS-in-JS overhead (`src/styles/tokens.css`):
* **Typography**:
  * Display & Headings: `Outfit` (Google Fonts)
  * Interface & Prose: `Inter` (Google Fonts)
  * Clinical Metrics & Cypher Code: `Departure Mono` (Self-hosted webfont in `public/fonts/`)
* **Theming**: Toggleable Light and Dark themes (`ThemeToggle.tsx`) persisted across sessions.

---

## 🏃 Running Locally

```bash
# Navigate to frontend directory
cd frontend

# Install dependencies
npm install

# Start Vite development server
npm run dev
# App runs at http://localhost:5173
```\n