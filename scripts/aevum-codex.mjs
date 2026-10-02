/**
 * Aevum Codex — GM compendium for the world of Aevum.
 *
 *  - Codex browser (search, categories, preview, reveal, map focus)
 *  - File-based sync: "Export for Claude" / "Import update" with change preview + conflict detection
 *  - World map scene with pins that follow the codex pages (pin moves sync back into the pages)
 *  - Optional Simple Quest integration (quest pages, map conversion, open-in-SQ)
 *
 * Written for Foundry VTT v13 (works on v12).
 */

const MODULE_ID = "aevum-codex";
const MAP_SRC = `modules/${MODULE_ID}/assets/aevum-map.webp`;
const MAP_W = 7680;
const MAP_H = 4400;
const ICON_DIR = `modules/${MODULE_ID}/assets/icons`;
const PIN_TYPES = {
  capital:   { size: 72, label: "Capital" },
  citystate: { size: 64, label: "City state" },
  town:      { size: 56, label: "Town" },
  port:      { size: 56, label: "Port" },
  fortress:  { size: 60, label: "Fortress" },
  ruin:      { size: 56, label: "Ruin" },
  tower:     { size: 72, label: "World Tower" },
  region:    { size: 96, label: "Region" },
  island:    { size: 84, label: "Island" },
  forest:    { size: 64, label: "Forest" },
  mountains: { size: 64, label: "Mountains" },
  desert:    { size: 64, label: "Desert" },
  sea:       { size: 84, label: "Sea" },
  temple:    { size: 60, label: "Temple / shrine" },
  landmark:  { size: 56, label: "Landmark" }
};

/* -------------------------------------------- */
/*  Compatibility helpers                       */
/* -------------------------------------------- */

const OWN = () => CONST.DOCUMENT_OWNERSHIP_LEVELS;
const TextEditorImpl = () => foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
const DialogV2 = () => foundry.applications.api.DialogV2;
const saveFile = (data, type, name) => (foundry.utils.saveDataToFile ?? globalThis.saveDataToFile)(data, type, name);
const esc = (s) => foundry.utils.escapeHTML ? foundry.utils.escapeHTML(String(s ?? "")) : String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const log = (...args) => console.log(`${MODULE_ID} |`, ...args);
const notify = (msg, type = "info") => ui.notifications?.[type]?.(`Aevum Codex: ${msg}`);
const stripHTML = (html) => {
  const div = document.createElement("div");
  div.innerHTML = html ?? "";
  return (div.textContent ?? "").replace(/\s+/g, " ").trim();
};

/** cyrb53 string hash -> hex. */
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}
const _tpl = document.createElement("template");
/** Canonicalise HTML (entity encoding, quoting, whitespace) so harmless re-serialisation doesn't count as an edit. */
const normHTML = (h) => {
  _tpl.innerHTML = String(h ?? "");
  return _tpl.innerHTML.replace(/\s+/g, " ").replace(/>\s+</g, "><").replace(/\s+>/g, ">").trim();
};
const normMap = (m) => (m ? [Math.round(m.x), Math.round(m.y), m.icon ?? "landmark", m.label ?? ""] : null);
const pageHash = (d) => hash(JSON.stringify([d.name, normHTML(d.html), normMap(d.map)]));
const entryHash = (d) => hash(JSON.stringify([d.name, d.folder ?? null]));

/* -------------------------------------------- */
/*  Codex document access                       */
/* -------------------------------------------- */

function rootFolder() {
  const id = game.settings.get(MODULE_ID, "rootFolderId");
  return game.folders.get(id) ?? game.folders.find((f) => f.type === "JournalEntry" && f.getFlag(MODULE_ID, "root"));
}

/** All JournalEntry folders inside the codex root (including the root). */
function codexFolders() {
  const root = rootFolder();
  if (!root) return [];
  const out = [root];
  const all = game.folders.filter((f) => f.type === "JournalEntry");
  let added = true;
  while (added) {
    added = false;
    for (const f of all) {
      if (out.includes(f)) continue;
      const parentId = f.folder?.id ?? f.folder;
      if (out.some((o) => o.id === parentId)) { out.push(f); added = true; }
    }
  }
  return out;
}

function codexEntries() {
  const ids = new Set(codexFolders().map((f) => f.id));
  return game.journal.filter((e) => ids.has(e.folder?.id));
}

function isCodexEntry(entry) {
  if (!entry) return false;
  const ids = new Set(codexFolders().map((f) => f.id));
  return ids.has(entry.folder?.id);
}

/** Top-level category (first folder under root) of an entry. */
function categoryOf(entry) {
  const root = rootFolder();
  let f = entry.folder;
  if (!f || !root) return "Other";
  if (f.id === root.id) return "Start";
  while (f.folder && f.folder.id !== root.id) f = f.folder;
  return f.name;
}

function folderPath(entry) {
  const root = rootFolder();
  const parts = [];
  let f = entry.folder;
  while (f && f.id !== root?.id) { parts.unshift(f.name); f = f.folder; }
  return parts;
}

const sortedPages = (entry) => entry.pages.contents.slice().sort((a, b) => a.sort - b.sort);
const pageHTML = (p) => p.text?.content ?? "";
const pageMap = (p) => p.getFlag(MODULE_ID, "map") ?? null;
const pinLabel = (page) => (["overview"].includes(page.name.toLowerCase()) ? page.parent.name : page.name);

/* -------------------------------------------- */
/*  Simple Quest                                */
/* -------------------------------------------- */

const SQ = {
  get active() { return !!game.modules.get("simple-quest")?.active; },
  get enabled() { return this.active && game.settings.get(MODULE_ID, "useSimpleQuest"); },
  /** Find the page sub-type Simple Quest registers for quests. */
  questType() {
    const types = new Set([
      ...Object.keys(CONFIG.JournalEntryPage?.dataModels ?? {}),
      ...(game.documentTypes?.JournalEntryPage ?? []),
      ...Object.keys(CONFIG.JournalEntryPage?.typeLabels ?? {})
    ]);
    const sq = [...types].filter((t) => t.startsWith("simple-quest."));
    const byLabel = sq.find((t) => /quest/i.test(game.i18n.localize(CONFIG.JournalEntryPage?.typeLabels?.[t] ?? "")) && !/achiev/i.test(t));
    return byLabel ?? sq.find((t) => /quest/i.test(t) && !/achiev/i.test(t)) ?? null;
  },
  get ui() { return ui.simpleQuest; }
};

/* -------------------------------------------- */
/*  Serialization / Export                      */
/* -------------------------------------------- */

function serializePage(p) {
  const out = {
    id: p.id, name: p.name, sort: p.sort, type: p.type,
    html: pageHTML(p),
    map: pageMap(p),
    ownership: p.ownership?.default ?? -1
  };
  if (p.getFlag(MODULE_ID, "quest") || p.type.startsWith("simple-quest.")) out.quest = { ...(p.getFlag(MODULE_ID, "quest") ?? {}), sqType: p.type.startsWith("simple-quest.") ? p.type : undefined };
  if (p.src) out.src = p.src;
  if (!["text"].includes(p.type)) {
    const sys = p.toObject().system;
    if (sys && Object.keys(sys).length) out.system = sys;
  }
  return out;
}

function serializeEntry(e) {
  return {
    id: e.id, name: e.name, folder: e.folder?.id ?? null, sort: e.sort,
    category: categoryOf(e),
    ownership: e.ownership?.default ?? 0,
    pages: sortedPages(e).map(serializePage)
  };
}

