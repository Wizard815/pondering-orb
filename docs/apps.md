# Orb's apps: Windows, Linux and Android

The same Orb you use in the browser, in its own window or on your phone, plus
what a browser tab can't do: notifications, a tray icon, shortcuts, home-screen
widgets and a Quick Settings tile. The apps show your Orb's own page, so every
panel works the same, and they reach it at any address: your Cloudflare tunnel
(`https://orb.thefellashub.com`) or the LAN (`http://192.168.20.5:8095`).

## Get them

From the repository's **Releases** page:

- **apps-latest**: built from `main` every time the apps change.
- **v1.2.3**: a tagged version.

| You have | Download | Install |
| --- | --- | --- |
| Windows 10 or 11 | `Pondering-Orb-…-win-x64.exe` | Run it. It installs for you only; no admin needed. Windows may warn about an unknown publisher (the app isn't code-signed): *More info* → *Run anyway*. |
| Linux, any | `Pondering-Orb-…-linux-x86_64.AppImage` | `chmod +x` it and run it. |
| Debian, Ubuntu, Mint | `Pondering-Orb-…-linux-amd64.deb` | `sudo apt install ./Pondering-Orb-…deb` |
| Android 8 or newer | `Pondering-Orb-android.apk` | Open it on the phone and allow installs from your browser or file manager when asked. |

To build them yourself, see [Build](#build).

## Sign in

Each app asks for Orb's address, Orb's password and a name for the device
("Wizard's laptop"). The password is used once: Orb gives that device its own
key and the app keeps only the key, encrypted by the computer's keychain (Windows
DPAPI, a Linux keyring) or the Android Keystore.

**Settings → Devices** in Orb lists every signed-in app with when it was last
seen. **Sign out** there removes its key at once; the app goes back to its
sign-in screen. Do that for a lost phone: a device key can do anything you can,
including picks and orders.

Wrong passwords count toward the same ten-in-ten-minutes lock as the web page.

## Cloudflare Access

A tunnel alone needs nothing extra. If Orb is also behind **Cloudflare Access**:

- **The window** shows Access's sign-in page the first time, like a browser,
  and carries on to Orb after.
- **Background checks** (notifications, the tray, widgets) can't answer a
  sign-in page. Either:
  - add a **service token** in the app (Zero Trust → Access → Service
    Auth → Create; then add a *Service Auth* rule for it to Orb's Access
    application). The apps send it on every request. Or
  - rely on the Access cookie from the window's sign-in. That works until the
    Access session expires (24 hours by default), then the background checks
    stop until you open Orb again.

The service token's secret is kept encrypted with the device key.

## Notifications

The apps check Orb every minute (desktop) or every 15 minutes (Android, the
shortest Android allows). Nothing goes through Google's or Microsoft's push
services, and ntfy isn't needed. You get the same alerts ntfy gets:

| Alert | When |
| --- | --- |
| Services | an Uptime Kuma monitor goes down or comes back, or Kuma can't be read |
| Morning brief | the automatic brief is written |
| Media | Seerr has new requests waiting, a Sonarr or Radarr download finishes or gets stuck |
| Outbox | a write to CalDAV or the wiki keeps failing |

Choose which kinds in **Settings → Connections → ntfy → Send** (empty: all);
the list applies to the apps too, even with no ntfy address. Turn them off per
device in the app. A new install starts from now, so old alerts aren't
replayed; after a long time offline you get the last three and "N more".

## Desktop (Windows and Linux)

- **Orb in its own window.** Links to other apps open in your browser.
- **The tray**: the orb icon gets a red dot when something is down. Its menu
  shows what's down, today's events, the media lines, and **Tick off a task**.
  Click the icon to show or hide Orb.
- **Shortcuts from anywhere**: `Ctrl+Alt+O` shows or hides Orb, `Ctrl+Alt+M`
  opens **Orb at a glance**, a small window that stays on top: services,
  the brief, today, tasks (tick them off), chores and media. Change them in
  the app's Settings.
- **Start in the tray** when you sign in to the computer (Settings, or the
  tray menu).
- **Closing the window** keeps Orb in the tray. Quit from the tray menu.
- **Offline**: when Orb can't be reached, the window shows what Orb last
  showed and comes back by itself when Orb answers.

**What goes wrong:**

- *No tray icon on GNOME*: install the *AppIndicator and KStatusNotifierItem
  Support* extension.
- *"No keyring was found"* (Linux): the key is kept in a file only your account
  can read. Install and unlock GNOME Keyring or KWallet to encrypt it.
- *A shortcut "didn't work"*: another app uses it. Pick another one.
- *Windows doesn't show notifications*: Settings → System → Notifications →
  Pondering Orb.

## Android

- **Orb in the app**, signed in. ⋮ → *Reload*, *Check now*, *App settings*.
- **Home-screen widgets** (long-press the home screen → Widgets → Pondering Orb):

  | Widget | Shows | Tap |
  | --- | --- | --- |
  | Orb: services | "All 14 up", or what's down, in red | Uptime |
  | Orb: today | the brief's first line, today's events, chores due | Daily |
  | Orb: tasks | open tasks, a circle to tick one off | To-do |
  | Orb: media | one line each for Plex, Tautulli, SABnzbd, Sonarr, Radarr and Seerr | Main |

  ↻ on any widget checks now. Widgets update with each check and show how old
  their data is.
- **Quick Settings tile**: edit Quick Settings and drag *Orb* in. It shows the
  status and opens Orb (on Uptime when something is down).
- **App shortcuts** (long-press the icon): *Add a task*, *To-do*, *Daily*,
  *Uptime*.
- **Share → Pondering Orb** from any app: the text or link becomes a task or a
  log entry.
- **Lock screen**: notifications say only "New alert" until you unlock.
- **Offline**: the app shows Orb from its cache, or what Orb last showed.

**What goes wrong:**

- *No notifications*: allow them when the app asks, or in Android's settings
  for Pondering Orb. Some phones (Xiaomi, Huawei, Samsung's "sleeping apps")
  stop background checks: set battery use for Orb to *Unrestricted*.
- *Widgets say "Cloudflare Access is asking for a sign-in"*: add a service
  token (above).
- *"App not installed" when updating*: the new APK was signed with a
  different key. Uninstall, then install. Add a signing key (below) so updates
  install over the old version.

## Build

### Desktop

Node 22. In `desktop/`:

```bash
npm ci
npm test                    # unit tests
xvfb-run -a npm run e2e     # the real app against a real Orb (build the web page first: npm run build at the root)
npm run dist                # release/: AppImage and .deb on Linux, the .exe installer on Windows
```

### Android

JDK 17 and the Android SDK (`platforms;android-35`, `build-tools;35.0.0`). In
`android/`:

```bash
./gradlew testDebugUnitTest          # unit tests
./gradlew recordPaparazziDebug       # pictures of the widgets in app/src/test/snapshots
./gradlew assembleRelease            # app/build/outputs/apk/release/app-release.apk
```

**Signing.** Without a key, release APKs are signed with the build machine's
debug key, which differs per machine, so an update won't install over the
previous version. Make one key and keep it:

```bash
keytool -genkeypair -v -keystore orb.jks -alias orb -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 orb.jks   # paste into the repository secret ORB_KEYSTORE_B64
```

Then add the secrets `ORB_KEYSTORE_PASSWORD`, `ORB_KEY_ALIAS` (`orb`) and
`ORB_KEY_PASSWORD` in GitHub (Settings → Secrets and variables → Actions). For
a local build, set `ORB_KEYSTORE=/path/to/orb.jks` and the same variables.
Keep `orb.jks` safe: losing it means uninstalling before the next update.

### The API the apps use

| Call | What |
| --- | --- |
| `POST /api/devices` `{password, name, platform}` | sign a device in; returns its key (`orbd_…`) once |
| `POST /api/devices/session` (device key) | a session cookie for the app's window |
| `GET /api/devices`, `DELETE /api/devices/:id` | Settings → Devices |
| `GET /api/glance` | services, today's events, tasks, chores due, the brief's first line, one line per media widget |
| `GET /api/alerts?since=<ms>` | the alerts since then (the last 100 are kept) |
| `POST /api/glance/tasks/:id/done` | tick a task off |

Device keys act as you; agent tokens (`ORB_API_TOKENS`) can't list or remove
devices.
