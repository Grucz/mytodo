/* ============================================================
   UPPGIFTSHANTERAREN – applikationslogik
   Statisk app utan byggsteg. Data lagras i Supabase (Postgres)
   och skyddas av Row Level Security per användare.
   ============================================================ */

"use strict";

// ---------- Supabase-klient ----------
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- Globalt tillstånd ----------
const state = {
  user: null,
  areas: [],
  projects: [],
  tasks: [],
  events: [],
  view: "board",
  search: "",
  showDone: new Set(),   // projekt-id där klara uppgifter visas
  openMenu: null,
};

// ---------- Små hjälpare ----------
const $ = (sel) => document.querySelector(sel);
const byOrder = (a, b) => (a.sort_order - b.sort_order) || (a.id - b.id);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

const fmtShort = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short" });
const fmtLong = new Intl.DateTimeFormat("sv-SE", { weekday: "short", day: "numeric", month: "short" });

function localDateStr(d) {
  const x = new Date(d);
  return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
}
const todayStr = () => localDateStr(new Date());

function isoFromDateInput(v) {
  // Sparar kl 12:00 lokal tid så att datumet inte förskjuts av tidszoner
  if (!v) return null;
  const [y, m, d] = v.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).toISOString();
}
function dateInputFromIso(iso) {
  return iso ? localDateStr(iso) : "";
}

function fail(msg, error) {
  console.error(msg, error);
  alert(msg + (error?.message ? "\n\n" + error.message : ""));
}

// ---------- Autentisering ----------
async function initAuth() {
  if (SUPABASE_ANON_KEY.startsWith("KLISTRA_IN")) {
    $("#login-screen").classList.remove("hidden");
    const err = $("#login-error");
    err.textContent = "Konfiguration saknas: anon-nyckeln är inte ifylld i config.js.";
    err.classList.remove("hidden");
    return;
  }
  sb.auth.onAuthStateChange((_event, session) => setUser(session?.user ?? null));
  const { data } = await sb.auth.getSession();
  setUser(data.session?.user ?? null);
}

let loadedFor = null;
async function setUser(user) {
  state.user = user;
  if (!user) {
    loadedFor = null;
    $("#app").classList.add("hidden");
    $("#login-screen").classList.remove("hidden");
    return;
  }
  $("#login-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#user-email").textContent = user.email || "";
  if (loadedFor !== user.id) {
    loadedFor = user.id;
    await loadAll();
    render();
  }
}

async function login() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin + location.pathname },
  });
  if (error) fail("Inloggningen misslyckades.", error);
}

async function logout() {
  await sb.auth.signOut();
}

// ---------- Datahämtning ----------
async function loadAll() {
  const [a, p, t, e] = await Promise.all([
    sb.from("areas").select("*").order("sort_order").order("id"),
    sb.from("projects").select("*").order("sort_order").order("id"),
    sb.from("tasks").select("*").order("sort_order").order("id"),
    sb.from("events").select("*").order("event_date").order("id"),
  ]);
  for (const r of [a, p, t, e]) {
    if (r.error) return fail("Kunde inte hämta data.", r.error);
  }
  state.areas = a.data; state.projects = p.data; state.tasks = t.data; state.events = e.data;
}

// ---------- CRUD-hjälpare ----------
async function dbInsert(table, row, list) {
  const { data, error } = await sb.from(table).insert(row).select().single();
  if (error) { fail("Kunde inte spara.", error); return null; }
  list.push(data);
  return data;
}
async function dbUpdate(table, id, patch, list) {
  const { data, error } = await sb.from(table).update(patch).eq("id", id).select().single();
  if (error) { fail("Kunde inte spara ändringen.", error); return null; }
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list[i] = data;
  return data;
}
async function dbDelete(table, id, list) {
  const { error } = await sb.from(table).delete().eq("id", id);
  if (error) { fail("Kunde inte ta bort.", error); return false; }
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list.splice(i, 1);
  return true;
}
const nextOrder = (items) => items.reduce((m, x) => Math.max(m, x.sort_order), -1) + 1;

