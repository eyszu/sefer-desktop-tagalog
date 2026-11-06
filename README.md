# Ang Biblia Viewer (Tauri v2)

Verse-by-verse viewer for the TagAngBiblia SQLite database (bundled at `src-tauri/resources/TagAngBiblia.db`, opened read-only).

## Run
Prerequisites: Rust, Node.js, and the Tauri platform deps (https://tauri.app/start/prerequisites/).

    npm install
    npm run dev        # development
    npm run build      # installer / bundle

## Installation (windows)
- download the codes (zip)
- unzip and install Ang Biblia Viewer_0.1.0_x64_installer.msi

## Usage
- **← / →** previous / next verse (crosses chapter and book boundaries)
- **Book / Chapter / Verse** inputs with autocomplete dropdowns (`1 sam` → I Samuel). Enter picks and advances; Enter on Verse goes.
- **History ▾** last 100 locations (saved between runs)
- **Search** tab (or press `/`): all words must match; optional book filter; click a result to open it.


## Buiding in debian or mac

The command is the same on both: `npm run build` (which runs `tauri build`). Tauri builds for the OS it runs on, so each platform needs its own build. You can't produce a Mac app from Debian or the other way round.

**Debian**
- Install the system libraries first: `sudo apt install libwebkit2gtk-4.1-dev build-essential libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`. You also need Rust and Node.
- The output is in `src-tauri/target/release/bundle/`, as `.deb` and `.AppImage` files (`.rpm` as well if `rpmbuild` is installed).

**macOS**
- Install the Xcode command line tools (`xcode-select --install`), plus Rust and Node.
- The output is in `src-tauri/target/release/bundle/`, as a `.app` in `macos/` and a `.dmg` in `dmg/`.
- Without Apple code signing and notarization, the app works on your own machine. Other Macs will show a "can't be opened" warning that people have to click through.

The database is bundled through `"resources": ["resources/*"]` in `tauri.conf.json`, so it ends up inside the package on both systems with no extra steps.