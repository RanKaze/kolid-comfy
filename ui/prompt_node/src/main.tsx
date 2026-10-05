import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installLibraryWriteNotifier } from './blockScope';
import './index.css';

// Before any write can happen: tell the host when this document changes the shared library.
installLibraryWriteNotifier();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