async function exportBundle() {
  if (!game.user.isGM) return notify("Only the GM can export.", "warn");
  const root = rootFolder();
  if (!root) return notify("There is no codex in this world yet. Import a content file first.", "warn");
  const folders = codexFolders().map((f) => ({ id: f.id, name: f.name, parent: f.id === root.id ? null : (f.folder?.id ?? null), sort: f.sort }));
  const entries = codexEntries().map(serializeEntry);
  const tomb = game.settings.get(MODULE_ID, "tombstones") ?? { pages: [], entries: [] };
  const bundle = {
    format: "aevum-codex", schema: 1, source: "foundry",
    createdAt: new Date().toISOString(),
    world: game.world.id, foundry: game.version,
    rootFolder: root.id,
    folders, entries,
    deleted: [...(tomb.entries ?? []), ...(tomb.pages ?? [])]
  };
  // Mark everything as "seen by Claude" so the next import can tell later local edits apart.
  for (const e of codexEntries()) {
    const eh = entryHash({ name: e.name, folder: e.folder?.id ?? null });
    if (e.getFlag(MODULE_ID, "syncHash") !== eh) await e.setFlag(MODULE_ID, "syncHash", eh);
    const updates = [];
    for (const p of e.pages) {
      const ph = pageHash({ name: p.name, html: pageHTML(p), map: pageMap(p) });
      if (p.getFlag(MODULE_ID, "syncHash") !== ph) updates.push({ _id: p.id, [`flags.${MODULE_ID}.syncHash`]: ph });
    }
    if (updates.length) await e.updateEmbeddedDocuments("JournalEntryPage", updates, { aevumCodex: true, render: false });
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  saveFile(JSON.stringify(bundle, null, 1), "application/json", `aevum-codex-export-${stamp}.json`);
  await game.settings.set(MODULE_ID, "lastExport", new Date().toISOString());
  notify(`Exported ${entries.length} journals (${entries.reduce((n, e) => n + e.pages.length, 0)} pages). Upload the file to Claude.`);
}

/* -------------------------------------------- */
/*  Import                                      */
/* -------------------------------------------- */

function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      resolve(file ? await file.text() : null);
    });
    input.click();
  });
}

function validateBundle(b) {
  if (!b || b.format !== "aevum-codex" || !Array.isArray(b.entries) || !Array.isArray(b.folders)) {
    throw new Error("This file is not an Aevum Codex bundle.");
  }
  return b;
}

/** Work out what an import would do, without changing anything. */
function planImport(bundle) {
  const plan = { folders: [], entries: [], pages: [], deletes: [] };
  const tomb = game.settings.get(MODULE_ID, "tombstones") ?? { pages: [], entries: [] };
  const tombPages = new Set(tomb.pages ?? []);
  const tombEntries = new Set(tomb.entries ?? []);

  for (const f of bundle.folders) {
    const local = game.folders.get(f.id);
    if (!local) plan.folders.push({ action: "create", data: f });
    else if (local.name !== f.name || (f.id !== bundle.rootFolder && (local.folder?.id ?? null) !== (f.parent ?? null))) plan.folders.push({ action: "update", data: f, local });
  }

  for (const e of bundle.entries) {
    const local = game.journal.get(e.id);
    if (!local) {
      if (tombEntries.has(e.id)) { plan.entries.push({ action: "tombstoned", data: e, label: e.name }); continue; }
      plan.entries.push({ action: "create", data: e, label: e.name });
      continue;
    }
    // entry-level (name / folder)
    const inH = entryHash({ name: e.name, folder: e.folder });
    const locH = entryHash({ name: local.name, folder: local.folder?.id ?? null });
    const base = local.getFlag(MODULE_ID, "syncHash");
    if (inH !== locH) {
      const status = classify(inH, locH, base);
      plan.entries.push({ action: status, data: e, local, label: e.name, newHash: inH });
    } else if (base !== inH) plan.entries.push({ action: "rebase", data: e, local, label: e.name, newHash: inH });

    for (const p of e.pages) {
      const lp = local.pages.get(p.id);
      const label = `${e.name} › ${p.name}`;
      const inPH = pageHash(p);
      if (!lp) {
        if (tombPages.has(p.id)) plan.pages.push({ action: "tombstoned", entry: local, data: p, label });
        else plan.pages.push({ action: "create", entry: local, data: p, label, newHash: inPH });
        continue;
      }
      const locPH = pageHash({ name: lp.name, html: pageHTML(lp), map: pageMap(lp) });
      const pBase = lp.getFlag(MODULE_ID, "syncHash");
      if (inPH === locPH) {
        if (pBase !== inPH) plan.pages.push({ action: "rebase", entry: local, local: lp, data: p, label, newHash: inPH });
        continue;
      }
      plan.pages.push({ action: classify(inPH, locPH, pBase), entry: local, local: lp, data: p, label, newHash: inPH });
    }
  }

  for (const id of bundle.deleted ?? []) {
    const entry = game.journal.get(id);
    if (entry && isCodexEntry(entry)) {
      const locH = entryHash({ name: entry.name, folder: entry.folder?.id ?? null });
      const unchanged = entry.pages.contents.every((p) => p.getFlag(MODULE_ID, "syncHash") === pageHash({ name: p.name, html: pageHTML(p), map: pageMap(p) }));
      plan.deletes.push({ kind: "entry", doc: entry, label: entry.name, safe: unchanged && entry.getFlag(MODULE_ID, "syncHash") === locH });
      continue;
    }
    for (const e of codexEntries()) {
      const p = e.pages.get(id);
      if (!p) continue;
      const safe = p.getFlag(MODULE_ID, "syncHash") === pageHash({ name: p.name, html: pageHTML(p), map: pageMap(p) });
      plan.deletes.push({ kind: "page", doc: p, entry: e, label: `${e.name} › ${p.name}`, safe });
    }
  }
  return plan;
}

/** incoming / local / base hashes -> what to do. */
function classify(incoming, local, base) {
  if (local === base) return "update";      // only Claude changed it
  if (incoming === base) return "keep";     // only you changed it in Foundry
  return "conflict";                        // both changed (or never synced)
}

