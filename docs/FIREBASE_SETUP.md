# Firebase Auth and roles (WP1)

WP1 implements Google school sign-in, API authorization and Firestore read rules. Development and evidence use only demo-sfab on local emulators. This change does not provision, deploy, enable billing or contact a cabinet.

## Local development

The runtime floor is Node 22; use Node 24 and Java 21 for development and CI. Validated with Node 24.21.0, npm 11.19.1 and Java 21.

Run npm ci, npm run build, npm test, then npm run test:firebase.

The last command starts and stops Auth and Firestore emulators, creates synthetic identities and records, and runs actual ID-token/API and get/list/write rules tests. Ports 9099 and 8080 must be free. No real LINE or MQTT configuration is inherited. The API test supplies its own loopback MQTT broker and proves the existing drawer ACK path for teacher and admin.

For an interactive browser session, run these commands in separate terminals:

    node --env-file=.env.emulator.example node_modules/firebase-tools/lib/bin/firebase.js emulators:start --project demo-sfab --only auth,firestore

    node --env-file=.env.emulator.example scripts/dev-web.mjs

Open http://127.0.0.1:4173/student/. Google sign-in opens the Auth Emulator account picker. Add a synthetic school address. Do not enter a real Google password. New school users default to student. Seed a role for that synthetic account:

    node --env-file=.env.emulator.example scripts/emulator-role.mjs synthetic-student@tesaban6.ac.th teacher

Allowed roles: student (remove the role), teacher, admin. Refresh the page to refresh its presentation; the server reads the role on every request. The local web server strips LINE and MQTT environment variables, so SOS/commands report unavailable and cannot reach live recipients or hardware.

The emulators bind to loopback and require an explicit demo-project opt-in. Emulator flags are rejected on Vercel or with NODE_ENV=production, non-demo project IDs, or partial/non-loopback hosts. The SDK accepts unsigned emulator tokens locally; production cryptographic verification uses Firebase Admin verifyIdToken with revoked/disabled-user checks. Emulator success does not prove production OAuth or Workspace policy.

## WP0 contract: school administrators own these steps

| Vercel variable | Source and handling |
| --- | --- |
| FIREBASE_PROJECT_ID | School Firebase project ID; shared by Admin and public web config. |
| FIREBASE_CLIENT_EMAIL | Dedicated service-account email; Sensitive server environment variable. |
| FIREBASE_PRIVATE_KEY | Service-account PEM; Sensitive server environment variable. Literal PEM newlines or escaped newlines are accepted. Never expose through public config, browser, Pi, logs or Git. |
| FIREBASE_WEB_API_KEY | Public registered web app SDK API key. |
| FIREBASE_AUTH_DOMAIN | Registered web app auth domain, usually the project firebaseapp.com domain. |
| FIREBASE_WEB_APP_ID | Public registered web app ID. |

The local-only variables are SFAB_USE_FIREBASE_EMULATORS=true, FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099, FIRESTORE_EMULATOR_HOST=127.0.0.1:8080, with FIREBASE_PROJECT_ID=demo-sfab. Never add these emulator settings to Vercel. No Storage bucket variable is used.

1. Keep the Firebase project inside the school organization on Spark. No billing link, Cloud Storage, Cloud Functions or Firestore TTL provisioning is required.
2. Create Firestore (default) in asia-southeast1; keep existing deny-all placeholder rules until a reviewed release is authorized.
3. Register the web app and provide the four public config values above. Enable Authentication > Google with the school support email. Add only the actual web origins under Authentication > Settings > Authorized domains. Configure matching authorized JavaScript origins and the auth-domain /__/auth/handler redirect URI in the matching Google OAuth web client when needed.
4. In Google Auth Platform, set the OAuth audience to Internal in the school organization. In Workspace Admin > Security > Access and data control > API controls, configure the app by its exact OAuth client ID as trusted/allowed for the intended student organizational units, including users under 18. Verify this with an actual student account; hd in the picker is only a hint.
5. Use a dedicated service account in this project with roles/datastore.user and roles/firebaseauth.viewer. The latter permits the user lookup required for revoked/disabled-token checks. Store the key in Vercel Sensitive env, scoped to the release environments Bank chooses. Admin SDK bypasses Firestore rules, so the API authorization helper is required independently.
6. Bootstrap the first administrator manually in Firestore: roles/<Firebase Auth UID> with exactly role: "admin". Use the UID from Firebase Authentication, not an email, display name or student number. Add approved teacher/admin UIDs the same way. All browser role writes are denied; missing/unknown roles grant only student access.
7. Once release is separately authorized, publish the reviewed Firestore rules and application with its environment configuration. Test a real school student on iPhone Safari and Android Chrome, an unverified/external account, sign-out, staff access and role removal. Do not treat emulator accounts as evidence for Internal audience or under-18 access.

