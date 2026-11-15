export const googleAvailable = () => false;
export async function googleIdToken(): Promise<string> {
  throw new Error('Google sign-in runs in the mobile app. Use dev sign-in in the preview.');
}
export async function googleSignOut() {}
