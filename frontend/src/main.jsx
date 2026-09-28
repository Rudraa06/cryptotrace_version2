import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import { AuthProvider } from './hooks/AuthContext.jsx';
import AmbientBackground from './components/AmbientBackground.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <AmbientBackground />
        <App />
      </AuthProvider>
    </ErrorBoundary>
  </StrictMode>
);