// Flytta ett objekt inom sin grupp och skriv om sort_order sekventiellt
async function moveWithin(table, group, item, dir, list) {
  const sorted = [...group].sort(byOrder);
  const i = sorted.indexOf(item);
  const j = i + dir;
  if (j < 0 || j >= sorted.length) return;
  [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
  const updates = [];
  sorted.forEach((x, idx) => {
    if (x.sort_order !== idx) {
      x.sort_order = idx;
      updates.push(sb.from(table).update({ sort_order: idx }).eq("id", x.id));
    }
  });
  const results = await Promise.all(updates);
  const bad = results.find((r) => r.error);
  if (bad) return fail("Kunde inte flytta.", bad.error);
  render();
}

// ---------- Kontextmenyer ----------
function closeMenus() {
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
  state.openMenu = null;
}
function openCtxMenu(anchorBtn, items) {
  closeMenus();
  const menu = h("div", { class: "ctx-menu" },
    items.map((it) =>
      it === "-" ? h("hr") :
      h("button", { class: it.danger ? "danger" : "", onclick: (e) => { e.stopPropagation(); closeMenus(); it.action(); } }, it.label)
    )
  );
  anchorBtn.parentElement.classList.add("menu-wrap");
  anchorBtn.parentElement.append(menu);
  state.openMenu = menu;
}
document.addEventListener("click", (e) => {
  if (state.openMenu && !state.openMenu.contains(e.target)) closeMenus();
}, true);

// ============================================================
// RENDERING
// ============================================================
function render() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === state.view));
  for (const v of ["board", "today", "upcoming", "archive"]) {
    $("#view-" + v).classList.toggle("hidden", v !== state.view);
  }
  if (state.view === "board") renderBoard();
  if (state.view === "today") renderToday();
  if (state.view === "upcoming") renderUpcoming();
  if (state.view === "archive") renderArchive();
}

const ctxName = (projectId) => {
  const p = state.projects.find((x) => x.id === projectId);
  const a = p && state.areas.find((x) => x.id === p.area_id);
  return (a ? a.name + " → " : "") + (p ? p.name : "");
};

// ---------- Sökfilter ----------
function matches(text) {
  return (text || "").toLowerCase().includes(state.search);
}
function taskMatches(t) {
  return matches(t.title) || matches(t.description) || matches(t.notes);
}
function projectMatches(p) {
  return matches(p.name) || matches(p.description) || matches(p.notes);
}

// ---------- Tavlan ----------
function renderBoard() {
  const root = $("#view-board");
  root.replaceChildren();
  const areas = state.areas.filter((a) => !a.archived).sort(byOrder);
  const searching = state.search.length > 0;

  for (const area of areas) {
    const projects = state.projects
      .filter((p) => p.area_id === area.id && !p.archived)
      .sort(byOrder);

    const col = h("div", { class: "area-col" });
    const head = h("div", { class: "area-head" },
      h("span", { class: "area-name" }, area.name),
      h("button", { class: "btn-icon", title: "Områdesmeny", onclick: (e) => { e.stopPropagation(); areaMenu(e.currentTarget, area, areas); } }, "⋯")
    );
    col.append(head);

    let anyShown = false;
    for (const p of projects) {
      const card = renderProject(p, projects, searching);
      if (card) { col.append(card); anyShown = true; }
    }

    // Lägg till projekt
    if (!searching) {
      col.append(inlineAdder("+ Lägg till projekt", async (name) => {
        await dbInsert("projects", { area_id: area.id, name, sort_order: nextOrder(projects) }, state.projects);
        render();
      }));
    }
    if (searching && !anyShown) continue;
    root.append(col);
  }

  if (!state.search) {
    root.append(h("button", { class: "add-area", onclick: async () => {
      const name = prompt("Namn på nytt område:");
      if (!name) return;
      await dbInsert("areas", { name: name.trim(), sort_order: nextOrder(state.areas) }, state.areas);
      render();
    } }, "+ Lägg till område"));
  }
}