function planSummaryHTML(plan) {
  const count = (arr, a) => arr.filter((x) => x.action === a).length;
  const newEntries = count(plan.entries, "create");
  const newPages = count(plan.pages, "create") + plan.entries.filter((x) => x.action === "create").reduce((n, x) => n + x.data.pages.length, 0);
  const updates = count(plan.pages, "update") + count(plan.entries, "update");
  const keeps = count(plan.pages, "keep") + count(plan.entries, "keep");
  const conflicts = [...plan.entries, ...plan.pages].filter((x) => x.action === "conflict");
  const tomb = [...plan.entries, ...plan.pages].filter((x) => x.action === "tombstoned");
  const list = (items, name, checked, note) => items.length ? `<ul class="ac-plan-list">${items.map((x, i) => `
      <li><label><input type="checkbox" name="${name}-${i}" ${checked ? "checked" : ""}> ${esc(x.label)}</label>${note ? ` <span class="ac-dim">${note(x)}</span>` : ""}</li>`).join("")}</ul>` : "";
  const changed = [...plan.entries, ...plan.pages].filter((x) => x.action === "update");
  return `
    <div class="aevum-codex-plan">
      <p class="ac-plan-stats">
        <span><b>${newEntries}</b> new journals</span>
        <span><b>${newPages}</b> new pages</span>
        <span><b>${updates}</b> updated</span>
        <span><b>${keeps}</b> kept (only edited in Foundry)</span>
        <span class="${conflicts.length ? "ac-warn" : ""}"><b>${conflicts.length}</b> conflicts</span>
        ${plan.deletes.length ? `<span><b>${plan.deletes.length}</b> deletions</span>` : ""}
      </p>
      ${changed.length ? `<details><summary>Updated (${changed.length})</summary><ul class="ac-plan-list">${changed.map((x) => `<li>${esc(x.label)}</li>`).join("")}</ul></details>` : ""}
      ${conflicts.length ? `<h4>Conflicts: changed both in Foundry and in the update</h4>
        <p class="ac-dim">Ticked = take the update (your Foundry version is saved to the <i>Aevum Codex Backups</i> journal first). Unticked = keep your Foundry version.</p>
        ${list(conflicts, "conflict", false)}` : ""}
      ${tomb.length ? `<h4>Deleted in Foundry</h4><p class="ac-dim">You deleted these in Foundry. Tick to bring them back.</p>${list(tomb, "tomb", false)}` : ""}
      ${plan.deletes.length ? `<h4>Removed in the update</h4><p class="ac-dim">Ticked = delete in Foundry. Items you edited since your last export are unticked.</p>${list(plan.deletes, "del", true, (x) => (x.safe ? "" : "edited in Foundry"))}` : ""}
    </div>`;
}

async function importFlow(text) {
  if (!game.user.isGM) return notify("Only the GM can import.", "warn");
  let bundle;
  try { bundle = validateBundle(JSON.parse(text)); }
  catch (err) { return notify(err.message, "error"); }
  const plan = planImport(bundle);
  const nothing = !plan.folders.length && !plan.deletes.length &&
    ![...plan.entries, ...plan.pages].some((x) => !["rebase", "keep"].includes(x.action));
  if (nothing) {
    await applyImport(bundle, plan, {});
    return notify("Everything is already up to date.");
  }
  const choice = await DialogV2().wait({
    window: { title: "Aevum Codex: Import update", icon: "fa-solid fa-file-import" },
    position: { width: 620 },
    classes: ["aevum-codex-dialog"],
    content: planSummaryHTML(plan),
    buttons: [
      { action: "apply", label: "Apply", icon: "fa-solid fa-check", default: true,
        callback: (event, button) => {
          const form = button.form;
          const checked = (prefix) => [...form.querySelectorAll(`input[name^="${prefix}-"]`)].map((i) => i.checked);
          return { conflict: checked("conflict"), tomb: checked("tomb"), del: checked("del") };
        } },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" }
    ],
    rejectClose: false
  });
  if (!choice || choice === "cancel") return;
  await applyImport(bundle, plan, choice);
}

function pageCreateData(p, hashValue) {
  const sqType = p.quest && SQ.enabled ? (SQ.questType() ?? null) : null;
  const flags = { [MODULE_ID]: { syncHash: hashValue ?? pageHash(p) } };
  if (p.map) flags[MODULE_ID].map = p.map;
  if (p.quest) flags[MODULE_ID].quest = { hidden: !!p.quest.hidden };
  let type = p.type && p.type !== "text" && (game.documentTypes?.JournalEntryPage ?? []).includes(p.type) ? p.type : "text";
  if (sqType) type = sqType;
  if (p.quest && !sqType && type.startsWith("simple-quest.")) type = "text";
  const data = {
    _id: p.id, name: p.name, sort: p.sort ?? 0, type,
    title: { show: true, level: 1 },
    text: { content: p.html ?? "", format: CONST.JOURNAL_ENTRY_PAGE_FORMATS?.HTML ?? 1 },
    flags
  };
  if (p.src) data.src = p.src;
  if (p.system && type === p.type) data.system = p.system;
  if (typeof p.ownership === "number" && p.ownership !== -1) data.ownership = { default: p.ownership };
  return data;
}

async function createPages(entry, pages) {
  if (!pages.length) return;
  try {
    await entry.createEmbeddedDocuments("JournalEntryPage", pages, { keepId: true, aevumCodex: true, render: false });
  } catch (err) {
    // Fall back to plain text pages if a module page type refused the data.
    console.warn(`${MODULE_ID} | page creation failed, retrying as text pages`, err);
    for (const p of pages) {
      const { system, ...rest } = p;
      try { await entry.createEmbeddedDocuments("JournalEntryPage", [{ ...rest, type: "text" }], { keepId: true, aevumCodex: true, render: false }); }
      catch (e2) { console.error(`${MODULE_ID} | could not create page ${p.name}`, e2); }
    }
  }
}

async function backupPage(page) {
  let folder = game.folders.find((f) => f.type === "JournalEntry" && f.getFlag(MODULE_ID, "backups"));
  if (!folder) folder = await Folder.create({ name: "Aevum Codex Backups", type: "JournalEntry", flags: { [MODULE_ID]: { backups: true } } });
  let journal = game.journal.find((j) => j.folder?.id === folder.id && j.getFlag(MODULE_ID, "backupJournal"));
  if (!journal) journal = await JournalEntry.create({ name: "Aevum Codex Backups", folder: folder.id, ownership: { default: OWN().NONE }, flags: { [MODULE_ID]: { backupJournal: true } } });
  const when = new Date().toLocaleString();
  await journal.createEmbeddedDocuments("JournalEntryPage", [{
    name: `${page.parent.name} › ${page.name} (${when})`, type: "text",
    text: { content: `<p><em>Backup of your Foundry version, replaced by an import on ${esc(when)}.</em></p>${pageHTML(page)}`, format: 1 }
  }]);
}

