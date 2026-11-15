/* global jest */
jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn(async () => true),
  getGenericPassword: jest.fn(async () => false),
  resetGenericPassword: jest.fn(async () => true),
}));
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn(), hasPlayServices: jest.fn(), signIn: jest.fn(), signOut: jest.fn() },
}));
// Node 22 already provides crypto.getRandomValues; the RN polyfill is native-only.
jest.mock('react-native-get-random-values', () => ({}));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@react-native-documents/picker', () => ({ pick: jest.fn(async () => []), types: { xlsx: 'xlsx', csv: 'csv' } }));
