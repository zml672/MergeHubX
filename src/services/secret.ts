import { invoke } from '@tauri-apps/api/core'

export function setSecret(key: string, value: string): Promise<void> {
  return invoke('set_secret', { key, value })
}

export function getSecret(key: string): Promise<string | null> {
  return invoke('get_secret', { key })
}

export function deleteSecret(key: string): Promise<void> {
  return invoke('delete_secret', { key })
}