async function applyImport(bundle, plan, choice) {
  const opts = { aevumCodex: true };
  let created = 0, updated = 0, deleted = 0;
  const touched = new Set(); // entry ids whose pages were written by this import

  // Folders (parents first; bundle order already parent-first, but be safe)
  const pending = plan.folders.slice();
  for (let guard = 0; pending.length && guard < 10; guard++) {
    for (const item of pending.slice()) {
      const f = item.data;
      if (f.parent && !game.folders.get(f.parent)) continue;
      if (item.action === "create") {
        await Folder.create({ _id: f.id, name: f.name, type: "JournalEntry", folder: f.parent ?? null, sort: f.sort ?? 0, sorting: "m",
          flags: { [MODULE_ID]: { codex: true, root: f.id === bundle.rootFolder } } }, { keepId: true, ...opts });
      } else {
        // the root folder may live anywhere (e.g. inside Simple Quest's Root folder) — never move it
        await item.local.update(f.id === bundle.rootFolder ? { name: f.name } : { name: f.name, folder: f.parent ?? null }, opts);
      }
      pending.splice(pending.indexOf(item), 1);
    }
  }
  if (bundle.rootFolder && game.folders.get(bundle.rootFolder)) {
    await game.settings.set(MODULE_ID, "rootFolderId", bundle.rootFolder);
    const rf = game.folders.get(bundle.rootFolder);
    if (!rf.getFlag(MODULE_ID, "root")) await rf.setFlag(MODULE_ID, "root", true);
  }

  // Entries
  const newEntries = [];
  for (const item of plan.entries) {
    const e = item.data;
    if (item.action === "create" || (item.action === "tombstoned" && choice.tomb?.[[...plan.entries, ...plan.pages].filter((x) => x.action === "tombstoned").indexOf(item)])) {
      newEntries.push(e);
    } else if (item.action === "update") {
      await item.local.update({ name: e.name, folder: e.folder ?? null, [`flags.${MODULE_ID}.syncHash`]: item.newHash }, opts);
      updated++;
    } else if (item.action === "rebase") {
      await item.local.setFlag(MODULE_ID, "syncHash", item.newHash);
    } else if (item.action === "conflict") {
      const idx = [...plan.entries, ...plan.pages].filter((x) => x.action === "conflict").indexOf(item);
      if (choice.conflict?.[idx]) { await item.local.update({ name: e.name, folder: e.folder ?? null, [`flags.${MODULE_ID}.syncHash`]: item.newHash }, opts); updated++; }
    }
  }
  for (const e of newEntries) {
    const pages = e.pages.map((p) => pageCreateData(p));
    const entry = await JournalEntry.create({
      _id: e.id, name: e.name, folder: e.folder ?? null, sort: e.sort ?? 0,
      ownership: { default: typeof e.ownership === "number" ? e.ownership : OWN().NONE },
      flags: { [MODULE_ID]: { syncHash: entryHash({ name: e.name, folder: e.folder ?? null }), category: e.category } }
    }, { keepId: true, ...opts, renderSheet: false });
    await createPages(entry, pages);
    created += pages.length;
    touched.add(e.id + ":*");
  }

  // Pages
  const conflicts = [...plan.entries, ...plan.pages].filter((x) => x.action === "conflict");
  const tombs = [...plan.entries, ...plan.pages].filter((x) => x.action === "tombstoned");
  const byEntry = new Map();
  const push = (entry, kind, data) => {
    if (!byEntry.has(entry.id)) byEntry.set(entry.id, { entry, create: [], update: [] });
    byEntry.get(entry.id)[kind].push(data);
  };
  for (const item of plan.pages) {
    const p = item.data;
    if (item.action === "create") push(item.entry, "create", pageCreateData(p, item.newHash));
    else if (item.action === "tombstoned" && choice.tomb?.[tombs.indexOf(item)]) push(item.entry, "create", pageCreateData(p));
    else if (item.action === "rebase") push(item.entry, "update", { _id: p.id, [`flags.${MODULE_ID}.syncHash`]: item.newHash });
    else if (item.action === "update" || (item.action === "conflict" && choice.conflict?.[conflicts.indexOf(item)])) {
      if (item.action === "conflict") await backupPage(item.local);
      const upd = { _id: p.id, name: p.name, "text.content": p.html ?? "", [`flags.${MODULE_ID}.syncHash`]: item.newHash };
      if (p.map) upd[`flags.${MODULE_ID}.map`] = p.map;
      else if (pageMap(item.local)) upd[`flags.${MODULE_ID}.-=map`] = null;
      push(item.entry, "update", upd);
    }
  }
  for (const { entry, create, update } of byEntry.values()) {
    for (const d of [...create, ...update]) if (d.name !== undefined || d.text) touched.add(`${entry.id}:${d._id}`);
    if (create.length) { await createPages(entry, create); created += create.length; }
    if (update.length) {
      await entry.updateEmbeddedDocuments("JournalEntryPage", update, { ...opts, render: false });
      updated += update.filter((u) => "text.content" in u).length;
    }
  }

  // Re-base the written pages on what Foundry actually stored (it may re-serialise HTML)
  for (const e of codexEntries()) {
    const fixes = [];
    for (const p of e.pages) {
      if (!touched.has(`${e.id}:*`) && !touched.has(`${e.id}:${p.id}`)) continue;
      const h = pageHash({ name: p.name, html: pageHTML(p), map: pageMap(p) });
      if (p.getFlag(MODULE_ID, "syncHash") !== h) fixes.push({ _id: p.id, [`flags.${MODULE_ID}.syncHash`]: h });
    }
    if (fixes.length) await e.updateEmbeddedDocuments("JournalEntryPage", fixes, { ...opts, render: false });
  }

  // Deletions
  for (const [i, d] of plan.deletes.entries()) {
    if (!choice.del?.[i]) continue;
    await d.doc.delete(opts);
    deleted++;
  }

  // Prune tombstones that the bundle no longer contains (Claude has processed them)
  const ids = new Set(bundle.entries.flatMap((e) => [e.id, ...e.pages.map((p) => p.id)]));
  const tomb = game.settings.get(MODULE_ID, "tombstones") ?? { pages: [], entries: [] };
  await game.settings.set(MODULE_ID, "tombstones", {
    pages: (tomb.pages ?? []).filter((id) => ids.has(id) && !game.journal.some((e) => e.pages.has(id))),
    entries: (tomb.entries ?? []).filter((id) => ids.has(id) && !game.journal.has(id))
  });
  await game.settings.set(MODULE_ID, "lastImport", new Date().toISOString());

  const hasPins = bundle.entries.some((e) => e.pages.some((p) => p.map));
  if (game.settings.get(MODULE_ID, "autoPins") && hasPins) await syncPins({ quiet: !!getMapScene() });
  CodexBrowser.refreshAll();
  if (created || updated || deleted) notify(`Import done: ${created} created, ${updated} updated, ${deleted} deleted.`);
}

/* -------------------------------------------- */
/*  World map + pins                            */
/* -------------------------------------------- */

function getMapScene() {
  return game.scenes.get(game.settings.get(MODULE_ID, "mapSceneId")) ?? game.scenes.find((s) => s.getFlag(MODULE_ID, "worldMap"));
}

async function ensureMapScene() {
  let scene = getMapScene();
  if (scene) return scene;
  const data = {
    name: "Aevum — World Map",
    background: { src: MAP_SRC },
    width: MAP_W, height: MAP_H, padding: 0,
    backgroundColor: "#3f5a6b",
    grid: { type: 0 },
    tokenVision: false,
    navigation: true,
    initial: { x: MAP_W / 2, y: MAP_H / 2, scale: 0.25 },
    flags: { [MODULE_ID]: { worldMap: true } }
  };
  try { scene = await Scene.create(data); }
  catch (err) {
    console.warn(`${MODULE_ID} | scene create failed with full data, retrying minimal`, err);
    scene = await Scene.create({ name: data.name, img: MAP_SRC, width: MAP_W, height: MAP_H, padding: 0, flags: data.flags });
  }
  await game.settings.set(MODULE_ID, "mapSceneId", scene.id);
  return scene;
}

function noteDataFor(page) {
  const map = pageMap(page);
  const type = PIN_TYPES[map.icon] ? map.icon : "landmark";
  const scale = game.settings.get(MODULE_ID, "pinScale") || 1;
  return {
    x: Math.round(map.x), y: Math.round(map.y),
    entryId: page.parent.id, pageId: page.id,
    texture: { src: `${ICON_DIR}/${type}.svg` },
    iconSize: Math.max(32, Math.round(PIN_TYPES[type].size * scale)),
    text: map.label || pinLabel(page),
    fontSize: Math.min(128, Math.max(8, Math.round(36 * scale))),
    textAnchor: CONST.TEXT_ANCHOR_POINTS.BOTTOM,
    textColor: "#fff4dc",
    global: true,
    flags: { [MODULE_ID]: { pageUuid: page.uuid, pinType: type } }
  };
}

