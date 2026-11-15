# Release signing and store uploads (APP-05)

How Mehfil (`in.mehfil.app`) gets signed and onto the Play Store internal track. iOS (TestFlight via `match`/`gym`/`pilot`) is APP-05b in S7.

**Status:** pipeline written and the release JS bundle is checked in CI; **needs credentials** — Google Play organisation account (D-U-N-S), upload keystore, Play service account, Google OAuth Android clients. Native Android builds have not been run in the cloud sandbox (no Android SDK there); the PR workflow builds a debug APK on GitHub.

## Keys

| Key | Who holds it | Signs |
| --- | --- | --- |
| Debug key | Everyone (`android/app/debug.keystore`, password `android`) | Debug builds |
| Upload key | The product owner, outside git | Release AABs uploaded to Play |
| App signing key | Google (Play App Signing) | What users install |

Each key's SHA-1 needs its own **Android OAuth client** in Google Cloud (package `in.mehfil.app`). The app always requests ID tokens for the one **Web client ID**, which the API checks as the audience (`GOOGLE_WEB_CLIENT_ID`).

## One-time setup

1. Create the upload key outside the repo and back it up with its password:
   ```bash
   keytool -genkeypair -v -storetype PKCS12 -keystore ~/mehfil-upload.keystore -alias mehfil-upload -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Local release builds: add to `~/.gradle/gradle.properties` (not the repo):
   ```properties
   MEHFIL_UPLOAD_STORE_FILE=/Users/<you>/mehfil-upload.keystore
   MEHFIL_UPLOAD_STORE_PASSWORD=<password>
   MEHFIL_UPLOAD_KEY_ALIAS=mehfil-upload
   MEHFIL_UPLOAD_KEY_PASSWORD=<password>
   ```
   Without them a release build is signed with the debug key (fine for a test phone, refused by Play).
3. Register SHA-1s for Google sign-in: `keytool -list -v -keystore ~/mehfil-upload.keystore -alias mehfil-upload`, then in Google Cloud → Google Auth Platform → Clients → Create client → Android, package `in.mehfil.app`, paste the SHA-1. After the first upload, repeat with the **app signing key** SHA-1 from Play Console → Test and release → App integrity.
4. Play Console: create the app, enable Play App Signing, set up the **internal testing** track and its tester list, and create a **service account** with release permissions (JSON key).
5. GitHub → Settings → Environments → `play-internal` (require approval), secrets:
   `MEHFIL_UPLOAD_KEYSTORE_BASE64` (`base64 -i ~/mehfil-upload.keystore`), `MEHFIL_UPLOAD_STORE_PASSWORD`, `MEHFIL_UPLOAD_KEY_ALIAS`, `MEHFIL_UPLOAD_KEY_PASSWORD`, `MEHFIL_PLAY_JSON_KEY` (the JSON).
6. Set `config.googleWebClientId` in `apps/mobile/src/lib/config.ts` and `GOOGLE_WEB_CLIENT_ID` on the API.

## Releasing

```bash
git tag mobile-v0.1.0 && git push origin mobile-v0.1.0
```

`.github/workflows/mobile.yml` checks the release bundle has no dev-only code (`pnpm --filter @mehfil/mobile check:release`), builds a signed AAB (version name = tag, version code = run number) and uploads it to **internal testing** with `fastlane android internal`. Promote with `bundle exec fastlane android promote from:internal to:alpha` (closed testing for pilots), later `to:production rollout:0.1`.

## Guards

- Dev sign-in, its seed emails and local API URLs are compiled out of release builds (`__DEV__`); the release check fails the build if any survive. The API also refuses the dev bypass in production.
- `android:allowBackup="false"` so restored backups never carry session tokens.
- Keystores and service-account keys never enter git (`.gitignore` refuses `*.keystore` except the debug key).
