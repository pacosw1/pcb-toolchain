import './assets/main.css'
import './assets/layout.css'
import './assets/polish.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installWebApi } from './webApi'

// Outside Electron (the read-only web viewer) there is no preload bridge: talk to the engine over WebSocket.
if (!(window as { api?: unknown }).api) {
  installWebApi()
  if ('serviceWorker' in navigator) void navigator.serviceWorker.register('./sw.js').catch(() => undefined)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