/** Create / move / remove notes on the world map so they match the pages' map flags. */
async function syncPins({ quiet = false } = {}) {
  if (!game.user.isGM) return;
  const scene = await ensureMapScene();
  const want = new Map();
  for (const e of codexEntries()) for (const p of e.pages) if (pageMap(p)) want.set(p.uuid, p);
  const create = [], update = [], remove = [];
  const seen = new Set();
  for (const note of scene.notes) {
    const uuid = note.getFlag(MODULE_ID, "pageUuid");
    if (!uuid) continue;
    const page = want.get(uuid);
    if (!page || seen.has(uuid)) { remove.push(note.id); continue; }
    seen.add(uuid);
    const d = noteDataFor(page);
    const diff = d.x !== note.x || d.y !== note.y || d.text !== note.text || d.iconSize !== note.iconSize || d.texture.src !== note.texture?.src;
    if (diff) update.push({ _id: note.id, x: d.x, y: d.y, text: d.text, iconSize: d.iconSize, fontSize: d.fontSize, "texture.src": d.texture.src });
  }
  for (const [uuid, page] of want) if (!seen.has(uuid)) create.push(noteDataFor(page));
  const o = { aevumCodex: true };
  if (remove.length) await scene.deleteEmbeddedDocuments("Note", remove, o);
  if (update.length) await scene.updateEmbeddedDocuments("Note", update, o);
  if (create.length) await scene.createEmbeddedDocuments("Note", create, o);
  if (!quiet || create.length || remove.length) notify(`World map pins: ${create.length} added, ${update.length} updated, ${remove.length} removed.`);
  return scene;
}

async function focusPage(page) {
  const scene = getMapScene();
  const map = pageMap(page);
  if (!scene || !map) return notify("This page has no pin on the world map.", "warn");
  if (canvas.scene?.id !== scene.id) await scene.view();
  await canvas.animatePan({ x: map.x, y: map.y, scale: 0.8, duration: 600 });
  const note = scene.notes.find((n) => n.getFlag(MODULE_ID, "pageUuid") === page.uuid);
  note?.object?.control?.({ releaseOthers: true });
}

/* -------------------------------------------- */
/*  Visibility                                  */
/* -------------------------------------------- */

function visibilityOf(entry, page) {
  const L = OWN();
  const ed = entry.ownership.default;
  const pd = page ? page.ownership.default : -1;
  if (ed >= L.OBSERVER && (pd === -1 || pd >= L.OBSERVER)) return "entry";
  if (page && pd >= L.OBSERVER && ed >= L.LIMITED) return "page";
  return "hidden";
}

async function setVisibility(entry, page, mode) {
  const L = OWN();
  if (mode === "entry") {
    await entry.update({ "ownership.default": L.OBSERVER });
    if (page && page.ownership.default !== -1 && page.ownership.default < L.OBSERVER) await page.update({ "ownership.default": -1 });
  } else if (mode === "page") {
    if (entry.ownership.default < L.LIMITED || entry.ownership.default >= L.OBSERVER) await entry.update({ "ownership.default": L.LIMITED });
    await page.update({ "ownership.default": L.OBSERVER });
  } else {
    await entry.update({ "ownership.default": L.NONE });
    const resets = entry.pages.filter((p) => p.ownership.default !== -1).map((p) => ({ _id: p.id, "ownership.default": -1 }));
    if (resets.length) await entry.updateEmbeddedDocuments("JournalEntryPage", resets);
  }
}

/* -------------------------------------------- */
/*  Codex Browser                               */
/* -------------------------------------------- */

const { ApplicationV2 } = foundry.applications.api;

class CodexBrowser extends ApplicationV2 {
  static instance = null;

  static DEFAULT_OPTIONS = {
    id: "aevum-codex-browser",
    classes: ["aevum-codex-app"],
    tag: "div",
    window: { title: "Aevum Codex", icon: "fa-solid fa-book-atlas", resizable: true },
    position: { width: 1040, height: 760 },
    actions: {
      selectPage: CodexBrowser.#onSelectPage,
      selectEntry: CodexBrowser.#onSelectEntry,
      toggleFolder: CodexBrowser.#onToggleFolder,
      setCategory: CodexBrowser.#onSetCategory,
      openJournal: CodexBrowser.#onOpenJournal,
      editPage: CodexBrowser.#onEditPage,
      focusMap: CodexBrowser.#onFocusMap,
      importFile: CodexBrowser.#onImport,
      exportFile: CodexBrowser.#onExport,
      buildMap: CodexBrowser.#onBuildMap,
      openMap: CodexBrowser.#onOpenMap,
      sqOpen: CodexBrowser.#onSQOpen,
      sqMap: CodexBrowser.#onSQMap,
      sqQuests: CodexBrowser.#onSQQuests,
      back: CodexBrowser.#onBack
    }
  };

  state = { query: "", category: "All", entryId: null, pageId: null, open: new Set(), history: [] };

  static open(options = {}) {
    if (!this.instance) this.instance = new CodexBrowser();
    if (options.pageUuid) {
      const page = fromUuidSync(options.pageUuid);
      if (page) this.instance._select(page.parent?.id ?? page.id, page.parent ? page.id : null, { render: false });
    }
    this.instance.render({ force: true });
    return this.instance;
  }

  static refreshAll() {
    const app = this.instance;
    if (app?.rendered) app._debouncedRefresh();
  }

  _debouncedRefresh = foundry.utils.debounce(() => { if (this.rendered) this.render(); }, 250);

  /* ---------- data ---------- */

  _visibleEntries() {
    const user = game.user;
    return codexEntries().filter((e) => user.isGM || e.testUserPermission(user, "LIMITED"));
  }

  _visiblePages(entry) {
    const user = game.user;
    return sortedPages(entry).filter((p) => user.isGM || p.testUserPermission(user, "OBSERVER"));
  }

  _categories() {
    const root = rootFolder();
    if (!root) return [];
    const cats = game.folders.filter((f) => f.type === "JournalEntry" && f.folder?.id === root.id).sort((a, b) => a.sort - b.sort).map((f) => f.name);
    return ["All", ...cats];
  }

  _select(entryId, pageId, { render = true, pushHistory = true } = {}) {
    if (pushHistory && this.state.entryId) this.state.history.push([this.state.entryId, this.state.pageId]);
    if (this.state.history.length > 50) this.state.history.shift();
    this.state.entryId = entryId;
    const entry = game.journal.get(entryId);
    this.state.pageId = pageId ?? (entry ? this._visiblePages(entry)[0]?.id ?? null : null);
    if (entry) {
      // expand folder path in the tree
      let f = entry.folder;
      while (f) { this.state.open.add(f.id); f = f.folder; }
      this.state.open.add(entry.id);
    }
    if (render && this.rendered) this._refreshView();
    if (render && this.rendered) this._refreshTree();
  }

  /* ---------- rendering ---------- */

