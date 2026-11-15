import { Platform } from 'react-native';

/**
 * Build-time app config. Development builds talk to the local API and show the dev sign-in
 * (DEV_AUTH_ENABLED on the API). Release builds use the production API and Google only.
 * GOOGLE_WEB_CLIENT_ID is empty until the OAuth clients exist (needs credentials).
 */
export const config = {
  appEnv: (__DEV__ ? 'development' : 'production') as 'development' | 'production',
  apiUrl: __DEV__ ? (Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://localhost:4000') : 'https://api.mehfil.app',
  googleWebClientId: '',
  showDevSignIn: __DEV__,
};