function areaMenu(btn, area, areas) {
  openCtxMenu(btn, [
    { label: "Byt namn…", action: async () => {
      const name = prompt("Nytt namn:", area.name);
      if (name && name.trim()) { await dbUpdate("areas", area.id, { name: name.trim() }, state.areas); render(); }
    }},
    { label: "Flytta vänster", action: () => moveWithin("areas", areas, area, -1, state.areas) },
    { label: "Flytta höger", action: () => moveWithin("areas", areas, area, +1, state.areas) },
    "-",
    { label: "Arkivera område", action: async () => { await dbUpdate("areas", area.id, { archived: true }, state.areas); render(); } },
    { label: "Ta bort område…", danger: true, action: async () => {
      if (!confirm(`Ta bort "${area.name}"? Alla projekt, uppgifter och händelser i området raderas permanent.`)) return;
      await dbDelete("areas", area.id, state.areas);
      await loadAll(); render();
    }},
  ]);
}

function renderProject(p, siblings, searching) {
  const allTasks = state.tasks.filter((t) => t.project_id === p.id && !t.archived);
  const events = state.events.filter((e) => e.project_id === p.id);
  const today = todayStr();

  // Sökfiltrering
  let visibleFilter = null;
  if (searching) {
    const pHit = projectMatches(p);
    const hitIds = new Set(allTasks.filter(taskMatches).map((t) => t.id));
    // ta med föräldrar till träffade deluppgifter
    for (const t of allTasks) if (hitIds.has(t.id) && t.parent_task_id) hitIds.add(t.parent_task_id);
    if (!pHit && hitIds.size === 0) return null;
    if (!pHit) visibleFilter = hitIds;
  }

  const card = h("div", { class: "project" });

  // Rubrikrad
  const nameEl = h("div", { class: "project-name", title: "Klicka för att byta namn", onclick: () => startRename(nameEl, p) }, p.name);
  card.append(h("div", { class: "project-head" },
    nameEl,
    h("button", { class: "btn-icon", onclick: (e) => { e.stopPropagation(); projectMenu(e.currentTarget, p, siblings); } }, "⋯")
  ));

  if (p.description) card.append(h("div", { class: "project-desc", onclick: () => openNotesDialog(p) }, p.description));
  if (p.notes) card.append(h("div", { class: "project-notes", onclick: () => openNotesDialog(p) }, p.notes));

  // Händelser
  for (const ev of events) {
    const past = localDateStr(ev.event_date) < today;
    card.append(h("div", { class: "event-row" + (past ? " past" : ""), onclick: () => openEventDialog(p.id, ev) },
      h("span", { class: "event-date" }, fmtShort.format(new Date(ev.event_date))),
      h("span", { class: "event-title" }, ev.title),
      h("button", { class: "event-x", title: "Ta bort händelse", onclick: async (e) => {
        e.stopPropagation();
        if (!confirm(`Ta bort händelsen "${ev.title}"?`)) return;
        await dbDelete("events", ev.id, state.events); render();
      } }, "×")
    ));
  }

  // Uppgifter – aktiva överst, klara samlade i egen lista längst ner
  const list = h("div", { class: "task-list" });
  const tops = allTasks.filter((t) => !t.parent_task_id).sort(byOrder);
  const subsOf = (id) => allTasks.filter((t) => t.parent_task_id === id).sort(byOrder);
  const showDone = state.showDone.has(p.id);
  const doneRows = [];
  let doneCount = 0;

  const scheduledHidden = (t) => t.scheduled_date && localDateStr(t.scheduled_date) > today;

  for (const t of tops) {
    const subs = subsOf(t.id);
    const skipByFilter = visibleFilter && !visibleFilter.has(t.id) && !subs.some((s) => visibleFilter.has(s.id));
    if (skipByFilter) continue;
    if (!searching && scheduledHidden(t)) continue;

    // Klar huvuduppgift: hela gruppen (inkl. deluppgifter) flyttas till klara-listan
    if (t.status === "completed" && !searching) {
      doneRows.push(taskRow(t, tops, false));
      for (const s of subs) doneRows.push(taskRow(s, subs, true));
      doneCount += 1 + subs.length;
      continue;
    }

    list.append(taskRow(t, tops, false));
    for (const s of subs) {
      if (visibleFilter && !visibleFilter.has(s.id) && !visibleFilter.has(t.id)) continue;
      if (s.status === "completed" && !searching) { doneRows.push(taskRow(s, subs, true)); doneCount++; continue; }
      list.append(taskRow(s, subs, true));
    }
  }
  card.append(list);

  if (!searching) {
    card.append(inlineAdder("+ Lägg till uppgift", async (title) => {
      await dbInsert("tasks", { project_id: p.id, title, sort_order: nextOrder(tops) }, state.tasks);
      render();
    }, "add-task"));

    if (doneCount > 0) {
      card.append(h("button", { class: "show-done", onclick: () => {
        showDone ? state.showDone.delete(p.id) : state.showDone.add(p.id);
        render();
      } }, showDone ? "Dölj klara" : `👁 Visa klara (${doneCount})`));
      if (showDone) card.append(h("div", { class: "task-list done-list" }, doneRows));
    } else if (showDone) {
      state.showDone.delete(p.id);
    }
  }
  return card;
}