  async _renderHTML(context, options) {
    const root = rootFolder();
    const gm = game.user.isGM;
    if (!root) {
      return `<div class="ac-empty">
        <i class="fa-solid fa-book-atlas"></i>
        <h2>The codex is empty</h2>
        ${gm ? `<p>Import your <b>aevum-codex-content.json</b> file to create the journals, then build the world map.</p>
        <button type="button" data-action="importFile"><i class="fa-solid fa-file-import"></i> Import content file</button>` :
        `<p>The GM hasn't set up the codex yet.</p>`}
      </div>`;
    }
    if (!this.state.entryId) {
      const start = this._visibleEntries().find((e) => e.folder?.id === root.id) ?? this._visibleEntries()[0];
      if (start) this._select(start.id, null, { render: false, pushHistory: false });
    }
    const cats = this._categories();
    const sq = SQ.enabled;
    return `
      <div class="ac-layout">
        <aside class="ac-nav">
          <div class="ac-search">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input type="search" name="ac-query" placeholder="Search the codex…" value="${esc(this.state.query)}" autocomplete="off">
          </div>
          <div class="ac-cats">${cats.map((c) => `<button type="button" class="ac-chip ${c === this.state.category ? "active" : ""}" data-action="setCategory" data-category="${esc(c)}">${esc(c)}</button>`).join("")}</div>
          <nav class="ac-tree">${this._treeHTML()}</nav>
        </aside>
        <section class="ac-view">${await this._viewHTML()}</section>
      </div>
      ${gm ? `<footer class="ac-toolbar">
        <button type="button" data-action="importFile" data-tooltip="Apply an update file from Claude"><i class="fa-solid fa-file-import"></i> Import update</button>
        <button type="button" data-action="exportFile" data-tooltip="Download the whole codex (with your edits and pin positions) to give to Claude"><i class="fa-solid fa-file-export"></i> Export for Claude</button>
        <span class="ac-sep"></span>
        <button type="button" data-action="openMap"><i class="fa-solid fa-map"></i> World map</button>
        <button type="button" data-action="buildMap" data-tooltip="Create the map scene if needed and add, move or remove pins to match the codex"><i class="fa-solid fa-map-pin"></i> Sync pins</button>
        ${sq ? `<span class="ac-sep"></span>
        <button type="button" data-action="sqQuests"><i class="fa-solid fa-scroll"></i> Quests</button>
        <button type="button" data-action="sqMap" data-tooltip="Convert the world map scene into a Simple Quest map (one-way copy)"><i class="fa-solid fa-map-location-dot"></i> SQ map</button>` : ""}
        <span class="ac-grow"></span>
        <span class="ac-dim">${this._syncStatus()}</span>
      </footer>` : ""}`;
  }

  _syncStatus() {
    const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString() : "never");
    return `Last import: ${fmt(game.settings.get(MODULE_ID, "lastImport"))} · Last export: ${fmt(game.settings.get(MODULE_ID, "lastExport"))}`;
  }

  _treeHTML() {
    const q = this.state.query.trim().toLowerCase();
    if (q) return this._searchHTML(q);
    const root = rootFolder();
    const entries = this._visibleEntries();
    const cat = this.state.category;
    const folderChildren = (fid) => game.folders.filter((f) => f.type === "JournalEntry" && f.folder?.id === fid).sort((a, b) => a.sort - b.sort);
    const entriesIn = (fid) => entries.filter((e) => e.folder?.id === fid).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
    const entryHTML = (e) => {
      const open = this.state.open.has(e.id) || this.state.entryId === e.id;
      const pages = this._visiblePages(e);
      const hidden = game.user.isGM && e.ownership.default < OWN().LIMITED;
      return `<li class="ac-entry ${this.state.entryId === e.id ? "active" : ""}">
        <a data-action="selectEntry" data-entry="${e.id}"><i class="fa-solid ${pages.length > 1 ? (open ? "fa-caret-down" : "fa-caret-right") : "fa-file-lines"} ac-caret"></i>${esc(e.name)}${hidden ? ` <i class="fa-solid fa-eye-slash ac-hid" data-tooltip="Hidden from players"></i>` : ""}</a>
        ${open && pages.length > 1 ? `<ul class="ac-pages">${pages.map((p) => `<li class="${this.state.pageId === p.id ? "active" : ""}"><a data-action="selectPage" data-entry="${e.id}" data-page="${p.id}">${pageMap(p) ? '<i class="fa-solid fa-location-dot ac-pinmark"></i>' : ""}${esc(p.name)}</a></li>`).join("")}</ul>` : ""}
      </li>`;
    };
    const folderHTML = (f, depth) => {
      const subs = folderChildren(f.id).map((s) => folderHTML(s, depth + 1)).join("");
      const ents = entriesIn(f.id).map(entryHTML).join("");
      if (!subs && !ents) return "";
      const open = this.state.open.has(f.id) || cat !== "All";
      return `<li class="ac-folder depth-${depth}">
        <a data-action="toggleFolder" data-folder="${f.id}"><i class="fa-solid ${open ? "fa-folder-open" : "fa-folder"}"></i>${esc(f.name)}</a>
        ${open ? `<ul>${subs}${ents}</ul>` : ""}
      </li>`;
    };
    let html = "";
    if (cat === "All") {
      html += entriesIn(root.id).map(entryHTML).join("");
      html += folderChildren(root.id).map((f) => folderHTML(f, 1)).join("");
    } else {
      const f = folderChildren(root.id).find((x) => x.name === cat);
      if (f) html += folderChildren(f.id).map((s) => folderHTML(s, 2)).join("") + entriesIn(f.id).map(entryHTML).join("");
    }
    return `<ul class="ac-root">${html || '<li class="ac-dim">Nothing here yet.</li>'}</ul>`;
  }

  _searchHTML(q) {
    const terms = q.split(/\s+/).filter(Boolean);
    const results = [];
    for (const e of this._visibleEntries()) {
      const cat = categoryOf(e);
      if (this.state.category !== "All" && cat !== this.state.category) continue;
      for (const p of this._visiblePages(e)) {
        const text = stripHTML(pageHTML(p));
        const name = `${p.name} ${e.name}`.toLowerCase();
        const lower = text.toLowerCase();
        if (!terms.every((t) => name.includes(t) || lower.includes(t))) continue;
        let score = 0;
        for (const t of terms) {
          if (p.name.toLowerCase() === t) score += 100;
          if (p.name.toLowerCase().startsWith(t)) score += 40;
          if (name.includes(t)) score += 20;
          score += Math.min(10, lower.split(t).length - 1);
        }
        const i = lower.indexOf(terms[0]);
        const snippet = i >= 0 ? (i > 40 ? "…" : "") + text.slice(Math.max(0, i - 40), i + 90) + "…" : text.slice(0, 120);
        results.push({ e, p, score, snippet, cat });
      }
    }
    results.sort((a, b) => b.score - a.score);
    if (!results.length) return `<p class="ac-dim ac-pad">No matches for “${esc(q)}”.</p>`;
    const mark = (s) => { let out = esc(s); for (const t of terms) out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>"); return out; };
    return `<ul class="ac-results">${results.slice(0, 60).map((r) => `
      <li class="${this.state.pageId === r.p.id ? "active" : ""}"><a data-action="selectPage" data-entry="${r.e.id}" data-page="${r.p.id}">
        <span class="ac-r-title">${mark(r.p.name === "Overview" ? r.e.name : r.p.name)}</span>
        <span class="ac-r-path">${esc(r.cat)} › ${esc(r.e.name)}</span>
        <span class="ac-r-snip">${mark(r.snippet)}</span>
      </a></li>`).join("")}</ul>`;
  }

  async _viewHTML() {
    const entry = game.journal.get(this.state.entryId);
    if (!entry || !isCodexEntry(entry)) return `<div class="ac-empty small"><p>Select an entry on the left.</p></div>`;
    const pages = this._visiblePages(entry);
    const page = entry.pages.get(this.state.pageId) ?? pages[0];
    const gm = game.user.isGM;
    const path = [categoryOf(entry) === "Start" ? null : categoryOf(entry), ...folderPath(entry).slice(1)].filter(Boolean);
    let body = `<p class="ac-dim">This entry has no pages yet.</p>`;
    if (page) {
      const TE = TextEditorImpl();
      body = await TE.enrichHTML(pageHTML(page), { secrets: entry.isOwner, relativeTo: page });
      if (page.type === "image" && page.src) body = `<img src="${esc(page.src)}" alt="">` + body;
    }
    const vis = page ? visibilityOf(entry, page) : "hidden";
    const visLabel = { entry: "Visible to players", page: "This page visible", hidden: "Hidden from players" }[vis];
    const map = page && pageMap(page);
    return `
      <header class="ac-head">
        <div class="ac-crumbs">${this.state.history.length ? `<a data-action="back" data-tooltip="Back"><i class="fa-solid fa-arrow-left"></i></a>` : ""}${path.map(esc).join(" › ")}</div>
        <h1>${esc(entry.name)}</h1>
        <div class="ac-actions">
          <button type="button" data-action="openJournal" data-tooltip="Open in the journal sheet"><i class="fa-solid fa-book-open"></i> Open</button>
          ${page && entry.isOwner ? `<button type="button" data-action="editPage" data-tooltip="Edit this page"><i class="fa-solid fa-pen"></i> Edit</button>` : ""}
          ${map ? `<button type="button" data-action="focusMap" data-tooltip="Show on the world map"><i class="fa-solid fa-location-dot"></i> Map</button>` : ""}
          ${gm && page ? `<span class="ac-vis ac-vis-${vis}">
              <i class="fa-solid ${vis === "hidden" ? "fa-eye-slash" : "fa-eye"}"></i> ${visLabel}
              <select name="ac-visibility" data-tooltip="Who can see this">
                <option value="hidden" ${vis === "hidden" ? "selected" : ""}>Hide from players</option>
                <option value="page" ${vis === "page" ? "selected" : ""}>Reveal this page only</option>
                <option value="entry" ${vis === "entry" ? "selected" : ""}>Reveal whole journal</option>
              </select></span>` : ""}
          ${SQ.active && page ? `<button type="button" data-action="sqOpen" data-tooltip="Open in Simple Quest"><i class="fa-solid fa-scroll"></i></button>` : ""}
        </div>
        ${pages.length > 1 && pages.length <= 14 ? `<div class="ac-tabs">${pages.map((p) => `<a class="${p.id === page?.id ? "active" : ""}" data-action="selectPage" data-entry="${entry.id}" data-page="${p.id}">${esc(p.name)}</a>`).join("")}</div>` : ""}
      </header>
      <article class="ac-body journal-entry-page text">
        ${page && pages.length > 1 ? `<h2 class="ac-page-title">${esc(page.name)}</h2>` : ""}
        ${body}
      </article>`;
  }

  _replaceHTML(result, content, options) {
    content.innerHTML = result;
  }

  _onRender(context, options) {
    const input = this.element.querySelector('input[name="ac-query"]');
    if (input) {
      const run = foundry.utils.debounce(() => { this.state.query = input.value; this._refreshTree(); }, 150);
      input.addEventListener("input", run);
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          const first = this.element.querySelector(".ac-results a[data-action='selectPage']");
          first?.click();
        }
      });
    }
    this._bindViewContainer();
  }

  /** Listeners on the (persistent) view container — bound once per full render. */
  _bindViewContainer() {
    const view = this.element.querySelector(".ac-view");
    if (!view) return;
    // Navigate codex links inside the browser instead of opening sheets (shift-click = normal behaviour)
    view.addEventListener("click", (ev) => {
      const a = ev.target.closest("a.content-link[data-uuid]");
      if (!a || ev.shiftKey) return;
      const doc = fromUuidSync(a.dataset.uuid);
      const entry = doc?.documentName === "JournalEntryPage" ? doc.parent : doc?.documentName === "JournalEntry" ? doc : null;
      if (!entry || !isCodexEntry(entry)) return;
      ev.preventDefault();
      ev.stopPropagation();
      this._select(entry.id, doc.documentName === "JournalEntryPage" ? doc.id : null);
    }, { capture: true });
    this._bindView();
  }

  /** Listeners on elements inside the view — re-bound whenever the view HTML is replaced. */
  _bindView() {
    const sel = this.element?.querySelector('.ac-view select[name="ac-visibility"]');
    sel?.addEventListener("change", async () => {
      const entry = game.journal.get(this.state.entryId);
      const page = entry?.pages.get(this.state.pageId);
      if (entry && page) await setVisibility(entry, page, sel.value);
      this._refreshView();
      this._refreshTree();
    });
  }

  async _refreshView() {
    const view = this.element?.querySelector(".ac-view");
    if (!view) return this.render();
    view.innerHTML = await this._viewHTML();
    view.scrollTop = 0;
    this._bindView();
  }

  _refreshTree() {
    const tree = this.element?.querySelector(".ac-tree");
    if (!tree) return;
    const st = tree.scrollTop;
    tree.innerHTML = this._treeHTML();
    tree.scrollTop = st;
    this.element.querySelectorAll(".ac-chip").forEach((c) => c.classList.toggle("active", c.dataset.category === this.state.category));
  }

  _onClose(options) {
    super._onClose?.(options);
    CodexBrowser.instance = null;
  }

  /* ---------- actions ---------- */

  static #onSelectPage(event, target) {
    this._select(target.dataset.entry, target.dataset.page);
  }

  static #onSelectEntry(event, target) {
    const id = target.dataset.entry;
    if (this.state.entryId === id && this.state.open.has(id)) {
      this.state.open.delete(id);
      return this._refreshTree();
    }
    this._select(id, null);
  }

  static #onToggleFolder(event, target) {
    const id = target.dataset.folder;
    if (this.state.open.has(id)) this.state.open.delete(id); else this.state.open.add(id);
    this._refreshTree();
  }

  static #onSetCategory(event, target) {
    this.state.category = target.dataset.category;
    this._refreshTree();
  }

  static #onBack() {
    const prev = this.state.history.pop();
    if (prev) this._select(prev[0], prev[1], { pushHistory: false });
  }

  static #onOpenJournal() {
    const entry = game.journal.get(this.state.entryId);
    entry?.sheet.render(true, { pageId: this.state.pageId });
  }

  static #onEditPage() {
    const page = game.journal.get(this.state.entryId)?.pages.get(this.state.pageId);
    page?.sheet.render(true);
  }

  static #onFocusMap() {
    const page = game.journal.get(this.state.entryId)?.pages.get(this.state.pageId);
    if (page) focusPage(page);
  }

  static #onImport() {
    // input.click() must run synchronously inside the click gesture
    pickFile().then((text) => text && importFlow(text));
  }

  static #onExport() { exportBundle(); }

  static async #onBuildMap() { await syncPins(); }

  static async #onOpenMap() {
    const scene = getMapScene() ?? (await syncPins());
    scene?.view();
  }

  static #onSQOpen() {
    const page = game.journal.get(this.state.entryId)?.pages.get(this.state.pageId);
    if (page && SQ.ui?.openToPage) SQ.ui.openToPage(page.uuid);
    else notify("Simple Quest is not available.", "warn");
  }

  static async #onSQQuests() {
    if (SQ.ui?.openToTab) SQ.ui.openToTab("quests");
    else SQ.ui?.toggle?.();
  }

  static async #onSQMap() {
    if (!SQ.ui?.sceneToMap) return notify("This version of Simple Quest has no scene-to-map conversion.", "warn");
    const ok = await DialogV2().confirm({
      window: { title: "Convert to Simple Quest map" },
      content: `<p>This views the <b>Aevum — World Map</b> scene and asks Simple Quest to turn it into an SQ Map page, converting the pins into markers.</p>
        <p>It is a one-way copy: moving markers in Simple Quest won't move the codex pins. Run <b>Sync pins</b> first so the copy is current.</p>`
    });
    if (!ok) return;
    const scene = getMapScene() ?? (await syncPins());
    if (canvas.scene?.id !== scene.id) await scene.view();
    await SQ.ui.sceneToMap();
  }
}

