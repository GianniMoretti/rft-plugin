// The tree view's light and dark themes: the page follows the system until the button in the
// bar picks one, then keeps that choice for every project (`rft:theme` in localStorage). Loaded
// in <head>, before the stylesheet, so the first paint is already in the right theme; app.css
// holds the colours of both.
(function () {
  'use strict'

  const KEY = 'rft:theme'
  const root = document.documentElement
  const system = matchMedia('(prefers-color-scheme: dark)')
  let chosen = null // 'light' | 'dark' once the button was used, else null: follow the system
  try { chosen = ['light', 'dark'].includes(localStorage.getItem(KEY)) ? localStorage.getItem(KEY) : null } catch (e) { /* private window */ }

  function apply() {
    const theme = chosen || (system.matches ? 'dark' : 'light')
    root.dataset.theme = theme
    const button = document.getElementById('theme')
    if (!button) return
    const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`
    button.title = label
    button.setAttribute('aria-label', label)
  }

  system.addEventListener('change', () => { if (!chosen) apply() })
  apply()
  document.addEventListener('DOMContentLoaded', () => {
    apply()
    document.getElementById('theme').addEventListener('click', () => {
      chosen = root.dataset.theme === 'dark' ? 'light' : 'dark'
      try { localStorage.setItem(KEY, chosen) } catch (e) { /* private window: kept for this visit */ }
      apply()
    })
  })
})()
