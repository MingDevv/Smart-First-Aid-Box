# chromium-policies.json — per-key notes

STATUS: NEVER APPLIED. No `chrome://policy` page on hardware has confirmed any of this.
The JSON parses (checked with `python3 -m json.tool` this session); that is the only
thing about it that has been verified.

This file exists because JSON has no comments and Chromium's policy loader does not
accept them. Do not add `_comment` keys to the JSON — they show up as "Unknown policy"
errors on `chrome://policy` and make the real errors harder to see.

Install: `/etc/chromium/policies/managed/sfab-kiosk.json`
Some Chromium packages read `/etc/chromium-browser/policies/managed/` instead. Which one
Raspberry Pi OS uses for its `chromium-browser` package is **not verified here** — install
into both, then confirm on `chrome://policy` which one was loaded and delete the other.

Certainty column:
- **CERTAIN** — long-standing, stable Chrome Enterprise policy name.
- **VERIFY** — I believe this key exists but have not confirmed it against the Chromium
  version on the device. Check `chrome://policy`: an unknown key is listed with an error
  and is simply ignored, so a wrong guess here is noisy, not dangerous.

| Key | Value | Certainty | Why |
|---|---|---|---|
| `URLBlocklist` | `["*"]` | CERTAIN | Deny-all navigation, then allowlist back. |
| `URLAllowlist` | kiosk origins | CERTAIN | Allowlist entries win over blocklist entries. |
| `RestoreOnStartup` | `4` | CERTAIN | 4 = "open a list of URLs". Kills session-restore prompts. |
| `RestoreOnStartupURLs` | `/kiosk` | CERTAIN | Same URL the command line opens. |
| `DeveloperToolsAvailability` | `2` | CERTAIN | 2 = disallowed everywhere. Blocks F12 / Ctrl+Shift+I. |
| `PrintingEnabled` | `false` | CERTAIN | No print dialog to get stuck behind. |
| `DownloadRestrictions` | `3` | CERTAIN | 3 = block all downloads. |
| `PromptForDownloadLocation` | `false` | CERTAIN | Belt for the above: never open a save dialog. |
| `IncognitoModeAvailability` | `1` | CERTAIN | 1 = disabled. See the warning below about profile data. |
| `BrowserSignin` | `0` | CERTAIN | 0 = disable browser sign-in. |
| `SyncDisabled` | `true` | CERTAIN | Nothing on a cabinet should sync to an account. |
| `PasswordManagerEnabled` | `false` | CERTAIN | No save-password bubbles. |
| `PasswordLeakDetectionEnabled` | `false` | CERTAIN | Would phone home on an offline device. |
| `AutofillAddressEnabled` | `false` | CERTAIN | Student IDs are typed here; do not retain them. |
| `AutofillCreditCardEnabled` | `false` | CERTAIN | Same. |
| `VideoCaptureAllowed` | `true` | CERTAIN | Must stay true or the allowlist below has nothing to grant. |
| `VideoCaptureAllowedUrls` | kiosk origins | CERTAIN | **This is the camera grant.** Auto-allows `getUserMedia` video for those origins with no prompt. |
| `AudioCaptureAllowed` | `false` | CERTAIN | `kiosk-app.js` asks for `{video:true, audio:false}`. The cabinet never needs a microphone in a school corridor. |
| `DefaultGeolocationSetting` | `2` | CERTAIN | 2 = block. |
| `DefaultNotificationsSetting` | `2` | CERTAIN | 2 = block. A notification prompt on a kiosk is a dead end. |
| `DefaultPopupsSetting` | `2` | CERTAIN | 2 = block. |
| `DefaultFileSystemReadGuardSetting` | `2` | VERIFY | Blocks the File System Access API. The kiosk page deliberately has no `<input type=file>`; this closes the scripted route to an OS file picker too. |
| `DefaultFileSystemWriteGuardSetting` | `2` | VERIFY | Same. |
| `DefaultSerialGuardSetting` | `2` | VERIFY | No page should reach a serial device directly. Cabinet control goes through the edge service, which owns the SQLite anti-replay journal. A page with raw serial access would bypass that entirely. |
| `DefaultWebUsbGuardSetting` | `2` | VERIFY | Same reasoning. |
| `DefaultWebBluetoothGuardSetting` | `2` | VERIFY | Same reasoning. |
| `ExtensionInstallBlocklist` | `["*"]` | CERTAIN | No extensions at all. |
| `BookmarkBarEnabled` | `false` | CERTAIN | Cosmetic; no bar under `--kiosk` anyway. |
| `EditBookmarksEnabled` | `false` | CERTAIN | Removes a Ctrl+D bubble. |
| `ShowHomeButton` | `false` | CERTAIN | Cosmetic. |
| `TranslateEnabled` | `false` | CERTAIN | The page is Thai. The translate bar would cover the UI. Authoritative control; the `--disable-features=Translate` flag is the backup. |
| `SpellcheckEnabled` | `false` | CERTAIN | Also stops the dictionary download on first run. |
| `SearchSuggestEnabled` | `false` | CERTAIN | No suggestion traffic. |
| `DefaultSearchProviderEnabled` | `false` | CERTAIN | Nothing typed anywhere should become a web search. |
| `BackgroundModeEnabled` | `false` | CERTAIN | No lingering background process after exit — the kiosk unit's `Restart=always` must be the only thing bringing Chromium back. |
| `PromotionalTabsEnabled` | `false` | CERTAIN | Suppresses welcome / what's-new tabs after an update. |
| `DefaultBrowserSettingEnabled` | `false` | CERTAIN | No "make default" prompt. |
| `MetricsReportingEnabled` | `false` | CERTAIN | Offline device; also a privacy default for a page that holds student photos. |
| `SafeBrowsingEnabled` | `false` | CERTAIN (key) / judgement call (value) | Navigation is already restricted to one loopback origin and all downloads are blocked, so Safe Browsing has nothing left to protect — it would only add failing network calls on a cabinet designed to run with the internet unplugged. If you later widen `URLAllowlist` to any real site, **set this back to `true` in the same edit.** |

