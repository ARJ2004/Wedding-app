import * as Keychain from 'react-native-keychain';

export type SecureKey = 'host' | 'guest' | 'install';

const service = (key: SecureKey) => `in.mehfil.app.${key}`;

/** Session secrets in the OS keychain, one entry per identity (never MMKV/AsyncStorage). */
export const secureStore = {
  async get(key: SecureKey = 'host'): Promise<string | null> {
    const res = await Keychain.getGenericPassword({ service: service(key) });
    return res ? res.password : null;
  },
  async set(value: string, key: SecureKey = 'host'): Promise<void> {
    await Keychain.setGenericPassword(key, value, { service: service(key) });
  },
  async clear(key: SecureKey = 'host'): Promise<void> {
    await Keychain.resetGenericPassword({ service: service(key) });
  },
};
