import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { TurnEvent, VoiceNotesApi } from '../shared/types'

const api: VoiceNotesApi = {
  submitUtterance: (pcm, sampleRate) => ipcRenderer.invoke('turn:submit', pcm, sampleRate),
  cancelTurn: () => ipcRenderer.invoke('turn:cancel'),
  newConversation: () => ipcRenderer.invoke('conversation:new'),
  preflight: () => ipcRenderer.invoke('preflight'),
  onTurnEvent: (handler) => {
    const listener = (_event: IpcRendererEvent, turnEvent: TurnEvent): void => handler(turnEvent)
    ipcRenderer.on('turn:event', listener)
    return () => {
      ipcRenderer.off('turn:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