function startRename(nameEl, p) {
  const input = h("input", { type: "text", value: p.name });
  nameEl.replaceChildren(input);
  input.focus(); input.select();
  const commit = async () => {
    const v = input.value.trim();
    if (v && v !== p.name) await dbUpdate("projects", p.id, { name: v }, state.projects);
    render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") render();
  });
  input.addEventListener("blur", commit);
}

function projectMenu(btn, p, siblings) {
  const otherAreas = state.areas.filter((a) => !a.archived && a.id !== p.area_id).sort(byOrder);
  openCtxMenu(btn, [
    { label: "Beskrivning & anteckningar…", action: () => openNotesDialog(p) },
    { label: "Lägg till händelse…", action: () => openEventDialog(p.id, null) },
    "-",
    { label: "Flytta upp", action: () => moveWithin("projects", siblings, p, -1, state.projects) },
    { label: "Flytta ner", action: () => moveWithin("projects", siblings, p, +1, state.projects) },
    ...otherAreas.map((a) => ({ label: "Flytta till: " + a.name, action: async () => {
      const dest = state.projects.filter((x) => x.area_id === a.id && !x.archived);
      await dbUpdate("projects", p.id, { area_id: a.id, sort_order: nextOrder(dest) }, state.projects);
      render();
    }})),
    "-",
    { label: "Arkivera projekt", action: async () => { await dbUpdate("projects", p.id, { archived: true }, state.projects); render(); } },
    { label: "Ta bort projekt…", danger: true, action: async () => {
      if (!confirm(`Ta bort "${p.name}"? Projektets uppgifter och händelser raderas permanent.`)) return;
      await dbDelete("projects", p.id, state.projects);
      await loadAll(); render();
    }},
  ]);
}

function noteIcon() {
  const s = h("span", { class: "note-ico", title: "Har anteckning – klicka på uppgiften" });
  s.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>';
  return s;
}

function taskRow(t, siblings, isSub) {
  const done = t.status === "completed";
  const row = h("div", { class: "task" + (isSub ? " sub" : "") + (done ? " done" : "") + (t.status === "in_progress" ? " inprog" : "") });

  row.append(h("button", {
    class: "task-check " + t.status,
    title: "Klicka för att växla status",
    onclick: async () => {
      const next = t.status === "pending" ? "in_progress" : t.status === "in_progress" ? "completed" : "pending";
      await dbUpdate("tasks", t.id, { status: next, completed_at: next === "completed" ? new Date().toISOString() : null }, state.tasks);
      render();
    },
  }));

  const meta = [];
  if (t.deadline) {
    const overdue = !done && localDateStr(t.deadline) < todayStr();
    meta.push(h("span", { class: "badge " + (overdue ? "overdue" : "deadline") },
      (overdue ? "⚠ " : "") + fmtShort.format(new Date(t.deadline))));
  }
  if (t.scheduled_date && localDateStr(t.scheduled_date) > todayStr()) {
    meta.push(h("span", { class: "badge" }, "⏰ " + fmtShort.format(new Date(t.scheduled_date))));
  }
  row.append(h("div", { class: "task-title", onclick: () => openTaskDialog(t) },
    t.title,
    t.notes ? noteIcon() : null,
    meta.length ? h("div", { class: "task-meta" }, meta) : null
  ));

  row.append(h("button", { class: "btn-icon", style: "font-size:14px;padding:2px 6px", onclick: (e) => {
    e.stopPropagation();
    openCtxMenu(e.currentTarget, [
      ...(!isSub ? [{ label: "Lägg till deluppgift…", action: () => {
        const title = prompt("Deluppgiftens rubrik:");
        if (!title || !title.trim()) return;
        const subs = state.tasks.filter((x) => x.parent_task_id === t.id);
        dbInsert("tasks", { project_id: t.project_id, parent_task_id: t.id, title: title.trim(), sort_order: nextOrder(subs) }, state.tasks).then(render);
      }}] : []),
      { label: "Flytta upp", action: () => moveWithin("tasks", siblings, t, -1, state.tasks) },
      { label: "Flytta ner", action: () => moveWithin("tasks", siblings, t, +1, state.tasks) },
    ]);
  } }, "⋯"));

  return row;
}

