import { createMMKV, type MMKV } from 'react-native-mmkv';
import { newDeviceId } from './device-id';
import { secureStore } from './secure-store';

/**
 * Encrypted on-device key-value store (APP-04): MMKV with a random key kept in the keychain, so a
 * copied app sandbox or backup can't read cached schedules or queued RSVPs.
 */
let store: MMKV | null = null;

export async function initKv(): Promise<void> {
  if (store) return;
  // A dedicated random key that never leaves the keychain (the install id is sent to the API).
  let key = await secureStore.get('cachekey');
  if (!key) {
    key = newDeviceId().slice(0, 16);
    await secureStore.set(key, 'cachekey');
  }
  store = createMMKV({ id: 'mehfil-cache', encryptionKey: key });
}

function s(): MMKV {
  if (!store) throw new Error('initKv() must finish before the cache is used');
  return store;
}

export const kv = {
  getItem: (k: string): string | null => s().getString(k) ?? null,
  setItem: (k: string, v: string) => s().set(k, v),
  removeItem: (k: string) => {
    s().remove(k);
  },
};
