import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from '../../src/ui/components/ErrorBoundary';
import './style.css';

const container = document.getElementById('root');
if (!container) throw new Error('popup root element missing');

createRoot(container).render(
  <StrictMode>
    {/* Outermost boundary: catches even a throw in the providers, where no
        locale is known yet. Without it a render error is a blank popup. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