/* -------------------------------------------- */
/*  Settings, hooks, API                        */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const hidden = (key, type, def) => game.settings.register(MODULE_ID, key, { scope: "world", config: false, type, default: def });
  hidden("rootFolderId", String, "");
  hidden("mapSceneId", String, "");
  hidden("lastImport", String, "");
  hidden("lastExport", String, "");
  hidden("tombstones", Object, { pages: [], entries: [] });

  game.settings.register(MODULE_ID, "pinScale", {
    name: "Map pin size", hint: "Multiplier for the size of codex pins on the world map. Run 'Sync pins' afterwards.",
    scope: "world", config: true, type: Number, default: 1, range: { min: 0.5, max: 3, step: 0.1 }
  });
  game.settings.register(MODULE_ID, "autoPins", {
    name: "Update pins after import", hint: "After an import, automatically add/move/remove world map pins to match the codex.",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "useSimpleQuest", {
    name: "Use Simple Quest", hint: "If Simple Quest is active, create quest pages as SQ Quest pages and show Simple Quest buttons in the codex.",
    scope: "world", config: true, type: Boolean, default: true
  });

  game.keybindings.register(MODULE_ID, "open", {
    name: "Open the Aevum Codex",
    editable: [{ key: "KeyC", modifiers: ["Alt"] }],
    onDown: () => { CodexBrowser.open(); return true; }
  });
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  mod.api = {
    open: (opts) => CodexBrowser.open(opts),
    exportBundle,
    importText: (text) => importFlow(typeof text === "string" ? text : JSON.stringify(text)),
    importFile: () => pickFile().then((t) => t && importFlow(t)),
    syncPins,
    getMapScene,
    entries: codexEntries,
    pageHash,
    simpleQuestType: () => SQ.questType()
  };
  if (game.user.isGM && !rootFolder()) {
    notify("No codex found in this world yet. Open the Aevum Codex (Journal tab button or Alt+C) and import your content file.");
  }
});

