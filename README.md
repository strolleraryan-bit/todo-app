# Todo List by Aryan

A stylish, fully animated day-to-day to-do list — checklists, tags,
priorities, due dates, recurring tasks, a **#daily must** streak system,
pinning, drag reorder, swipe gestures, system notifications with sound &
vibration for reminders, a text-to-tasks generator, PDF export, and
autosave. Installable on your phone as a PWA.

> **Maintainers, read this first:** this file is the single source of truth
> for how the app works. See **"Keeping this README up to date"** at the
> bottom — it's not optional, it's how the next person (or the next AI
> session, on a different account, with zero memory of this one) avoids
> re-breaking things that were already fixed once.

---

## What's inside

```
todo_v1_updated/
├── index.html        the app shell (markup only)
├── css/style.css      all styling
├── js/app.js           all app logic (one IIFE, no build step, no framework)
├── manifest.json      makes the app installable (name, icons, colors)
├── sw.js               service worker: offline caching + reminder notifications
├── icons/              home-screen icons
└── netlify.toml        headers config for Netlify hosting
```

There is no build step. It's plain HTML/CSS/JS — edit the files directly and
reload the page.

## Core concepts

**Tasks** live in one in-memory array (`tasks`) in `js/app.js`, persisted via
a small `localStore` wrapper (see `saveTasks()` / `loadTasks()`) under a
single storage key. Every task has: `text`, `priority`, `due` (ISO date or
`""`), `done`, `completedAt`, `note`, `tags[]`, `subtasks[]`, `pinned`,
`repeat` (`none` / `daily` / `weekly` / `monthly`), `remind` (`HH:MM`),
`seriesId` (links repeat occurrences together), and a few bookkeeping fields
(`id`, `order`, `serial`, `createdAt`).

**Tags** are free-form strings managed from the "Manage tags" modal, except
for one special one:

### The `#daily must` tag — how it's *supposed* to work

`#daily must` (constant `PERMANENT_TAG` in `app.js`) is a built-in tag that
can't be renamed or deleted. It powers a streak feature (`streak-panel` at
the top of the app): complete every ticket tagged `#daily must` before a
calendar day ends, and the streak continues; miss one, and it resets.

The intended behavior, enforced as of this update:

1. **Choosing the `#daily must` tag in the composer always repeats daily.**
   The repeat dropdown auto-selects "Daily" and locks (greyed out,
   `disabled`) so it can't accidentally be set to weekly/monthly/none. See
   `applyDailyMustRepeatLock()` in `app.js`.
2. **Every `#daily must` ticket always has a due date.** If you don't pick
   one, it defaults to today. This matters because the repeat "rollover"
   engine (`rolloverRepeatingTasks()`) only regenerates the next occurrence
   for tasks that *have* a `due` date — a `#daily must` ticket with no due
   date was previously a dead end that never refreshed.
3. **A `#daily must` ticket belongs to exactly one calendar day**, its `due`
   date (or its creation date if somehow still undated). Outside calendar/
   date-view, the main list only ever shows **today's** `#daily must`
   ticket(s) — done or not. Yesterday's (missed or completed) and tomorrow's
   (if one was pre-spawned early by completing today's) stay hidden until
   you're actually looking at that date via the calendar view. This is
   enforced in `getFiltered()`.
4. **Refresh happens automatically at (or after) midnight**, independent of
   whether you finished the previous day's ticket. `rolloverRepeatingTasks()`
   runs on load, every 20s (`setInterval`), and on tab
   `visibilitychange` — it walks every repeating series forward to "today"
   regardless of whether the prior occurrence was ever completed, so a
   missed day doesn't stall the series (it does still break the streak,
   which is the point).
5. Completing a `#daily must` (or any repeating) ticket **also** immediately
   spawns tomorrow's occurrence (`toggleDone()`), as an instant confirmation
   / for the undo toast — rule 3 above is what keeps that early spawn
   invisible until its actual day.

If you ever touch daily-must / repeat / due-date logic, re-read points 1–5
above and make sure your change doesn't violate any of them. Search
`js/app.js` for `PERMANENT_TAG` to find every place that treats this tag
specially — there is deliberately no separate "daily must module", it's
woven into the composer, the bulk "Text → tasks" generator, `getFiltered()`,
`rolloverRepeatingTasks()`, `toggleDone()`, and the streak functions
(`taskDayKey`, `dailyMustDayMap`, `computeDailyMustStreak`,
`updateStreakWidget`, `updateStreakPanel`).