function inlineAdder(label, onAdd, cls = "add-task") {
  const wrap = h("div");
  const btn = h("button", { class: cls, onclick: () => {
    const input = h("input", { class: "add-task-input", type: "text", placeholder: "Rubrik – Enter för att spara" });
    wrap.replaceChildren(input);
    input.focus();
    let saving = false;
    const commit = async () => {
      if (saving) return;
      const v = input.value.trim();
      if (v) { saving = true; await onAdd(v); }
      else wrap.replaceChildren(btn);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") wrap.replaceChildren(btn);
    });
    input.addEventListener("blur", commit);
  } }, label);
  wrap.append(btn);
  return wrap;
}

// ---------- Idag ----------
function renderToday() {
  const root = $("#view-today");
  root.replaceChildren();
  const today = todayStr();
  const week = localDateStr(Date.now() + 7 * 864e5);
  const active = state.tasks.filter((t) => !t.archived && t.status !== "completed" &&
    !state.projects.find((p) => p.id === t.project_id)?.archived);

  const overdue = active.filter((t) => t.deadline && localDateStr(t.deadline) < today);
  const dueToday = active.filter((t) => t.deadline && localDateStr(t.deadline) === today);
  const evToday = state.events.filter((e) => localDateStr(e.event_date) === today);
  const dueWeek = active.filter((t) => t.deadline && localDateStr(t.deadline) > today && localDateStr(t.deadline) <= week);
  const evWeek = state.events.filter((e) => localDateStr(e.event_date) > today && localDateStr(e.event_date) <= week);

  const section = (title, rows) => {
    root.append(h("h2", {}, title));
    root.append(rows.length
      ? h("div", { class: "lv-group" }, rows)
      : h("div", { class: "lv-group" }, h("div", { class: "lv-empty" }, "Inget här. 🙂")));
  };
  const taskLine = (t) => h("div", { class: "lv-row" },
    h("span", { class: "lv-date" }, fmtShort.format(new Date(t.deadline))),
    h("div", { class: "lv-main" },
      h("div", { style: "cursor:pointer", onclick: () => openTaskDialog(t) }, t.title),
      h("div", { class: "lv-ctx" }, ctxName(t.project_id))));
  const evLine = (e) => h("div", { class: "lv-row" },
    h("span", { class: "lv-date" }, fmtShort.format(new Date(e.event_date))),
    h("div", { class: "lv-main" }, h("div", {}, "📅 " + e.title), h("div", { class: "lv-ctx" }, ctxName(e.project_id))));

  section("⚠ Försenade", overdue.map(taskLine));
  section("Idag", [...evToday.map(evLine), ...dueToday.map(taskLine)]);
  section("Kommande 7 dagar", [
    ...[...evWeek.map((e) => ({ d: localDateStr(e.event_date), el: evLine(e) })),
        ...dueWeek.map((t) => ({ d: localDateStr(t.deadline), el: taskLine(t) }))]
      .sort((a, b) => a.d.localeCompare(b.d)).map((x) => x.el),
  ]);
}

