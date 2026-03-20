import React from 'react'
import ReactDOM from 'react-dom/client'
import { Toaster } from 'react-hot-toast'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <Toaster
      position="top-right"
      toastOptions={{
        duration: 4000,
        style: { fontSize: '14px', maxWidth: '420px' },
        success: { iconTheme: { primary: '#2563eb', secondary: '#fff' } },
      }}
    />
  </React.StrictMode>
)
