import * as Keychain from 'react-native-keychain';

const SERVICE = 'in.mehfil.app.session';

/** Refresh token + device id in the OS keychain (never MMKV/AsyncStorage). */
export const secureStore = {
  async get(): Promise<string | null> {
    const res = await Keychain.getGenericPassword({ service: SERVICE });
    return res ? res.password : null;
  },
  async set(value: string): Promise<void> {
    await Keychain.setGenericPassword('session', value, { service: SERVICE });
  },
  async clear(): Promise<void> {
    await Keychain.resetGenericPassword({ service: SERVICE });
  },
};