// ---------- Kommande ----------
function renderUpcoming() {
  const root = $("#view-upcoming");
  root.replaceChildren();
  const today = todayStr();
  const items = [];

  for (const e of state.events) {
    const d = localDateStr(e.event_date);
    if (d >= today) items.push({ d, el: h("div", { class: "lv-row" },
      h("div", { class: "lv-main" }, h("div", {}, "📅 " + e.title), h("div", { class: "lv-ctx" }, ctxName(e.project_id)))) });
  }
  for (const t of state.tasks) {
    if (t.archived || t.status === "completed") continue;
    if (t.scheduled_date && localDateStr(t.scheduled_date) >= today) {
      items.push({ d: localDateStr(t.scheduled_date), el: h("div", { class: "lv-row" },
        h("div", { class: "lv-main" },
          h("div", { style: "cursor:pointer", onclick: () => openTaskDialog(t) }, "⏰ " + t.title),
          h("div", { class: "lv-ctx" }, ctxName(t.project_id)))) });
    } else if (t.deadline && localDateStr(t.deadline) >= today) {
      items.push({ d: localDateStr(t.deadline), el: h("div", { class: "lv-row" },
        h("div", { class: "lv-main" },
          h("div", { style: "cursor:pointer", onclick: () => openTaskDialog(t) }, "🎯 " + t.title + " (deadline)"),
          h("div", { class: "lv-ctx" }, ctxName(t.project_id)))) });
    }
  }

  if (!items.length) {
    root.append(h("div", { class: "lv-group" }, h("div", { class: "lv-empty" }, "Inga kommande händelser eller schemalagda uppgifter.")));
    return;
  }
  items.sort((a, b) => a.d.localeCompare(b.d));
  let current = "";
  let group = null;
  for (const it of items) {
    if (it.d !== current) {
      current = it.d;
      root.append(h("h2", {}, fmtLong.format(new Date(it.d + "T12:00:00"))));
      group = h("div", { class: "lv-group" });
      root.append(group);
    }
    group.append(it.el);
  }
}

// ---------- Arkiv ----------
function renderArchive() {
  const root = $("#view-archive");
  root.replaceChildren();

  const restoreBtn = (fn) => h("button", { class: "btn btn-ghost lv-restore", onclick: fn }, "↩ Återställ");

  const areas = state.areas.filter((a) => a.archived);
  root.append(h("h2", {}, "Arkiverade områden"));
  root.append(h("div", { class: "lv-group" },
    areas.length ? areas.map((a) => h("div", { class: "lv-row" },
      h("div", { class: "lv-main" }, a.name),
      restoreBtn(async () => { await dbUpdate("areas", a.id, { archived: false }, state.areas); render(); })
    )) : h("div", { class: "lv-empty" }, "Inga arkiverade områden.")));

  const projects = state.projects.filter((p) => p.archived);
  root.append(h("h2", {}, "Arkiverade projekt"));
  root.append(h("div", { class: "lv-group" },
    projects.length ? projects.map((p) => h("div", { class: "lv-row" },
      h("div", { class: "lv-main" }, h("div", {}, p.name), h("div", { class: "lv-ctx" }, state.areas.find((a) => a.id === p.area_id)?.name || "")),
      restoreBtn(async () => { await dbUpdate("projects", p.id, { archived: false }, state.projects); render(); })
    )) : h("div", { class: "lv-empty" }, "Inga arkiverade projekt.")));

  const tasks = state.tasks.filter((t) => t.archived);
  root.append(h("h2", {}, "Arkiverade uppgifter"));
  root.append(h("div", { class: "lv-group" },
    tasks.length ? tasks.map((t) => h("div", { class: "lv-row" },
      h("div", { class: "lv-main" }, h("div", {}, t.title), h("div", { class: "lv-ctx" }, ctxName(t.project_id))),
      restoreBtn(async () => { await dbUpdate("tasks", t.id, { archived: false }, state.tasks); render(); })
    )) : h("div", { class: "lv-empty" }, "Inga arkiverade uppgifter.")));
}

