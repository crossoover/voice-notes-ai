import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { optimizer, is } from '@electron-toolkit/utils'
import type { Preflight, TurnEvent } from '../shared/types'
import { checkAgent, newConversation } from './agent'
import { NOTES_DIR } from './paths'
import { cancelTurn, shutdown, startTurn } from './turn'
import { checkSpeech } from './whisper'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // The window renders agent-produced text: never navigate away, never open a window.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  win.on('ready-to-show', () => win.show())

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // F12 toggles devtools in dev, Cmd+R is ignored in production.
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // The agent's whole world; it must exist before the first turn runs in it.
  mkdirSync(NOTES_DIR, { recursive: true })

  ipcMain.handle('turn:cancel', () => cancelTurn())

  ipcMain.handle('conversation:new', () => {
    // Cancel first, or the turn still running would repopulate the cleared window.
    cancelTurn({ notify: false })
    newConversation()
  })

  ipcMain.handle('preflight', async (): Promise<Preflight> => ({
    agent: await checkAgent(),
    speech: await checkSpeech()
  }))

  ipcMain.handle('turn:submit', (e, pcm: ArrayBuffer, sampleRate: number) => {
    const send = (event: TurnEvent): void => {
      if (!e.sender.isDestroyed()) e.sender.send('turn:event', event)
    }
    return { turnId: startTurn(send, pcm, sampleRate) }
  })

  createWindow()
})

app.on('before-quit', shutdown)
app.on('window-all-closed', () => app.quit())