Existing MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD, MQTT_BASE_TOPIC, LINE_CHANNEL_ACCESS_TOKEN and LINE_GROUP_ID stay server-only. They are not needed for offline WP1 checks. Cloud SOS requires both LINE values and has no broadcast fallback.

## Access contract and later work

- /api/command GET and POST require a verified school ID token and current teacher/admin role, including buzzer operations. Missing/invalid/expired/revoked tokens produce 401; authenticated forbidden users produce 403. Auth/role lookup failures close access with 503 before MQTT starts.
- /api/notify POST accepts any verified school user only for { "event": "sos" }. It derives the sender from the verified token; client UID/name/Flex/messages are ignored. Other event kinds are rejected. Only server-generated first name, UID reference and time go to the configured LINE target. Successful SOS deliveries are deduplicated per UID for 120 seconds; concurrent requests share the actual delivery outcome. A duplicate returns 200 with deduplicated:true only after LINE acceptance. Failed sends remain 503 and can be retried. New attempts, including failures, are capped globally at 10 per minute per instance (429 with Retry-After). These in-memory limits do not coordinate separate Vercel instances.
- /api/me returns only uid, email, name, effective role, and profile.active (boolean or null). Clinical fields and studentNo are never included. /api/firebase-config exposes only registered public SDK configuration.
- Firestore denies every client write and unmatched read. Students and photos deny direct client reads for every role; their approved fields reach the browser only through explicit server projections. Students may read only their own dispenses, using a UID-constrained list query; staff may read cabinet status. Teacher and admin are equal readers (Bank, 2026-09-14); only /api/roles remains admin-only.
- Firebase handles its own session persistence in IndexedDB. Application localStorage contains UI preferences only; legacy identity/PIN/mode/inventory/history values are ignored. Unsynced inventory/history and unimplemented digital badges show unavailable states, pending WP2-WP4.
- Local Pi runtime remains authoritative for its own mode. Only physical open is gated by mode; local SOS/buzzer and the guide remain accessible. Cloud student SOS does not request a buzzer. The one-line edge/controller.mjs gate adjustment is isolated for the separate Pi bridge change.
- Photos are a WP4 Firestore concern: photos/{eventId}, JPEG base64 up to 300 KB, dispenses.photoId. WP4 must add expiresAt read enforcement in API/rules, short-lived signed image URLs and daily /api/cron/cleanup deletion using CRON_SECRET before accepting any photos. No TTL provisioning or photo/cron endpoint is included in WP1.

## Ordered pre-merge gate (Bank/Khai)

Merging master deploys production. Missing Firebase env correctly fails closed, but would interrupt school sign-in and cloud commands. Complete these gates in order; the implementation PR does not authorize any deployment or merge.

1. Set the six FIREBASE variables above on the Vercel project for Preview and Production, keeping the service-account values Sensitive. Resolve project/team access first. Complete WP0 Google provider, Internal audience, under-18 trust and role bootstrap before live acceptance.
2. Add smart-first-aid-box.vercel.app to Firebase Authentication Authorized domains. Also authorize the exact preview hostname selected for K2; verify it against the Vercel project rather than allowing arbitrary preview domains.
3. Once those prerequisites are ready and Bank authorizes the preview, re-enable this branch preview by removing the branch-specific git.deploymentEnabled line in vercel.json. It remains disabled in this fix commit. Record the resulting preview URL and SHA.
4. Run K2 on that preview with a real std…@tesaban6.ac.th student account on iPhone Safari and Android Chrome. Check sign-in, student scanning/guide access, SOS sign-in guidance, sign-out, student command denial and staff access. Preserve the results; emulator tests cannot satisfy K2. Any physical-command acceptance must wait for the cabinet power-work hold to be lifted.
5. Only after K2 passes and review dispositions are closed may Bank merge. Nai leaves this PR open and does not merge or deploy.

If PR #17 merges first, resolve package.json scripts by keeping both tests/mqtt-cloud.test.mjs in test:edge and npm run test:auth in test, regenerate package-lock.json and rerun npm test plus npm run test:firebase before the final gate. Do not alter its worktree.

The gaxios 6.7.1 dependency uses compatible CommonJS uuid 11.1.1 through an override to remove the uuid buffer-bounds advisory. Gaxios calls v4() without caller-provided buffers; API/emulator checks and a clean install cover the resulting dependency tree.