// ============================================================
// DIALOGER
// ============================================================
let dlgTask = null;
function openTaskDialog(t) {
  dlgTask = t;
  $("#task-dlg-title").textContent = "Redigera uppgift";
  $("#task-title").value = t.title;
  // Äldre uppgifter kan ha text i beskrivningsfältet – den visas här och
  // flyttas till anteckningar vid nästa sparning.
  $("#task-notes").value = t.notes || t.description || "";
  $("#task-status").value = t.status;
  $("#task-deadline").value = dateInputFromIso(t.deadline);
  $("#task-scheduled").value = dateInputFromIso(t.scheduled_date);
  $("#dlg-task").showModal();
}
$("#task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("#task-status").value;
  await dbUpdate("tasks", dlgTask.id, {
    title: $("#task-title").value.trim(),
    description: null,
    notes: $("#task-notes").value.trim() || null,
    status,
    completed_at: status === "completed" ? (dlgTask.completed_at || new Date().toISOString()) : null,
    deadline: isoFromDateInput($("#task-deadline").value),
    scheduled_date: isoFromDateInput($("#task-scheduled").value),
  }, state.tasks);
  $("#dlg-task").close(); render();
});
$("#task-cancel").addEventListener("click", () => $("#dlg-task").close());
$("#task-archive").addEventListener("click", async () => {
  await dbUpdate("tasks", dlgTask.id, { archived: true }, state.tasks);
  $("#dlg-task").close(); render();
});
$("#task-delete").addEventListener("click", async () => {
  if (!confirm("Ta bort uppgiften permanent? Eventuella deluppgifter raderas också.")) return;
  await dbDelete("tasks", dlgTask.id, state.tasks);
  await loadAll();
  $("#dlg-task").close(); render();
});

let dlgEvent = null, dlgEventProject = null;
function openEventDialog(projectId, ev) {
  dlgEvent = ev; dlgEventProject = projectId;
  $("#event-dlg-title").textContent = ev ? "Redigera händelse" : "Ny händelse";
  $("#event-title").value = ev ? ev.title : "";
  $("#event-date").value = ev ? dateInputFromIso(ev.event_date) : "";
  $("#event-delete").classList.toggle("hidden", !ev);
  $("#dlg-event").showModal();
}
$("#event-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const patch = { title: $("#event-title").value.trim(), event_date: isoFromDateInput($("#event-date").value) };
  if (dlgEvent) await dbUpdate("events", dlgEvent.id, patch, state.events);
  else await dbInsert("events", { ...patch, project_id: dlgEventProject, sort_order: 0 }, state.events);
  state.events.sort((a, b) => a.event_date.localeCompare(b.event_date));
  $("#dlg-event").close(); render();
});
$("#event-cancel").addEventListener("click", () => $("#dlg-event").close());
$("#event-delete").addEventListener("click", async () => {
  if (!confirm("Ta bort händelsen?")) return;
  await dbDelete("events", dlgEvent.id, state.events);
  $("#dlg-event").close(); render();
});

let dlgNotesProject = null;
function openNotesDialog(p) {
  dlgNotesProject = p;
  $("#proj-desc").value = p.description || "";
  $("#proj-notes").value = p.notes || "";
  $("#dlg-notes").showModal();
}
$("#notes-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await dbUpdate("projects", dlgNotesProject.id, {
    description: $("#proj-desc").value.trim() || null,
    notes: $("#proj-notes").value.trim() || null,
  }, state.projects);
  $("#dlg-notes").close(); render();
});
$("#notes-cancel").addEventListener("click", () => $("#dlg-notes").close());

