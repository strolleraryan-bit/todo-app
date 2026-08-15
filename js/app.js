(function(){
  "use strict";

  // ---------- STATE ----------
  let tasks = [];
  let idCounter = 1;
  let currentFilter = "all";
  let searchTerm = "";
  let composerPriority = "med";
  let draggingId = null;
  let hasCelebrated = false;
  let sortMode = "manual";
  let activeTagFilter = null;
  let meta = { notificationsEnabled: false, customTags: [], theme: null, seriesWatermark: {} }; // small persisted settings blob

  // ---------- PERMANENT TAG ----------
  // "daily must" always exists in every dropdown/filter/manage list — it
  // can't be renamed or deleted like a normal custom tag, since the streak
  // feature depends on its name staying stable.
  const PERMANENT_TAG = "daily must";

  // ---------- DATE HELPERS ----------
  function toISODate(d){
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,"0");
    const day = String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${day}`;
  }
  function todayISO(){ return toISODate(new Date()); }
  function isSameDayAs(timestamp, dateStr){
    if(!timestamp) return false;
    return toISODate(new Date(timestamp)) === dateStr;
  }
  function formatDateLong(dateStr){
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString(undefined, { weekday:"long", month:"long", day:"numeric", year:"numeric" });
  }
  function formatDateShort(dateStr){
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString(undefined, { month:"short", day:"numeric" });
  }

  // ---------- CALENDAR / DATE-VIEW STATE ----------
  let calendarMode = false;
  let selectedDate = todayISO();
  let pickerViewYear = new Date().getFullYear();
  let pickerViewMonth = new Date().getMonth(); // 0-indexed

  const el = (sel) => document.querySelector(sel);
  const list = el("#list");
  const emptyState = el("#emptyState");
  const emptyMsg = el("#emptyMsg");
  const saveIndicator = el("#saveIndicator");

  const TAG_PALETTE = [
    { bg:"rgba(255,200,69,0.18)", fg:"#ffc845" },
    { bg:"rgba(125,166,255,0.18)", fg:"#7da6ff" },
    { bg:"rgba(255,107,107,0.18)", fg:"#ff6b6b" },
    { bg:"rgba(95,227,192,0.18)", fg:"#5fe3c0" },
    { bg:"rgba(180,140,255,0.18)", fg:"#b48cff" }
  ];
  function tagColor(tag){
    let hash = 0;
    for(let i=0;i<tag.length;i++) hash = (hash*31 + tag.charCodeAt(i)) % 997;
    return TAG_PALETTE[hash % TAG_PALETTE.length];
  }

  // Tracks, per repeating series, the furthest-future due date ever
  // generated for it — independent of whether that task still exists.
  // Without this, deleting today's occurrence of a repeating task (to skip
  // it on purpose) would get silently recreated by the next rollover check,
  // since rollover would only see the earlier surviving instance and think
  // the series hadn't caught up yet.
  function bumpSeriesWatermark(seriesId, due){
    const cur = meta.seriesWatermark[seriesId];
    if(!cur || due > cur) meta.seriesWatermark[seriesId] = due;
  }

  function mkTask(text, priority, due, done, note, tags, repeat, remind, serial, seriesId){
    const id = idCounter++;
    const resolvedRepeat = repeat || "none";
    const resolvedSeriesId = typeof seriesId === "number" ? seriesId : id;
    if(resolvedRepeat !== "none" && due) bumpSeriesWatermark(resolvedSeriesId, due);
    return {
      id, text, priority, due, done: !!done, note: note||"",
      tags: tags || [], subtasks: [], pinned:false, repeat: resolvedRepeat,
      order: idCounter, createdAt: Date.now(), completedAt: null,
      remind: remind || "", reminded: false, // remind: "HH:MM" on the due date; reminded guards against repeat firing
      // seriesId links every auto-regenerated occurrence of a repeating
      // task back to the one that started the chain, so the midnight
      // rollover can tell which tasks belong together and never spawns a
      // duplicate for a date that's already covered. A fresh repeating
      // task starts its own series (seriesId === its own id); non-repeating
      // tasks just carry a seriesId that's never used for anything.
      seriesId: resolvedSeriesId,
      // "serial" is the human-facing ticket number (No. 003 etc). Unlike `id`
      // (an ever-increasing internal key that's never reused), the serial
      // always fills the lowest free slot — delete ticket #3 and the next
      // new ticket becomes #3 again instead of skipping ahead.
      serial: typeof serial === "number" ? serial : claimSerials(1)[0]
    };
  }

  // Returns `count` distinct serial numbers, each the smallest not already
  // used by an existing task — safe to call once and hand out multiple
  // numbers for a batch (e.g. text→tasks) without collisions.
  function claimSerials(count){
    const used = new Set(tasks.map(t => t.serial).filter(n => typeof n === "number"));
    const claimed = [];
    let n = 1;
    while(claimed.length < count){
      if(!used.has(n)){ claimed.push(n); used.add(n); }
      n++;
    }
    return claimed;
  }

  // Ensures every task in an array has a unique positive-integer serial,
  // preserving any valid ones already present (e.g. from a backup file) and
  // gap-filling the rest — used after load and after any bulk restore.
  function normalizeSerials(arr){
    const used = new Set();
    arr.forEach(t => {
      if(typeof t.serial === "number" && t.serial > 0 && !used.has(t.serial)){
        used.add(t.serial);
      } else {
        t.serial = null;
      }
    });
    let n = 1;
    arr.forEach(t => {
      if(t.serial === null){
        while(used.has(n)) n++;
        t.serial = n;
        used.add(n);
      }
    });
    return arr;
  }

  // ---------- PERSISTENT STORAGE (autosave) ----------
  // NOTE: this app runs standalone on Netlify (a real browser), not inside a
  // Claude artifact sandbox, so `window.storage` is not available there — it
  // silently failed on every save/load. Fixed to use localStorage directly,
  // wrapped in the same small async-looking API so the rest of the app is unchanged.
  const STORAGE_KEY = "todos:aryan:tasks";
  const META_KEY = "todos:aryan:meta";
  let saveIndicatorTimeout = null;

  const localStore = {
    async get(key){
      try{
        const v = localStorage.getItem(key);
        return v === null ? null : { key, value: v };
      }catch(err){ return null; }
    },
    async set(key, value){
      try{
        localStorage.setItem(key, value);
        return { key, value };
      }catch(err){ return null; }
    }
  };

  function flashSaveIndicator(status){
    if(!saveIndicator) return;
    saveIndicator.textContent = status === "error" ? "Couldn't save" : "Saved";
    saveIndicator.classList.toggle("error", status === "error");
    saveIndicator.classList.add("show");
    if(saveIndicatorTimeout) clearTimeout(saveIndicatorTimeout);
    saveIndicatorTimeout = setTimeout(() => saveIndicator.classList.remove("show"), 1400);
  }

  async function saveTasks(){
    try{
      const payload = JSON.stringify({ tasks, idCounter });
      const result = await localStore.set(STORAGE_KEY, payload);
      if(!result) throw new Error("no result");
      await localStore.set(META_KEY, JSON.stringify(meta));
      flashSaveIndicator("ok");
    }catch(err){
      console.error("Autosave failed:", err);
      flashSaveIndicator("error");
    }
  }

  async function loadTasks(){
    let found = false;
    try{
      const result = await localStore.get(STORAGE_KEY);
      if(result && result.value){
        const parsed = JSON.parse(result.value);
        if(parsed && Array.isArray(parsed.tasks)){
          tasks = parsed.tasks.map(t => ({ tags:[], subtasks:[], pinned:false, repeat:"none", note:"", remind:"", reminded:false, seriesId:t.id, ...t }));
          // Older saves (before per-task serials existed) won't have a
          // `serial` field yet — sort by creation time so numbering still
          // reads oldest-first the first time it's assigned.
          tasks.sort((a,b) => (a.createdAt||0) - (b.createdAt||0));
          normalizeSerials(tasks);
          // Migration: earlier versions let a #daily must ticket be saved
          // without a due date or repeat:daily. Without a due date the
          // rollover logic can't ever regenerate it, and it would vanish
          // from the day-scoped list below (see getFiltered). Backfill both
          // so every #daily must ticket behaves like a proper daily target
          // from here on, using the day it was created on if it has no due
          // date yet.
          tasks.forEach(t => {
            if(t.tags && t.tags.includes(PERMANENT_TAG)){
              if(!t.due) t.due = toISODate(new Date(t.createdAt || Date.now()));
              if(!t.repeat || t.repeat === "none") t.repeat = "daily";
            }
          });
          idCounter = parsed.idCounter || (Math.max(0, ...tasks.map(t => t.id)) + 1);
          found = true;
        }
      }
    }catch(err){ console.log("No saved list found yet, starting fresh."); }

    try{
      const metaResult = await localStore.get(META_KEY);
      if(metaResult && metaResult.value){
        meta = { ...meta, ...JSON.parse(metaResult.value) };
      }
    }catch(err){ /* no meta yet */ }

    return found;
  }

  // ---------- RIPPLE ----------
  document.addEventListener("click", (e) => {
    const host = e.target.closest(".ripple-host");
    if(!host) return;
    const rect = host.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const r = document.createElement("span");
    r.className = "ripple";
    r.style.width = r.style.height = size + "px";
    r.style.left = (e.clientX - rect.left - size/2) + "px";
    r.style.top = (e.clientY - rect.top - size/2) + "px";
    host.appendChild(r);
    r.addEventListener("animationend", () => r.remove());
  });

  // ---------- THEME ----------
  const themeToggle = el("#themeToggle");
  function applyTheme(isLight){
    document.documentElement.classList.toggle("light", isLight);
    themeToggle.textContent = isLight ? "☀" : "☾";
  }
  themeToggle.addEventListener("click", () => {
    const isLight = !document.documentElement.classList.contains("light");
    applyTheme(isLight);
    meta.theme = isLight ? "light" : "dark";
    saveTasks();
  });

  // ---------- CALENDAR MODE TOGGLE & DATE NAV ----------
  const calendarToggle = el("#calendarToggle");
  calendarToggle.addEventListener("click", () => {
    calendarMode = !calendarMode;
    calendarToggle.classList.toggle("active", calendarMode);
    if(calendarMode){
      selectedDate = todayISO();
      dueInput.value = selectedDate;
      if(typeof refreshDueTodayBtn === "function") refreshDueTodayBtn();
    }
    render();
  });

  el("#dnExit").addEventListener("click", () => {
    calendarMode = false;
    calendarToggle.classList.remove("active");
    render();
  });

  el("#dnPrev").addEventListener("click", (e) => { pulseArrow(e.currentTarget); shiftSelectedDate(-1); });
  el("#dnNext").addEventListener("click", (e) => { pulseArrow(e.currentTarget); shiftSelectedDate(1); });
  el("#dnToday").addEventListener("click", () => { setSelectedDate(todayISO()); });
  function shiftSelectedDate(deltaDays){
    const d = new Date(selectedDate + "T00:00:00");
    d.setDate(d.getDate() + deltaDays);
    setSelectedDate(toISODate(d));
  }
  function pulseArrow(btn){
    btn.classList.remove("pressed"); void btn.offsetWidth; btn.classList.add("pressed");
  }
  function setSelectedDate(dateStr, opts){
    const changed = selectedDate !== dateStr;
    selectedDate = dateStr;
    dueInput.value = selectedDate;
    if(typeof refreshDueTodayBtn === "function") refreshDueTodayBtn();
    render();
    if(changed && (opts && opts.animate !== false)){
      const dateNav = el("#dateNav");
      dateNav.classList.remove("jump"); void dateNav.offsetWidth; dateNav.classList.add("jump");
    }
  }

  // ---------- MONTH PICKER ----------
  const pickerOverlay = el("#pickerOverlay");
  const pickerGrid = el("#pickerGrid");
  const pickerMonthLabel = el("#pickerMonthLabel");

  el("#dnLabel").addEventListener("click", () => {
    const d = new Date(selectedDate + "T00:00:00");
    pickerViewYear = d.getFullYear();
    pickerViewMonth = d.getMonth();
    renderPickerGrid();
    pickerOverlay.classList.add("show");
  });
  el("#pickerClose").addEventListener("click", () => pickerOverlay.classList.remove("show"));
  pickerOverlay.addEventListener("click", (e) => { if(e.target === pickerOverlay) pickerOverlay.classList.remove("show"); });
  el("#pickerPrevMonth").addEventListener("click", () => {
    pickerViewMonth--; if(pickerViewMonth < 0){ pickerViewMonth = 11; pickerViewYear--; }
    renderPickerGrid();
  });
  el("#pickerNextMonth").addEventListener("click", () => {
    pickerViewMonth++; if(pickerViewMonth > 11){ pickerViewMonth = 0; pickerViewYear++; }
    renderPickerGrid();
  });

  function renderPickerGrid(){
    const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    pickerMonthLabel.textContent = `${MONTH_NAMES[pickerViewMonth]} ${pickerViewYear}`;

    const datesWithTasks = new Set(tasks.filter(t => t.due).map(t => t.due));
    const first = new Date(pickerViewYear, pickerViewMonth, 1);
    const startOffset = first.getDay();
    const daysInMonth = new Date(pickerViewYear, pickerViewMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(pickerViewYear, pickerViewMonth, 0).getDate();
    const today = todayISO();

    let cells = [];
    for(let i = startOffset - 1; i >= 0; i--){
      cells.push({ day: daysInPrevMonth - i, otherMonth:true, dateStr:null });
    }
    for(let d = 1; d <= daysInMonth; d++){
      const dateStr = `${pickerViewYear}-${String(pickerViewMonth+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      cells.push({ day: d, otherMonth:false, dateStr });
    }
    while(cells.length % 7 !== 0){
      cells.push({ day: cells.length, otherMonth:true, dateStr:null });
    }

    pickerGrid.innerHTML = cells.map(c => {
      if(c.otherMonth) return `<button class="other-month" disabled>${c.day}</button>`;
      const classes = ["cal-day"];
      if(c.dateStr === today) classes.push("today");
      if(c.dateStr === selectedDate) classes.push("selected");
      if(datesWithTasks.has(c.dateStr)) classes.push("has-tasks");
      return `<button class="${classes.join(" ")}" data-date="${c.dateStr}">${c.day}</button>`;
    }).join("");
  }

  pickerGrid.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-date]");
    if(!btn || btn.disabled) return;
    setSelectedDate(btn.dataset.date);
    pickerOverlay.classList.remove("show");
  });

  // ---------- PDF SUMMARY EXPORT ----------
  el("#dnPdf").addEventListener("click", () => exportDayPdf());
  el("#exportAllPdfBtn").addEventListener("click", () => exportAllTasksPdf());
  el("#exportActivePdfBtn").addEventListener("click", () => exportActiveOnlyPdf());
  el("#exportDonePdfBtn").addEventListener("click", () => exportDoneOnlyPdf());
  el("#exportTagPdfBtn").addEventListener("click", () => openTagPdfPicker());

  // Priority + status colors reused across the summary cards and both tables,
  // so the whole document reads consistently at a glance.
  const PDF_COLORS = {
    header:    [40, 44, 74],     // deep indigo header band
    headerTxt: [255,255,255],
    high:      [214, 69, 65],
    med:       [222, 158, 34],
    low:       [58, 130, 199],
    done:      [46, 140, 87],
    doneBg:    [223, 243, 231],
    pending:   [193, 66, 66],
    pendingBg: [252, 228, 228],
    zebra:     [246, 247, 251],
    border:    [222, 224, 235],
    cardBg:    [247, 248, 252],
    text:      [35, 37, 48],
    subtext:   [110, 114, 132]
  };
  const PRIO_COLOR = { high: PDF_COLORS.high, med: PDF_COLORS.med, low: PDF_COLORS.low };
  const PRIO_LABEL = { high: "High", med: "Med", low: "Low" };

  function exportDayPdf(){
    if(!window.jspdf || !window.jspdf.jsPDF){
      showInfoToast("PDF library still loading — try again in a second");
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit:"pt", format:"a4" });
    if(typeof doc.autoTable !== "function"){
      showInfoToast("PDF table library still loading — try again in a second");
      return;
    }
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 40;

    const dayTasks = getDayTasksLive(selectedDate);
    // report-only carry-forward: still-pending OR completed on the selected date
    // (excludes #daily must tickets — those never carry forward, see getCarryForwardLive)
    const carryReport = tasks.filter(t => t.due && t.due < selectedDate && !t.tags.includes(PERMANENT_TAG) && (!t.done || isSameDayAs(t.completedAt, selectedDate)));
    const dayDone = dayTasks.filter(t => t.done).length;
    const carryDone = carryReport.filter(t => t.done).length;
    const combinedTotal = dayTasks.length + carryReport.length;
    const combinedDone = dayDone + carryDone;

    // ---- Header band ----
    doc.setFillColor(...PDF_COLORS.header);
    doc.rect(0, 0, pageWidth, 86, "F");
    doc.setTextColor(...PDF_COLORS.headerTxt);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.text("Todo Summary", margin, 38);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11.5);
    doc.text(formatDateLong(selectedDate), margin, 58);
    doc.setFontSize(9.5);
    doc.setTextColor(220, 222, 235);
    doc.text(`Generated ${new Date().toLocaleString()}`, margin, 74);

    // ---- Summary stat cards ----
    let y = 108;
    const cardGap = 12;
    const cardW = (pageWidth - margin*2 - cardGap*2) / 3;
    const cardH = 58;
    const cards = [
      { label: "Today's Tasks", total: dayTasks.length, done: dayDone, color: PDF_COLORS.low },
      { label: "Carried Forward", total: carryReport.length, done: carryDone, color: PDF_COLORS.med },
      { label: "Combined", total: combinedTotal, done: combinedDone, color: PDF_COLORS.done }
    ];
    cards.forEach((c, i) => {
      const x = margin + i * (cardW + cardGap);
      doc.setFillColor(...PDF_COLORS.cardBg);
      doc.roundedRect(x, y, cardW, cardH, 6, 6, "F");
      doc.setFillColor(...c.color);
      doc.roundedRect(x, y, 5, cardH, 2, 2, "F");
      doc.setTextColor(...PDF_COLORS.subtext);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(c.label.toUpperCase(), x + 14, y + 18);
      doc.setTextColor(...PDF_COLORS.text);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(17);
      doc.text(String(c.total), x + 14, y + 39);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(...PDF_COLORS.done);
      const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
      doc.text(`${c.done} done (${pct}%)`, x + 14, y + 51);
    });
    y += cardH + 26;

    y = drawTaskTable(doc, `${formatDateShort(selectedDate)}'s Tasks`, dayTasks, y, pageWidth, pageHeight, margin, false);
    y = drawTaskTable(doc, "Carried Forward (from earlier dates)", carryReport, y, pageWidth, pageHeight, margin, true);

    // ---- Footer page numbers ----
    const pageCount = doc.internal.getNumberOfPages();
    for(let p = 1; p <= pageCount; p++){
      doc.setPage(p);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(...PDF_COLORS.subtext);
      doc.text(`Page ${p} of ${pageCount}`, pageWidth - margin, pageHeight - 18, { align: "right" });
      doc.text("Todo Planner", margin, pageHeight - 18);
    }

    const fname = `todo-summary-${selectedDate}.pdf`;
    doc.save(fname);
    showInfoToast(`Downloaded ${fname}`);
  }

  // ---------- FULL LIST PDF EXPORT (all active + all done tasks) ----------
  function exportAllTasksPdf(){
    if(!window.jspdf || !window.jspdf.jsPDF){
      showInfoToast("PDF library still loading — try again in a second");
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit:"pt", format:"a4" });
    if(typeof doc.autoTable !== "function"){
      showInfoToast("PDF table library still loading — try again in a second");
      return;
    }
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 40;

    const activeTasks = [...tasks].filter(t => !t.done).sort((a,b) => priorityWeight(a.priority) - priorityWeight(b.priority));
    const doneTasks = [...tasks].filter(t => t.done).sort((a,b) => (b.completedAt||0) - (a.completedAt||0));

    // ---- Header band ----
    doc.setFillColor(...PDF_COLORS.header);
    doc.rect(0, 0, pageWidth, 86, "F");
    doc.setTextColor(...PDF_COLORS.headerTxt);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.text("Full Task Report", margin, 38);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11.5);
    doc.text("All active tickets and completed tickets", margin, 58);
    doc.setFontSize(9.5);
    doc.setTextColor(220, 222, 235);
    doc.text(`Generated ${new Date().toLocaleString()}`, margin, 74);

    // ---- Summary stat cards ----
    let y = 108;
    const cardGap = 12;
    const cardW = (pageWidth - margin*2 - cardGap*2) / 3;
    const cardH = 58;
    const total = activeTasks.length + doneTasks.length;
    const cards = [
      { label: "Active", total: activeTasks.length, done: 0, color: PDF_COLORS.med, showPct:false },
      { label: "Completed", total: doneTasks.length, done: 0, color: PDF_COLORS.done, showPct:false },
      { label: "All Tickets", total, done: doneTasks.length, color: PDF_COLORS.low, showPct:true }
    ];
    cards.forEach((c, i) => {
      const x = margin + i * (cardW + cardGap);
      doc.setFillColor(...PDF_COLORS.cardBg);
      doc.roundedRect(x, y, cardW, cardH, 6, 6, "F");
      doc.setFillColor(...c.color);
      doc.roundedRect(x, y, 5, cardH, 2, 2, "F");
      doc.setTextColor(...PDF_COLORS.subtext);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(c.label.toUpperCase(), x + 14, y + 18);
      doc.setTextColor(...PDF_COLORS.text);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(17);
      doc.text(String(c.total), x + 14, y + 39);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(...PDF_COLORS.done);
      if(c.showPct){
        const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
        doc.text(`${c.done} done (${pct}%)`, x + 14, y + 51);
      } else {
        doc.setTextColor(...PDF_COLORS.subtext);
        doc.text(c.label === "Active" ? "pending now" : "all time", x + 14, y + 51);
      }
    });
    y += cardH + 26;

    y = drawFullTaskTable(doc, "Active Tickets", activeTasks, y, pageWidth, pageHeight, margin, false);
    y = drawFullTaskTable(doc, "Completed Tickets", doneTasks, y, pageWidth, pageHeight, margin, true);

    // ---- Footer page numbers ----
    const pageCount = doc.internal.getNumberOfPages();
    for(let p = 1; p <= pageCount; p++){
      doc.setPage(p);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(...PDF_COLORS.subtext);
      doc.text(`Page ${p} of ${pageCount}`, pageWidth - margin, pageHeight - 18, { align: "right" });
      doc.text("Todo Planner — Full Report", margin, pageHeight - 18);
    }

    const fname = `todo-full-report-${todayISO()}.pdf`;
    doc.save(fname);
    showInfoToast(`Downloaded ${fname}`);
  }

  // ---------- TAG-WISE PDF EXPORT (active + done for one tag, colour-coded rows) ----------
  function exportTagPdf(tag){
    if(!window.jspdf || !window.jspdf.jsPDF){
      showInfoToast("PDF library still loading — try again in a second");
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit:"pt", format:"a4" });
    if(typeof doc.autoTable !== "function"){
      showInfoToast("PDF table library still loading — try again in a second");
      return;
    }
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 40;

    const tagTasks = tasks.filter(t => t.tags.includes(tag));
    const activeTasks = tagTasks.filter(t => !t.done).sort((a,b) => priorityWeight(a.priority) - priorityWeight(b.priority));
    const doneTasks = tagTasks.filter(t => t.done).sort((a,b) => (b.completedAt||0) - (a.completedAt||0));
    const total = activeTasks.length + doneTasks.length;

    // ---- Header band ----
    doc.setFillColor(...PDF_COLORS.header);
    doc.rect(0, 0, pageWidth, 86, "F");
    doc.setTextColor(...PDF_COLORS.headerTxt);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.text(`#${tag} — Tag Report`, margin, 38);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11.5);
    doc.text("Active tickets shown in red, completed tickets shown in green", margin, 58);
    doc.setFontSize(9.5);
    doc.setTextColor(220, 222, 235);
    doc.text(`Generated ${new Date().toLocaleString()}`, margin, 74);

    // ---- Summary stat cards ----
    let y = 108;
    const cardGap = 12;
    const cardW = (pageWidth - margin*2 - cardGap*2) / 3;
    const cardH = 58;
    const cards = [
      { label: "Active", total: activeTasks.length, color: PDF_COLORS.pending, sub: "pending now" },
      { label: "Completed", total: doneTasks.length, color: PDF_COLORS.done, sub: "all time" },
      { label: `#${tag} Total`, total, color: PDF_COLORS.low, sub: `${total ? Math.round((doneTasks.length/total)*100) : 0}% done` }
    ];
    cards.forEach((c, i) => {
      const x = margin + i * (cardW + cardGap);
      doc.setFillColor(...PDF_COLORS.cardBg);
      doc.roundedRect(x, y, cardW, cardH, 6, 6, "F");
      doc.setFillColor(...c.color);
      doc.roundedRect(x, y, 5, cardH, 2, 2, "F");
      doc.setTextColor(...PDF_COLORS.subtext);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(c.label.toUpperCase(), x + 14, y + 18);
      doc.setTextColor(...PDF_COLORS.text);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(17);
      doc.text(String(c.total), x + 14, y + 39);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(...c.color);
      doc.text(c.sub, x + 14, y + 51);
    });
    y += cardH + 26;

    y = drawTagTaskTable(doc, `Active — #${tag}`, activeTasks, y, pageWidth, pageHeight, margin, false);
    y = drawTagTaskTable(doc, `Completed — #${tag}`, doneTasks, y, pageWidth, pageHeight, margin, true);

    // ---- Footer page numbers ----
    const pageCount = doc.internal.getNumberOfPages();
    for(let p = 1; p <= pageCount; p++){
      doc.setPage(p);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(...PDF_COLORS.subtext);
      doc.text(`Page ${p} of ${pageCount}`, pageWidth - margin, pageHeight - 18, { align: "right" });
      doc.text(`Todo Planner — #${tag}`, margin, pageHeight - 18);
    }

    const fname = `todo-tag-${tag}-${todayISO()}.pdf`;
    doc.save(fname);
    showInfoToast(`Downloaded ${fname}`);
  }

  // Table for the tag-wise PDF — every row in a section is tinted by status
  // (soft red wash for active, soft green wash for done) so the two groups
  // stay visually distinct even when the tag report spans a page break.
  function drawTagTaskTable(doc, title, taskArr, y, pageWidth, pageHeight, margin, isDoneSection){
    if(y > pageHeight - 80){ doc.addPage(); y = 50; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(...PDF_COLORS.text);
    doc.text(title, margin, y);
    y += 9;

    if(taskArr.length === 0){
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10.5);
      doc.setTextColor(...PDF_COLORS.subtext);
      doc.text("— none —", margin, y + 15);
      return y + 34;
    }

    const head = isDoneSection
      ? [["#", "Task", "Priority", "Completed"]]
      : [["#", "Task", "Priority", "Due"]];

    const body = taskArr.map((t, i) => [
      String(i + 1),
      t.text,
      PRIO_LABEL[t.priority] || t.priority,
      isDoneSection ? (t.completedAt ? new Date(t.completedAt).toLocaleDateString() : "—") : (t.due || "—")
    ]);

    const rowFill = isDoneSection ? PDF_COLORS.doneBg : PDF_COLORS.pendingBg;
    const statusColor = isDoneSection ? PDF_COLORS.done : PDF_COLORS.pending;
    const prioColIdx = 2;

    doc.autoTable({
      head,
      body,
      startY: y,
      margin: { left: margin, right: margin, bottom: 50 },
      theme: "grid",
      styles: {
        font: "helvetica",
        fontSize: 10.5,
        cellPadding: 8,
        textColor: PDF_COLORS.text,
        lineColor: PDF_COLORS.border,
        lineWidth: 0.6,
        overflow: "linebreak",
        valign: "middle",
        fillColor: rowFill
      },
      headStyles: {
        fillColor: statusColor,
        textColor: PDF_COLORS.headerTxt,
        fontStyle: "bold",
        fontSize: 10.5
      },
      columnStyles: {
        0: { cellWidth: 26, halign: "center" },
        2: { cellWidth: 62, halign: "center" },
        3: { cellWidth: 78, halign: "center" }
      },
      didParseCell: (data) => {
        if(data.section !== "body") return;
        if(data.column.index === prioColIdx){
          const rawPrio = taskArr[data.row.index].priority;
          const c = PRIO_COLOR[rawPrio] || PDF_COLORS.subtext;
          data.cell.styles.textColor = c;
          data.cell.styles.fontStyle = "bold";
        }
      },
      didDrawPage: () => {}
    });

    return doc.lastAutoTable.finalY + 22;
  }

  // ---------- ACTIVE-ONLY PDF EXPORT (single-section, large readable type) ----------
  function exportActiveOnlyPdf(){
    if(!window.jspdf || !window.jspdf.jsPDF){
      showInfoToast("PDF library still loading — try again in a second");
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit:"pt", format:"a4" });
    if(typeof doc.autoTable !== "function"){
      showInfoToast("PDF table library still loading — try again in a second");
      return;
    }
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 40;

    const activeTasks = [...tasks].filter(t => !t.done).sort((a,b) => priorityWeight(a.priority) - priorityWeight(b.priority));
    const high = activeTasks.filter(t => t.priority === "high").length;
    const med = activeTasks.filter(t => t.priority === "med").length;
    const low = activeTasks.filter(t => t.priority === "low").length;
    const overdue = activeTasks.filter(t => t.due && t.due < todayISO()).length;

    drawBigHeaderBand(doc, "Active Tasks", "Everything still pending — not yet completed", pageWidth, margin);

    let y = 112;
    const cards = [
      { label: "Total Active", value: String(activeTasks.length), sub: `${overdue} overdue`, color: PDF_COLORS.med },
      { label: "High Priority", value: String(high), sub: `${med} med · ${low} low`, color: PDF_COLORS.high }
    ];
    y = drawBigStatCards(doc, cards, y, pageWidth, margin);

    y = drawBigTaskTable(doc, "Active Tickets", activeTasks, y, pageWidth, pageHeight, margin, false);

    drawBigFooter(doc, pageWidth, pageHeight, margin, "Todo Planner — Active Tasks");

    const fname = `todo-active-${todayISO()}.pdf`;
    doc.save(fname);
    showInfoToast(`Downloaded ${fname}`);
  }

  // ---------- DONE-ONLY PDF EXPORT (single-section, large readable type) ----------
  function exportDoneOnlyPdf(){
    if(!window.jspdf || !window.jspdf.jsPDF){
      showInfoToast("PDF library still loading — try again in a second");
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit:"pt", format:"a4" });
    if(typeof doc.autoTable !== "function"){
      showInfoToast("PDF table library still loading — try again in a second");
      return;
    }
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 40;

    const doneTasks = [...tasks].filter(t => t.done).sort((a,b) => (b.completedAt||0) - (a.completedAt||0));
    const today = todayISO();
    const doneToday = doneTasks.filter(t => t.completedAt && isSameDayAs(t.completedAt, today)).length;
    const high = doneTasks.filter(t => t.priority === "high").length;

    drawBigHeaderBand(doc, "Completed Tasks", "Everything you've finished so far", pageWidth, margin);

    let y = 112;
    const cards = [
      { label: "Total Completed", value: String(doneTasks.length), sub: `${doneToday} completed today`, color: PDF_COLORS.done },
      { label: "High Priority Done", value: String(high), sub: "out of all completed", color: PDF_COLORS.high }
    ];
    y = drawBigStatCards(doc, cards, y, pageWidth, margin);

    y = drawBigTaskTable(doc, "Completed Tickets", doneTasks, y, pageWidth, pageHeight, margin, true);

    drawBigFooter(doc, pageWidth, pageHeight, margin, "Todo Planner — Completed Tasks");

    const fname = `todo-done-${todayISO()}.pdf`;
    doc.save(fname);
    showInfoToast(`Downloaded ${fname}`);
  }

  // Shared header band for the single-section (active-only / done-only) PDFs.
  function drawBigHeaderBand(doc, title, subtitle, pageWidth, margin){
    doc.setFillColor(...PDF_COLORS.header);
    doc.rect(0, 0, pageWidth, 90, "F");
    doc.setTextColor(...PDF_COLORS.headerTxt);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(24);
    doc.text(title, margin, 42);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(12.5);
    doc.text(subtitle, margin, 62);
    doc.setFontSize(10);
    doc.setTextColor(220, 222, 235);
    doc.text(`Generated ${new Date().toLocaleString()}`, margin, 78);
  }

  // Shared big stat cards (two wide cards instead of three, so numbers read large).
  function drawBigStatCards(doc, cards, y, pageWidth, margin){
    const cardGap = 14;
    const cardW = (pageWidth - margin*2 - cardGap) / 2;
    const cardH = 66;
    cards.forEach((c, i) => {
      const x = margin + i * (cardW + cardGap);
      doc.setFillColor(...PDF_COLORS.cardBg);
      doc.roundedRect(x, y, cardW, cardH, 7, 7, "F");
      doc.setFillColor(...c.color);
      doc.roundedRect(x, y, 6, cardH, 3, 3, "F");
      doc.setTextColor(...PDF_COLORS.subtext);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10.5);
      doc.text(c.label.toUpperCase(), x + 18, y + 22);
      doc.setTextColor(...PDF_COLORS.text);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(24);
      doc.text(c.value, x + 18, y + 47);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10.5);
      doc.setTextColor(...PDF_COLORS.subtext);
      doc.text(c.sub, x + 18, y + 59);
    });
    return y + cardH + 28;
  }

  // Shared footer with page numbers for the single-section PDFs.
  function drawBigFooter(doc, pageWidth, pageHeight, margin, label){
    const pageCount = doc.internal.getNumberOfPages();
    for(let p = 1; p <= pageCount; p++){
      doc.setPage(p);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(...PDF_COLORS.subtext);
      doc.text(`Page ${p} of ${pageCount}`, pageWidth - margin, pageHeight - 20, { align: "right" });
      doc.text(label, margin, pageHeight - 20);
    }
  }

  // Large-type single-section task table used by the active-only / done-only PDFs.
  // Font sizes here are bumped up noticeably from the combined report table so
  // the export stays comfortably readable when printed or viewed at 100%.
  function drawBigTaskTable(doc, title, taskArr, y, pageWidth, pageHeight, margin, isDoneSection){
    if(y > pageHeight - 90){ doc.addPage(); y = 50; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.setTextColor(...PDF_COLORS.text);
    doc.text(title, margin, y);
    y += 10;

    if(taskArr.length === 0){
      doc.setFont("helvetica", "normal");
      doc.setFontSize(12);
      doc.setTextColor(...PDF_COLORS.subtext);
      doc.text("— none —", margin, y + 16);
      return y + 36;
    }

    const head = isDoneSection
      ? [["#", "Task", "Tags", "Priority", "Completed"]]
      : [["#", "Task", "Tags", "Priority", "Due"]];

    const body = taskArr.map((t, i) => [
      String(i + 1),
      t.text,
      t.tags.length ? t.tags.map(tg => "#"+tg).join(", ") : "—",
      PRIO_LABEL[t.priority] || t.priority,
      isDoneSection ? (t.completedAt ? new Date(t.completedAt).toLocaleDateString() : "—") : (t.due || "—")
    ]);

    const prioColIdx = 3;

    doc.autoTable({
      head,
      body,
      startY: y,
      margin: { left: margin, right: margin, bottom: 50 },
      theme: "grid",
      styles: {
        font: "helvetica",
        fontSize: 12,
        cellPadding: 9,
        textColor: PDF_COLORS.text,
        lineColor: PDF_COLORS.border,
        lineWidth: 0.6,
        overflow: "linebreak",
        valign: "middle"
      },
      headStyles: {
        fillColor: isDoneSection ? PDF_COLORS.done : PDF_COLORS.header,
        textColor: PDF_COLORS.headerTxt,
        fontStyle: "bold",
        fontSize: 12
      },
      alternateRowStyles: { fillColor: PDF_COLORS.zebra },
      columnStyles: {
        0: { cellWidth: 28, halign: "center" },
        2: { cellWidth: 120 },
        3: { cellWidth: 68, halign: "center" },
        4: { cellWidth: 80, halign: "center" }
      },
      didParseCell: (data) => {
        if(data.section !== "body") return;
        if(data.column.index === prioColIdx){
          const rawPrio = taskArr[data.row.index].priority;
          const c = PRIO_COLOR[rawPrio] || PDF_COLORS.subtext;
          data.cell.styles.textColor = c;
          data.cell.styles.fontStyle = "bold";
        }
      },
      didDrawPage: () => {}
    });

    return doc.lastAutoTable.finalY + 22;
  }

  function drawFullTaskTable(doc, title, taskArr, y, pageWidth, pageHeight, margin, isDoneSection){
    if(y > pageHeight - 80){ doc.addPage(); y = 50; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12.5);
    doc.setTextColor(...PDF_COLORS.text);
    doc.text(title, margin, y);
    y += 8;

    if(taskArr.length === 0){
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(...PDF_COLORS.subtext);
      doc.text("— none —", margin, y + 14);
      return y + 32;
    }

    const head = isDoneSection
      ? [["#", "Task", "Tags", "Priority", "Completed"]]
      : [["#", "Task", "Tags", "Priority", "Due"]];

    const body = taskArr.map((t, i) => [
      String(i + 1),
      t.text,
      t.tags.length ? t.tags.map(tg => "#"+tg).join(", ") : "—",
      PRIO_LABEL[t.priority] || t.priority,
      isDoneSection ? (t.completedAt ? new Date(t.completedAt).toLocaleDateString() : "—") : (t.due || "—")
    ]);

    const prioColIdx = 3;

    doc.autoTable({
      head,
      body,
      startY: y,
      margin: { left: margin, right: margin },
      theme: "grid",
      styles: {
        font: "helvetica",
        fontSize: 9.5,
        cellPadding: 6,
        textColor: PDF_COLORS.text,
        lineColor: PDF_COLORS.border,
        lineWidth: 0.6,
        overflow: "linebreak"
      },
      headStyles: {
        fillColor: isDoneSection ? PDF_COLORS.done : PDF_COLORS.header,
        textColor: PDF_COLORS.headerTxt,
        fontStyle: "bold",
        fontSize: 9.5
      },
      alternateRowStyles: { fillColor: PDF_COLORS.zebra },
      columnStyles: {
        0: { cellWidth: 22, halign: "center" },
        2: { cellWidth: 110 },
        3: { cellWidth: 55, halign: "center" },
        4: { cellWidth: 68, halign: "center" }
      },
      didParseCell: (data) => {
        if(data.section !== "body") return;
        if(data.column.index === prioColIdx){
          const rawPrio = taskArr[data.row.index].priority;
          const c = PRIO_COLOR[rawPrio] || PDF_COLORS.subtext;
          data.cell.styles.textColor = c;
          data.cell.styles.fontStyle = "bold";
        }
      },
      didDrawPage: () => {}
    });

    return doc.lastAutoTable.finalY + 22;
  }

  function drawTaskTable(doc, title, taskArr, y, pageWidth, pageHeight, margin, showFrom){
    // Section title
    if(y > pageHeight - 80){ doc.addPage(); y = 50; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12.5);
    doc.setTextColor(...PDF_COLORS.text);
    doc.text(title, margin, y);
    y += 8;

    if(taskArr.length === 0){
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(...PDF_COLORS.subtext);
      doc.text("— none —", margin, y + 14);
      return y + 32;
    }

    const head = showFrom
      ? [["#", "Task", "Orig. Due", "Priority", "Status"]]
      : [["#", "Task", "Priority", "Status"]];

    const body = taskArr.map((t, i) => showFrom
      ? [String(i + 1), t.text, t.due || "—", PRIO_LABEL[t.priority] || t.priority, t.done ? "Completed" : "Not completed"]
      : [String(i + 1), t.text, PRIO_LABEL[t.priority] || t.priority, t.done ? "Completed" : "Not completed"]);

    const prioColIdx = showFrom ? 3 : 2;
    const statusColIdx = showFrom ? 4 : 3;

    doc.autoTable({
      head,
      body,
      startY: y,
      margin: { left: margin, right: margin },
      theme: "grid",
      styles: {
        font: "helvetica",
        fontSize: 9.5,
        cellPadding: 6,
        textColor: PDF_COLORS.text,
        lineColor: PDF_COLORS.border,
        lineWidth: 0.6,
        overflow: "linebreak"
      },
      headStyles: {
        fillColor: PDF_COLORS.header,
        textColor: PDF_COLORS.headerTxt,
        fontStyle: "bold",
        fontSize: 9.5
      },
      alternateRowStyles: { fillColor: PDF_COLORS.zebra },
      columnStyles: showFrom
        ? { 0: { cellWidth: 22, halign: "center" }, 2: { cellWidth: 62 }, 3: { cellWidth: 55, halign: "center" }, 4: { cellWidth: 78, halign: "center" } }
        : { 0: { cellWidth: 22, halign: "center" }, 2: { cellWidth: 55, halign: "center" }, 3: { cellWidth: 78, halign: "center" } },
      didParseCell: (data) => {
        if(data.section !== "body") return;
        if(data.column.index === prioColIdx){
          const rawPrio = taskArr[data.row.index].priority;
          const c = PRIO_COLOR[rawPrio] || PDF_COLORS.subtext;
          data.cell.styles.textColor = c;
          data.cell.styles.fontStyle = "bold";
        }
        if(data.column.index === statusColIdx){
          const isDone = taskArr[data.row.index].done;
          data.cell.styles.fillColor = isDone ? PDF_COLORS.doneBg : PDF_COLORS.pendingBg;
          data.cell.styles.textColor = isDone ? PDF_COLORS.done : PDF_COLORS.pending;
          data.cell.styles.fontStyle = "bold";
        }
      },
      didDrawPage: () => {}
    });

    return doc.lastAutoTable.finalY + 22;
  }

  // ---------- COMPOSER ----------
  const addForm = el("#addForm");
  const taskInput = el("#taskInput");
  const dueInput = el("#dueInput");
  const remindInput = el("#remindInput");
  const composerTagSelect = el("#composerTagSelect");
  const composerTagSelectBtn = el("#composerTagSelectBtn");
  const composerTagSelectMenu = el("#composerTagSelectMenu");
  const composerTagSelectValue = el("#composerTagSelectValue");
  const composerTagSelectSwatch = el("#composerTagSelectSwatch");
  let composerSelectedTag = null;
  const repeatSelect = el("#repeatSelect");
  const prioPicker = el("#prioPicker");
  const dueTodayBtn = el("#dueTodayBtn");

  // Shows a "Today" reset button next to the composer's due-date field
  // whenever it's been set to some other date, so it's a one-tap fix
  // instead of having to reopen the native date picker.
  function refreshDueTodayBtn(){
    const isOtherDate = !!dueInput.value && dueInput.value !== todayISO();
    dueTodayBtn.classList.toggle("hidden", !isOtherDate);
  }
  dueInput.addEventListener("change", refreshDueTodayBtn);
  dueInput.addEventListener("input", refreshDueTodayBtn);
  dueTodayBtn.addEventListener("click", () => {
    dueInput.value = todayISO();
    refreshDueTodayBtn();
    dueInput.dispatchEvent(new Event("change"));
  });

  // ---------- TAG SELECT DROPDOWN (shared markup/behaviour for composer + per-task pickers) ----------
  // Tags themselves are only ever created/renamed/deleted from the separate
  // "Manage tags" block — everywhere else (composer, task cards) just picks
  // from that existing list via this dropdown, with "None" always first/default.
  function tagSelectMenuHTML(selectedTag){
    const tags = allTags();
    const noneItem = `<button type="button" class="tag-select-item ${!selectedTag ? "selected" : ""}" data-tag="">
        <span class="dot none"></span><span>None</span><span class="check">✓</span>
      </button>`;
    if(tags.length === 0){
      return noneItem + `<div class="tag-select-empty">No tags yet — create one from the 🏷 Tags block below.</div>`;
    }
    const items = tags.map(tag => {
      const c = tagColor(tag);
      const active = selectedTag === tag;
      return `<button type="button" class="tag-select-item ${active ? "selected" : ""}" data-tag="${escapeHtml(tag)}">
          <span class="dot" style="background:${c.fg}"></span><span>#${escapeHtml(tag)}</span><span class="check">✓</span>
        </button>`;
    }).join("");
    return noneItem + items;
  }

  // ---------- OVERFLOW-CLIP LIFTING FOR DROPDOWNS ----------
  // Several containers (the composer card, each swipeable task card) use
  // overflow:hidden for their own decorative effects (a border sweep, the
  // swipe-to-delete reveal). Any dropdown menu nested inside them would get
  // silently clipped — invisible and unclickable in the clipped region —
  // the moment it needs to extend past that box. Rather than special-casing
  // every container, we walk up from the open dropdown and temporarily set
  // overflow:visible on any ancestor that's actually clipping, restoring the
  // exact original value when the dropdown closes.
  let liftedOverflowEls = [];
  // ---------- FIXED-POSITION PINNING FOR DROPDOWNS ----------
  // Absolute-positioned menus stay clipped/covered whenever a later sibling
  // in the list (the next task card) paints over the same screen area — the
  // overflow-lift above only fixes clipping, not paint order between
  // sibling <li> cards. Pinning the open menu to position:fixed with
  // JS-measured coordinates guarantees it paints above every card and that
  // clicks land on the menu, not on whatever is visually behind it.
  function pinMenuToViewport(btn, menu){
    // A lingering inline transform on an ancestor (e.g. the swipe card
    // resting at "translateX(0)" right after a tap — see attachSwipe)
    // creates a local stacking/containing-block context that would make
    // this "fixed" menu position itself relative to that ancestor instead
    // of the viewport. Strip any such transform before measuring/pinning
    // so the menu is always positioned relative to the real viewport.
    let node = btn.parentElement;
    while(node && node !== document.body){
      if(node.style && node.style.transform && node.style.transform !== "none"){
        node.style.transform = "";
      }
      node = node.parentElement;
    }
    const r = btn.getBoundingClientRect();
    menu.classList.add("pinned");
    menu.style.left = r.left + "px";
    menu.style.width = r.width + "px";
    const menuHeight = Math.min(menu.scrollHeight || 230, 230);
    const spaceBelow = window.innerHeight - r.bottom;
    if(spaceBelow < menuHeight + 12 && r.top > menuHeight + 12){
      // not enough room below — open upward instead
      menu.style.top = (r.top - menuHeight - 6) + "px";
    } else {
      menu.style.top = (r.bottom + 6) + "px";
    }
  }
  function unpinMenu(menu){
    if(!menu) return;
    menu.classList.remove("pinned");
    menu.style.left = "";
    menu.style.top = "";
    menu.style.width = "";
  }

  function liftClippingAncestors(startEl){
    restoreClippingAncestors();
    let node = startEl.parentElement;
    let hops = 0;
    while(node && node !== document.body && hops < 8){
      const cs = getComputedStyle(node);
      if(cs.overflow === "hidden" || cs.overflowX === "hidden" || cs.overflowY === "hidden"){
        liftedOverflowEls.push({ el: node, prevOverflow: node.style.overflow, prevX: node.style.overflowX, prevY: node.style.overflowY });
        node.style.overflow = "visible";
      }
      node = node.parentElement;
      hops++;
    }
  }
  function restoreClippingAncestors(){
    liftedOverflowEls.forEach(({ el, prevOverflow, prevX, prevY }) => {
      el.style.overflow = prevOverflow;
      el.style.overflowX = prevX;
      el.style.overflowY = prevY;
    });
    liftedOverflowEls = [];
  }

  function closeAllTagSelects(except){
    document.querySelectorAll(".tag-select.open").forEach(node => {
      if(node !== except){
        node.classList.remove("open");
        unpinMenu(node.querySelector(".tag-select-menu"));
      }
    });
    if(!except) restoreClippingAncestors();
  }
  document.addEventListener("click", (e) => {
    if(!e.target.closest(".tag-select")) closeAllTagSelects();
  });

  function updateComposerTagButton(){
    if(composerSelectedTag){
      const c = tagColor(composerSelectedTag);
      composerTagSelectSwatch.className = "tag-select-swatch";
      composerTagSelectSwatch.style.background = c.fg;
      composerTagSelectValue.textContent = "#" + composerSelectedTag;
    } else {
      composerTagSelectSwatch.className = "tag-select-swatch none";
      composerTagSelectSwatch.style.background = "";
      composerTagSelectValue.textContent = "None";
    }
  }
  composerTagSelectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = !composerTagSelect.classList.contains("open");
    closeAllTagSelects();
    if(willOpen){
      composerTagSelectMenu.innerHTML = tagSelectMenuHTML(composerSelectedTag);
      composerTagSelect.classList.add("open");
      liftClippingAncestors(composerTagSelect);
      pinMenuToViewport(composerTagSelectBtn, composerTagSelectMenu);
    }
  });
  composerTagSelectMenu.addEventListener("click", (e) => {
    const item = e.target.closest(".tag-select-item");
    if(!item) return;
    composerSelectedTag = item.dataset.tag || null;
    updateComposerTagButton();
    applyDailyMustRepeatLock();
    composerTagSelect.classList.remove("open");
    unpinMenu(composerTagSelectMenu);
    restoreClippingAncestors();
  });

  // #daily must tickets only make sense as a daily recurrence — the streak
  // and day-scoping logic both assume one occurrence per calendar day.
  // Selecting the tag forces the repeat dropdown to "Daily" and locks it so
  // it can't be set to weekly/monthly/none by mistake; deselecting the tag
  // hands control back to the user.
  function applyDailyMustRepeatLock(){
    const isDailyMust = composerSelectedTag === PERMANENT_TAG;
    repeatSelect.disabled = isDailyMust;
    repeatSelect.classList.toggle("locked", isDailyMust);
    if(isDailyMust){
      repeatSelect.value = "daily";
      repeatSelect.title = `#${PERMANENT_TAG} always repeats daily`;
    } else {
      repeatSelect.title = "";
    }
  }

  prioPicker.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if(!btn) return;
    [...prioPicker.children].forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    composerPriority = btn.dataset.p;
  });

  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = taskInput.value.trim();
    if(!text) return;
    const tags = composerSelectedTag ? [composerSelectedTag] : [];
    const isDailyMust = tags.includes(PERMANENT_TAG);
    // a reminder needs a date to anchor to — fall back to today if only a
    // time was set. #daily must tickets always need a due date too: the
    // rollover/streak logic keys off it to know which calendar day a
    // ticket belongs to and to regenerate the next day's occurrence.
    const due = dueInput.value || (remindInput.value ? todayISO() : "") || (isDailyMust ? todayISO() : "");
    // Belt-and-suspenders: #daily must always repeats daily, even if the
    // locked dropdown was somehow bypassed.
    const repeatVal = isDailyMust ? "daily" : repeatSelect.value;
    const t = mkTask(text, composerPriority, due, false, "", tags, repeatVal, remindInput.value);
    tasks.unshift(t);
    taskInput.value = "";
    dueInput.value = calendarMode ? selectedDate : "";
    refreshDueTodayBtn();
    composerSelectedTag = null;
    updateComposerTagButton();
    applyDailyMustRepeatLock();
    closeAllTagSelects();
    remindInput.value = "";
    repeatSelect.value = "none";
    render(t.id);
    saveTasks();
    taskInput.focus();
    notifyActivity("add", `Added <b>“${escapeHtml(truncate(t.text, 26))}”</b>`);
    if(t.remind && !notificationsEnabled()){
      showInfoToast("Reminder set — enable notifications from the ＋ menu to get alerted");
    }
  });

  // ---------- FILTER / SEARCH / SORT ----------
  const filterTabs = el("#filterTabs");
  filterTabs.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if(!btn) return;
    [...filterTabs.children].forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    render();
  });

  const searchInput = el("#searchInput");
  searchInput.addEventListener("input", () => {
    searchTerm = searchInput.value.trim().toLowerCase();
    render();
  });

  const sortSelect = el("#sortSelect");
  sortSelect.addEventListener("change", () => {
    sortMode = sortSelect.value;
    list.classList.toggle("manual-sort", sortMode === "manual");
    list.style.opacity = "0.3";
    setTimeout(() => { render(); list.style.opacity = "1"; }, 150);
  });

  // ---------- KEYBOARD SHORTCUTS ----------
  document.addEventListener("keydown", (e) => {
    if(e.key === "/" && document.activeElement !== taskInput && document.activeElement !== searchInput){
      e.preventDefault();
      searchInput.focus();
    }
    if(e.key === "Escape"){
      document.activeElement && document.activeElement.blur();
    }
  });

  // ---------- RENDER ----------
  function fmtDue(dateStr){
    if(!dateStr) return null;
    const d = new Date(dateStr + "T00:00:00");
    const today = new Date(); today.setHours(0,0,0,0);
    const diff = Math.round((d - today) / 86400000);
    let label;
    if(diff === 0) label = "Today";
    else if(diff === 1) label = "Tomorrow";
    else if(diff === -1) label = "Yesterday";
    else label = d.toLocaleDateString(undefined, { month:"short", day:"numeric" });
    return { label, overdue: diff < 0 };
  }

  function priorityColor(p){
    return p === "high" ? "var(--coral)" : p === "low" ? "var(--blue)" : "var(--yellow)";
  }
  function priorityWeight(p){ return p === "high" ? 0 : p === "med" ? 1 : 2; }

  function allTags(){
    const s = new Set();
    tasks.forEach(t => t.tags.forEach(tag => s.add(tag)));
    (meta.customTags || []).forEach(tag => s.add(tag));
    s.delete(PERMANENT_TAG);
    // Permanent tag always sorts first, everything else alphabetically after.
    return [PERMANENT_TAG, ...[...s].sort()];
  }

  function getFiltered(){
    const today = todayISO();
    let arr = tasks
      // #daily must is a per-day target, not a running list: outside calendar
      // view (where a specific date is already being looked at), only
      // today's occurrence should ever show here — done or not. Past
      // occurrences stay visible via the calendar/date view; future
      // occurrences (e.g. one spawned early by completing today's early)
      // stay hidden until their own day arrives.
      .filter(t => !t.tags.includes(PERMANENT_TAG) || taskDayKey(t) === today)
      .filter(t => currentFilter === "all" ? true : currentFilter === "done" ? t.done : !t.done)
      .filter(t => !searchTerm || t.text.toLowerCase().includes(searchTerm) || t.note.toLowerCase().includes(searchTerm) || t.tags.some(tg => tg.toLowerCase().includes(searchTerm)))
      .filter(t => !activeTagFilter || t.tags.includes(activeTagFilter));

    if(sortMode === "priority"){
      arr = [...arr].sort((a,b) => priorityWeight(a.priority) - priorityWeight(b.priority));
    } else if(sortMode === "due"){
      arr = [...arr].sort((a,b) => (a.due || "9999-99-99").localeCompare(b.due || "9999-99-99"));
    } else if(sortMode === "newest"){
      arr = [...arr].sort((a,b) => b.createdAt - a.createdAt);
    } else {
      arr = [...arr].sort((a,b) => a.order - b.order);
    }
    // pinned always float to top, preserving relative order otherwise
    arr = [...arr].sort((a,b) => (b.pinned?1:0) - (a.pinned?1:0));
    return arr;
  }

  function renderTagFilterRow(){
    const row = el("#tagFilterRow");
    const tags = allTags();
    if(tags.length === 0){
      row.innerHTML = `<span class="tags-block-empty">No tags yet — tap “Manage tags” to create one.</span>`;
      return;
    }
    row.innerHTML = tags.map(tag => {
      const c = tagColor(tag);
      const active = activeTagFilter === tag;
      return `<button class="tag-chip-filter ${active?"active":""}" data-tag="${escapeHtml(tag)}" style="${active?"":`color:${c.fg};border-color:${c.bg}`}">#${escapeHtml(tag)}</button>`;
    }).join("");
  }

  // ---------- MANAGE TAGS MODAL (add / rename / delete globally) ----------
  const manageTagsBtn = el("#manageTagsBtn");
  const manageTagsOverlay = el("#manageTagsOverlay");
  const manageTagsClose = el("#manageTagsClose");
  const manageTagsList = el("#manageTagsList");
  const newTagInput = el("#newTagInput");
  const newTagAddBtn = el("#newTagAddBtn");

  function tagUsageCount(tag){
    return tasks.filter(t => t.tags.includes(tag)).length;
  }

  function renderManageTagsList(){
    const tags = allTags();
    if(tags.length === 0){
      manageTagsList.innerHTML = `<div class="manage-tags-empty">No tags yet — add one above.</div>`;
      return;
    }
    manageTagsList.innerHTML = tags.map(tag => {
      const c = tagColor(tag);
      const count = tagUsageCount(tag);
      const isPermanent = tag === PERMANENT_TAG;
      return `
        <div class="manage-tag-row ${isPermanent ? "permanent" : ""}" data-tag="${escapeHtml(tag)}">
          <span class="manage-tag-swatch" style="background:${c.bg};color:${c.fg}">#${escapeHtml(tag)}</span>
          <span class="manage-tag-count">${count} ticket${count===1?"":"s"}</span>
          ${isPermanent
            ? `<span class="manage-tag-permanent-badge" title="Built-in tag — powers the streak counter">🔒 permanent</span>`
            : `<button class="manage-tag-rename" data-tag="${escapeHtml(tag)}" title="Rename">✎</button>
               <button class="manage-tag-delete" data-tag="${escapeHtml(tag)}" title="Delete">✕</button>`}
        </div>`;
    }).join("");
  }

  // ---------- EXPORT-BY-TAG PDF PICKER ----------
  const tagPdfPickOverlay = el("#tagPdfPickOverlay");
  const tagPdfPickClose = el("#tagPdfPickClose");
  const tagPdfPickList = el("#tagPdfPickList");

  function openTagPdfPicker(){
    const tags = allTags();
    if(tags.length === 0){
      showInfoToast("No tags yet — add one from Manage tags first");
      return;
    }
    tagPdfPickList.innerHTML = tags.map(tag => {
      const c = tagColor(tag);
      const count = tagUsageCount(tag);
      return `
        <button type="button" class="tag-pdf-pick-row" data-tag="${escapeHtml(tag)}">
          <span class="tag-pdf-pick-swatch" style="background:${c.bg};color:${c.fg}">#${escapeHtml(tag)}</span>
          <span class="tag-pdf-pick-count">${count} ticket${count===1?"":"s"}</span>
        </button>`;
    }).join("");
    tagPdfPickOverlay.classList.add("show");
  }
  tagPdfPickClose.addEventListener("click", () => tagPdfPickOverlay.classList.remove("show"));
  tagPdfPickOverlay.addEventListener("click", (e) => { if(e.target === tagPdfPickOverlay) tagPdfPickOverlay.classList.remove("show"); });
  tagPdfPickList.addEventListener("click", (e) => {
    const row = e.target.closest(".tag-pdf-pick-row");
    if(!row) return;
    tagPdfPickOverlay.classList.remove("show");
    exportTagPdf(row.dataset.tag);
  });

  manageTagsBtn.addEventListener("click", () => {
    renderManageTagsList();
    manageTagsOverlay.classList.add("show");
    setTimeout(() => newTagInput.focus(), 200);
  });
  manageTagsClose.addEventListener("click", () => manageTagsOverlay.classList.remove("show"));
  manageTagsOverlay.addEventListener("click", (e) => { if(e.target === manageTagsOverlay) manageTagsOverlay.classList.remove("show"); });

  // ---------- HAMBURGER MENU (notifications / PDF export / backup, all tucked away) ----------
  const hamburgerBtn = el("#hamburgerBtn");
  const menuOverlay = el("#menuOverlay");
  const menuClose = el("#menuClose");
  const menuList = el(".menu-list");

  hamburgerBtn.addEventListener("click", () => menuOverlay.classList.add("show"));
  menuClose.addEventListener("click", () => menuOverlay.classList.remove("show"));
  menuOverlay.addEventListener("click", (e) => { if(e.target === menuOverlay) menuOverlay.classList.remove("show"); });
  // Every action inside (notifications, exports, backup/restore) is wired up
  // by its own listener elsewhere via these same element ids — this just
  // closes the menu afterwards so it doesn't linger over the result.
  menuList.addEventListener("click", (e) => {
    if(e.target.closest(".menu-item")) menuOverlay.classList.remove("show");
  });

  function addCustomTag(){
    const val = newTagInput.value.trim().toLowerCase();
    if(!val) return;
    const existing = allTags();
    if(existing.includes(val)){
      newTagInput.value = "";
      if(val === PERMANENT_TAG) showInfoToast(`#${PERMANENT_TAG} already exists — it's a built-in tag`);
      return;
    }
    meta.customTags = [...(meta.customTags || []), val];
    newTagInput.value = "";
    renderManageTagsList();
    renderTagFilterRow();
    saveTasks();
    notifyActivity("add", `Added tag <b>#${escapeHtml(val)}</b>`);
  }
  newTagAddBtn.addEventListener("click", addCustomTag);
  newTagInput.addEventListener("keydown", (e) => { if(e.key === "Enter"){ e.preventDefault(); addCustomTag(); } });

  manageTagsList.addEventListener("click", (e) => {
    const renameBtn = e.target.closest(".manage-tag-rename");
    const deleteBtn = e.target.closest(".manage-tag-delete");
    if(renameBtn){
      const oldTag = renameBtn.dataset.tag;
      if(oldTag === PERMANENT_TAG) return; // built-in tag, never renameable
      const row = renameBtn.closest(".manage-tag-row");
      if(row.querySelector(".manage-tag-rename-input")) return; // already editing
      const swatch = row.querySelector(".manage-tag-swatch");
      const input = document.createElement("input");
      input.className = "manage-tag-rename-input";
      input.value = oldTag;
      input.maxLength = 24;
      swatch.replaceWith(input);
      input.focus();
      input.select();
      const finish = () => {
        const newTag = input.value.trim().toLowerCase();
        if(newTag === PERMANENT_TAG){
          showInfoToast(`#${PERMANENT_TAG} is a built-in tag name — pick another`);
          renderManageTagsList();
          return;
        }
        if(newTag && newTag !== oldTag){
          tasks.forEach(t => {
            if(t.tags.includes(oldTag)){
              t.tags = t.tags.includes(newTag) ? t.tags.filter(tg => tg !== oldTag) : t.tags.map(tg => tg === oldTag ? newTag : tg);
            }
          });
          meta.customTags = (meta.customTags || []).map(tg => tg === oldTag ? newTag : tg);
          if(activeTagFilter === oldTag) activeTagFilter = newTag;
          if(composerSelectedTag === oldTag){ composerSelectedTag = newTag; updateComposerTagButton(); }
          if(parseSelectedTag === oldTag){ parseSelectedTag = newTag; updateParseTagButton(); }
          saveTasks();
          render();
          notifyActivity("edit", `Renamed tag <b>#${escapeHtml(oldTag)}</b> → #${escapeHtml(newTag)}`);
        }
        renderManageTagsList();
      };
      input.addEventListener("blur", finish);
      input.addEventListener("keydown", (ev) => {
        if(ev.key === "Enter"){ ev.preventDefault(); input.blur(); }
        if(ev.key === "Escape"){ input.value = oldTag; input.blur(); }
      });
      return;
    }
    if(deleteBtn){
      requestTagDelete(deleteBtn.dataset.tag);
      return;
    }
  });

  // ---------- DELETE-TAG CONFIRMATION (asks what to do with tagged tasks) ----------
  const tagDeleteConfirmOverlay = el("#tagDeleteConfirmOverlay");
  const tagDeleteConfirmName = el("#tagDeleteConfirmName");
  const tagDeleteConfirmBody = el("#tagDeleteConfirmBody");
  const tagDeleteCancel = el("#tagDeleteCancel");
  const tagDeleteKeepTasks = el("#tagDeleteKeepTasks");
  const tagDeleteWithTasks = el("#tagDeleteWithTasks");
  let pendingDeleteTag = null;

  function requestTagDelete(tag){
    if(tag === PERMANENT_TAG) return; // built-in tag, never deletable
    const count = tagUsageCount(tag);
    if(count === 0){
      // Nothing depends on this tag — just remove it, no need to ask.
      finishTagDelete(tag, false);
      return;
    }
    pendingDeleteTag = tag;
    tagDeleteConfirmName.textContent = "#" + tag;
    tagDeleteConfirmBody.textContent = `${count} task${count===1?"":"s"} ${count===1?"has":"have"} this tag. Delete those tasks too, or keep them and just clear the tag?`;
    tagDeleteConfirmOverlay.classList.add("show");
  }
  function closeTagDeleteConfirm(){
    tagDeleteConfirmOverlay.classList.remove("show");
    pendingDeleteTag = null;
  }
  tagDeleteCancel.addEventListener("click", closeTagDeleteConfirm);
  tagDeleteConfirmOverlay.addEventListener("click", (e) => { if(e.target === tagDeleteConfirmOverlay) closeTagDeleteConfirm(); });
  tagDeleteKeepTasks.addEventListener("click", () => {
    if(pendingDeleteTag) finishTagDelete(pendingDeleteTag, false);
    closeTagDeleteConfirm();
  });
  tagDeleteWithTasks.addEventListener("click", () => {
    if(pendingDeleteTag) finishTagDelete(pendingDeleteTag, true);
    closeTagDeleteConfirm();
  });

  // Removes a tag globally. If deleteTasksToo is true, every task carrying
  // the tag is deleted outright; otherwise the tag is just stripped from
  // those tasks, which then fall back to showing "None" and can be given a
  // different tag from the same picker used everywhere else.
  function finishTagDelete(tag, deleteTasksToo){
    const count = tagUsageCount(tag);
    if(deleteTasksToo){
      tasks = tasks.filter(t => !t.tags.includes(tag));
    } else {
      tasks.forEach(t => { t.tags = t.tags.filter(tg => tg !== tag); });
    }
    meta.customTags = (meta.customTags || []).filter(tg => tg !== tag);
    if(activeTagFilter === tag) activeTagFilter = null;
    if(composerSelectedTag === tag){ composerSelectedTag = null; updateComposerTagButton(); }
    if(parseSelectedTag === tag){ parseSelectedTag = null; updateParseTagButton(); }
    saveTasks();
    render();
    renderManageTagsList();
    const detail = count
      ? (deleteTasksToo ? ` and ${count} task${count===1?"":"s"} with it` : ` from ${count} task${count===1?"":"s"} (kept, now untagged)`)
      : "";
    notifyActivity("delete", `Deleted tag <b>#${escapeHtml(tag)}</b>${detail}`);
  }

  // Builds a single task <li> (swipe-wrap). Reused by normal render and calendar view.
  function buildTaskLi(t, i, opts){
    opts = opts || {};
    const li = document.createElement("li");
    li.className = "swipe-wrap";
    li.dataset.id = t.id;

    const due = fmtDue(t.due);
    const doneSubtasks = t.subtasks.filter(s => s.done).length;
    const draggable = opts.draggable !== false;

    li.innerHTML = `
      <div class="swipe-bg right">✓ Complete</div>
      <div class="swipe-bg left">Delete ✕</div>
      <div class="task-card ${t.done ? "done" : ""} ${t.pinned ? "pinned" : ""}" draggable="${draggable}" style="animation-delay:${Math.min(i,20)*0.03}s">
        <span class="drag-handle" title="Drag to reorder">⠿</span>
        <button class="checkbox" aria-label="Toggle done">
          <span class="check-burst"></span>
          <svg viewBox="0 0 20 20"><path d="M4 10.5l4 4 8-9"/></svg>
        </button>
        <div class="task-main">
          <div class="task-row">
            <span class="task-no">No. ${String(t.serial).padStart(3,"0")}</span>
            <span class="prio-dot" style="background:${priorityColor(t.priority)}"></span>
            ${opts.showFromBadge ? `<span class="from-badge">from ${escapeHtml(formatDateShort(t.due))}</span>` : (due ? `<span class="due-badge ${due.overdue && !t.done ? "overdue" : ""}">${due.label}</span>` : "")}
            ${t.repeat !== "none" ? `<span class="repeat-badge">↻ ${t.repeat}</span>` : ""}
            ${t.remind ? `<span class="remind-badge">🔔 ${escapeHtml(t.remind)}</span>` : ""}
            ${t.pinned ? `<span class="pin-badge">📌</span>` : ""}
          </div>
          <p class="task-title" data-id="${t.id}">${escapeHtml(t.text)}<span class="highlight"></span></p>
          ${t.tags.length ? `<div class="tag-chips" data-id="${t.id}">${t.tags.map(tag => { const c = tagColor(tag); return `<span class="tag-chip" style="background:${c.bg};color:${c.fg}">#${escapeHtml(tag)}</span>`; }).join("")}</div>` : ""}

          <div class="task-meta-row">
            <button class="note-toggle ${t.note ? "has-note" : ""}" data-id="${t.id}">
              ${t.note ? "✎ note — view" : "+ note"}
            </button>
            <button class="subtask-toggle ${t.subtasks.length ? "has-subtasks" : ""}" data-id="${t.id}">
              ☑ ${t.subtasks.length ? `${doneSubtasks}/${t.subtasks.length} steps` : "checklist"}
            </button>
            <button class="tags-toggle ${t.tags.length ? "has-tags" : ""}" data-id="${t.id}">
              🏷 ${t.tags.length ? "edit tags" : "+ tags"}
            </button>
          </div>

          <div class="note-panel" data-id="${t.id}">
            <textarea placeholder="Jot a quick note…" data-id="${t.id}">${escapeHtml(t.note)}</textarea>
          </div>

          <div class="tags-panel" data-id="${t.id}">
            ${t.tags.length ? `
              <div class="tags-panel-chips" data-id="${t.id}">
                ${t.tags.map(tag => { const c = tagColor(tag); return `<span class="tag-chip removable" style="background:${c.bg};color:${c.fg}">#${escapeHtml(tag)}<button class="tag-chip-remove" data-id="${t.id}" data-tag="${escapeHtml(tag)}" aria-label="Remove tag">✕</button></span>`; }).join("")}
              </div>
            ` : `
              <div class="task-tag-picker">
                <label>Choose a tag</label>
                <div class="tag-select" data-id="${t.id}">
                  <button type="button" class="tag-select-btn task-tag-select-btn" data-id="${t.id}" aria-haspopup="listbox" aria-expanded="false">
                    <span class="tag-select-swatch none"></span>
                    <span class="tag-select-value">None</span>
                    <svg class="tag-select-caret" viewBox="0 0 12 8"><path d="M1 1l5 5 5-5"/></svg>
                  </button>
                  <div class="tag-select-menu" data-id="${t.id}" role="listbox"></div>
                </div>
              </div>
            `}
          </div>

          <div class="subtask-panel" data-id="${t.id}">
            <div class="subtasks" data-id="${t.id}">
              ${t.subtasks.map(s => `
                <div class="subtask-row ${s.done?"done":""}" data-sid="${s.id}" data-id="${t.id}">
                  <button class="subtask-check" data-sid="${s.id}" data-id="${t.id}"><svg viewBox="0 0 10 10"><path d="M1 5l2.5 2.5L9 1.5"/></svg></button>
                  <span class="subtask-text">${escapeHtml(s.text)}</span>
                  <button class="subtask-del" data-sid="${s.id}" data-id="${t.id}">✕</button>
                </div>
              `).join("")}
            </div>
            <div class="subtask-add">
              <input type="text" placeholder="Add a step…" data-id="${t.id}" class="subtask-input" maxlength="80" />
              <button class="subtask-add-btn" data-id="${t.id}">Add</button>
            </div>
          </div>
        </div>
        <div class="task-actions">
          <button class="pin-btn ${t.pinned?"active":""}" title="Pin" data-id="${t.id}">📌</button>
          <button class="edit-btn" title="Edit" data-id="${t.id}">✎</button>
          <button class="delete-btn" title="Delete" data-id="${t.id}">✕</button>
        </div>
      </div>
    `;
    return li;
  }

  function appendTaskLi(t, i, opts){
    const li = buildTaskLi(t, i, opts);
    list.appendChild(li);
    attachSwipe(li.querySelector(".task-card"), li, t.id);
  }

  function appendSectionHeader(text, count, extraClass){
    const li = document.createElement("li");
    li.className = "list-section-header" + (extraClass ? " " + extraClass : "");
    li.innerHTML = `<span>${text}</span><span class="count">${count}</span>`;
    list.appendChild(li);
  }

  // ---------- CALENDAR VIEW helpers ----------
  function getDayTasksLive(dateStr){
    return applyCommonFilters(tasks.filter(t => t.due === dateStr));
  }
  function getCarryForwardLive(dateStr){
    // still-pending tasks originally due before the selected date —
    // #daily must tickets are excluded on purpose: missing one should cost
    // the streak instead of quietly rolling forward as a lingering task.
    return applyCommonFilters(tasks.filter(t => t.due && t.due < dateStr && !t.done && !t.tags.includes(PERMANENT_TAG)));
  }
  function applyCommonFilters(arr){
    arr = arr
      .filter(t => currentFilter === "all" ? true : currentFilter === "done" ? t.done : !t.done)
      .filter(t => !searchTerm || t.text.toLowerCase().includes(searchTerm) || t.note.toLowerCase().includes(searchTerm) || t.tags.some(tg => tg.toLowerCase().includes(searchTerm)))
      .filter(t => !activeTagFilter || t.tags.includes(activeTagFilter));
    if(sortMode === "priority") arr = [...arr].sort((a,b) => priorityWeight(a.priority) - priorityWeight(b.priority));
    else if(sortMode === "due") arr = [...arr].sort((a,b) => (a.due||"9999-99-99").localeCompare(b.due||"9999-99-99"));
    else arr = [...arr].sort((a,b) => b.createdAt - a.createdAt);
    arr = [...arr].sort((a,b) => (b.pinned?1:0) - (a.pinned?1:0));
    return arr;
  }

  let lastRenderedLabelDate = null;
  function renderCalendarNav(){
    const dateNav = el("#dateNav");
    dateNav.classList.toggle("show", calendarMode);
    list.classList.toggle("cal-mode", calendarMode);
    if(!calendarMode) return;
    const label = el("#dnLabel");
    const inner = label.querySelector(".dn-label-inner");
    const text = selectedDate === todayISO() ? `Today · ${formatDateLong(selectedDate)}` : formatDateLong(selectedDate);
    inner.textContent = text;
    if(lastRenderedLabelDate !== selectedDate){
      label.classList.remove("swap"); void label.offsetWidth; label.classList.add("swap");
      lastRenderedLabelDate = selectedDate;
    }
    // The pill is only useful when viewing a date other than today, so hide
    // it entirely once "today" is already selected (same rule as the FAB).
    const onToday = selectedDate === todayISO();
    el("#dnToday").classList.toggle("hidden", onToday);
    el("#dnToday").classList.toggle("active", onToday);
  }

  function renderCalendarView(){
    const dayTasks = getDayTasksLive(selectedDate);
    const carryTasks = getCarryForwardLive(selectedDate);
    const noDateCount = tasks.filter(t => !t.due).length;

    appendSectionHeader(`📅 ${formatDateShort(selectedDate)}`, dayTasks.length);
    if(dayTasks.length === 0){
      const li = document.createElement("li");
      li.className = "no-date-hint";
      li.textContent = "Nothing scheduled for this date yet.";
      list.appendChild(li);
    } else {
      dayTasks.forEach((t,i) => appendTaskLi(t, i, { draggable:false }));
    }

    if(carryTasks.length){
      appendSectionHeader(`⏳ Carried forward`, carryTasks.length, "carry-header");
      carryTasks.forEach((t,i) => appendTaskLi(t, i, { draggable:false, showFromBadge:true }));
    }

    const total = dayTasks.length + carryTasks.length;
    if(total === 0){
      emptyState.classList.add("show");
      emptyMsg.textContent = "Nothing here yet — add a ticket with this date, or pick another day.";
    } else {
      emptyState.classList.remove("show");
    }

    if(noDateCount > 0){
      const hint = document.createElement("div");
      hint.className = "no-date-hint";
      hint.textContent = `${noDateCount} ticket${noDateCount>1?"s":""} have no date — exit calendar view to see ${noDateCount>1?"them":"it"}.`;
      list.parentElement.insertBefore(hint, list.nextSibling);
      hint.id = "noDateHint";
    }
  }

  function render(focusId){
    list.innerHTML = "";
    const oldHint = document.getElementById("noDateHint");
    if(oldHint) oldHint.remove();
    renderTagFilterRow();
    renderCalendarNav();

    if(calendarMode){
      renderCalendarView();
    } else {
      const filtered = getFiltered();
      filtered.forEach((t, i) => appendTaskLi(t, i));

      if(filtered.length === 0){
        emptyState.classList.add("show");
        if(tasks.length === 0) emptyMsg.textContent = "Nothing here yet — add your first ticket.";
        else if(searchTerm) emptyMsg.textContent = `No tasks match “${searchTerm}”.`;
        else if(activeTagFilter) emptyMsg.textContent = `Nothing tagged #${activeTagFilter}.`;
        else if(currentFilter === "done") emptyMsg.textContent = "No completed tasks yet — go get one done!";
        else emptyMsg.textContent = "All clear. Nothing active right now.";
      } else {
        emptyState.classList.remove("show");
      }
    }

    updateStats();
    updateStreakWidget();
    updateBulkRow();
    if(typeof refreshTodayFabState === "function") refreshTodayFabState();

    if(focusId){
      const card = list.querySelector(`[data-id="${focusId}"].swipe-wrap`);
      if(card) card.scrollIntoView({ behavior:"smooth", block:"nearest" });
    }
  }

  function escapeHtml(str){
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function updateBulkRow(){
    const bulkRow = el("#bulkRow");
    const anyDone = tasks.some(t => t.done);
    bulkRow.classList.toggle("show", anyDone);
  }

  function updateStats(){
    const total = tasks.length;
    const done = tasks.filter(t => t.done).length;
    el("#doneCount").textContent = done;
    el("#totalCount").textContent = total;
    const pct = total === 0 ? 0 : Math.round((done/total)*100);
    el("#ringPct").textContent = pct + "%";
    const circumference = 132;
    const offset = circumference - (circumference * pct / 100);
    el("#ringFg").style.strokeDashoffset = offset;

    const ringColor = pct >= 80 ? "var(--mint)" : pct >= 40 ? "var(--blue)" : "var(--yellow)";
    document.documentElement.style.setProperty("--ring-color", ringColor);

    const sub = el("#statSub");
    if(total === 0) sub.textContent = "Add your first ticket below";
    else if(pct === 100) sub.textContent = "Every ticket cleared 🎉";
    else if(pct >= 50) sub.textContent = "More than halfway there";
    else sub.textContent = "Keep going, one ticket at a time";

    if(total > 0 && pct === 100 && !hasCelebrated){
      hasCelebrated = true;
      celebrate();
    } else if(pct < 100){
      hasCelebrated = false;
    }
  }

  // ---------- STREAK (for the permanent "daily must" tag) ----------
  // A calendar day "counts" toward the streak when at least one task tagged
  // #daily must belongs to that day AND every one of them is done. A task's
  // day is its due date if it has one, otherwise the date it was created on
  // — so untimed daily-must tasks still count against the day they were
  // added, matching how the rest of the app treats due-less tasks.
  function taskDayKey(t){
    return t.due || toISODate(new Date(t.createdAt || Date.now()));
  }

  function dailyMustDayMap(){
    const map = new Map(); // dayKey -> { total, done }
    tasks.forEach(t => {
      if(!t.tags.includes(PERMANENT_TAG)) return;
      const day = taskDayKey(t);
      const entry = map.get(day) || { total:0, done:0 };
      entry.total++;
      if(t.done) entry.done++;
      map.set(day, entry);
    });
    return map;
  }

  // Walks backwards day-by-day from today. Today is allowed to be
  // incomplete/empty without breaking the streak (the day isn't over yet);
  // every day before that must be a fully-completed daily-must day.
  function computeDailyMustStreak(){
    const map = dailyMustDayMap();
    const today = todayISO();
    let streak = 0;
    let cursor = new Date(today + "T00:00:00");
    let first = true;

    while(true){
      const key = toISODate(cursor);
      const entry = map.get(key);
      const complete = !!entry && entry.total > 0 && entry.done === entry.total;

      if(complete){
        streak++;
      } else if(first && (!entry || entry.total === 0)){
        // Today has no daily-must tasks yet (or none logged) — skip without
        // breaking the streak, but don't count it either.
      } else if(first && entry && entry.done < entry.total){
        // Today has tasks but isn't finished yet — doesn't break the streak,
        // just doesn't extend it until it's done.
      } else {
        break;
      }
      first = false;
      cursor.setDate(cursor.getDate() - 1);
      if(streak > 3660) break; // sanity guard, ~10 years
    }
    return streak;
  }

  function updateStreakWidget(){
    const streak = computeDailyMustStreak();
    const map = dailyMustDayMap();
    const todayEntry = map.get(todayISO());
    const todayActive = !!todayEntry && todayEntry.total > 0;
    const todayComplete = todayActive && todayEntry.done === todayEntry.total;

    const wrap = el("#streakWidget");
    if(wrap){
      el("#streakCount").textContent = streak;
      wrap.classList.toggle("on-fire", streak >= 3);
      wrap.classList.toggle("today-done", todayComplete);
      wrap.title = streak === 0
        ? `No streak yet — complete every #${PERMANENT_TAG} ticket today to start one.`
        : `${streak} day${streak===1?"":"s"} of clearing every #${PERMANENT_TAG} ticket${todayActive && !todayComplete ? " (finish today's to extend it)" : ""}.`;
    }

    updateStreakPanel(streak, todayEntry, todayComplete);
  }

  // Dedicated streak division — separate from the compact header pill.
  // Shows the plain-language rule for how a streak is built, plus a live
  // count of today's #daily must targets vs. how many are done. Since this
  // runs from updateStreakWidget() on every render(), it stays in sync with
  // live edits, deletes, and completions of #daily must tickets.
  function updateStreakPanel(streak, todayEntry, todayComplete){
    const panel = el("#streakPanel");
    if(!panel) return;
    const total = todayEntry ? todayEntry.total : 0;
    const done = todayEntry ? todayEntry.done : 0;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    el("#streakPanelCount").textContent = streak;
    el("#streakPanelDayWord").textContent = streak === 1 ? "day" : "days";

    const fill = el("#streakProgressFill");
    if(fill) fill.style.width = pct + "%";

    const label = el("#streakProgressLabel");
    if(label){
      label.innerHTML = total > 0
        ? `<b>${done}</b> of <b>${total}</b> #${PERMANENT_TAG} target${total === 1 ? "" : "s"} completed today`
        : `No #${PERMANENT_TAG} targets logged for today yet — add one to keep the streak going.`;
    }

    panel.classList.toggle("on-fire", streak >= 3);
    panel.classList.toggle("complete-today", todayComplete);
  }

  // ---------- SWIPE GESTURES ----------
  function attachSwipe(card, wrap, id){
    let startX = 0, currentX = 0, dragging = false;
    const bgRight = wrap.querySelector(".swipe-bg.right");
    const bgLeft = wrap.querySelector(".swipe-bg.left");
    const THRESHOLD = 90;

    card.addEventListener("touchstart", (e) => {
      if(e.target.closest(".drag-handle") || e.target.closest("input, textarea, select, button.subtask-check, button.subtask-del")) return;
      startX = e.touches[0].clientX;
      dragging = true;
      card.style.transition = "none";
    }, { passive:true });

    card.addEventListener("touchmove", (e) => {
      if(!dragging) return;
      currentX = e.touches[0].clientX - startX;
      card.style.transform = `translateX(${currentX}px)`;
      const progress = Math.min(Math.abs(currentX) / THRESHOLD, 1);
      if(currentX > 0){ bgRight.style.opacity = progress; bgLeft.style.opacity = 0; }
      else { bgLeft.style.opacity = progress; bgRight.style.opacity = 0; }
    }, { passive:true });

    card.addEventListener("touchend", () => {
      if(!dragging) return;
      dragging = false;
      card.style.transition = "transform 0.3s cubic-bezier(.2,.8,.2,1)";
      if(currentX > THRESHOLD){
        card.style.transform = `translateX(120%)`;
        setTimeout(() => toggleDone(id, true), 150);
      } else if(currentX < -THRESHOLD){
        card.style.transform = `translateX(-120%)`;
        setTimeout(() => deleteTask(id), 150);
      } else {
        // A plain tap (touchstart+touchend with no movement) reaches this
        // branch with currentX still 0 — there's no drag to snap back from,
        // so skip touching transform at all. Setting even "translateX(0)"
        // here left an inline transform on the card for the ~320ms cleanup
        // window below, which traps any dropdown menu opened by that same
        // tap in a local stacking context (see pinMenuToViewport's own
        // defensive cleanup for the belt-and-braces fix on top of this).
        if(currentX === 0){
          card.style.transform = "";
          bgRight.style.opacity = 0; bgLeft.style.opacity = 0;
          return;
        }
        card.style.transform = "translateX(0)";
        bgRight.style.opacity = 0; bgLeft.style.opacity = 0;
        // Once the snap-back settles, drop the inline transform entirely
        // rather than leaving "translateX(0)" sitting on the element. Even
        // an identity transform is a non-"none" value, and per the CSS
        // stacking rules that alone permanently traps this card (and any
        // dropdown menu inside it) in its own stacking context — so the
        // card's tag-select menu would render *behind* later cards in the
        // list instead of above them the moment it needed to overflow past
        // its own row. A tap alone (touchstart+touchend, no real drag) hits
        // this exact branch, so nearly every touched card was affected.
        const clearRestingTransform = () => {
          if(!dragging) card.style.transform = "";
        };
        card.addEventListener("transitionend", clearRestingTransform, { once:true });
        setTimeout(clearRestingTransform, 320);
      }
      currentX = 0;
    });
  }

  // ---------- EVENT DELEGATION ----------
  list.addEventListener("click", (e) => {
    if(e.target.closest(".checkbox")){
      const card = e.target.closest(".task-card");
      const burst = card.querySelector(".check-burst");
      burst.classList.remove("play"); void burst.offsetWidth; burst.classList.add("play");
      card.classList.add("completing");
      setTimeout(() => card.classList.remove("completing"), 500);
      toggleDone(Number(card.closest("[data-id]").dataset.id));
      return;
    }
    if(e.target.closest(".delete-btn")){
      deleteTask(Number(e.target.closest(".delete-btn").dataset.id));
      return;
    }
    if(e.target.closest(".edit-btn")){
      startEdit(Number(e.target.closest(".edit-btn").dataset.id));
      return;
    }
    if(e.target.closest(".pin-btn")){
      togglePin(Number(e.target.closest(".pin-btn").dataset.id));
      return;
    }
    if(e.target.closest(".note-toggle")){
      const btn = e.target.closest(".note-toggle");
      const panel = list.querySelector(`.note-panel[data-id="${btn.dataset.id}"]`);
      panel.classList.toggle("open");
      if(panel.classList.contains("open")){
        const ta = panel.querySelector("textarea");
        setTimeout(() => ta.focus(), 200);
      }
      return;
    }
    if(e.target.closest(".subtask-toggle")){
      const btn = e.target.closest(".subtask-toggle");
      const panel = list.querySelector(`.subtask-panel[data-id="${btn.dataset.id}"]`);
      panel.classList.toggle("open");
      return;
    }
    if(e.target.closest(".subtask-check")){
      const btn = e.target.closest(".subtask-check");
      toggleSubtask(Number(btn.dataset.id), Number(btn.dataset.sid));
      return;
    }
    if(e.target.closest(".subtask-del")){
      const btn = e.target.closest(".subtask-del");
      deleteSubtask(Number(btn.dataset.id), Number(btn.dataset.sid));
      return;
    }
    if(e.target.closest(".subtask-add-btn")){
      const btn = e.target.closest(".subtask-add-btn");
      addSubtaskFromInput(Number(btn.dataset.id));
      return;
    }
    if(e.target.closest(".tags-toggle")){
      const btn = e.target.closest(".tags-toggle");
      setTagsPanelOpen(btn.dataset.id, null);
      return;
    }
    if(e.target.closest(".tag-chip-remove")){
      const btn = e.target.closest(".tag-chip-remove");
      removeTagFromTask(Number(btn.dataset.id), btn.dataset.tag);
      return;
    }
    if(e.target.closest(".task-tag-select-btn")){
      const btn = e.target.closest(".task-tag-select-btn");
      const id = btn.dataset.id;
      const wrap = btn.closest(".tag-select");
      const menu = list.querySelector(`.tags-panel .tag-select-menu[data-id="${id}"]`);
      const willOpen = !wrap.classList.contains("open");
      closeAllTagSelects();
      if(willOpen && menu){
        const t = tasks.find(tk => tk.id === Number(id));
        menu.innerHTML = tagSelectMenuHTML(t ? (t.tags[0] || null) : null);
        wrap.classList.add("open");
        // Lift any clipping ancestor (the swipe-card uses overflow:hidden
        // for its swipe-to-delete reveal) while this dropdown is open so
        // the menu isn't cut off.
        liftClippingAncestors(wrap);
        // Pin to the viewport so the menu always paints above the next
        // task card instead of being covered by it (see pinMenuToViewport).
        pinMenuToViewport(btn, menu);
        // The tags-panel may still be mid max-height transition (it opens
        // together with this menu when reached via "edit tags"), which can
        // shift btn's position by a few px right after the first measurement
        // — re-measure once layout has settled so the menu lands correctly.
        requestAnimationFrame(() => pinMenuToViewport(btn, menu));
      }
      return;
    }
    if(e.target.closest(".tags-panel .tag-select-item")){
      const item = e.target.closest(".tag-select-item");
      const menu = item.closest(".tag-select-menu");
      const id = Number(menu.dataset.id);
      const tag = item.dataset.tag || null;
      const wrap = item.closest(".tag-select");
      if(wrap) wrap.classList.remove("open");
      unpinMenu(menu);
      restoreClippingAncestors();
      if(tag) selectTagForTask(id, tag);
      return;
    }
    if(e.target.classList.contains("task-title")){
      startEdit(Number(e.target.dataset.id));
      return;
    }
  });

  list.addEventListener("keydown", (e) => {
    if(e.target.classList.contains("subtask-input") && e.key === "Enter"){
      e.preventDefault();
      addSubtaskFromInput(Number(e.target.dataset.id));
    }
  });

  list.addEventListener("change", (e) => {
    if(e.target.tagName === "TEXTAREA"){
      const t = tasks.find(t => t.id === Number(e.target.dataset.id));
      if(t){
        t.note = e.target.value;
        const toggle = list.querySelector(`.note-toggle[data-id="${t.id}"]`);
        toggle.textContent = t.note ? "✎ note — view" : "+ note";
        toggle.classList.toggle("has-note", !!t.note);
        saveTasks();
        notifyActivity("edit", `Updated note on <b>“${escapeHtml(truncate(t.text, 20))}”</b>`);
      }
    }
  });

  el("#tagFilterRow").addEventListener("click", (e) => {
    const btn = e.target.closest(".tag-chip-filter");
    if(!btn) return;
    activeTagFilter = activeTagFilter === btn.dataset.tag ? null : btn.dataset.tag;
    render();
  });

  el("#clearCompletedBtn").addEventListener("click", () => {
    const removed = tasks.filter(t => t.done);
    if(removed.length === 0) return;
    tasks = tasks.filter(t => !t.done);
    render();
    saveTasks();
    notifyActivity("delete", `Cleared <b>${removed.length} completed</b> ticket${removed.length>1?"s":""}`);
    pushUndo(
      `Cleared ${removed.length} completed ticket${removed.length>1?"s":""}`,
      () => { tasks = tasks.concat(removed); render(); saveTasks(); },
      () => { tasks = tasks.filter(t => !removed.some(r => r.id === t.id)); render(); saveTasks(); }
    );
  });

  function haptic(ms){ if(navigator.vibrate) navigator.vibrate(ms); }

  function nextDueDate(dueStr, repeat){
    const base = dueStr ? new Date(dueStr + "T00:00:00") : new Date();
    if(repeat === "daily") base.setDate(base.getDate() + 1);
    else if(repeat === "weekly") base.setDate(base.getDate() + 7);
    else if(repeat === "monthly") base.setMonth(base.getMonth() + 1);
    return toISODate(base); // was base.toISOString().slice(0,10) — bug: toISOString()
    // converts to UTC, which silently shifted the date back a day for any
    // timezone ahead of UTC (e.g. IST, UTC+5:30). toISODate() below uses the
    // local Y/M/D so repeat due-dates land on the correct day.
  }

  // ---------- REPEAT ROLLOVER (auto-regenerate at midnight) ----------
  // Previously a repeating task's next occurrence only appeared once you
  // ticked the current one done — miss a day and the chain went quiet.
  // This walks every repeating series forward to "today" regardless of
  // whether yesterday's occurrence was ever completed, so e.g. a daily
  // #daily must ticket is always there to work on. The original overdue
  // instance is left exactly where it is (no carry-forward, per the rule
  // above) so it still counts as a missed day for the streak.
  function rolloverRepeatingTasks(){
    const today = todayISO();
    const bySeries = new Map();
    tasks.forEach(t => {
      if(!t.repeat || t.repeat === "none" || !t.due) return;
      const key = t.seriesId;
      const list = bySeries.get(key) || [];
      list.push(t);
      bySeries.set(key, list);
    });

    let created = false;
    bySeries.forEach((list, seriesId) => {
      list.sort((a, b) => a.due.localeCompare(b.due));
      const latestExisting = list[list.length - 1];
      // Start from whichever is further ahead: the newest surviving task,
      // or the watermark. This is what stops a deliberately-deleted
      // occurrence from being recreated — if "today" was deleted, the
      // watermark still remembers it was already generated, so we resume
      // from the day *after* it instead of regenerating it.
      const wm = meta.seriesWatermark[seriesId] || "";
      let cursorDue = wm > latestExisting.due ? wm : latestExisting.due;
      let cursorRepeat = latestExisting.repeat;
      let guard = 0;
      // Walk forward one interval at a time, catching up on any days the
      // app was closed for — capped so a series left dormant for months
      // doesn't flood the list with backdated tickets.
      while(guard < 60){
        const next = nextDueDate(cursorDue, cursorRepeat);
        if(next > today) break;
        const exists = tasks.some(t => t.seriesId === seriesId && t.due === next);
        if(!exists){
          const spawned = mkTask(latestExisting.text, latestExisting.priority, next, false, "", [...latestExisting.tags], latestExisting.repeat, latestExisting.remind, undefined, seriesId);
          tasks.push(spawned);
          created = true;
        }
        cursorDue = next;
        guard++;
      }
    });
    if(created) saveTasks();
    return created;
  }

  let lastRolloverDate = null;
  // Cheap to call often — only does the real work when the calendar date
  // has actually changed since the last check.
  function checkRepeatRollover(){
    const today = todayISO();
    if(lastRolloverDate === today) return;
    lastRolloverDate = today;
    if(rolloverRepeatingTasks()) render();
  }

  function toggleDone(id, viaSwipe){
    const t = tasks.find(t => t.id === id);
    if(!t) return;
    t.done = !t.done;
    haptic(t.done ? 12 : 6);
    if(t.done){
      t.completedAt = Date.now();
      if(t.repeat && t.repeat !== "none"){
        const next = mkTask(t.text, t.priority, nextDueDate(t.due, t.repeat), false, "", [...t.tags], t.repeat, t.remind, undefined, t.seriesId);
        tasks.push(next);
        pushUndo(
          `Next “${truncate(t.text,22)}” scheduled`,
          () => { tasks = tasks.filter(x => x.id !== next.id); render(); saveTasks(); },
          () => { tasks.push(next); render(); saveTasks(); }
        );
      }
    } else {
      t.completedAt = null;
    }
    render();
    saveTasks();
    notifyActivity(t.done ? "done" : "edit", `${t.done ? "Completed" : "Reopened"} <b>“${escapeHtml(truncate(t.text, 22))}”</b>`);
  }

  function togglePin(id){
    const t = tasks.find(t => t.id === id);
    if(!t) return;
    t.pinned = !t.pinned;
    render(id);
    saveTasks();
    notifyActivity("edit", `${t.pinned ? "Pinned" : "Unpinned"} <b>“${escapeHtml(truncate(t.text, 24))}”</b>`);
  }

  function toggleSubtask(taskId, subId){
    const t = tasks.find(t => t.id === taskId);
    if(!t) return;
    const s = t.subtasks.find(s => s.id === subId);
    if(!s) return;
    s.done = !s.done;
    render();
    saveTasks();
    notifyActivity(s.done ? "done" : "edit", `${s.done ? "Checked" : "Unchecked"} step in <b>“${escapeHtml(truncate(t.text, 18))}”</b>`);
  }

  function deleteSubtask(taskId, subId){
    const t = tasks.find(t => t.id === taskId);
    if(!t) return;
    const sub = t.subtasks.find(s => s.id === subId);
    t.subtasks = t.subtasks.filter(s => s.id !== subId);
    render();
    saveTasks();
    if(sub) notifyActivity("delete", `Removed step from <b>“${escapeHtml(truncate(t.text, 20))}”</b>`);
  }

  // ---------- PER-TASK TAG EDITING ----------
  function selectTagForTask(taskId, tag){
    const t = tasks.find(t => t.id === taskId);
    if(!t || !tag) return;
    if(t.tags.length) return; // picker is only ever offered while the task has no tag
    t.tags = [tag];
    render();
    saveTasks();
    notifyActivity("edit", `Tagged <b>“${escapeHtml(truncate(t.text, 22))}”</b> #${escapeHtml(tag)}`);
    setTimeout(() => setTagsPanelOpen(taskId, true), 50);
  }
  function removeTagFromTask(taskId, tag){
    const t = tasks.find(t => t.id === taskId);
    if(!t) return;
    t.tags = t.tags.filter(tg => tg !== tag);
    render();
    saveTasks();
    notifyActivity("edit", `Removed tag <b>#${escapeHtml(tag)}</b> from “${escapeHtml(truncate(t.text, 20))}”`);
    setTimeout(() => setTagsPanelOpen(taskId, true), 50);
  }

  let subtaskIdCounter = 1;
  function addSubtaskFromInput(taskId){
    const input = list.querySelector(`.subtask-input[data-id="${taskId}"]`);
    if(!input) return;
    const val = input.value.trim();
    if(!val) return;
    const t = tasks.find(t => t.id === taskId);
    if(!t) return;
    t.subtasks.push({ id: Date.now() + Math.floor(Math.random()*1000), text: val, done:false });
    input.value = "";
    render();
    saveTasks();
    notifyActivity("add", `Added step to <b>“${escapeHtml(truncate(t.text, 20))}”</b>`);
    setTimeout(() => {
      const panel = list.querySelector(`.subtask-panel[data-id="${taskId}"]`);
      if(panel) panel.classList.add("open");
      const newInput = list.querySelector(`.subtask-input[data-id="${taskId}"]`);
      if(newInput) newInput.focus();
    }, 50);
  }

  // Opens/closes a task's tags-panel, keeping the summary tag-chips row in
  // sync so tags never render twice at once (panel open <-> chips hidden).
  // force: true = open, false = close, null/undefined = toggle.
  function setTagsPanelOpen(id, force){
    const panel = list.querySelector(`.tags-panel[data-id="${id}"]`);
    const chips = list.querySelector(`.tag-chips[data-id="${id}"]`);
    if(!panel) return;
    const willOpen = force === true || force === false ? force : !panel.classList.contains("open");
    panel.classList.toggle("open", willOpen);
    if(chips) chips.classList.toggle("hidden-while-editing", willOpen);
  }

  function startEdit(id){
    const t = tasks.find(t => t.id === id);
    if(!t) return;
    const p = list.querySelector(`.task-title[data-id="${id}"]`);
    if(!p) return;
    const input = document.createElement("input");
    input.className = "task-title-input";
    input.value = t.text;
    input.maxLength = 140;
    p.replaceWith(input);
    input.focus();
    input.select();
    // surface the tags panel too, so editing text and tags happen in one flow
    // (hides the summary tag-chips row so tags aren't shown twice at once)
    setTagsPanelOpen(id, true);

    function commit(){
      const val = input.value.trim();
      const changed = val && val !== t.text;
      if(val) t.text = val;
      render(id);
      saveTasks();
      if(changed) notifyActivity("edit", `Edited <b>“${escapeHtml(truncate(t.text, 26))}”</b>`);
    }
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if(e.key === "Enter"){ e.preventDefault(); input.blur(); }
      if(e.key === "Escape"){ input.value = t.text; input.blur(); }
    });
  }

  function deleteTask(id){
    const wrap = list.querySelector(`.swipe-wrap[data-id="${id}"]`);
    const card = wrap ? wrap.querySelector(".task-card") : null;
    const index = tasks.findIndex(t => t.id === id);
    if(index === -1) return;
    const task = tasks[index];
    haptic(15);

    if(card){
      card.classList.add("removing");
      card.addEventListener("animationend", () => {
        tasks.splice(index, 1);
        render();
        saveTasks();
      }, { once:true });
    } else {
      tasks.splice(index, 1);
      render();
      saveTasks();
    }

    pushUndo(
      `Deleted “${truncate(task.text, 28)}”`,
      () => { tasks.splice(Math.min(index, tasks.length), 0, task); render(task.id); saveTasks(); },
      () => { const i = tasks.findIndex(t => t.id === task.id); if(i !== -1){ tasks.splice(i, 1); render(); saveTasks(); } }
    );
    notifyActivity("delete", `Deleted <b>“${escapeHtml(truncate(task.text, 26))}”</b>`);
  }

  function truncate(str, n){ return str.length > n ? str.slice(0, n-1) + "…" : str; }

  // ---------- ACTIVITY NOTIFICATIONS (top-left, colourful) ----------
  // Fires for every add / delete / edit / move, independent of the
  // bottom undo/redo toast. Stacks up to 3 at once and auto-dismisses.
  const activityStack = el("#activityStack");
  const ACTIVITY_ICONS = { add:"✚", delete:"🗑", edit:"✎", move:"↕", done:"✓" };
  const MAX_ACTIVITY_NOTES = 4;

  function notifyActivity(type, text){
    if(!activityStack) return;
    // keep the stack short so it never overwhelms the corner
    while(activityStack.children.length >= MAX_ACTIVITY_NOTES){
      activityStack.removeChild(activityStack.firstChild);
    }
    const note = document.createElement("div");
    note.className = `activity-note ${type}`;
    note.innerHTML = `<span class="a-icon">${ACTIVITY_ICONS[type] || "•"}</span><span class="a-text">${text}</span>`;
    activityStack.appendChild(note);
    const dismissAfter = setTimeout(() => dismissNote(note), 3200);
    note.addEventListener("click", () => { clearTimeout(dismissAfter); dismissNote(note); });
  }
  function dismissNote(note){
    if(!note || !note.parentNode) return;
    note.classList.add("leaving");
    note.addEventListener("animationend", () => note.remove(), { once:true });
  }

  // ---------- TOAST + UNDO/REDO STACK ----------
  const toast = el("#toast");
  const toastMsg = el("#toastMsg");
  const undoBtn = el("#undoBtn");
  const redoBtn = el("#redoBtn");
  let toastTimeout = null;

  // Undo/redo history, capped at 10 entries. Each entry is
  // { label, undo(), redo() }. Pushing a new action clears any pending redo
  // history, the same way undo/redo works in a text editor — once you do
  // something new, the old "future" (the stuff you undid) is gone.
  const MAX_UNDO_DEPTH = 10;
  let undoStack = [];
  let redoStack = [];

  function pushUndo(label, undo, redo){
    undoStack.push({ label, undo, redo });
    if(undoStack.length > MAX_UNDO_DEPTH) undoStack.shift();
    redoStack = [];
    showToast(label, true);
  }

  // Plain informational toast — no undo/redo entry, e.g. "PDF downloaded".
  function showInfoToast(msg){
    showToast(msg, false);
  }
  function showToast(msg, hasUndo){
    toastMsg.textContent = msg;
    undoBtn.classList.toggle("hidden", !hasUndo);
    redoBtn.classList.add("hidden");
    toast.classList.add("show");
    if(toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove("show"), 5000);
  }

  // One-shot guards: a fast double-click on Undo/Redo before the toast
  // visually disappears shouldn't re-apply the same stack action twice.
  let undoInFlight = false;
  undoBtn.addEventListener("click", () => {
    if(undoInFlight || undoStack.length === 0) return;
    undoInFlight = true;
    const entry = undoStack.pop();
    entry.undo();
    redoStack.push(entry);
    toastMsg.textContent = `Undid: ${entry.label}`;
    undoBtn.classList.toggle("hidden", undoStack.length === 0);
    redoBtn.classList.remove("hidden");
    if(toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove("show"), 5000);
    undoInFlight = false;
  });

  let redoInFlight = false;
  redoBtn.addEventListener("click", () => {
    if(redoInFlight || redoStack.length === 0) return;
    redoInFlight = true;
    const entry = redoStack.pop();
    entry.redo();
    undoStack.push(entry);
    if(undoStack.length > MAX_UNDO_DEPTH) undoStack.shift();
    toastMsg.textContent = `Redid: ${entry.label}`;
    redoBtn.classList.toggle("hidden", redoStack.length === 0);
    undoBtn.classList.remove("hidden");
    if(toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove("show"), 5000);
    redoInFlight = false;
  });

  // ---------- DRAG REORDER (manual sort only) ----------
  list.addEventListener("dragstart", (e) => {
    if(sortMode !== "manual") { e.preventDefault(); return; }
    const card = e.target.closest(".task-card");
    if(!card) return;
    draggingId = Number(card.closest("[data-id]").dataset.id);
    card.classList.add("dragging");
  });
  list.addEventListener("dragend", (e) => {
    const card = e.target.closest(".task-card");
    if(card) card.classList.remove("dragging");
    draggingId = null;
  });
  list.addEventListener("dragover", (e) => {
    if(sortMode !== "manual") return;
    e.preventDefault();
    const afterEl = getDragAfterElement(list, e.clientY);
    const dragging = list.querySelector(".dragging");
    if(!dragging) return;
    const draggingWrap = dragging.closest(".swipe-wrap");
    if(afterEl == null) list.appendChild(draggingWrap);
    else list.insertBefore(draggingWrap, afterEl);
  });
  list.addEventListener("drop", () => {
    if(sortMode !== "manual") return;
    const movedTask = draggingId != null ? tasks.find(t => t.id === draggingId) : null;
    const newOrderIds = [...list.querySelectorAll(".swipe-wrap")].map(c => Number(c.dataset.id));
    newOrderIds.forEach((id, i) => {
      const t = tasks.find(t => t.id === id);
      if(t) t.order = i;
    });
    render();
    saveTasks();
    if(movedTask) notifyActivity("move", `Moved <b>“${escapeHtml(truncate(movedTask.text, 26))}”</b>`);
  });
  function getDragAfterElement(container, y){
    const wraps = [...container.querySelectorAll(".swipe-wrap:not(:has(.dragging))")];
    return wraps.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height/2;
      if(offset < 0 && offset > closest.offset) return { offset, element: child };
      else return closest;
    }, { offset: -Infinity }).element;
  }

  // ---------- CONFETTI ----------
  function celebrate(){
    const colors = ["#ffc845","#ff6b6b","#5fe3c0","#7da6ff","#b48cff"];
    for(let i=0;i<44;i++){
      const piece = document.createElement("div");
      piece.className = "confetti-piece";
      piece.style.left = Math.random()*100 + "vw";
      piece.style.background = colors[Math.floor(Math.random()*colors.length)];
      piece.style.animationDuration = (2 + Math.random()*1.5) + "s";
      piece.style.opacity = 0.7 + Math.random()*0.3;
      piece.style.transform = `rotate(${Math.random()*360}deg)`;
      document.body.appendChild(piece);
      piece.addEventListener("animationend", () => piece.remove());
    }
    haptic([10,40,10,40,20]);
  }

  // ---------- BACKUP / RESTORE ----------
  // (Text-paste backup/restore was removed — the JSON file backup/restore
  // below is simpler and covers the same ground, so it's the only path now.)

  // ---------- BACKUP / RESTORE AS A .JSON FILE ----------
  // Same data shape as the text-box backup above (tasks + meta), just saved
  // to / loaded from an actual downloadable file instead of copy-paste.
  const downloadJsonBtn = el("#downloadJsonBtn");
  const uploadJsonBtn = el("#uploadJsonBtn");
  const jsonFileInput = el("#jsonFileInput");

  downloadJsonBtn.addEventListener("click", () => {
    const payload = {
      app: "todo list by Aryan",
      schemaVersion: 2, // 2 = tasks carry a single `tags[0]` + a gap-filling `serial`
      exportedAt: new Date().toISOString(),
      tasks,
      meta
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type:"application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = todayISO();
    a.href = url;
    a.download = `todo-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showInfoToast("Backup file downloaded");
  });

  uploadJsonBtn.addEventListener("click", () => jsonFileInput.click());

  jsonFileInput.addEventListener("change", () => {
    const file = jsonFileInput.files && jsonFileInput.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try{
        const parsed = JSON.parse(String(reader.result));
        // Accept either the full { tasks, meta } export shape, or a bare
        // array of tasks (matches what the text-box backup/restore uses),
        // so files from either method restore correctly.
        const rawTasks = Array.isArray(parsed) ? parsed : parsed.tasks;
        if(!Array.isArray(rawTasks)) throw new Error("no tasks array found in file");

        const prevTasks = tasks;
        const prevMeta = meta;

        // Build the old-id -> new-id map first so seriesId (which points at
        // another task's id) can be remapped consistently, keeping repeating
        // chains linked together instead of each task becoming a lone series.
        const idRemap = new Map();
        rawTasks.forEach(t => { if(t && typeof t.id !== "undefined") idRemap.set(t.id, idCounter + idRemap.size); });

        const restoredTasks = rawTasks.map(t => {
          const newId = idRemap.has(t.id) ? idRemap.get(t.id) : idCounter++;
          idCounter = Math.max(idCounter, newId + 1);
          return {
          id: newId,
          text: String(t.text || "Untitled"),
          priority: ["low","med","high"].includes(t.priority) ? t.priority : "med",
          due: t.due || "",
          done: !!t.done,
          note: t.note || "",
          tags: Array.isArray(t.tags) ? t.tags : [],
          subtasks: Array.isArray(t.subtasks) ? t.subtasks : [],
          pinned: !!t.pinned,
          repeat: t.repeat || "none",
          remind: t.remind || "",
          reminded: !!t.reminded,
          seriesId: (typeof t.seriesId !== "undefined" && idRemap.has(t.seriesId)) ? idRemap.get(t.seriesId) : newId,
          order: idCounter,
          createdAt: t.createdAt || Date.now(),
          completedAt: t.completedAt || null,
          serial: typeof t.serial === "number" ? t.serial : null
        };
        });
        normalizeSerials(restoredTasks);
        tasks = restoredTasks;
        // seriesWatermark keys are old (pre-remap) task ids too — remap them
        // the same way, or the delete-protection would silently lose track
        // of every series' progress the moment a backup is restored.
        const remappedWatermark = {};
        if(parsed.meta && parsed.meta.seriesWatermark && typeof parsed.meta.seriesWatermark === "object"){
          Object.entries(parsed.meta.seriesWatermark).forEach(([oldSeriesId, due]) => {
            const newSeriesId = idRemap.get(Number(oldSeriesId));
            if(typeof newSeriesId === "number" && typeof due === "string"){
              const cur = remappedWatermark[newSeriesId];
              if(!cur || due > cur) remappedWatermark[newSeriesId] = due;
            }
          });
        }
        const restoredMeta = (!Array.isArray(parsed) && parsed.meta && typeof parsed.meta === "object")
          ? { ...meta, ...parsed.meta, seriesWatermark: remappedWatermark }
          : meta;
        meta = restoredMeta;
        if(meta.theme) applyTheme(meta.theme === "light");

        render();
        saveTasks();
        pushUndo(
          `Restored ${tasks.length} ticket${tasks.length===1?"":"s"} from file`,
          () => { tasks = prevTasks; meta = prevMeta; if(meta.theme) applyTheme(meta.theme === "light"); render(); saveTasks(); },
          () => { tasks = restoredTasks; meta = restoredMeta; if(meta.theme) applyTheme(meta.theme === "light"); render(); saveTasks(); }
        );
      }catch(err){
        console.error("JSON restore failed:", err);
        showInfoToast("Couldn't read that file — is it a valid backup?");
      }finally{
        jsonFileInput.value = "";
      }
    };
    reader.onerror = () => {
      showInfoToast("Couldn't read that file");
      jsonFileInput.value = "";
    };
    reader.readAsText(file);
  });

  // ---------- FAB ROW (always-visible, no collapse) ----------
  const todayFab = el("#todayFab");

  // Today FAB — jumps straight to today's date. If not already in calendar
  // view, switch to it first (that's the view "today" makes sense in),
  // then select today's date and scroll the list back to the top.
  // The button is hidden entirely whenever selectedDate is already today,
  // since there's nothing for it to do in that state.
  function refreshTodayFabState(){
    const onToday = selectedDate === todayISO();
    todayFab.classList.toggle("hidden", onToday);
    todayFab.classList.toggle("active", calendarMode && onToday);
  }
  todayFab.addEventListener("click", () => {
    if(!calendarMode){
      calendarMode = true;
      calendarToggle.classList.add("active");
    }
    setSelectedDate(todayISO());
    refreshTodayFabState();
    window.scrollTo({ top:0, behavior:"smooth" });
  });

  // ---------- TEXT → TASKS ----------
  const parseFab = el("#parseFab");
  const parseOverlay = el("#parseOverlay");
  const parseArea = el("#parseArea");
  const parseClose = el("#parseClose");
  const parseGenerate = el("#parseGenerate");
  const parseCount = el("#parseCount");
  const parsePreview = el("#parsePreview");
  const parseTagSelect = el("#parseTagSelect");
  const parseTagSelectBtn = el("#parseTagSelectBtn");
  const parseTagSelectMenu = el("#parseTagSelectMenu");
  const parseTagSelectValue = el("#parseTagSelectValue");
  const parseTagSelectSwatch = el("#parseTagSelectSwatch");
  let parseSelectedTag = null;

  function updateParseTagButton(){
    if(parseSelectedTag){
      const c = tagColor(parseSelectedTag);
      parseTagSelectSwatch.className = "tag-select-swatch";
      parseTagSelectSwatch.style.background = c.fg;
      parseTagSelectValue.textContent = "#" + parseSelectedTag;
    } else {
      parseTagSelectSwatch.className = "tag-select-swatch none";
      parseTagSelectSwatch.style.background = "";
      parseTagSelectValue.textContent = "None";
    }
  }
  // Same picker style as elsewhere, but this one also lets you type a brand
  // new tag name right there — handy for a quick batch-add from the FAB
  // instead of hopping to the Tags block first. Newly created tags still
  // land in the shared tag list (Manage tags will show them too).
  function parseTagMenuHTML(){
    return tagSelectMenuHTML(parseSelectedTag) + `
      <div class="tag-select-divider"></div>
      <div class="tag-select-create">
        <input type="text" class="tag-select-create-input" placeholder="Create new tag…" maxlength="24" autocomplete="off" />
        <button type="button" class="tag-select-create-btn" title="Create &amp; select">＋</button>
      </div>`;
  }
  function openParseTagMenu(){
    closeAllTagSelects();
    parseTagSelectMenu.innerHTML = parseTagMenuHTML();
    parseTagSelect.classList.add("open");
  }
  function commitParseNewTag(){
    const input = parseTagSelectMenu.querySelector(".tag-select-create-input");
    if(!input) return;
    const val = input.value.trim().toLowerCase();
    if(!val) return;
    if(!allTags().includes(val)){
      meta.customTags = [...(meta.customTags || []), val];
      saveTasks();
      renderTagFilterRow();
    }
    parseSelectedTag = val;
    updateParseTagButton();
    parseTagSelect.classList.remove("open");
  }
  parseTagSelectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = !parseTagSelect.classList.contains("open");
    closeAllTagSelects();
    if(willOpen) openParseTagMenu();
  });
  parseTagSelectMenu.addEventListener("click", (e) => {
    if(e.target.closest(".tag-select-create-btn")){ commitParseNewTag(); return; }
    const item = e.target.closest(".tag-select-item");
    if(!item) return;
    parseSelectedTag = item.dataset.tag || null;
    updateParseTagButton();
    parseTagSelect.classList.remove("open");
  });
  parseTagSelectMenu.addEventListener("keydown", (e) => {
    if(e.target.classList.contains("tag-select-create-input") && e.key === "Enter"){
      e.preventDefault();
      commitParseNewTag();
    }
  });
  parseTagSelectMenu.addEventListener("click", (e) => { e.stopPropagation(); }); // keep menu open while typing/clicking inside

  function splitToTasks(raw){
    // commas AND newlines both act as separators, so pasted lists (one per
    // line) and comma-separated text both work the way the person expects.
    return raw
      .split(/,|\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 100); // sane ceiling so a giant paste can't freeze the UI
  }

  function updateParsePreview(){
    const items = splitToTasks(parseArea.value);
    parseCount.textContent = `${items.length} task${items.length===1?"":"s"} detected`;
    parsePreview.innerHTML = items.map(t => `<span class="parse-chip">${escapeHtml(t.length>40?t.slice(0,39)+"…":t)}</span>`).join("");
  }

  parseFab.addEventListener("click", () => {
    parseArea.value = "";
    updateParsePreview();
    parseSelectedTag = null;
    updateParseTagButton();
    closeAllTagSelects();
    parseOverlay.classList.add("show");
    setTimeout(() => parseArea.focus(), 200);
  });
  parseClose.addEventListener("click", () => parseOverlay.classList.remove("show"));
  parseOverlay.addEventListener("click", (e) => { if(e.target === parseOverlay) parseOverlay.classList.remove("show"); });
  parseArea.addEventListener("input", updateParsePreview);
  parseArea.addEventListener("paste", () => setTimeout(updateParsePreview, 0));

  parseGenerate.addEventListener("click", () => {
    const items = splitToTasks(parseArea.value);
    if(items.length === 0){
      parseArea.style.borderColor = "var(--coral)";
      setTimeout(() => parseArea.style.borderColor = "", 900);
      return;
    }
    const isDailyMust = parseSelectedTag === PERMANENT_TAG;
    // Same rule as the single-ticket composer: #daily must always repeats
    // daily and always has a due date (today, unless a calendar date is
    // already being viewed) — otherwise these bulk-added tickets would
    // never roll over at midnight and would be day-scoped out of the list
    // by getFiltered() with no way to regenerate. See README.
    const due = (calendarMode ? selectedDate : "") || (isDailyMust ? todayISO() : "");
    const repeatVal = isDailyMust ? "daily" : "none";
    const batchTags = parseSelectedTag ? [parseSelectedTag] : [];
    const serials = claimSerials(items.length);
    const created = items.map((text, i) => mkTask(text, "med", due, false, "", [...batchTags], repeatVal, "", serials[i]));
    // keep the typed/pasted order intact — first item typed ends up first (top) in the list
    tasks.unshift(...created);
    closeAllTagSelects();
    parseOverlay.classList.remove("show");
    render(created[0].id);
    saveTasks();
    notifyActivity("add", `Added <b>${items.length} ticket${items.length===1?"":"s"}</b> from text`);
    pushUndo(
      `Added ${items.length} ticket${items.length===1?"":"s"} from text`,
      () => {
        const ids = new Set(created.map(t => t.id));
        tasks = tasks.filter(t => !ids.has(t.id));
        render(); saveTasks();
      },
      () => { tasks.unshift(...created); render(created[0].id); saveTasks(); }
    );
  });

  // ---------- NOTIFICATIONS & REMINDERS ----------
  const notifFab = el("#notifFab");
  const notifOverlay = el("#notifOverlay");
  const notifClose = el("#notifClose");
  const notifSwitch = el("#notifSwitch");
  const notifStatus = el("#notifStatus");
  const notifTestBtn = el("#notifTestBtn");

  function hasNotificationApi(){ return "Notification" in window; }
  function notificationsEnabled(){
    return meta.notificationsEnabled && hasNotificationApi() && Notification.permission === "granted";
  }

  function refreshNotifUI(){
    notifFab.classList.toggle("on", notificationsEnabled());
    if(!hasNotificationApi()){
      notifStatus.textContent = "This browser doesn't support notifications.";
      notifStatus.className = "notif-status denied";
      notifSwitch.classList.remove("on");
      notifTestBtn.disabled = true;
      return;
    }
    notifTestBtn.disabled = false;
    if(Notification.permission === "denied"){
      notifStatus.textContent = "Blocked in browser settings — allow notifications for this site to use reminders.";
      notifStatus.className = "notif-status denied";
      notifSwitch.classList.remove("on");
    } else if(notificationsEnabled()){
      notifStatus.textContent = "Notifications are on. Tickets with a 🔔 reminder time will alert you.";
      notifStatus.className = "notif-status granted";
      notifSwitch.classList.add("on");
    } else {
      notifStatus.textContent = "Turn this on to allow reminder alerts with sound and vibration.";
      notifStatus.className = "notif-status";
      notifSwitch.classList.remove("on");
    }
  }

  notifFab.addEventListener("click", () => {
    refreshNotifUI();
    notifOverlay.classList.add("show");
  });
  notifClose.addEventListener("click", () => notifOverlay.classList.remove("show"));
  notifOverlay.addEventListener("click", (e) => { if(e.target === notifOverlay) notifOverlay.classList.remove("show"); });

  notifSwitch.addEventListener("click", async () => {
    if(!hasNotificationApi()){ refreshNotifUI(); return; }
    if(notifSwitch.classList.contains("on")){
      meta.notificationsEnabled = false;
      saveTasks();
      refreshNotifUI();
      return;
    }
    try{
      const perm = await Notification.requestPermission();
      meta.notificationsEnabled = perm === "granted";
      saveTasks();
    }catch(err){ meta.notificationsEnabled = false; }
    refreshNotifUI();
  });

  // Short synthesized beep — no audio file to bundle, and it plays instantly
  // the first time notifications are enabled without an extra network request.
  function playNotifySound(){
    try{
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if(!Ctx) return;
      const ctx = new Ctx();
      [880, 1180].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const start = ctx.currentTime + i * 0.16;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.15);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(start); osc.stop(start + 0.16);
      });
      setTimeout(() => ctx.close().catch(()=>{}), 500);
    }catch(err){ /* Web Audio unsupported / blocked — fail silently */ }
  }

  async function fireNotification(title, body, tag){
    playNotifySound();
    haptic([40, 60, 40, 60, 80]);
    if(!notificationsEnabled()) return;
    const opts = { body, tag, renotify:true, icon:"icons/icon-192.png", badge:"icons/icon-192.png", vibrate:[40,60,40,60,80] };
    try{
      if("serviceWorker" in navigator){
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, opts);
      } else {
        new Notification(title, opts);
      }
    }catch(err){ console.error("Notification failed:", err); }
  }

  notifTestBtn.addEventListener("click", () => {
    fireNotification("Test reminder", "This is what your task reminders will look like.", "test-reminder");
  });

  // Polls once every 20s while the app is open and checks each ticket's
  // due date + reminder time against "now". This is a best-effort, in-tab
  // reminder — true background delivery on a static PWA (no push server)
  // needs the tab to be loaded, so the app stays reliable as long as it's
  // open in the background rather than fully closed.
  function checkReminders(){
    if(!notificationsEnabled()) return;
    const now = new Date();
    const nowISO = todayISO();
    const nowHM = String(now.getHours()).padStart(2,"0") + ":" + String(now.getMinutes()).padStart(2,"0");
    tasks.forEach(t => {
      if(t.done || !t.remind || !t.due || t.reminded) return;
      if(t.due === nowISO && t.remind <= nowHM){
        t.reminded = true;
        fireNotification("Reminder: " + truncate(t.text, 60), formatDateLong(t.due) + " at " + t.remind, "task-" + t.id);
        saveTasks();
      }
    });
  }
  setInterval(() => { checkReminders(); checkRepeatRollover(); }, 20000);

  // JS timers (including the 20s poll above) can stall or pause entirely
  // while a mobile browser tab is backgrounded, so a rollover due right at
  // midnight might not fire until the phone screen turns back on — this
  // catches that moment too.
  document.addEventListener("visibilitychange", () => {
    if(document.visibilityState === "visible") checkRepeatRollover();
  });

  // ---------- PWA SERVICE WORKER ----------
  if("serviceWorker" in navigator){
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  // ---------- INIT ----------
  async function init(){
    list.innerHTML = `<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>`;
    const hadSavedData = await loadTasks();
    if(meta.theme){
      applyTheme(meta.theme === "light");
    } else {
      // No saved preference yet — respect the OS/browser setting instead of
      // always defaulting to dark.
      const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
      applyTheme(prefersLight);
    }
    if(!hadSavedData){
      tasks = [
        mkTask("Script tomorrow's Reel hook", "med", "", false, "Keep first 2 seconds punchy — pattern interrupt.", ["reels"], "none"),
        mkTask("Fix dark mode toggle in Study Planner", "high", "", false, "", ["code"], "none"),
        mkTask("Reply to brand collab email", "low", "", true, "Quoted ₹ rate, waiting on their reply.", ["brand"], "none")
      ];
      await saveTasks();
    }
    lastRolloverDate = todayISO();
    rolloverRepeatingTasks();
    render();
    refreshNotifUI();
    checkReminders();
  }
  init();
})();
