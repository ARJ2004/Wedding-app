import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { config } from './config';

let configured = false;

export const googleAvailable = () => Boolean(config.googleWebClientId);

/** Returns a Google ID token whose audience is the Web client ID the API verifies. */
export async function googleIdToken(): Promise<string> {
  if (!config.googleWebClientId) throw new Error('Google sign-in is not configured yet. Use dev sign-in.');
  if (!configured) {
    GoogleSignin.configure({ webClientId: config.googleWebClientId });
    configured = true;
  }
  await GoogleSignin.hasPlayServices();
  const res = await GoogleSignin.signIn();
  const token = res.type === 'success' ? res.data.idToken : null;
  if (!token) throw new Error('Google sign-in was cancelled');
  return token;
}

export async function googleSignOut() {
  if (configured) await GoogleSignin.signOut().catch(() => undefined);
}
