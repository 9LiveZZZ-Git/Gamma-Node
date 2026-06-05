/* =========================================================================
 * Tektite MD -- templates + daily notes
 *
 * Phase C sprint tektite-4. Mustache-ish placeholder engine used by:
 *   - Daily notes (today, yesterday, tomorrow)
 *   - User-defined note templates (sprint tektite-4b will add a picker)
 *   - The +New note flow (auto-injects sensible scaffolding)
 *
 * Placeholders honored by tektiteRenderTemplate(template, vars):
 *
 *   {{date}}            ISO date, today by default (vars.date overrides)
 *   {{date:format}}     formatted date; supports
 *                         YYYY MM DD HH mm ss
 *                         YYYY-MM-DD       (default `date`)
 *                         dddd ddd dd      day-of-week
 *                         MMMM MMM         month name
 *   {{time}}            HH:mm
 *   {{title}}           the new note's title (vars.title or "Untitled")
 *   {{slug}}            slugified title
 *   {{selection}}       text the user had selected when opening template
 *   {{cursor}}          marker that the editor will jump to after insert
 *   {{node:type}}       used by /insert-node-doc; replaced with the
 *                       registry doc-block of that node type (defers
 *                       to sprint tektite-4b; passes through here)
 *
 * Public surface:
 *   tektiteRenderTemplate(tpl, vars)
 *       -> string. Pure function; no IDB/UI side effects.
 *   tektiteDailyNoteTodayId()
 *       -> the slug of today's daily note (e.g. "daily-2026-06-04")
 *   tektiteDailyNoteOpenOrCreate({ offset = 0 })
 *       -> Promise<string> resolving to the note id; creates from the
 *       daily template if it doesn't exist yet. `offset` is days
 *       relative to today (-1 = yesterday, +1 = tomorrow).
 *   tektiteDailyNoteTemplate(date)
 *       -> string. Default daily-note template body. Easy to override
 *       in a later sprint via a settings entry.
 * ======================================================================== */

function _tektiteDateFormat(d, fmt) {
  const pad = (n, w) => String(n).padStart(w || 2, "0");
  const monthsLong = ["January","February","March","April","May","June",
                      "July","August","September","October","November","December"];
  const monthsShort = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const daysLong  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const daysShort = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const map = {
    YYYY: pad(d.getFullYear(), 4),
    YY:   pad(d.getFullYear() % 100, 2),
    MMMM: monthsLong[d.getMonth()],
    MMM:  monthsShort[d.getMonth()],
    MM:   pad(d.getMonth() + 1, 2),
    DD:   pad(d.getDate(), 2),
    HH:   pad(d.getHours(), 2),
    mm:   pad(d.getMinutes(), 2),
    ss:   pad(d.getSeconds(), 2),
    dddd: daysLong[d.getDay()],
    ddd:  daysShort[d.getDay()],
    dd:   pad(d.getDay(), 2)
  };
  // Longer tokens first so YYYY isn't half-consumed by YY.
  const order = ["YYYY","YY","MMMM","MMM","MM","DD","HH","mm","ss","dddd","ddd","dd"];
  let out = fmt;
  for (const tok of order) {
    out = out.split(tok).join(map[tok]);
  }
  return out;
}

function tektiteRenderTemplate(tpl, vars) {
  vars = vars || {};
  const baseDate = (vars.date instanceof Date) ? vars.date : new Date();
  const subs = {
    title:     vars.title     || "Untitled",
    slug:      vars.slug      || ((typeof tektiteSlugify === "function") ? tektiteSlugify(vars.title || "untitled") : "untitled"),
    selection: vars.selection || "",
    cursor:    "",  // marker is left empty; the editor strips + jumps
    date:      _tektiteDateFormat(baseDate, "YYYY-MM-DD"),
    time:      _tektiteDateFormat(baseDate, "HH:mm")
  };
  return String(tpl || "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, expr) => {
    const colon = expr.indexOf(":");
    if (colon < 0) {
      // Simple `{{key}}` lookup; pass through if unknown.
      return Object.prototype.hasOwnProperty.call(subs, expr) ? String(subs[expr]) : whole;
    }
    const head = expr.slice(0, colon).trim();
    const arg  = expr.slice(colon + 1).trim();
    if (head === "date") return _tektiteDateFormat(baseDate, arg || "YYYY-MM-DD");
    if (head === "time") return _tektiteDateFormat(baseDate, arg || "HH:mm");
    if (head === "node") {
      // sprint tektite-4b will resolve from the registry; pass through
      // for now so the user sees the literal placeholder.
      return whole;
    }
    return whole;
  });
}

function tektiteDailyNoteTodayId(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + (Number.isFinite(offsetDays) ? offsetDays : 0));
  return "daily-" + _tektiteDateFormat(d, "YYYY-MM-DD");
}

function tektiteDailyNoteTemplate(date) {
  const d = (date instanceof Date) ? date : new Date();
  return tektiteRenderTemplate([
    "---",
    "tags: [daily]",
    "date: {{date}}",
    "---",
    "# {{date:dddd, MMMM DD YYYY}}",
    "",
    "## Notes",
    "",
    "",
    "## Tasks",
    "",
    "- [ ] ",
    "",
    "## Log",
    "",
    "{{time}} — "
  ].join("\n"), { date: d });
}

async function tektiteDailyNoteOpenOrCreate(opts) {
  opts = opts || {};
  const offset = Number.isFinite(opts.offset) ? opts.offset : 0;
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const id = "daily-" + _tektiteDateFormat(d, "YYYY-MM-DD");
  const existing = await tektiteGetNote(id);
  if (existing) return id;
  // Title: human-readable date.
  const title = _tektiteDateFormat(d, "dddd, MMMM DD YYYY");
  await tektitePutNote({
    id,
    title,
    content: tektiteDailyNoteTemplate(d)
  });
  return id;
}
