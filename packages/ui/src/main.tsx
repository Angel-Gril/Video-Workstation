import React from 'react'
import { createRoot } from 'react-dom/client'
import { Workstation } from './Workstation'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('Root container not found')

createRoot(container).render(
  <React.StrictMode>
    <Workstation />
  </React.StrictMode>
)
