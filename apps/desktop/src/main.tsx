import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@medea/design-system';
import { App } from './app/App';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root container.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