**There are two places a person can pick `#daily must` on a new ticket** —
the single-ticket composer, and the bulk "Text → tasks" modal (📝, tags the
whole batch at once). Rules 1–2 above (`repeat: daily`, due date today by
default) must be enforced in **both**. The bulk modal has no repeat
dropdown to lock, so it forces `repeat`/`due` silently in the
`parseGenerate` click handler instead of via a UI lock — if you add a third
way to create tasks, it needs the same treatment.

### Bug fixed in this update (for context / regression-testing)

Previously: adding a `#daily must` ticket didn't force `repeat: daily` or a
due date, so (a) the repeat dropdown had to be set manually and easy to
forget, (b) a ticket with no due date never rolled over at midnight if left
unfinished, and (c) the main (non-calendar) list had no date-scoping at all,
so once a next-day occurrence *did* get spawned (e.g. right after marking
today's done), it showed up immediately in today's list — looking like the
ticket had "jumped to next day" instead of quietly waiting for its own day.
Fixed by: auto-locking repeat to daily + defaulting due to today when the
tag is chosen (composer), day-scoping `#daily must` tickets in
`getFiltered()`, and a one-time migration in `loadTasks()` that backfills
`due`/`repeat` on any older saved tickets missing them.

## Other features (quick reference)

- **Calendar / date view** (📅 button, bottom-right column) — browse any
  date; shows that day's tickets plus anything carried forward (overdue,
  non-`#daily must` tickets only — see `getCarryForwardLive`).
- **Reminders** — set a time next to a due date, get a system notification
  (needs notifications enabled from the 🔔 menu item; only fires while the
  app/tab is open, no push server).
- **Text → tasks** (📝 button) — paste comma- or newline-separated text,
  generate multiple tickets at once, optionally tag them all.
- **PDF export** (☰ menu) — export all / active / done / by-tag as PDF
  (via jsPDF + autotable, loaded from CDN in `index.html`).
- **Backup / Restore** (☰ menu) — download/upload the task list as JSON.
- **Drag reorder** — only active when Sort is "Manual order".
- **Swipe gestures** — swipe right to complete, left to delete (touch
  devices).
- **Undo/redo toast** — most destructive/completing actions push an undo
  entry (`pushUndo`).

## Deploy on Netlify (2 minutes)

**Option A — drag & drop (easiest)**
1. Go to https://app.netlify.com/drop
2. Drag this whole folder onto the page.
3. Netlify gives you a live URL. Done.

**Option B — via a Netlify site**
1. Log in at https://app.netlify.com
2. "Add new site" → "Deploy manually" → drag in the folder (or a zip of it).
3. Optionally rename the site under Site settings → General.

**Option C — connect to GitHub** (auto-deploy on every push)
1. Push this folder to a GitHub repo.
2. In Netlify: "Add new site" → "Import an existing project" → pick the repo.
3. Build command: leave blank. Publish directory: `.`

## Install it on your phone

**Android (Chrome):** open the live link → ⋮ menu → "Add to Home screen" /
"Install app". Works offline once installed. Allow notifications from the
🔔 panel if you want reminders.

**iPhone (Safari):** open the live link in Safari (must be Safari) → Share
icon → "Add to Home Screen". iOS requires the app to be opened from the
home screen at least once before reminder notifications will work — that's
an Apple platform requirement, not something this app can bypass.

## Notes

- Tasks autosave in the background — no manual save needed.
- Use **☰ Menu → Backup (json)** any time you want a portable copy of your
  list (handy before clearing browser data, or to move to another device).
- The 🔔 reminder time on a ticket needs a due date to anchor to — if you
  set a reminder time without picking a date, today's date is used
  automatically.

---

## Keeping this README up to date

**This is a standing instruction, not a one-time request.** This project
gets picked up across different chat sessions and potentially different
accounts, with no shared memory between them — this README is the only
continuity the next session has. Treat it as part of the app, not
paperwork.

Whenever you (human or AI assistant) change how the app behaves — not just
"add a feature," but also bug fixes, changed defaults, renamed concepts, new
files, or removed features — **update this README in the same change, not
as a follow-up:**

1. If you fixed a bug, add/update a short "why" note near the relevant
   feature section (like "Bug fixed in this update" above) so the next
   person understands the constraint that made the fix necessary, not just
   what the code does. This is what prevents the same bug from being
   silently reintroduced.
2. If you changed a rule about how `#daily must`, repeat, or due dates
   behave, update the numbered list under "The `#daily must` tag" — that
   list is meant to always reflect current, correct behavior.
3. If you added/removed/renamed a file, update the file tree under "What's
   inside."
4. If you added a user-facing feature, add one bullet under "Other
   features."
5. Keep entries short and behavioral (what it does and why), not a diff or
   changelog of every line touched — this file describes the app as it is
   *now*, not its history.

If a change and a README update can't both fit in the same response, the
change isn't done yet.
