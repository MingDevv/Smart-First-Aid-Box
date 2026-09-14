# Student roster and cabinet cards (WP3)

Staff use `/dashboard/students`; teacher and admin have identical roster capabilities. The dashboard main content links to it. Students use their verified school Google account at `/student/history`; a staff member must explicitly link that email in the roster first. Account identity never comes from a supplied student ID or QR in a browser request.

The roster is the source of identity. Documents are `students/{studentId}`, keyed by the school's stable student number (ASCII letters/digits/underscore/hyphen, 1–32 characters, leading zeros retained). Given name and surname are independent Unicode strings; `name` is derived for the existing LINE projection. `classLevel` and `room` retain school formatting. `schoolEmail` is optional, unique, and limited to tesaban6.ac.th. Staff must verify it belongs to the student before linking. Empty allergy fields mean unknown, not no allergies.

All reads/writes go through `/api/students` with server authorization and explicit projections. Firestore students/photos client denial is unchanged. Staff can read the roster, export, preview/confirm imports, view student history, and print or replace a card. Students can only request `action=me`, which resolves their verified Google email against the source roster and returns their own record/history. History pages use a scoped cursor and composite index from `firestore.indexes.json`. Cabinet timestamps remain explicitly untrusted unless the cabinet reports otherwise; ACK does not prove collection of supplies.

## CSV

The UTF-8 CSV header is:

```
studentId,givenName,surname,classLevel,room,drugAllergies,foodAllergies,schoolEmail
```

The UI downloads a three-student synthetic template. It never seeds production. Actual demo names and allergy records must come from the school; no invented clinical data is presented as real.

Limits: 1 MiB CSV, 200 imported records per file, 2,000 characters per allergy cell and 160 per name/class/room/email cell, 500 roster records. Larger imports must be split into files of at most 200 records. Export includes the whole roster and may therefore need splitting before reimport. Invalid shape, duplicate IDs/email links, control characters, oversized fields, and malformed CSV are rejected. No silent truncation.

The preview lists create/update/skip/reject with full proposed field values. Confirm recomputes the plan inside a Firestore transaction and checks its digest; a changed source record yields `preview_changed`. Any rejected row blocks the entire import. Reimporting the same file creates no duplicates. Existing cards survive updates.

Export is limited to once per minute per staff UID across function instances, with an `_studentAudit` record containing actor/action/time, not allergy values. UTF-8 BOM and CRLF support Thai Excel. Every cell is CSV-quoted; formula-leading values additionally receive an apostrophe (quoting alone does not neutralize Excel formulas). CSV has no column types: when opening in Excel use **Data → From Text/CSV**, UTF-8, and treat studentId/room as Text to preserve leading zeros. The server parser preserves them. Export contains health information and is labelled accordingly in the UI.

## Cabinet identification

Bank chose printed, reusable, cabinet-only cards and accepted impersonation by copying a card at the cabinet. A code is `SFAB3:` plus 256 random bits. It is not a URL, Google credential or remotely accepted browser token. No name, email or allergy is encoded. Recognition is an exact SHA-256 allowlist match, not an asserted student number; unpredictable codes and the authenticated roster make invented cards fail without adding an Ed25519 signing-key lifecycle.

`GET /api/sync` extends the existing SFAB1 signed bundle with a roster containing only studentId, givenName, surname, and cardHash. The Pi persists it in SQLite. No allergies, email, raw card codes, photos or student history are cached. No Firebase credential is installed on the cabinet. Staff-only card printing returns the raw code; ordinary roster reads and CSV do not. Cache replacement is atomic; deleted/replaced hashes disappear after sync.

Flow: landing → Start → existing webcam scans card → greeting → existing wound choice/photo/manual flow. The same getUserMedia function requests 1280×720 for both uses, releases tracks between uses, and fences late callbacks by generation. `js/qr-sdk.js` bundles jsQR and qrcode locally during build; the cabinet makes no CDN request. Camera failure/unknown card leaves help available and offers a return to the landing page. There is no anonymous dispense bypass.

Default lifecycle: one command per scan; UI clears identity on end/back/reload/idle. Existing idle policy remains 60 seconds for interaction and 180 seconds for reading, with its warning and in-flight command protections. The Pi also expires a card session after 10 minutes. An identical command retry can retrieve the original outcome; a confirmed or uncertain command consumes the scan. A rejected command proven not to have actuated releases the reservation so the existing safe-retry flow can continue. Physical uncertainty continues to hold the cabinet independently of student identity. SOS remains available without a scan.

Before dispatch, the Pi persists the student document ID and card hash alongside the pending command. Restart recovery and outbox delivery retain attribution. Events carry `uid = studentId = students document ID`, `badgeId = cardHash`, and `verifiedBy = cabinet_card`; this UID is a roster identifier, not a Firebase Auth UID. Unidentified legacy/cloud commands retain null identity. LINE's separate resolveStudent implementation can read only name and room; WP3 does not change either LINE implementation file.

Staff can print the same card again or replace a lost card. Replacement generates a new random code; an offline cabinet will continue accepting the old card until its next successful roster sync. The screen states this limit. Google account access and remote `/api/command` permissions are unchanged.

## Rollout and human acceptance

1. Review/merge through Khai and Bank; this change does not authorize a deploy or hardware operation.
2. Deploy the new Firestore index and wait until ready. Retain students/photos client denial. Provision matching cabinet sync configuration through Bank; WP3 does not set production secrets.
3. Build the web bundle (`npm ci`, `npm run build`) before cabinet rollout, so the ignored generated `js/qr-sdk.js` is present. Preserve the SQLite database; the additive command column migrates in place. Run under Node 24 as verified in development.
4. Import the school's real three-student CSV; repeat it and confirm create=0. Export and reopen via Excel UTF-8/Text import; check Thai names, leading zeros, and allergy cells. A synthetic test is not proof of the school's file or Excel behavior.
5. Print each card, complete one successful signed roster sync, disconnect LAN, and scan at the actual cabinet with the existing webcam. Confirm the name, finish the unchanged flow with physical observation, and verify the next student sees the landing page and must scan.
6. Reconnect; verify correctly attributed Firestore/history and one LINE notification per event. Replace a card, sync, and confirm the old print is rejected. Physical acceptance, actual printing, Excel, production sync and LINE remain operator checks.

Mechanical checks: `npm ci`, `npm run build`, `npm test`, `npm run test:firebase`. New tests cover real QR encode/decode, offline matching, one-command/expiry/reset/rotation, local HTTP enforcement, journal crash recovery, actual Firebase tokens, duplicate import, stale preview, audit/rate limit, minimal signed roster, identified ingest and own-history isolation.
