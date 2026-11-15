import 'react-native-get-random-values';

/** Random per-install id bound to refresh tokens (16–64 chars, API rule). */
export function newDeviceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
