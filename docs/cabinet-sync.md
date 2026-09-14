# Cabinet history sync (WP2)

The Pi journal owns physical command evidence. Firestore holds a replica, shared inventory counts and cabinet configuration. No Firebase or LINE credential belongs on the Pi.

## Configuration and rollout

Pi user service environment:

- `SFAB_CABINET_ID`: `box1` (must match Vercel; do not rename after journaling).
- `SFAB_CABINET_SECRET`: shared random secret, at least 32 characters.
- `SFAB_SYNC_URL`: HTTPS origin of the deployed application.
- Existing `SFAB_DATABASE`, mode, serial and MQTT configuration remain in use.

Vercel requires the same cabinet ID/secret, the existing Firebase Admin configuration, and `LINE_CHANNEL_ACCESS_TOKEN` plus `LINE_GROUP_ID`. Preserve `outputDirectory: "."` and the `jwks-rsa` / `jose` override. Production-only environment variables do not automatically exist in previews; changes require a new deployment.

Before an authorized rollout, back up SQLite using its backup facilities (including committed WAL contents) and preserve service configuration. Deploy the reviewed APIs and rules, provision the matching secret without displaying it, then update/restart the Pi service. Remove Pi-side LINE credentials after verifying the new path. Retain the previous release and configuration as rollback evidence; a rollback must also restore its notification configuration if the old release requires it.

Deploy rules separately from Vercel code; a PR merge does not publish Firestore rules. This package does not deploy to production or actuate the physical cabinet.

## Wire and persistence contract

`POST /api/ingest` accepts at most 20 events / 64 KiB of JSON plus a bounded heartbeat. HMAC-SHA256 covers protocol version, HTTP method, fixed endpoint path, configured cabinet ID, millisecond timestamp, and SHA256 of the exact request bytes. Old requests (over 30 seconds) and future requests (over 2 seconds) fail. A bad cabinet clock queues locally until network time recovers; it never gates local SOS or dispensing. Clock trust remains explicitly `untrusted` until a later clock-verification implementation supplies evidence.

Dispense completion and its outbox row commit in the same SQLite transaction. Restart recovers pending physical commands as uncertain and queues their evidence, without replaying the actuator. The first upgrade backfills existing journal rows as historical and suppresses old LINE messages. Browser localStorage history is not imported. Wound type is the drawer mapping, not a stored AI diagnosis; item quantities and badge identity are unknown in WP2, so rows have empty `itemsUsed` and null UID/badge ID.

Firestore event IDs are `<cabinetId>~<journalId>`; the cabinet ID alphabet excludes `~`. Event payload hashes and server delivery records reject changed-content or cross-kind reuse. Event records and delivery state are created transactionally. Acknowledgments are signed and bound to the request signature. The Pi accepts only acknowledgments for the current batch.

The single-flight loop runs on boot, after new events, and every 60 seconds, backing off to five minutes on errors. New SOS entries are prioritized. Already-stored events retry LINE without preventing new events from reaching Firestore. Synced outbox rows remain in SQLite for audit. Manual-review delivery state retains ambiguous evidence without automatic resend.

`GET /api/sync` returns a signed, cabinet-scoped bundle containing inventory and pending clearing decisions. An ETag avoids rewriting unchanged cache data. Even 304 responses are authenticated and bound to the current request. WP2 caches clearing requests but does not clear physical holds; nurse clear controls and their application remain WP4. The cabinet heartbeat mirrors its current hold separately.

## LINE and SOS

LINE runs only on Vercel. Each event retains one UUID retry key and a frozen payload/recipient. A transactional lease controls concurrent senders. A timeout retries the same key; LINE 409 is success only with its accepted-request header. LINE retry-key retention is 24 hours; automatic retry stops conservatively 23 hours after the first attempt and marks the event for staff review, preventing an ambiguous old push from being delivered twice. No fallback broadcast or legacy LINE Notify path exists on the Pi.

Local SOS journals immediately regardless of sign-in, mode, network or buzzer availability. The buzzer remains an independent action; `buzzerAck:null` means the SOS row does not prove its outcome. Kiosk copy reports pending LINE delivery rather than claiming a queued event was delivered.

Web SOS also persists before delivery and accepts anonymous users. Its existing 120-second user/IP dedupe is additionally persisted across Vercel instances; source IP is not stored in the row or sent to LINE. A cabinet heartbeat retries pending web pushes. If the cabinet is offline, web retries require another request until it reconnects. The documented shared-IP dedupe tradeoff remains: two anonymous users on the same network within that window can coalesce. Identity remains optional enrichment.

## Dashboard and permissions

The September 14 decision gives teacher, nurse and admin the same history and inventory view. `/api/history` verifies a current staff role, returns an explicit projection, and pages 100 records ordered by server sync time plus document ID. Statistics describe the loaded rows, rather than presenting a partial page as an all-time total. Date displays warn about unverified cabinet clocks. Missing stock counts stay unknown; a drawer ACK never decrements a physical stock estimate.

Firestore staff read membership is shared. Student and photo documents deny direct client reads for every role; approved fields must pass through explicit server projections (`/api/me` already does this for the caller). `/api/roles` remains admin-only, and its page/sidebar/auth implementation is unchanged by WP2.

## Verification

Run the same four commands as CI under Node 24:

```
npm ci
npm run build
npm test
npm run test:firebase
```

The emulator suite uses synthetic identities, local SQLite, a fake hardware adapter and stubbed LINE delivery. It exercises two offline dispenses, reconnect, response loss after commit, restart, concurrent retry, immutable IDs, request tampering, signed cache, role revocation, equal staff projections and anonymous web SOS. These tests do not prove physical movement or real LINE delivery.

Physical acceptance after authorized rollout: disconnect LAN, dispense twice with observed cabinet movement, reconnect, verify exactly two new Firestore rows and exactly one actual LINE push per event. Confirm anonymous SOS still queues/alarms and the teacher dashboard matches admin. Stop on mismatched counts, missing journal evidence or an uncertain physical hold; do not retry a drawer command to test data delivery.
