import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { ProjectProvider } from './project';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { QueuesPage } from './pages/Queues';
import { JobsPage } from './pages/Jobs';
import { JobDetailPage } from './pages/JobDetail';
import { WorkersPage } from './pages/Workers';
import { DeadLetterPage } from './pages/DeadLetter';

export function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="auth-wrap"><Loading text="Starting…" /></div>;
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <ProjectProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/queues" element={<QueuesPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/:jobId" element={<JobDetailPage />} />
          <Route path="/workers" element={<WorkersPage />} />
          <Route path="/dead-letter" element={<DeadLetterPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </ProjectProvider>
  );
}