## Deliberately NOT set — and why

These are the ones a kiosk guide will tell you to add. Each would cause a specific
failure here.

- **`ForceEphemeralProfiles`** — discards the profile on exit. `js/storage.js` keeps the
  medicine stock (`smart_first_aid_medicine`) and the treatment history in
  **`localStorage`**, inside that profile. Combined with the kiosk unit's
  `Restart=always`, this policy would wipe the cabinet's stock every time the browser
  restarted. That is a direct breach of the invariant that ending a round must never
  clear the medicine stock.
- **`ClearBrowsingDataOnExitList`** — same failure if the list includes cookies or site
  data. If you ever need it, it must exclude `cookies_and_other_site_data`.
- **`--incognito` / `IncognitoModeAvailability` set to *force* incognito** — same
  failure again. The policy here **disables** incognito (value `1`); do not confuse that
  with value `2`, which forces it.
- **`FullscreenAllowed`** — I am not certain this key applies to Chromium on Linux, and
  the downside is asymmetric: if it exists and lands as `false`, it breaks `--kiosk`
  itself. Left out on purpose.
- **`KioskMode`, `DeviceLocalAccounts`, `SystemFeaturesDisableList`** — ChromeOS-only
  policies. They do nothing on Raspberry Pi OS. Do not add them to make the file look
  more locked down; they only add "Unknown policy" noise that hides real errors.
- **`AutoplayAllowed`** — has moved between deprecated and supported across releases.
  The `--autoplay-policy` switch in the flags file is the stable route.

## Limits of `URLAllowlist` — read before believing the cabinet is sealed

`URLBlocklist` / `URLAllowlist` govern **navigation**. They do **not** filter
`fetch()` / `XMLHttpRequest` / WebSocket traffic from a page that is already loaded.
Concretely, on this app:

- `/api/analyze` (Gemini) and `/api/notify` (LINE) still work, because the **Pi's Node
  process** makes those outbound calls, not the browser. Blocking navigation does not
  touch them.
- `js/storage.js#syncToSupabase` fetches a Supabase URL **from the browser** when one is
  configured in settings. The allowlist will not stop that request. It is inert by
  default (`supabaseUrl` starts empty), but do not describe this policy file as a
  network lockdown, because it is not one. If outbound traffic must actually be
  constrained, do it at the router or with the `IPAddressAllow`/`IPAddressDeny` block in
  `sfab-edge.service` — and read the warning attached to it first.

## Verifying the policy actually loaded

`URLBlocklist: ["*"]` blocks `chrome://policy` too, which is the page you need in order
to check the policy. Two ways out, in order of preference:

1. During the verification pass only, add `"chrome://policy"` and `"chrome://version"` to
   `URLAllowlist`, restart Chromium, read both pages, then remove the two entries and
   restart again. Leaves no permanent extra surface.
2. Launch Chromium once by hand without `--kiosk` from a maintenance SSH session (see
   `README.md`) and read the pages there.

On `chrome://policy`, check three things, not one: that the **source** is "Platform" (so
the right directory was used), that **no key shows an error** (so no name is wrong), and
that `VideoCaptureAllowedUrls` shows the origin the browser is actually on.
