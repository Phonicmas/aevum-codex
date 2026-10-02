# Aevum Codex (Foundry VTT module)

A GM compendium for the world of Aevum: a searchable codex browser, an interactive world map with pins, and file-based sync so the lore can be edited both in Foundry and by Claude.

The module itself contains **no lore**, only the code, the world map and the pin icons. The lore lives in your world as normal journals and is loaded from `aevum-codex-content.json`, so the module can be hosted publicly without exposing GM secrets.

## Install on Sqyre

Sqyre installs custom modules from a **manifest URL**. The simplest free host is a GitHub release:

1. Create a free GitHub account and a **public** repository named `aevum-codex`.
2. `module.json` already points at `github.com/Phonicmas/aevum-codex`. Use exactly that repository name, or the links won't resolve.
3. In the repository, click **Releases → Draft a new release**, tag `v1.0.0`, and attach **both** `module.json` and `aevum-codex.zip`. Publish it.
4. In Sqyre's **Module Manager**, choose **Install by manifest URL** and paste:
   `https://github.com/Phonicmas/aevum-codex/releases/latest/download/module.json`
5. Launch the game and enable **Aevum Codex** under *Manage Modules*.

If Sqyre's File Manager lets you upload into your `Data/modules` folder, you can instead unzip the module into `Data/modules/aevum-codex/` and skip GitHub.

**Updating the module later:** bump `version` in `module.json`, attach the new `module.json` and zip to a new release, then click update in Sqyre or Foundry.

## First-time setup in Foundry

1. Open the **Journal** tab and click **Aevum Codex** (or press **Alt+C**).
2. Click **Import content file** and choose `aevum-codex-content.json`.
3. The journals are created under the **Aevum Codex** folder, and the **Aevum — World Map** scene is built with a pin for every place.

Everything starts hidden from players.

## Day-to-day use

- **Codex browser:** search box, category chips, folder tree, page tabs. Codex links inside a page navigate within the browser (shift-click opens the normal journal sheet). **Back** returns to the previous page.
- **Open / Edit:** opens the journal sheet or the page editor. Edit freely; it's a normal journal.
- **Map:** jumps to the page's pin on the world map.
- **Visibility:** *Hide from players*, *Reveal this page only* or *Reveal whole journal*. GM-only secret blocks stay hidden even on revealed pages. A pin only appears for players once its page is visible to them, and players need note display switched on.
- **Pins:** drag a pin on the world map and its new position is saved into the page. Drag a codex page onto the world map to give it a pin. Delete a pin to remove it. **Sync pins** rebuilds the pins from the codex.
- **New entries:** create journals or pages anywhere inside the *Aevum Codex* folder and they become part of the codex.

## Syncing with Claude

**Foundry → Claude:** click **Export for Claude**. A file `aevum-codex-export-….json` downloads. Upload it to the Claude project (or drop it in the chat). It contains every codex journal, your edits, pin positions and anything you deleted.

**Claude → Foundry:** Claude gives you an `aevum-codex-update.json` (or similar). Click **Import update** and choose it. A preview shows:

- **new / updated:** applied.
- **kept:** pages you changed in Foundry that Claude didn't touch stay as they are.
- **conflicts:** pages changed in both places. Unticked keeps your Foundry version; ticked takes Claude's and saves your version in the *Aevum Codex Backups* journal first.
- **deleted in Foundry:** stays deleted unless you tick it.
- **removed in the update:** deleted only if ticked (and unticked by default if you edited it).

Export before asking Claude for changes, so Claude works from your latest version and you avoid conflicts.

## Simple Quest

If **Simple Quest** is active (setting: *Use Simple Quest*):

- The *Aevum Quest Log* journal's pages are created as **SQ Quest** pages, with the bullet list as objectives. All quests start hidden.
- **Quests** opens Simple Quest's quest tab.
- **SQ map** views the world map scene and runs Simple Quest's *scene to map* conversion, turning the pins into SQ markers. It's a one-way copy.
- The scroll button on a page opens it in Simple Quest.

Simple Quest shows each folder inside its *Root* folder as a tab. To browse the codex inside Simple Quest too, drag the whole **Aevum Codex** folder into Simple Quest's Root folder. The codex keeps working there, and imports won't move it back out.

## Macro / API

```js
const codex = game.modules.get("aevum-codex").api;
codex.open();                // open the browser
codex.open({ pageUuid });    // open at a page
codex.exportBundle();        // download export
codex.importFile();          // pick a file and import
codex.syncPins();            // rebuild map pins
```