// Journal sidebar button
Hooks.on("renderJournalDirectory", (app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".aevum-codex-open")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "aevum-codex-open";
  btn.innerHTML = `<i class="fa-solid fa-book-atlas"></i> Aevum Codex`;
  btn.addEventListener("click", (ev) => { ev.preventDefault(); CodexBrowser.open(); });
  const actions = root.querySelector(".header-actions") ?? root.querySelector("header") ?? root;
  actions.append(btn);
});

// Canvas toolbar button (Notes controls)
Hooks.on("getSceneControlButtons", (controls) => {
  const tool = { name: "aevumCodex", title: "Aevum Codex", icon: "fa-solid fa-book-atlas", button: true, visible: true, order: 99 };
  if (Array.isArray(controls)) {
    const notes = controls.find((c) => c.name === "notes");
    notes?.tools.push({ ...tool, onClick: () => CodexBrowser.open() });
  } else if (controls?.notes?.tools) {
    controls.notes.tools.aevumCodex = { ...tool, onChange: () => CodexBrowser.open() };
  }
});

// Keep the browser fresh
for (const hook of ["createJournalEntry", "updateJournalEntry", "deleteJournalEntry", "createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage", "updateFolder", "createFolder", "deleteFolder"]) {
  Hooks.on(hook, () => CodexBrowser.refreshAll());
}

// Remember deletions made in Foundry so an import doesn't silently bring them back
Hooks.on("deleteJournalEntryPage", async (page, options, userId) => {
  if (options?.aevumCodex || userId !== game.user.id || !game.user.isGM) return;
  if (!page.getFlag(MODULE_ID, "syncHash") || !isCodexEntry(page.parent)) return;
  const t = foundry.utils.deepClone(game.settings.get(MODULE_ID, "tombstones") ?? { pages: [], entries: [] });
  t.pages = [...new Set([...(t.pages ?? []), page.id])];
  await game.settings.set(MODULE_ID, "tombstones", t);
  const scene = getMapScene();
  const note = scene?.notes.find((n) => n.getFlag(MODULE_ID, "pageUuid") === page.uuid);
  if (note) await note.delete({ aevumCodex: true });
});

Hooks.on("deleteJournalEntry", async (entry, options, userId) => {
  if (options?.aevumCodex || userId !== game.user.id || !game.user.isGM) return;
  if (!entry.getFlag(MODULE_ID, "syncHash") || !isCodexEntry(entry)) return;
  const t = foundry.utils.deepClone(game.settings.get(MODULE_ID, "tombstones") ?? { pages: [], entries: [] });
  t.entries = [...new Set([...(t.entries ?? []), entry.id])];
  await game.settings.set(MODULE_ID, "tombstones", t);
  const scene = getMapScene();
  const ids = scene?.notes.filter((n) => n.entryId === entry.id && n.getFlag(MODULE_ID, "pageUuid")).map((n) => n.id) ?? [];
  if (ids.length) await scene.deleteEmbeddedDocuments("Note", ids, { aevumCodex: true });
});

// Moving / adding / removing pins on the world map writes back into the page
Hooks.on("updateNote", async (note, changes, options, userId) => {
  if (options?.aevumCodex || userId !== game.user.id) return;
  if (!("x" in changes || "y" in changes)) return;
  if (note.parent?.id !== getMapScene()?.id) return;
  const page = fromUuidSync(note.getFlag(MODULE_ID, "pageUuid") ?? "");
  if (!page) return;
  const map = { ...(pageMap(page) ?? { icon: "landmark" }), x: Math.round(note.x), y: Math.round(note.y) };
  await page.setFlag(MODULE_ID, "map", map);
});

Hooks.on("createNote", async (note, options, userId) => {
  if (options?.aevumCodex || userId !== game.user.id) return;
  if (note.parent?.id !== getMapScene()?.id || note.getFlag(MODULE_ID, "pageUuid")) return;
  const entry = game.journal.get(note.entryId);
  if (!entry || !isCodexEntry(entry)) return;
  const page = (note.pageId && entry.pages.get(note.pageId)) ?? sortedPages(entry)[0];
  if (!page) return;
  if (pageMap(page)) return notify(`“${page.name}” already has a pin. Drag a specific page instead, or move the existing pin.`, "warn");
  await page.setFlag(MODULE_ID, "map", { x: Math.round(note.x), y: Math.round(note.y), icon: "landmark" });
  const d = noteDataFor(page);
  await note.update({ pageId: page.id, "texture.src": d.texture.src, iconSize: d.iconSize, text: d.text, fontSize: d.fontSize, global: true, [`flags.${MODULE_ID}`]: d.flags[MODULE_ID] }, { aevumCodex: true });
});

Hooks.on("deleteNote", async (note, options, userId) => {
  if (options?.aevumCodex || userId !== game.user.id) return;
  if (note.parent?.id !== getMapScene()?.id) return;
  const page = fromUuidSync(note.getFlag(MODULE_ID, "pageUuid") ?? "");
  if (page && pageMap(page)) await page.unsetFlag(MODULE_ID, "map");
});
