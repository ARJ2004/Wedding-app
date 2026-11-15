// Minimal globals used by the .web.ts variants (React Native Web preview) and the
// react-native-get-random-values polyfill on native. Avoids pulling the whole DOM lib.
interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
declare const window: { localStorage: MinimalStorage; sessionStorage: MinimalStorage; location: { origin: string } } | undefined;
declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };
