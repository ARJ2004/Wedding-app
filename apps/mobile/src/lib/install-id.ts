import { newDeviceId } from './device-id';
import { secureStore } from './secure-store';

let cached: string | null = null;

/** One random id per install, shared by host and guest sessions (refresh tokens are bound to it). */
export async function installId(): Promise<string> {
  if (cached) return cached;
  cached = (await secureStore.get('install')) ?? newDeviceId();
  await secureStore.set(cached, 'install');
  return cached;
}
