"use strict";

const { invoke } = window.__TAURI__.core;
const $ = (sel, root = document) => root.querySelector(sel);

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

let historyTimer = null;
const state = {
  books: [],        // [{id, name, chapters}]
  cur: null,        // {book_id, book, chapter, verse}
  verseCount: 0,    // verses in current chapter
  history: store.get("history", []),
};

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const refOf = (v) => `${v.book} ${v.chapter}:${v.verse}`;

/* ────────────────────────── Autocomplete combobox ────────────────────────── */

class Combo {
  /**
   * @param {HTMLElement} root   .combo element containing an <input> and <ul>
   * @param {object} opts
   *   items():      [{label, value}] full item list (evaluated on each open)
   *   filter(q, items): optional custom filter/ranker
   *   onPick(item): called when an item is chosen
   */
  constructor(root, opts) {
    this.root = root;
    this.input = $("input", root);
    this.list = $("ul", root);
    this.opts = opts;
    this.active = -1;
    this.shown = [];

    this.input.addEventListener("focus", () => { this.input.select(); this.open(true); });
    this.input.addEventListener("input", () => this.open(false));
    this.input.addEventListener("blur", () => setTimeout(() => this.close(), 120));
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.list.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep focus in the input
      const li = e.target.closest("li");
      if (li) this.pick(this.shown[+li.dataset.i]);
    });
  }

  get isOpen() { return !this.list.classList.contains("hidden"); }

  open(showAll) {
    const items = this.opts.items();
    const q = this.input.value.trim();
    this.shown = showAll || !q ? items : (this.opts.filter || defaultFilter)(q, items);
    this.active = this.shown.length ? 0 : -1;
    // when showing everything, start on the item that matches the current value
    if (showAll || !q) {
      const i = this.shown.findIndex((it) => it.label === this.input.value);
      if (i >= 0) this.active = i;
    }
    this.render(q && !showAll ? q : "");
    this.list.classList.toggle("hidden", this.shown.length === 0);
    this.scrollToActive();
  }

  close() { this.list.classList.add("hidden"); }

  render(q) {
    this.list.innerHTML = this.shown.map((it, i) =>
      `<li role="option" data-i="${i}" class="${i === this.active ? "active" : ""}">${highlight(it.label, q)}</li>`
    ).join("");
  }

  setActive(i) {
    if (!this.shown.length) return;
    this.active = (i + this.shown.length) % this.shown.length;
    [...this.list.children].forEach((li, n) => li.classList.toggle("active", n === this.active));
    this.scrollToActive();
  }

  scrollToActive() {
    const li = this.list.children[this.active];
    if (li) li.scrollIntoView({ block: "nearest" });
  }

  pick(item) {
    if (!item) return;
    this.input.value = item.label;
    this.close();
    this.opts.onPick(item);
  }

  onKey(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!this.isOpen) this.open(true);
      else this.setActive(this.active + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // pick highlighted item if the list is open, otherwise let the form handle it
      if (this.isOpen && this.shown[this.active]) this.pick(this.shown[this.active]);
      else this.opts.onEnter?.();
    } else if (e.key === "Escape") {
      if (this.isOpen) { e.preventDefault(); e.stopPropagation(); this.close(); }
    }
  }
}

function highlight(label, q) {
  if (!q) return esc(label);
  const i = label.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(label);
  return esc(label.slice(0, i)) + "<b>" + esc(label.slice(i, i + q.length)) + "</b>" + esc(label.slice(i + q.length));
}

function defaultFilter(q, items) {
  const s = q.toLowerCase();
  return items.filter((it) => it.label.toLowerCase().startsWith(s));
}

/** "1 sam", "1sam", "i sam" -> "i sam"; "2 ki" -> "ii ki" */
function normalizeBookQuery(q) {
  return q.toLowerCase().replace(/\./g, "").trim()
    .replace(/^1(?:st)?\s*(?=[a-z])/, "i ")
    .replace(/^2(?:nd)?\s*(?=[a-z])/, "ii ")
    .replace(/\s+/g, " ");
}