// ============================================================
// IMPORT FRÅN MANUS-EXPORT
// ============================================================
let importData = null;
$("#btn-import").addEventListener("click", () => {
  closeUserMenu();
  importData = null;
  $("#import-file").value = "";
  $("#import-status").textContent = "";
  $("#import-run").disabled = true;
  $("#dlg-import").showModal();
});
$("#import-cancel").addEventListener("click", () => $("#dlg-import").close());
$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!Array.isArray(d.areas) || !Array.isArray(d.projects) || !Array.isArray(d.tasks)) throw new Error("Fel format");
    importData = d;
    $("#import-status").textContent =
      `Hittade ${d.areas.length} områden, ${d.projects.length} projekt, ${d.tasks.length} uppgifter, ${(d.events || []).length} händelser.`;
    $("#import-run").disabled = false;
  } catch {
    $("#import-status").textContent = "Kunde inte läsa filen – är det rätt JSON-fil?";
  }
});
$("#import-run").addEventListener("click", async () => {
  if (!importData) return;
  const status = (msg) => { $("#import-status").textContent = msg; };
  $("#import-run").disabled = true;
  const msToIso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const oldSort = (a, b) => (a.sortOrder - b.sortOrder) || (a.id - b.id);

  try {
    // 1. Områden
    status("Importerar områden…");
    const oldAreas = [...importData.areas].sort(oldSort);
    const areaMap = new Map();
    const { data: newAreas, error: ea } = await sb.from("areas")
      .insert(oldAreas.map((a, i) => ({ name: a.name, sort_order: i, archived: !!a.archived }))).select();
    if (ea) throw ea;
    oldAreas.forEach((a, i) => areaMap.set(a.id, newAreas[i].id));

    // 2. Projekt
    status("Importerar projekt…");
    const oldProjects = [...importData.projects].sort(oldSort);
    const projMap = new Map();
    const { data: newProjects, error: ep } = await sb.from("projects")
      .insert(oldProjects.map((p, i) => ({
        area_id: areaMap.get(p.areaId), name: p.name,
        description: p.description || null, notes: p.notes || null,
        sort_order: i, archived: !!p.archived,
      }))).select();
    if (ep) throw ep;
    oldProjects.forEach((p, i) => projMap.set(p.id, newProjects[i].id));

    // 3. Uppgifter – först huvuduppgifter, sedan deluppgifter
    const taskMap = new Map();
    const mapTask = (t, i) => ({
      project_id: projMap.get(t.projectId),
      parent_task_id: t.parentTaskId ? taskMap.get(t.parentTaskId) : null,
      title: t.title, description: null,
      notes: [t.description, t.notes].filter(Boolean).join("\n\n") || null,
      status: t.completed ? "completed" : (t.status || "pending"),
      completed_at: t.completed ? (t.updatedAt || new Date().toISOString()) : null,
      deadline: msToIso(t.deadline), scheduled_date: msToIso(t.scheduledDate),
      sort_order: i, archived: !!t.archived,
    });
    const insertChunked = async (rows, originals) => {
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        const { data, error } = await sb.from("tasks").insert(chunk).select();
        if (error) throw error;
        data.forEach((row, j) => taskMap.set(originals[i + j].id, row.id));
        status(`Importerar uppgifter… ${Math.min(i + 100, rows.length)} av ${importData.tasks.length}`);
      }
    };
    const parents = importData.tasks.filter((t) => !t.parentTaskId).sort(oldSort);
    await insertChunked(parents.map(mapTask), parents);
    const children = importData.tasks.filter((t) => t.parentTaskId).sort(oldSort);
    await insertChunked(children.map(mapTask), children);

    // 4. Händelser
    status("Importerar händelser…");
    const oldEvents = (importData.events || []).filter((e) => projMap.has(e.projectId));
    if (oldEvents.length) {
      const { error: ee } = await sb.from("events").insert(oldEvents.map((e, i) => ({
        project_id: projMap.get(e.projectId), title: e.title,
        event_date: msToIso(e.eventDate), sort_order: i,
      })));
      if (ee) throw ee;
    }

    status("Klart! Laddar om…");
    await loadAll();
    $("#dlg-import").close();
    render();
  } catch (err) {
    fail("Importen avbröts av ett fel.", err);
    status("Importen misslyckades. Se felmeddelandet.");
    $("#import-run").disabled = false;
  }
});

// ---------- Export ----------
$("#btn-export").addEventListener("click", () => {
  closeUserMenu();
  const blob = new Blob([JSON.stringify({
    exportedAt: new Date().toISOString(),
    areas: state.areas, projects: state.projects, tasks: state.tasks, events: state.events,
  }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "uppgiftshanteraren-backup-" + todayStr() + ".json";
  a.click();
});

// ============================================================
// TOPPMENY & START
// ============================================================
$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  state.view = btn.dataset.view;
  render();
});

let searchTimer = null;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value.trim().toLowerCase();
    if (state.search && state.view !== "board") { state.view = "board"; }
    render();
  }, 200);
});

function closeUserMenu() { $("#user-dropdown").classList.add("hidden"); }
$("#btn-user").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#user-dropdown").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".usermenu")) closeUserMenu();
});
$("#btn-logout").addEventListener("click", logout);
$("#btn-google").addEventListener("click", login);

initAuth();
