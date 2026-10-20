import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import DataSourceChip from './components/DataSourcePanel.jsx';
import { hydrateSpill } from './lib/storage/SessionStorageAdapter.js';

// big collections the browser store could not hold come back from this tab's IndexedDB before anything reads data
hydrateSpill().catch(() => {}).finally(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
      <DataSourceChip />
    </React.StrictMode>
  );
});
