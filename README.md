# Touchless × HackerAI bridge

Control your Android phone from a [HackerAI](https://hackerai.co) chat, through [Touchless](https://touchless.tools).

HackerAI has no MCP and no API, but it can run shell commands on a machine you connect ("Remote Control"). This runs that machine **in Docker** with a web panel: you connect your phone and paste HackerAI's command once, and HackerAI drives the phone — apps, messages, automations, building apps in Touchless Studio, modding installed apps.

```
HackerAI chat ──► this container ──► Touchless ──► your phone
```

## Run

Needs [Docker](https://docs.docker.com/get-docker/) and the Touchless app on your phone.

```bash
git clone https://github.com/il90il90/touchless-hackerai-bridge
cd touchless-hackerai-bridge
docker compose up -d --build
```

Then open **http://localhost:8790** and follow the three steps:

1. **Phone** — in Touchless: Settings → AI connection, copy the secure address, paste it, approve on the phone.
2. **HackerAI** — in HackerAI: Settings → Remote Control → Copy command, paste it.
3. **Personalization** — copy the two texts into HackerAI → Settings → Personalization.

In a HackerAI chat, pick the computer `touchless-bridge` and ask for anything on your phone.

## From your phone

The panel is mobile-friendly, so you can do the whole setup from your phone's browser.

1. Set a **username + password** in the panel (Setup → Account & lock).
2. Restart with the port opened to your Wi-Fi: `BRIDGE_BIND=0.0.0.0 docker compose up -d`
3. On your phone (same Wi-Fi) open `http://<your PC's LAN IP>:8790` (find it with `ipconfig`).

It locks itself after 10 minutes idle. For access from outside your home, put it behind Tailscale rather than forwarding the port.

## Notes

- The panel is on `127.0.0.1` only and password-protected. Secrets stay in a root-only volume; the page never sees them.
- HackerAI's agent runs as an unprivileged user inside the container, so it can't reach your files or keys.
- Stop: `docker compose down`. Update: `git pull && docker compose up -d --build`.

## CI and releases

CI and releases run on a self-hosted GitHub Actions runner on the maintainer's PC (`.github/workflows/`).

- **CI** runs on every push to `main`: syntax-checks the JS, builds the Docker image and smoke-tests it.
- **Release**: push a tag that starts with `v`. The runner builds the image and publishes a GitHub Release with
  the image (`docker load` it) and a source zip.

```bash
git tag v1.2.3
git push origin v1.2.3
```

To re-run a release for an existing tag: Actions → Release → Run workflow, and enter the tag.
The runner only works while that PC is on and logged in. There's no `pull_request` trigger on purpose: the repo is
public, and a fork's PR would otherwise run its code on that machine.

**App release** (Actions → App release → Run workflow) publishes a signed Touchless Bridge Android APK as
`app-v<versionCode>`. The app is built and signed in the Touchless repo; the steps are at the top of
`.github/workflows/app-release.yml`. It checks the APK's signing certificate before publishing. It is the one
workflow that runs on GitHub's machine: it runs no code from the repo, and needs the Android build-tools.

MIT. Bundles [@hackerai/local](https://www.npmjs.com/package/@hackerai/local) (MIT).
