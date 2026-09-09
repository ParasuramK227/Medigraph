# MediGraph — Frontend Web Application

React 19 (TypeScript/TSX) + Vite frontend for MediGraph. Features interactive force-directed Vis.js graph exploration, an AI medical scribe with real-time audio visualization and translation, Neo4j Admin Console, and responsive mobile-optimized UI.

---

## Technology Stack

- **React 19** (TSX) + **Vite 8**
- **TypeScript** (Strict mode)
- **Vis.js Network (`vis-network`)** — Force-directed canvas physics for graph exploration
- **Lucide Icons (`lucide-react`)**
- **Plain CSS with Design Tokens** — CSS custom properties, zero CSS-in-JS overhead, light/dark themes
- **Audio Visualizer** — Custom SVG/Canvas audio-level meter inspired by CAVA

---

## Layout & Navigation

- **Left-Docked Navigation Rail** (`SideNav.tsx`): Persistent sidebar on desktop viewports.
- **Mobile Responsive Drawer** (`AppLayout.tsx`): Collapses to an off-canvas drawer with a hamburger trigger below `768px`, with touch-friendly backdrops and automated route navigation listeners.
- **Top Bar**: Real-time backend connectivity status (`BackendStatus.tsx`) and light/dark theme switcher (`ThemeToggle.tsx`).
- **Floating Clinical Chatbot** (`ChatFloatingButton.tsx`): Persistent floating assistant available across all pages with responsive modal scaling on mobile screens.

---

## Routing & Pages

```
/                             → Dashboard (KPI cards, 18-month treatment activity SVG, recent consultations)
/patients                     → Patient Directory (search, demographics, contact info)
/patients/:id                 → Patient Detail Dossier (embedded Scribe, Vis.js graph, similar patient cohort)
/sectors                      → Clinical Sectors (disease cohort search, patient distributions)
/sectors/:disease             → Sector Intelligence (biomarker control rates, top treatments, line-of-therapy)
/treatment-intelligence       → Treatment Intelligence (physiological biomarker control ranking)
/graph                        → Graph Explorer (Vis.js interactive canvas, preset queries, node inspection)
/admin/graph                  → Neo4j Admin Console (Neo4j Browser replica, live latency ping, Cypher runner)
/chatbot                      → Clinical Assistant Chat (graph-grounded conversational RAG)
```

---

## Core Interactive Features

### 1. Interactive Vis.js Network (`VisNetworkCanvas.tsx`)
- **Physics Simulation**: Force-directed layout algorithm with Barnes-Hut repulsion and collision stabilization.
- **Canvas Controls**: Zoom in/out, fit to viewport, toggle physics, and quick label search overlay.
- **Node Properties Sidebar** (`NodePropertiesSidebar.tsx`): Slide-out drawer on node or edge selection displaying properties, metadata, and connected entities. Fully responsive on mobile ($100\%$ width).
- **Color Taxonomy**: Centralized node coloring via `src/lib/graphColors.ts` matching medical entity types (`:Patient`, `:Disease`, `:Medication`, `:Treatment`, `:ConsultationNote`, `:Doctor`, `:LabTest`).

### 2. AI Medical Scribe (`ScribeWidget.tsx`)
- Embedded in Patient Detail views and Admin Graph views.
- **Workflow Stages**:
  `Idle → Recording (CAVA Audio Meter) → Transcribing (AssemblyAI) → Review/Edit (Doctor Verification) → Extracting (Groq) → Saved to Neo4j`
- **Real-Time Translation**: Live translation into English or other languages via Groq.
- **Zero-Compounding Hallucination**: Physicians verify/edit transcripts *before* LLM extraction runs.
- **Failure Resilience**: Automatic fallback to manual typed consultation notes if recording fails.

### 3. Neo4j Admin Console (`AdminGraphPanel.tsx`)
- Faithfully replicates the official Neo4j Browser interface:
  - Top status bar with live AuraDB latency ping (`ms`) and connection status.
  - Left rail with Database Information (node labels, relationship pills, property keys).
  - Cypher query editor (`neo4j$` prompt) with bookmarking and query execution.
  - Persistent Query History drawer backed by browser `localStorage`.
  - Multi-tab results: **Graph Canvas**, **Data Table**, and **RAW JSON** with CSV/JSON export.

---

## Design Tokens & Typography

All tokens reside in `src/styles/tokens.css`:
- **Headings**: Outfit (Google Fonts)
- **Body**: Inter (Google Fonts)
- **Clinical Stats & Monospace**: Departure Mono (Self-hosted webfont in `public/fonts/`)

---

## Running Locally

```bash
# Navigate to frontend
cd frontend

# Install dependencies
npm install

# Start development server
npm run dev
# App runs at http://localhost:5173
```