function bookFilter(q, items) {
  const s = normalizeBookQuery(q);
  if (!s) return items;
  const scored = [];
  for (const it of items) {
    const name = it.label.toLowerCase();
    let score = -1;
    if (name === s) score = 0;
    else if (name.startsWith(s)) score = 1;
    else if (name.split(" ").some((w, i) => i > 0 && w.startsWith(s))) score = 2;  // "solomon"
    else if (name.replace(/^i+ /, "").startsWith(s)) score = 3;                   // "sam" -> I/II Samuel
    else if (name.includes(s)) score = 4;
    if (score >= 0) scored.push([score, it]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

/* ────────────────────────── Viewer ────────────────────────── */

const els = {
  inBook: $("#in-book"), inChapter: $("#in-chapter"), inVerse: $("#in-verse"),
  ref: $("#ref"), text: $("#verse-text"),
  prev: $("#prev"), next: $("#next"),
};

const bookById = (id) => state.books.find((b) => b.id === id);
const numItems = (n) => Array.from({ length: n }, (_, i) => ({ label: String(i + 1), value: i + 1 }));

const comboBook = new Combo($("#combo-book"), {
  items: () => state.books.map((b) => ({ label: b.name, value: b.id })),
  filter: bookFilter,
  onPick: async (it) => {
    await setPending(it.value, 1);
    els.inChapter.focus();
  },
});
const comboChapter = new Combo($("#combo-chapter"), {
  items: () => numItems(bookById(pending.book_id)?.chapters ?? 0),
  onPick: async (it) => {
    await setPending(pending.book_id, it.value);
    els.inVerse.focus();
  },
  onEnter: () => commitChapterText(),
});
const comboVerse = new Combo($("#combo-verse"), {
  items: () => numItems(pending.verseCount),
  onPick: (it) => { els.inVerse.value = it.label; goFromInputs(); },
  onEnter: () => goFromInputs(),
});

// Values typed in the form, not yet navigated to.
const pending = { book_id: 1, chapter: 1, verseCount: 0 };

async function setPending(bookId, chapter) {
  pending.book_id = bookId;
  pending.chapter = chapter;
  els.inBook.value = bookById(bookId)?.name ?? "";
  els.inChapter.value = chapter;
  pending.verseCount = await invoke("get_verse_count", { bookId, chapter });
  els.inVerse.value = 1;
}

async function commitChapterText() {
  const n = parseInt(els.inChapter.value, 10);
  const max = bookById(pending.book_id)?.chapters ?? 0;
  if (!(n >= 1 && n <= max)) return flashInvalid(els.inChapter);
  await setPending(pending.book_id, n);
  els.inVerse.focus();
}

function flashInvalid(input) {
  input.style.borderColor = "#c0392b";
  setTimeout(() => (input.style.borderColor = ""), 700);
  input.focus();
}

/** Resolve whatever is typed in the three inputs and navigate to it. */
async function goFromInputs() {
  // book: accept exact/first autocomplete match for typed text
  const typed = els.inBook.value.trim();
  let book = state.books.find((b) => b.name.toLowerCase() === typed.toLowerCase());
  if (!book) {
    const m = bookFilter(typed, state.books.map((b) => ({ label: b.name, value: b.id })))[0];
    book = m && bookById(m.value);
  }
  if (!book) return flashInvalid(els.inBook);

  const chapter = parseInt(els.inChapter.value, 10);
  if (!(chapter >= 1 && chapter <= book.chapters)) return flashInvalid(els.inChapter);

  const verse = parseInt(els.inVerse.value, 10) || 1;
  const v = await invoke("get_verse", { bookId: book.id, chapter, verse });
  if (!v) return flashInvalid(els.inVerse);

  document.activeElement?.blur(); // so ←/→ navigate verses again
  await showVerse(v);
}

async function showVerse(v, { stepped = false } = {}) {
  state.cur = { book_id: v.book_id, book: v.book, chapter: v.chapter, verse: v.verse };
  els.ref.textContent = refOf(v);
  els.text.textContent = v.text;
  $(".verse-card").scrollTop = 0;
  document.title = `${refOf(v)} — Ang Biblia Viewer`;

  pending.book_id = v.book_id;
  pending.chapter = v.chapter;
  els.inBook.value = v.book;
  els.inChapter.value = v.chapter;
  els.inVerse.value = v.verse;
  pending.verseCount = await invoke("get_verse_count", { bookId: v.book_id, chapter: v.chapter });

  store.set("last", state.cur);
  if (stepped) scheduleHistory(state.cur);
  else { clearTimeout(historyTimer); recordHistory(state.cur); }
  updateNavButtons();
}

async function updateNavButtons() {
  const c = state.cur;
  const [p, n] = await Promise.all([
    invoke("step_verse", { bookId: c.book_id, chapter: c.chapter, verse: c.verse, forward: false }),
    invoke("step_verse", { bookId: c.book_id, chapter: c.chapter, verse: c.verse, forward: true }),
  ]);
  if (state.cur !== c) return; // navigated again meanwhile
  els.prev.disabled = !p;
  els.next.disabled = !n;
}

let stepping = false;
async function step(forward) {
  if (!state.cur || stepping) return;
  stepping = true;
  try {
    const c = state.cur;
    const v = await invoke("step_verse", { bookId: c.book_id, chapter: c.chapter, verse: c.verse, forward });
    if (v) await showVerse(v, { stepped: true });
  } finally {
    stepping = false;
  }
}
els.prev.addEventListener("click", () => step(false));
els.next.addEventListener("click", () => step(true));

$("#goto-form").addEventListener("submit", (e) => { e.preventDefault(); goFromInputs(); });

/* ────────────────────────── History ────────────────────────── */

function scheduleHistory(c) {
  // Debounce so holding → doesn't flood the history with every verse passed.
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => recordHistory(c), 800);
}

function recordHistory(c) {
  const key = (h) => `${h.book_id}:${h.chapter}:${h.verse}`;
  state.history = [{ ...c, t: Date.now() }, ...state.history.filter((h) => key(h) !== key(c))].slice(0, 100);
  store.set("history", state.history);
  if (!$("#history-menu").classList.contains("hidden")) renderHistory();
}

function renderHistory() {
  const menu = $("#history-menu");
  if (!state.history.length) {
    menu.innerHTML = `<div class="empty">No history yet</div>`;
    return;
  }
  menu.innerHTML = state.history.map((h, i) => {
    const t = new Date(h.t);
    const when = t.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
      t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `<button class="item" data-i="${i}" role="option"><span>${esc(refOf(h))}</span><small>${when}</small></button>`;
  }).join("") + `<button class="clear" data-clear>Clear history</button>`;
}

function toggleHistory(open) {
  const menu = $("#history-menu");
  const show = open ?? menu.classList.contains("hidden");
  if (show) renderHistory();
  menu.classList.toggle("hidden", !show);
  $("#history-btn").setAttribute("aria-expanded", String(show));
}

$("#history-btn").addEventListener("click", (e) => { e.stopPropagation(); toggleHistory(); });
$("#history-menu").addEventListener("click", async (e) => {
  e.stopPropagation();
  if (e.target.closest("[data-clear]")) {
    state.history = [];
    store.set("history", []);
    return renderHistory();
  }
  const btn = e.target.closest(".item");
  if (!btn) return;
  const h = state.history[+btn.dataset.i];
  toggleHistory(false);
  showPage("viewer");
  const v = await invoke("get_verse", { bookId: h.book_id, chapter: h.chapter, verse: h.verse });
  if (v) await showVerse(v);
});
document.addEventListener("click", () => toggleHistory(false));

/* ────────────────────────── Search ────────────────────────── */

const searchEls = {
  form: $("#search-form"), input: $("#search-input"), book: $("#search-book"),
  status: $("#search-status"), results: $("#search-results"),
};

async function runSearch() {
  const query = searchEls.input.value.trim();
  if (!query) { searchEls.status.textContent = ""; searchEls.results.innerHTML = ""; return; }
  const bookId = searchEls.book.value ? +searchEls.book.value : null;
  searchEls.status.textContent = "Searching…";
  try {
    const { total, results } = await invoke("search_verses", { query, bookId, limit: 200 });
    const terms = query.split(/\s+/).filter(Boolean).map(escRe);
    const re = new RegExp(`(${terms.join("|")})`, "gi");
    searchEls.results.innerHTML = results.map((v, i) =>
      `<li tabindex="0" data-i="${i}"><div class="r-ref">${esc(refOf(v))}</div>` +
      `<div class="r-text">${esc(v.text).replace(re, "<mark>$1</mark>")}</div></li>`
    ).join("");
    searchEls.results._data = results;
    searchEls.status.textContent = total === 0
      ? "No verses found."
      : total > results.length
        ? `${total} verses found — showing the first ${results.length}. Narrow the search to see more.`
        : `${total} verse${total === 1 ? "" : "s"} found.`;
  } catch (err) {
    searchEls.status.textContent = `Search failed: ${err}`;
  }
}

async function openResult(li) {
  const v = searchEls.results._data?.[+li.dataset.i];
  if (!v) return;
  showPage("viewer");
  await showVerse(v);
}

searchEls.form.addEventListener("submit", (e) => { e.preventDefault(); runSearch(); });
searchEls.book.addEventListener("change", runSearch);
searchEls.results.addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) openResult(li); });
searchEls.results.addEventListener("keydown", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  if (e.key === "Enter") openResult(li);
  else if (e.key === "ArrowDown") { e.preventDefault(); li.nextElementSibling?.focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); (li.previousElementSibling || searchEls.input).focus(); }
});
searchEls.input.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); searchEls.results.firstElementChild?.focus(); }
});

