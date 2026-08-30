import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LedgerApp } from './App';
import { ErrorBoundary } from '../../src/ui/components/ErrorBoundary';
import '../popup/style.css';

const container = document.getElementById('root');
if (!container) throw new Error('ledger root element missing');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <LedgerApp />
    </ErrorBoundary>
  </StrictMode>,
);
