# todo list by Aryan

A stylish, fully animated day-to-day to-do list — checklists, tags, priorities,
due dates, recurring tasks, pinning, drag reorder, swipe gestures, system
notifications with sound & vibration for reminders, a text-to-tasks generator,
and autosave. Installable on your phone as an app.

Streaks, points, and the Pomodoro focus timer have been removed — this build
is scoped purely to day-to-day task management.

## What's inside

- `index.html` — the app shell (links to `css/style.css` and `js/app.js`)
- `css/style.css` — all styling, separated out from the markup
- `js/app.js` — all app logic, separated out from the markup
- `index-standalone.html` — the **exact same app** as a single self-contained
  file (CSS and JS inlined). Use this if you ever want to copy/share/host the
  app as one file instead of a folder — it works identically to `index.html`.
- `manifest.json` — makes the app installable (name, icons, colors)
- `sw.js` — service worker: caches the app shell for offline use, and shows
  reminder notifications from the system tray
- `icons/` — app icons for the home screen
- `netlify.toml` — sets correct headers when hosted on Netlify

Both `index.html` and `index-standalone.html` sit side by side and share the
same `manifest.json`, `sw.js`, and `icons/` — deploy the whole `todo-app`
folder and either entry point works.

## New in this build

**Notifications & reminders**
Tap the **🔔 Notifications** button in the bottom utility row to turn on
notifications. Add a reminder time next to a ticket's due date (the 🔔 time
field in the composer) and you'll get a system notification — with a short
tone and a vibration — when it comes due. There's a "Send a test
notification" button in that same panel so you can check it works on your device before relying
on it.

> Note: since this is a browser-based app with no push server, reminders
> fire while the app is open in a tab (foreground or background) — not if
> the browser/tab is fully closed. Keep it open (or pinned) for reminders to
> reach you reliably. Installing it as a home-screen app and keeping it
> running in the background works well on most phones.

**Text → tasks**
Tap the 📝 button in the bottom-right column. Paste or type a block of text,
separating each task with a comma (new lines also work), then tap
**Generate tasks**. Each item becomes its own ticket, in the order you wrote
them. There's an undo if you change your mind.

**Always-visible bottom-right button column**
The calendar/date-view toggle, light/dark theme toggle, and text-to-tasks
live as small round buttons stacked vertically at the bottom right — no
collapsed "＋" menu, everything is one tap away. The Today button in that
column (and the "Today" pill in the date-nav bar) only appears when you're
viewing a date other than today.

**Bottom utility row**
Backup/Restore, Download backup, Restore from file, and Notifications sit
together as clearly visible buttons below the task list — grouped there so
they're out of the way of everyday use but easy to find.


**Animated date switching**
Moving between days (arrows, "Today," or picking a date from the calendar)
now has a small transition on the date label and a subtle highlight pulse,
instead of the date just snapping.

## Deploy on Netlify (2 minutes)

**Option A — drag & drop (easiest)**
1. Go to https://app.netlify.com/drop
2. Unzip this folder on your computer, then drag the whole `todo-app` folder
   onto the page.
3. Netlify gives you a live URL (e.g. `https://random-name.netlify.app`).
   That's it — done.

**Option B — via a Netlify site**
1. Log in at https://app.netlify.com
2. "Add new site" → "Deploy manually" → drag in the `todo-app` folder (or a
   zip of it).
3. Optionally rename the site under Site settings → General → Site details →
   change site name, so your URL reads something like
   `https://aryan-todo.netlify.app`.

**Option C — connect to GitHub** (if you want auto-deploys on every change)
1. Push this folder to a new GitHub repo.
2. In Netlify: "Add new site" → "Import an existing project" → pick the repo.
3. Build command: leave blank. Publish directory: `.`

## Install it on your phone

Once it's live on Netlify:

**Android (Chrome):**
1. Open the Netlify link in Chrome.
2. Tap the ⋮ menu → **"Add to Home screen"** / **"Install app"**.
3. It installs like a native app, opens full-screen, and works offline.
4. When first prompted (from the 🔔 panel), allow notifications so reminders
   can reach you.

**iPhone (Safari):**
1. Open the Netlify link in Safari (must be Safari, not Chrome, for this to work).
2. Tap the **Share** icon → **"Add to Home Screen"**.
3. It appears on your home screen as its own app icon.
4. iOS reminder notifications require the app to have been added to the
   home screen and opened at least once from there (Apple's requirement for
   web push, not something this app can bypass).

## Notes

- Your tasks autosave in the background as you use the app — no manual save needed.
- Use the **⇅ Backup / Restore** button any time you want a copy of your list as
  text (handy before clearing browser data, or to move your list to another device).
- Swipe a task right to complete it, left to delete it (on touch devices).
- Drag reorder works when Sort is set to "Manual order."
- The 🔔 reminder time on a ticket needs a due date to anchor to — if you set
  a reminder time without picking a date, today's date is used automatically.