/* ────────────────────────── Pages & keyboard ────────────────────────── */

function showPage(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.page === name));
  $("#page-viewer").classList.toggle("hidden", name !== "viewer");
  $("#page-search").classList.toggle("hidden", name !== "search");
  if (name === "search") searchEls.input.focus();
  else document.activeElement?.blur();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showPage(t.dataset.page)));

const isTyping = (el) => el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const onViewer = !$("#page-viewer").classList.contains("hidden");

  if (e.key === "Escape") {
    toggleHistory(false);
    if (isTyping(document.activeElement)) document.activeElement.blur();
    return;
  }
  if (isTyping(document.activeElement)) return;

  if (onViewer && e.key === "ArrowLeft") { e.preventDefault(); step(false); }
  else if (onViewer && e.key === "ArrowRight") { e.preventDefault(); step(true); }
  else if (e.key === "/") { e.preventDefault(); showPage("search"); }
});

/* ────────────────────────── Init ────────────────────────── */

(async function init() {
  try {
    state.books = await invoke("get_books");
    searchEls.book.innerHTML = `<option value="">All books</option>` +
      state.books.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("");

    const last = store.get("last", null) || { book_id: state.books[0].id, chapter: 1, verse: 1 };
    const v = await invoke("get_verse", { bookId: last.book_id, chapter: last.chapter, verse: last.verse })
      ?? await invoke("get_verse", { bookId: state.books[0].id, chapter: 1, verse: 1 });
    await showVerse(v);
    document.activeElement?.blur();
  } catch (err) {
    els.text.textContent = `Failed to load the Bible database: ${err}`;
  }
})();
