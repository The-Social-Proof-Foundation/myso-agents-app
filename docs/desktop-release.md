# MySo Agents desktop distribution

The Electron product identity is **MySo Agents**. The current package configuration targets macOS arm64, Windows x64 and Linux x64. Artifacts use the `MySo Agents-<version>-...` product name; Linux's executable is `myso-agents` and its desktop entry is `myso-agents.desktop`.

## Source packaging

`electron-builder.yml` keeps the Electron shell in `app.asar` and ships the Next.js standalone server as an extra resource. Build each server payload on its target operating system because Next traces native binaries for the build host. The local `desktop:dist` script packages with `--publish never`.

Static compilation can be checked with `npm run desktop:compile`. App launches, builds that start application processes, installer creation, signing, tests and human platform checks are owner-run activities. No runtime or release has been verified as part of source implementation.

## Owner-supplied distribution settings

The app bundle identifier is fixed as `com.mysocial.agents`, and the product/help URL is `https://mysocial.network/agents`. The supplied update-feed URL (`https://mysocial.network/agents/desktop/updates/stable`) and candidate GitHub release repository (`mysocial/agents-desktop-releases`) are placeholders only. Do not enable updates or distribution until the feed/repository is real and platform signing infrastructure is configured. Until then, produce only unsigned/ad-hoc development builds. Never reuse LearnHarness signing identities or publish a MySo Agents build to the upstream repository.

The GitHub release workflow must remain disabled until the actual destination and signing secrets are configured by the owner. The workflow's release flag alone is not sufficient authorization to distribute unsigned builds. The workflow also contains owner-run quality and platform packaging steps; they are not run during this implementation.

The packaged updater is disabled unless the owner configures `MYSO_AGENTS_UPDATE_FEED` with an HTTPS URL. There is no baked GitHub release feed. `publish: null` remains in `electron-builder.yml`; command-line release publishing must not be enabled until the owner has chosen and configured a destination.

## Current artifact names

The release verifier derives these from `productName: MySo Agents` and `package.json` version:

| Artifact | Platform |
|---|---|
| `MySo Agents-<version>-arm64.dmg` and `MySo Agents-<version>-arm64-mac.zip` | macOS arm64 |
| `MySo Agents-<version>-x64-setup.exe` | Windows x64 |
| `MySo Agents-<version>-x86_64.AppImage` and `MySo Agents-<version>-amd64.deb` | Linux x64 |

No installer, update feed, signature, notarization or release upload has been produced or verified.
