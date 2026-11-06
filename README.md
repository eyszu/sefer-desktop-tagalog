# Ang Biblia Viewer (Tauri v2)

Verse-by-verse viewer for the TagAngBiblia SQLite database (bundled at `src-tauri/resources/TagAngBiblia.db`, opened read-only).

## Run
Prerequisites: Rust, Node.js, and the Tauri platform deps (https://tauri.app/start/prerequisites/).

    npm install
    npm run dev        # development
    npm run build      # installer / bundle

## Usage
- **← / →** previous / next verse (crosses chapter and book boundaries)
- **Book / Chapter / Verse** inputs with autocomplete dropdowns (`1 sam` → I Samuel). Enter picks and advances; Enter on Verse goes.
- **History ▾** last 100 locations (saved between runs)
- **Search** tab (or press `/`): all words must match; optional book filter; click a result to open it.
