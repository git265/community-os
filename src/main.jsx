import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import DataSourceChip from './components/DataSourcePanel.jsx';
import { hydrateSpill } from './lib/storage/SessionStorageAdapter.js';
import PublicPass from './modules/gate/PublicPass.jsx';

// big collections the browser store could not hold come back from this tab's IndexedDB before anything reads data
// a guest's pass link (#/pass?...) opens only the pass: no sign-in, no app, no data
if (/^#\/pass\?/.test(window.location.hash)) {
  ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><PublicPass /></React.StrictMode>);
} else hydrateSpill().catch(() => {}).finally(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
      <DataSourceChip />
    </React.StrictMode>
  );
});
