import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { optimizer, is } from '@electron-toolkit/utils'
import type { TurnEvent } from '../shared/types'
import { startTurn } from './turn'

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

  ipcMain.handle('turn:submit', (e, pcm: ArrayBuffer, sampleRate: number) => {
    const send = (event: TurnEvent): void => {
      if (!e.sender.isDestroyed()) e.sender.send('turn:event', event)
    }
    return { turnId: startTurn(send, pcm, sampleRate) }
  })

  createWindow()
})

app.on('window-all-closed', () => app.quit())
