import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { AppLayout } from './components/layout/AppLayout'
import { ProtectedRoute } from './components/auth/ProtectedRoute'
import { DashboardPage } from './pages/DashboardPage'
import { PatientsPage } from './pages/PatientsPage'
import { PatientDetailPage } from './pages/PatientDetailPage'
import { SectorsPage } from './pages/SectorsPage'
import { SectorViewPage } from './pages/SectorViewPage'
import { TreatmentIntelligencePage } from './pages/TreatmentIntelligencePage'
import { TreatmentIntelPatientPage } from './pages/TreatmentIntelPatientPage'
import { GraphExplorerPage } from './pages/GraphExplorerPage'
import { ChatbotPage } from './pages/ChatbotPage'
import { LoginPage } from './pages/LoginPage'
import { UnauthorizedPage } from './pages/UnauthorizedPage'
import { NotFoundPage } from './pages/NotFoundPage'
import './styles/page.css'

const AdminGraphPage = lazy(() =>
  import('./pages/AdminGraphPage').then((m) => ({ default: m.AdminGraphPage })),
)

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/unauthorized" element={<UnauthorizedPage />} />

      <Route element={<AppLayout />}>
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/patients"
          element={
            <ProtectedRoute>
              <PatientsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/patients/:id"
          element={
            <ProtectedRoute>
              <PatientDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/sectors"
          element={
            <ProtectedRoute>
              <SectorsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/sectors/:id"
          element={
            <ProtectedRoute>
              <SectorViewPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/treatment-intelligence"
          element={
            <ProtectedRoute>
              <TreatmentIntelligencePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/treatment-intelligence/:id"
          element={
            <ProtectedRoute>
              <TreatmentIntelPatientPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/graph"
          element={
            <ProtectedRoute allowedRoles={['admin', 'researcher']}>
              <GraphExplorerPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/graph"
          element={
            <ProtectedRoute allowedRoles={['admin']}>
              <Suspense fallback={<div>Loading admin graph…</div>}>
                <AdminGraphPage />
              </Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="/chatbot"
          element={
            <ProtectedRoute>
              <ChatbotPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="*"
          element={
            <ProtectedRoute>
              <NotFoundPage />
            </ProtectedRoute>
          }
        />
      </Route>
    </Routes>
  )
}

export default App
