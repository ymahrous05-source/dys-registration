/**
 * ============================================================================
 *  Delta Youth Sanad — Registration backend (Google Apps Script)
 * ============================================================================
 *  This is the server-side code behind:
 *    - dys_form.html      (public registration form, sends doPost)
 *    - dys_dashboard.html (admin dashboard, calls doGet?action=list, plus the
 *                          new "الإعدادات" tab which manages the registration
 *                          window, form title, sheet name, and the logo image)
 *
 *  ⚠️ READ THIS BEFORE DEPLOYING ⚠️
 *  If you already have real registrations in a Google Sheet:
 *    1. Open THAT sheet first → Extensions ▸ Apps Script. If code shows up
 *       there, your old backend isn't actually lost — it's attached to the
 *       sheet. Don't replace it blindly; compare it with this file instead.
 *    2. Make a copy of the sheet (File ▸ Make a copy) before testing this,
 *       so you can experiment without risking real data.
 *    3. Make sure SHEET_NAME below matches your real tab name, and that
 *       row 1 of your sheet has headers matching HEADERS below — in the
 *       same order. Run checkHeaders() (see bottom of this file) from the
 *       Apps Script editor to get a report instead of guessing.
 *
 *  ✅ UPGRADING FROM THE OLDER VERSION OF THIS FILE
 *  This version is backward compatible with your existing data: on first
 *  run it keeps using whatever sheet tab is named SHEET_NAME below (your
 *  real registrations stay exactly where they are). The new "cycle" system
 *  (registration windows + auto-created sheets) only kicks in once you set
 *  it up from the dashboard's Settings tab — nothing changes until you do.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// CONFIG — the only section you should normally need to touch
// ---------------------------------------------------------------------------

// Bump this string any time you paste in a new version of this file. After
// deploying, open ?action=diagnostics&password=... (or the "🩺 تشخيص" button
// in the dashboard) — if codeVersion doesn't match what you expect, the web
// app is still running an OLD deployment and you need Deploy ▸ Manage
// deployments ▸ Edit (✏️) ▸ New version ▸ Deploy (see BACKEND_SETUP_STEPS.md
// step 7). This single check rules out the #1 cause of "I edited the code
// but nothing changed."
const CODE_VERSION = "2026-08-23-granular-permissions";

// The five independently-grantable admin capabilities. "viewData" is always
// true for every account (there's no point in an account that can log in
// and see nothing) — the other four are what actually differ per account.
// Add a new capability here + wire it into ACTION_PERMISSIONS below and the
// dashboard's account-editor checkboxes if you ever need a 6th one.
const PERMISSION_KEYS = ["manageSettings", "manageFields", "manageCertificates", "manageAccounts"];

const SHEET_NAME = "Registrations"; // <-- change to match your actual tab name (used as the default/first cycle's sheet)

// Column order written to the sheet. Keep this order in sync with HEADERS —
// index i of HEADERS must correspond to index i of the row array built in
// buildRow_(). The dashboard finds columns by header NAME (not position), so
// reordering here is safe as long as HEADERS and buildRow_() stay matched.
// ---------------------------------------------------------------------------
// Extended field registry — the "literally every field a form might need"
// set. Each of these behaves exactly like the original 9 toggleable fields
// (age, gender, phone, ...) below: shown/hidden and required/optional from
// the "🧩 حقول الاستمارة" settings card, with no code changes needed. They're
// kept in a SEPARATE object from TOGGLEABLE_FIELDS (rather than merged in)
// so the original 9 fields' hand-written validation further down stays
// completely untouched — these newer ones are validated generically instead
// (see the EXTRA_FIELDS loop inside validatePayload_), based on `type`:
//   "text"     — any non-empty string passes (min-length 1)
//   "textarea" — same as text, just a bigger box on the form
//   "select"   — value must be one of `options`
//   "date"     — must look like YYYY-MM-DD
//   "checkbox" — stored/validated as "Yes"/"No", same convention as the
//                existing graduate/hasJob fields
// `section` groups fields on both the dashboard's config card and the
// public form — a section with zero enabled fields (all disabled here, and
// no custom fields assigned to it) simply never renders, per your request
// that empty pages/sections shouldn't show up in the form at all.
const FIELD_SECTIONS = {
  personal: "بيانات شخصية إضافية",
  education: "بيانات تعليمية ووظيفية إضافية",
  contact: "بيانات تواصل إضافية",
  entity: "بيانات داخل الكيان إضافية",
  other: "حقول تانية",
  custom: "حقول مخصصة",
};

const EXTRA_FIELDS = {
  address:        { section: "personal", label: "العنوان بالتفصيل", type: "text", defaultRequired: false },
  birthDate:      { section: "personal", label: "تاريخ الميلاد", type: "date", defaultRequired: false },
  maritalStatus:  { section: "personal", label: "الحالة الاجتماعية", type: "select", options: ["أعزب", "متزوج", "مطلق", "أرمل"], defaultRequired: false },
  governorate:    { section: "personal", label: "المحافظة", type: "text", defaultRequired: false },
  academicYear:   { section: "education", label: "الفرقة الدراسية", type: "text", defaultRequired: false },
  gradeLevel:     { section: "education", label: "التقدير الدراسي", type: "text", defaultRequired: false },
  facebook:       { section: "contact", label: "رابط الفيسبوك", type: "text", defaultRequired: false },
  instagram:      { section: "contact", label: "يوزر الانستجرام", type: "text", defaultRequired: false },
  emergencyName:  { section: "contact", label: "اسم شخص للطوارئ", type: "text", defaultRequired: false },
  emergencyPhone: { section: "contact", label: "رقم شخص للطوارئ", type: "text", defaultRequired: false },
  howHeard:       { section: "entity", label: "عرفت عننا إزاي؟", type: "text", defaultRequired: false },
  prevVolunteer:  { section: "entity", label: "خبرة تطوعية سابقة", type: "textarea", defaultRequired: false },
  motivation:     { section: "entity", label: "ليه عايز تنضم؟", type: "textarea", defaultRequired: false },
  skills:         { section: "entity", label: "مهارات أو اهتمامات", type: "text", defaultRequired: false },
  availability:   { section: "entity", label: "الأوقات المتاحة للتطوع", type: "text", defaultRequired: false },
  tshirtSize:     { section: "other", label: "مقاس التيشيرت", type: "select", options: ["S", "M", "L", "XL", "XXL"], defaultRequired: false },
  notes:          { section: "other", label: "ملاحظات إضافية", type: "textarea", defaultRequired: false },
};

// address reuses the pre-existing "Address" column (it was always in
// HEADERS, just unconditionally blank — see buildRow_) so it's NOT in
// EXTRA_HEADERS below; everything else here is a genuinely new column.
const EXTRA_HEADERS = [
  "Birth Date", "Marital Status", "Governorate", "Academic Year", "Grade Level",
  "Facebook", "Instagram", "Emergency Contact Name", "Emergency Contact Phone",
  "How Heard", "Previous Volunteering", "Motivation", "Skills", "Availability",
  "Tshirt Size", "Notes",
];
const EXTRA_HEADER_KEYS = Object.keys(EXTRA_FIELDS).filter(k => k !== "address");
const HEADER_TO_EXTRA_FIELD = {};
EXTRA_HEADERS.forEach((h, i) => { HEADER_TO_EXTRA_FIELD[h] = EXTRA_HEADER_KEYS[i]; });

const CUSTOM_FIELDS_HEADER = "Custom Fields (JSON)";

const HEADERS = [
  "Timestamp",
  "Membership No",
  "Name",
  "Age",
  "Gender",
  "National ID",
  "Phone",
  "Whatsapp",
  "Email",
  "Address",
  "Faculty",
  "Graduate",
  "Role in Entity",   // ← this is the "committee" field from the form
  "Has Job",
  "Current Job",
].concat(EXTRA_HEADERS).concat([CUSTOM_FIELDS_HEADER]).concat(["Photo URL"]);

const MIN_FILL_MS = 2500; // mirrors the frontend's own MIN_FILL_MS anti-bot check
const MEMBERSHIP_PREFIX = "DYS";

// ---------------------------------------------------------------------------
// Configurable fields — controlled from the dashboard's "🧩 حقول الاستمارة"
// settings card. Each of these can be shown/hidden on the form, and marked
// required or optional, WITHOUT touching any code or the sheet's columns
// (the column stays in HEADERS either way — it's just left blank when a
// field is disabled or skipped). "Name" and "National ID" are intentionally
// NOT in this list: the whole duplicate-check + membership system depends
// on them, so they always stay shown and required.
const TOGGLEABLE_FIELDS = {
  age:       { section: "personal", label: "العمر", defaultRequired: true },
  gender:    { section: "personal", label: "النوع", defaultRequired: true },
  phone:     { section: "contact", label: "رقم الهاتف", defaultRequired: true },
  whatsapp:  { section: "contact", label: "رقم الواتساب", defaultRequired: true },
  email:     { section: "contact", label: "البريد الإلكتروني", defaultRequired: false },
  faculty:   { section: "education", label: "الكلية / المدرسة", defaultRequired: true },
  graduate:  { section: "education", label: "هل أنت خريج؟", defaultRequired: true },
  committee: { section: "entity", label: "صفتك داخل الكيان", defaultRequired: true },
  hasJob:    { section: "education", label: "هل تعمل حاليًا؟", defaultRequired: true },
};

// The personal-photo field is file-typed (not text/select/etc. like
// EXTRA_FIELDS), so it's validated and uploaded through its own dedicated
// path (see handleSubmit_'s photo-upload step + validatePayload_) rather
// than the generic EXTRA_FIELDS loop — but it still shows up in
// ALL_BUILTIN_FIELDS so the dashboard can enable/require it exactly like
// every other field.
const PHOTO_FIELD = { section: "personal", label: "صورة شخصية", type: "photo", defaultRequired: false };

// Every built-in field (original 9 + the newer 17 + the photo field) — this
// is what the dashboard's "🧩 حقول الاستمارة" card and
// getFieldConfig_/handleSaveFieldConfig_ iterate over. The original 9 keep
// their bespoke hand-written validation in validatePayload_ (unchanged);
// EXTRA_FIELDS are validated generically.
const ALL_BUILTIN_FIELDS = Object.assign({}, TOGGLEABLE_FIELDS, EXTRA_FIELDS, { photo: PHOTO_FIELD });


// ---------------------------------------------------------------------------
// ENTRY POINTS
// ---------------------------------------------------------------------------

function doGet(e) {
  const action = (e.parameter.action || "").trim();

  try {
    if (action === "list") return handleList_(e);
    if (action === "checkNid") return handleCheckNid_(e);
    if (action === "publicConfig") return handlePublicConfig_();
    if (action === "getConfig") return handleGetConfig_(e);
    if (action === "listCycles") return handleListCycles_(e);
    if (action === "diagnostics") return handleDiagnostics_(e);

    return jsonOutput_({
      status: "success",
      message: "Delta Youth Sanad backend is running. Use ?action=list, ?action=checkNid, or ?action=publicConfig.",
    });
  } catch (err) {
    return jsonOutput_({ status: "error", message: String(err) });
  }
}

function doPost(e) {
  try {
    if (!e.postData || !e.postData.contents) {
      return jsonOutput_({ status: "error", message: "No data received" });
    }

    let payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (err) {
      return jsonOutput_({ status: "error", message: "Invalid JSON" });
    }

    // Admin-only actions (settings panel in the dashboard) — every one of
    // these re-checks the password itself, so nothing here is trusted blindly.
    const ADMIN_ACTIONS = [
      "saveConfig", "uploadLogo", "removeLogo",
      "uploadCertTemplate", "removeCertTemplate",
      "sendCertificate", "sendCertificatesBulk", "sendTestCertificate",
      "saveFieldConfig",
      "listAdminAccounts", "addAdminAccount", "removeAdminAccount",
      "exportExcel", "getActivityLog",
    ];
    if (payload && ADMIN_ACTIONS.indexOf(payload.action) > -1) {
      return handleAdminAction_(payload);
    }

    // Anything else is treated as a normal registration submission.
    return handleSubmit_(payload || {});
  } catch (err) {
    return jsonOutput_({ status: "error", message: String(err) });
  }
}


// ---------------------------------------------------------------------------
// action=list  (admin dashboard — table + charts)
// ---------------------------------------------------------------------------

function handleList_(e) {
  const password = e.parameter.password || "";
  if (!getAdminAccounts_().length) {
    return jsonOutput_({ status: "error", message: "لسه محددتش كلمة سر الأدمن. شوف تعليمات ADMIN_PASSWORD تحت." });
  }
  const account = requirePermission_(password, "viewData");
  if (!account) {
    return jsonOutput_({ status: "error", message: "Unauthorized" });
  }

  const cfg = getRegConfig_();
  const requestedSheet = (e.parameter.sheet || "").trim();
  const sheetName = requestedSheet || cfg.activeSheetName;

  const sheet = findSheet_(sheetName);
  if (!sheet) {
    return jsonOutput_({ status: "error", message: `الشيت "${sheetName}" مش موجود.` });
  }

  const data = sheet.getDataRange().getValues();
  const headers = data[0] || [];
  const rows = data.slice(1).filter(row => row.some(cell => String(cell).trim() !== ""));

  // Timestamps come back as Date objects from the Sheets API — stringify them
  // so the dashboard's JSON.parse-based date detection keeps working.
  const tsIdx = headers.indexOf("Timestamp");
  const serialized = rows.map(row => {
    const copy = row.slice();
    if (tsIdx > -1 && copy[tsIdx] instanceof Date) {
      copy[tsIdx] = Utilities.formatDate(copy[tsIdx], Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
    }
    return copy;
  });

  return jsonOutput_({
    status: "success",
    headers,
    rows: serialized,
    sheetName: sheet.getName(),
    activeSheetName: cfg.activeSheetName,
    role: account.role,
    permissions: account.permissions,
    accountName: account.name,
  });
}


// ---------------------------------------------------------------------------
// action=checkNid  (live duplicate check while typing — no password needed,
// it only ever answers true/false, never returns any personal data)
// ---------------------------------------------------------------------------

function handleCheckNid_(e) {
  const nationalId = (e.parameter.nationalId || "").trim();
  if (!/^[0-9]{14}$/.test(nationalId)) {
    return jsonOutput_({ status: "success", exists: false });
  }
  return jsonOutput_({ status: "success", exists: isDuplicateNid_(nationalId) });
}


// ---------------------------------------------------------------------------
// action=publicConfig  (public — the form calls this on load to know its
// title, its logo, and whether registration is currently open)
// ---------------------------------------------------------------------------

// Reads FIELD_CONFIG from Script Properties and fills in defaults for any
// field/key that's missing — so an install that never touched this Settings
// card behaves exactly like the original hardcoded validation.
function getFieldConfig_() {
  const raw = PropertiesService.getScriptProperties().getProperty("FIELD_CONFIG");
  let stored = {};
  if (raw) {
    try { stored = JSON.parse(raw); } catch (e) { stored = {}; }
  }
  const result = {};
  Object.keys(ALL_BUILTIN_FIELDS).forEach((key, index) => {
    const s = stored[key] || {};
    result[key] = {
      enabled: typeof s.enabled === "boolean" ? s.enabled : true,
      required: typeof s.required === "boolean" ? s.required : ALL_BUILTIN_FIELDS[key].defaultRequired,
      // Drag-and-drop order within a section, from the "🧩 حقول الاستمارة"
      // card — defaults to registry order the first time (before anyone's
      // ever dragged anything), so ordering degrades gracefully to "however
      // they were defined" rather than a random/undefined order.
      order: typeof s.order === "number" ? s.order : index,
    };
  });
  return result;
}

// action=saveFieldConfig — admin toggles which fields are shown on the form
// and which are required (payload.fields), and/or replaces the whole list
// of admin-defined custom fields (payload.customFields), from the
// "🧩 حقول الاستمارة" settings card. Sending fields without customFields (or
// vice versa) only touches the one that was sent.
function handleSaveFieldConfig_(payload) {
  const incoming = payload.fields || {};
  const sanitized = {};
  Object.keys(ALL_BUILTIN_FIELDS).forEach((key, index) => {
    const f = incoming[key] || {};
    sanitized[key] = {
      enabled: f.enabled !== false,   // default true unless explicitly turned off
      required: f.required === true,  // default false unless explicitly turned on
      order: typeof f.order === "number" ? f.order : index,
    };
  });
  PropertiesService.getScriptProperties().setProperty("FIELD_CONFIG", JSON.stringify(sanitized));

  let customFields = getCustomFields_();
  if (Array.isArray(payload.customFields)) {
    customFields = payload.customFields.map(sanitizeCustomField_).filter(Boolean);
    // Custom fields also carry their own drag order (index in the array the
    // dashboard sends = the order the admin arranged them in).
    customFields.forEach((cf, i) => { cf.order = i; });
    saveCustomFields_(customFields);
  }
  return jsonOutput_({ status: "success", fieldConfig: sanitized, customFields });
}

// ---------------------------------------------------------------------------
// Custom fields — admin-defined, unlimited, no code changes needed. Unlike
// the built-in fields above, these don't get their own sheet column each
// (see CUSTOM_FIELDS_HEADER) — their answers are stored as one JSON blob per
// registrant. Reference them in a certificate template as {{key}}, e.g.
// {{c_1a2b3c}} — the exact key is shown next to each custom field in the
// dashboard's "🧩 حقول الاستمارة" card after you add it.
// ---------------------------------------------------------------------------

function getCustomFields_() {
  const raw = PropertiesService.getScriptProperties().getProperty("CUSTOM_FIELDS");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveCustomFields_(fields) {
  PropertiesService.getScriptProperties().setProperty("CUSTOM_FIELDS", JSON.stringify(fields));
}

const CUSTOM_FIELD_TYPES = ["text", "textarea", "number", "date", "select", "checkbox"];

// Forces an incoming {label, type, options, required, enabled, key} object
// into a trusted shape. Existing custom fields keep their original `key`
// (passed back by the dashboard) so certificate placeholders referencing
// them don't silently break when you just tweak the label or required flag.
function sanitizeCustomField_(cf) {
  const label = String((cf && cf.label) || "").trim();
  if (!label) return null;
  const type = CUSTOM_FIELD_TYPES.indexOf(cf.type) > -1 ? cf.type : "text";
  const key = (cf && cf.key && /^c_[a-z0-9]+$/.test(cf.key)) ? cf.key : "c_" + Utilities.getUuid().replace(/-/g, "").slice(0, 8);
  const out = {
    key,
    label,
    type,
    required: cf.required === true,
    enabled: cf.enabled !== false,
  };
  if (type === "select") {
    out.options = Array.isArray(cf.options)
      ? cf.options.map(String).map(s => s.trim()).filter(Boolean)
      : String(cf.options || "").split(",").map(s => s.trim()).filter(Boolean);
  }
  return out;
}

function handlePublicConfig_() {
  const cfg = getRegConfig_();
  const phase = getRegPhase_(cfg); // "before" | "open" | "closed"
  return jsonOutput_({
    status: "success",
    formTitle: cfg.formTitle,
    logoUrl: cfg.logoUrl,
    startAt: cfg.startAt,
    endAt: cfg.endAt,
    phase,
    fieldConfig: cfg.fieldConfig,
    fieldDefs: cfg.fieldDefs,
    fieldSections: cfg.fieldSections,
    customFields: cfg.customFields,
    serverNow: new Date().toISOString(),
  });
}

// action=getConfig  (owner only — prefills the Settings tab in the dashboard)
function handleGetConfig_(e) {
  if (!requirePermission_(e.parameter.password || "", "manageSettings")) {
    return jsonOutput_({ status: "error", message: "Unauthorized" });
  }
  return jsonOutput_({ status: "success", config: getRegConfig_() });
}

// action=listCycles  (anyone logged in — lets the dashboard switch which
// sheet/cycle's data it's showing; viewing a cycle only needs viewData)
function handleListCycles_(e) {
  if (!requirePermission_(e.parameter.password || "", "viewData")) {
    return jsonOutput_({ status: "error", message: "Unauthorized" });
  }
  const cfg = getRegConfig_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets().map(sh => ({
    name: sh.getName(),
    rows: Math.max(0, sh.getLastRow() - 1),
    isActive: sh.getName() === cfg.activeSheetName,
  }));
  return jsonOutput_({ status: "success", sheets, activeSheetName: cfg.activeSheetName });
}

// action=diagnostics  (owner only) — runs a handful of read-only checks and
// reports exactly what's working and what isn't, instead of you having to
// guess from a generic "error" message. Open ?action=diagnostics&password=...
// directly in a browser, or use the "🩺 تشخيص" button in the dashboard.
function handleDiagnostics_(e) {
  if (!requirePermission_(e.parameter.password || "", "manageSettings")) {
    return jsonOutput_({ status: "error", message: "Unauthorized" });
  }

  const report = {};

  // 1) Deployed code version marker — bump CODE_VERSION at the top of this
  //    file (or just eyeball this string) to confirm the web app is actually
  //    running the version you last pasted in, and not a stale deployment.
  report.codeVersion = typeof CODE_VERSION !== "undefined" ? CODE_VERSION : "(CODE_VERSION not set)";

  // 2) Admin accounts configured?
  report.adminAccounts = getAdminAccounts_().map(a => ({ name: a.name, role: a.role, permissions: a.permissions }));

  // 3) Script timezone (affects {{date}} / {{registrationDate}} on certificates)
  try { report.scriptTimeZone = Session.getScriptTimeZone(); }
  catch (err) { report.scriptTimeZone = "خطأ: " + String(err); }

  // 4) Active sheet reachable?
  try {
    const cfg = getRegConfig_();
    report.activeSheetName = cfg.activeSheetName;
    const sheet = findSheet_(cfg.activeSheetName);
    report.activeSheetFound = !!sheet;
    report.fieldConfig = cfg.fieldConfig;
    report.sendCertAuto = cfg.sendCertAuto;
    report.certTemplateReady = cfg.certTemplateReady;
  } catch (err) {
    report.sheetCheckError = String(err);
  }

  // 5) MailApp — remaining daily quota. If this is 0, that's exactly why
  //    emails (confirmation AND certificate) silently stop sending — Gmail
  //    accounts get ~100/day, more with Google Workspace.
  try { report.mailRemainingQuota = MailApp.getRemainingDailyQuota(); }
  catch (err) { report.mailQuotaError = String(err); }

  // 6) Drive API advanced service — required for certificate template
  //    upload/conversion. If this errors, go enable it: Apps Script editor ▸
  //    Services ▸ + ▸ Drive API (see BACKEND_SETUP_STEPS.md section 11-أ).
  try {
    if (typeof Drive === "undefined") {
      report.driveApiAdvancedService = "غير مفعّلة — روح فعّلها من Services جوه محرر الكود (Drive API).";
    } else {
      Drive.About.get({ fields: "user" }); // v3 requires an explicit `fields` param — trivial read-only call just to confirm the service works
      report.driveApiAdvancedService = "شغالة ✓";
    }
  } catch (err) {
    report.driveApiAdvancedService = "مفعّلة بس بترمي خطأ: " + String(err);
  }

  // 7) DocumentApp OAuth scope — separate from "Drive API advanced service"
  //    above. generateCertificatePdf_() calls DocumentApp.openById() to fill
  //    in the template, which needs the documents scope. Enabling the Drive
  //    advanced service switches this project to an EXPLICIT scope list in
  //    its manifest (appsscript.json) instead of auto-detecting scopes from
  //    your code — so the documents scope can go missing even though
  //    everything else (template upload, mail quota) reports fine. If this
  //    fails, see "لو الشهادة التجريبية بترجع Exception: ليس لديك إذن..." in
  //    BACKEND_SETUP_STEPS.md.
  try {
    const tempDoc = DocumentApp.create("dys-diagnostics-scope-check-temp");
    DriveApp.getFileById(tempDoc.getId()).setTrashed(true);
    report.documentAppScope = "شغالة ✓";
  } catch (err) {
    report.documentAppScope = "بترمي خطأ: " + String(err) +
      " — لازم تضيف https://www.googleapis.com/auth/documents لـ oauthScopes في appsscript.json وتعيد الموافقة (شوف قسم الشهادات في BACKEND_SETUP_STEPS.md).";
  }

  return jsonOutput_({ status: "success", report });
}


// ---------------------------------------------------------------------------
// doPost  (form submission)
// ---------------------------------------------------------------------------

// Uploads a registrant's personal photo (payload.photoBase64, a data: URI
// or raw base64 string sent by the form after client-side resizing) to a
// dedicated "DYS - صور المسجلين" Drive folder, and returns a public
// view-only URL — or "" on any failure (a broken photo upload must never
// block someone's registration, so this is best-effort and swallows errors).
function uploadRegistrationPhoto_(photoBase64) {
  if (!photoBase64) return "";
  try {
    const raw = String(photoBase64);
    const commaIdx = raw.indexOf(",");
    const base64 = commaIdx > -1 && raw.slice(0, commaIdx).indexOf("base64") > -1 ? raw.slice(commaIdx + 1) : raw;
    const mimeMatch = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64/);
    const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
    const bytes = Utilities.base64Decode(base64);
    const blob = Utilities.newBlob(bytes, mimeType, "photo-" + new Date().getTime() + ".jpg");

    const folder = getOrCreatePhotosFolder_();
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return "https://drive.google.com/uc?export=view&id=" + file.getId();
  } catch (err) {
    return "";
  }
}

function getOrCreatePhotosFolder_() {
  const FOLDER_NAME = "DYS - صور المسجلين";
  const existing = DriveApp.getFoldersByName(FOLDER_NAME);
  if (existing.hasNext()) return existing.next();
  return DriveApp.createFolder(FOLDER_NAME);
}

function handleSubmit_(payload) {
  // ---- 1) anti-bot checks (mirrors the frontend's own honeypot + timing check) ----
  if (payload.website) { // honeypot field — a real user never fills this in
    return jsonOutput_({ status: "error", message: "Rejected" });
  }
  const elapsed = Date.now() - Number(payload.loadedAt || 0);
  if (!payload.loadedAt || isNaN(elapsed) || elapsed < MIN_FILL_MS) {
    return jsonOutput_({ status: "error", message: "Submitted too fast" });
  }

  // ---- 2) is registration currently open? ----
  const cfg = getRegConfig_();
  const phase = getRegPhase_(cfg);
  if (phase !== "open") {
    return jsonOutput_({
      status: phase === "before" ? "not_started" : "closed",
      startAt: cfg.startAt,
      endAt: cfg.endAt,
    });
  }

  // ---- 3) validate every field server-side — never trust the client alone ----
  const errors = validatePayload_(payload);
  if (errors.length) {
    return jsonOutput_({ status: "error", message: errors.join(" | ") });
  }

  const nationalId = String(payload.nationalId).trim();

  // ---- 4) duplicate guard (uses a lock so two near-simultaneous submits
  //         of the same ID can't both slip through) ----
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (isDuplicateNid_(nationalId)) {
      return jsonOutput_({ status: "duplicate" });
    }

    // ---- 5) generate membership number + append the row ----
    const membershipNo = generateMembershipNumber_();
    const fc = getFieldConfig_();
    if (fc.photo && fc.photo.enabled && payload.photoBase64) {
      payload.photoUrl = uploadRegistrationPhoto_(payload.photoBase64);
    }
    const sheet = getSheet_();
    sheet.appendRow(buildRow_(payload, membershipNo));

    // ---- 6) confirmation email (best-effort — never fails the submission) ----
    let emailSent = false;
    const validEmail = payload.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email.trim());
    if (validEmail) {
      emailSent = sendConfirmationEmail_(payload, membershipNo);
    }

    // ---- 7) certificate email (best-effort, only if auto-send is turned on
    //         from the dashboard AND a certificate template is uploaded) ----
    let certificateSent = false;
    if (validEmail && cfg.sendCertAuto && cfg.certTemplateReady) {
      certificateSent = sendCertificateEmail_(payload, membershipNo);
    }

    return jsonOutput_({ status: "success", membershipNo, emailSent, certificateSent });
  } finally {
    lock.releaseLock();
  }
}


// ---------------------------------------------------------------------------
// Validation — mirrors the frontend's validators[] exactly (dys_form.html)
// ---------------------------------------------------------------------------

function validatePayload_(p) {
  const errors = [];
  const str = (v) => String(v || "").trim();
  const fc = getFieldConfig_();
  const isOn = (key) => fc[key] ? fc[key].enabled : true;
  const isReq = (key) => fc[key] ? fc[key].required : true;

  // Name + National ID are always required — the whole duplicate-check and
  // membership system depends on them, so they're not part of TOGGLEABLE_FIELDS.
  if (str(p.name).length < 3) errors.push("name");
  if (!isValidEgyptianNationalId_(str(p.nationalId))) errors.push("nationalId");

  if (isOn("age")) {
    const v = str(p.age);
    if (isReq("age") || v !== "") {
      const age = Number(v);
      if (!/^[0-9]{1,2}$/.test(v) || age <= 0 || age >= 100) errors.push("age");
    }
  }

  if (isOn("gender")) {
    if (isReq("gender") || p.gender) {
      if (!["Male", "Female"].includes(p.gender)) errors.push("gender");
    }
  }

  if (isOn("phone")) {
    const v = str(p.phone);
    if (isReq("phone") || v !== "") {
      if (!/^01[0125][0-9]{8}$/.test(v)) errors.push("phone");
    }
  }

  if (isOn("whatsapp")) {
    const v = str(p.whatsapp);
    if (isReq("whatsapp") || v !== "") {
      if (!/^01[0125][0-9]{8}$/.test(v)) errors.push("whatsapp");
    }
  }

  if (isOn("email")) {
    const v = str(p.email);
    if (isReq("email") && v === "") errors.push("email");
    else if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) errors.push("email");
  }

  if (isOn("faculty")) {
    const v = str(p.faculty);
    if (isReq("faculty") || v !== "") {
      if (v.length < 2) errors.push("faculty");
    }
  }

  if (isOn("graduate")) {
    if (isReq("graduate") || p.graduate) {
      if (!["Yes", "No"].includes(p.graduate)) errors.push("graduate");
    }
  }

  if (isOn("committee")) {
    const v = str(p.committee);
    if (isReq("committee") || v !== "") {
      if (v.length < 1) errors.push("committee");
    }
  }

  if (isOn("hasJob")) {
    if (isReq("hasJob") || p.hasJob) {
      if (!["Yes", "No"].includes(p.hasJob)) errors.push("hasJob");
    }
  }

  // Generic validation for the newer EXTRA_FIELDS (address, birthDate,
  // maritalStatus, ...) — unlike the hand-written checks above, these are
  // all driven purely by `type` (see EXTRA_FIELDS at the top of the file).
  Object.keys(EXTRA_FIELDS).forEach(key => {
    if (!isOn(key)) return;
    const def = EXTRA_FIELDS[key];
    const v = str(p[key]);
    if (v === "") {
      if (isReq(key)) errors.push(key);
      return;
    }
    if (def.type === "select" && def.options && def.options.indexOf(p[key]) === -1) errors.push(key);
    if (def.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push(key);
    if (def.type === "checkbox" && ["Yes", "No"].indexOf(v) === -1) errors.push(key);
  });

  // Admin-defined custom fields — payload.customFields is {key: value, ...}.
  getCustomFields_().forEach(cf => {
    if (!cf.enabled) return;
    const v = str((p.customFields || {})[cf.key]);
    if (v === "") {
      if (cf.required) errors.push(cf.key);
      return;
    }
    if (cf.type === "select" && cf.options && cf.options.indexOf(v) === -1) errors.push(cf.key);
  });

  // Photo — just a presence check here (payload.photoBase64 non-empty).
  // The actual upload/failure handling happens later in handleSubmit_ and
  // never blocks the registration even if it fails.
  if (isOn("photo") && isReq("photo") && !p.photoBase64) {
    errors.push("photo");
  }

  return errors;
}

// Same structural check the frontend does client-side (century digit, valid
// month/day, valid governorate code, plausible age) — see extractNationalIdInfo()
// in dys_form.html for the reference implementation this mirrors.
function isValidEgyptianNationalId_(id) {
  if (!/^[0-9]{14}$/.test(id)) return false;

  const centuryDigit = id[0];
  const centuryMap = { "2": 1900, "3": 2000 };
  if (!(centuryDigit in centuryMap)) return false;

  const yy = parseInt(id.slice(1, 3), 10);
  const mm = parseInt(id.slice(3, 5), 10);
  const dd = parseInt(id.slice(5, 7), 10);
  const govCode = id.slice(7, 9);

  const validGovCodes = ["01","02","03","04","11","12","13","14","15","16","17","18",
    "19","21","22","23","24","25","26","27","28","29","31","32","33","34","35","88"];
  if (!validGovCodes.includes(govCode)) return false;

  if (mm < 1 || mm > 12) return false;
  const birthYear = centuryMap[centuryDigit] + yy;
  const daysInMonth = new Date(birthYear, mm, 0).getDate();
  if (dd < 1 || dd > daysInMonth) return false;

  const now = new Date();
  let age = now.getFullYear() - birthYear;
  if (now.getMonth() + 1 < mm || (now.getMonth() + 1 === mm && now.getDate() < dd)) age--;
  if (age < 0 || age > 110) return false;

  return true;
}


// ---------------------------------------------------------------------------
// Registration window / cycle config
// ---------------------------------------------------------------------------
// Stored entirely in Script Properties (not in this source file), so the
// dashboard's Settings tab can change everything without ever touching code.
//
//   FORM_TITLE        — shown as the form's page title (falls back to the
//                        form's own default text if left empty)
//   SHEET_BASE_NAME    — the "base" tab name each new cycle is built from
//   REG_START/REG_END  — ISO datetime strings, or "" for "no limit"
//   ACTIVE_SHEET_NAME   — the tab the form is CURRENTLY writing into
//   CYCLE_NUMBER        — how many cycles/sheets have been created so far
//   LOGO_URL/LOGO_FILE_ID — the uploaded logo image, stored in Drive

function getRegConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    formTitle: props.getProperty("FORM_TITLE") || "",
    sheetBaseName: props.getProperty("SHEET_BASE_NAME") || SHEET_NAME,
    startAt: props.getProperty("REG_START") || "",
    endAt: props.getProperty("REG_END") || "",
    activeSheetName: props.getProperty("ACTIVE_SHEET_NAME") || SHEET_NAME,
    cycleNumber: Number(props.getProperty("CYCLE_NUMBER") || "0"),
    logoUrl: (() => {
      const fileId = props.getProperty("LOGO_FILE_ID");
      return fileId ? logoUrlFromFileId_(fileId) : "";
    })(),
    sendCertAuto: props.getProperty("CERT_AUTO_SEND") === "true",
    certTemplateReady: !!props.getProperty("CERT_TEMPLATE_FILE_ID"),
    certTemplateName: props.getProperty("CERT_TEMPLATE_NAME") || "",
    fieldConfig: getFieldConfig_(),
    fieldDefs: buildFieldDefsForClient_(),
    fieldSections: FIELD_SECTIONS,
    customFields: getCustomFields_(),
  };
}

// The original 9 toggleable fields already have their own hand-built HTML on
// the form (radio pills, national-ID auto-detect, etc.) so they're NOT part
// of this — this only describes the newer EXTRA_FIELDS, which the form
// renders generically from this metadata (see buildDynamicStep_ in
// dys_form.html). Sent to both the dashboard (to build the checkboxes) and
// the public form (to build the extra-fields step).
function buildFieldDefsForClient_() {
  const defs = {};
  Object.keys(EXTRA_FIELDS).forEach(key => {
    const f = EXTRA_FIELDS[key];
    defs[key] = { section: f.section, label: f.label, type: f.type, options: f.options || null };
  });
  defs.photo = { section: PHOTO_FIELD.section, label: PHOTO_FIELD.label, type: PHOTO_FIELD.type, options: null };
  return defs;
}

// "before"  → now is earlier than startAt (registration hasn't opened yet)
// "closed"  → now is later than endAt (registration window is over)
// "open"    → anything else, including when no dates are configured at all
//             (keeps old deployments working exactly as before by default)
function getRegPhase_(cfg) {
  const now = Date.now();
  const start = cfg.startAt ? Date.parse(cfg.startAt) : NaN;
  const end = cfg.endAt ? Date.parse(cfg.endAt) : NaN;
  if (!isNaN(start) && now < start) return "before";
  if (!isNaN(end) && now > end) return "closed";
  return "open";
}

// Dispatches the password-protected admin actions sent via doPost. Each
// action requires ONE specific permission (not a blanket "owner" gate any
// more) — an account only needs to be granted the capability that matches
// what it's trying to do. See PERMISSION_KEYS at the top of the file for
// the full list of grantable capabilities.
// ---------------------------------------------------------------------------
// Activity log — a lightweight audit trail of every admin action, who did
// it, and when. Lives in its own "Activity Log" sheet tab (separate from
// the registration-data cycles), created automatically on first use.
// Logging failures are swallowed — an audit trail must never be the reason
// a real action fails.
// ---------------------------------------------------------------------------

const ACTIVITY_LOG_SHEET_NAME = "Activity Log";
const ACTIVITY_LOG_MAX_ROWS = 500; // trims oldest entries past this so the sheet never grows unbounded

function logActivity_(accountName, action, details) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let log = ss.getSheetByName(ACTIVITY_LOG_SHEET_NAME);
    if (!log) {
      log = ss.insertSheet(ACTIVITY_LOG_SHEET_NAME);
      log.appendRow(["Timestamp", "Account", "Action", "Details"]);
      log.setFrozenRows(1);
    }
    log.appendRow([new Date(), accountName || "?", action || "", details || ""]);

    const lastRow = log.getLastRow();
    if (lastRow > ACTIVITY_LOG_MAX_ROWS + 1) {
      log.deleteRows(2, lastRow - ACTIVITY_LOG_MAX_ROWS - 1);
    }
  } catch (err) {
    // logging must never break the actual action
  }
}

// Human-readable one-line summary per action, shown in the "📜 سجل النشاط"
// dashboard card — kept separate from the raw payload so nothing sensitive
// (like a newly-set password) ever ends up in the log.
function describeActionForLog_(payload) {
  switch (payload.action) {
    case "saveConfig": return "عدّل إعدادات الاستمارة العامة";
    case "uploadLogo": return "رفع شعار جديد";
    case "removeLogo": return "شال الشعار";
    case "uploadCertTemplate": return `رفع تيمبلت شهادة: ${payload.fileName || ""}`;
    case "removeCertTemplate": return "شال تيمبلت الشهادة";
    case "sendCertificate": return `بعت شهادة لسجل واحد (${payload.membershipNo || payload.rowIndex || ""})`;
    case "sendCertificatesBulk": return "بعت شهادات لدفعة من الأعضاء";
    case "sendTestCertificate": return `بعت شهادة تجريبية لـ ${payload.testEmail || ""}`;
    case "saveFieldConfig": return "عدّل إعدادات حقول الاستمارة";
    case "listAdminAccounts": return "شاف قائمة الحسابات";
    case "addAdminAccount": return `أضاف/عدّل حساب: ${payload.name || ""}`;
    case "removeAdminAccount": return `حذف حساب: ${payload.name || ""}`;
    case "exportExcel": return "صدّر البيانات لملف Excel";
    default: return payload.action || "";
  }
}

// action=getActivityLog — returns the most recent N entries, newest first.
function handleGetActivityLog_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const log = ss.getSheetByName(ACTIVITY_LOG_SHEET_NAME);
  if (!log || log.getLastRow() < 2) return jsonOutput_({ status: "success", entries: [] });
  const data = log.getRange(2, 1, log.getLastRow() - 1, 4).getValues();
  const entries = data.map(row => ({
    timestamp: row[0] instanceof Date ? row[0].toISOString() : String(row[0] || ""),
    account: row[1],
    action: row[2],
    details: row[3],
  })).reverse();
  return jsonOutput_({ status: "success", entries });
}

// action=exportExcel — payload: {sheetName}. Formats the sheet's header row
// (bold, colored, frozen) and column widths, then exports it as a real
// .xlsx file (returned as base64 for the dashboard to trigger a download —
// Apps Script web apps can't just hand back a raw file download).
// Requires the "script.external_request" OAuth scope (same one QR codes
// need) since exporting goes through a UrlFetchApp call — see
// BACKEND_SETUP_STEPS.md if this throws an authorization error.
function handleExportExcel_(payload) {
  try {
    const sheetName = String(payload.sheetName || "").trim() || getActiveSheetName_();
    const sheet = findSheet_(sheetName);
    if (!sheet) return jsonOutput_({ status: "error", message: `الشيت "${sheetName}" مش موجود.` });

    formatSheetForExport_(sheet);

    const ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
    const gid = sheet.getSheetId();
    const url = `https://docs.google.com/spreadsheets/d/${ssId}/export?format=xlsx&gid=${gid}`;
    const token = ScriptApp.getOAuthToken();
    const resp = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      return jsonOutput_({ status: "error", message: "فشل التصدير — كود الاستجابة: " + resp.getResponseCode() });
    }
    const blob = resp.getBlob().setName(sheetName + ".xlsx");
    const fileBase64 = Utilities.base64Encode(blob.getBytes());
    return jsonOutput_({ status: "success", fileName: blob.getName(), fileBase64 });
  } catch (err) {
    return jsonOutput_({
      status: "error",
      message: "فشل تصدير Excel: " + String(err) +
        " — تأكد إنك مضيف صلاحية script.external_request في appsscript.json (شوف BACKEND_SETUP_STEPS.md).",
    });
  }
}

// Bold white-on-green header row + frozen row + auto-sized columns — a
// modest but real formatting pass so the exported file looks intentional
// instead of like a raw data dump.
function formatSheetForExport_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return;
  sheet.getRange(1, 1, 1, lastCol)
    .setFontWeight("bold")
    .setBackground("#1F6B3A")
    .setFontColor("#FFFFFF");
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, lastCol);
}


const ACTION_PERMISSIONS = {
  saveConfig: "manageSettings",
  uploadLogo: "manageSettings",
  removeLogo: "manageSettings",
  uploadCertTemplate: "manageCertificates",
  removeCertTemplate: "manageCertificates",
  sendCertificate: "manageCertificates",
  sendCertificatesBulk: "manageCertificates",
  sendTestCertificate: "manageCertificates",
  saveFieldConfig: "manageFields",
  listAdminAccounts: "manageAccounts",
  addAdminAccount: "manageAccounts",
  removeAdminAccount: "manageAccounts",
  exportExcel: "manageSettings",
  getActivityLog: "manageSettings",
};

function handleAdminAction_(payload) {
  const requiredPermission = ACTION_PERMISSIONS[payload.action];
  if (!requiredPermission) return jsonOutput_({ status: "error", message: "Unknown admin action" });

  const account = requirePermission_(payload.password || "", requiredPermission);
  if (!account) {
    return jsonOutput_({ status: "error", message: "Unauthorized" });
  }
  if (payload.action === "saveConfig") return logAndReturn_(account, payload, handleSaveConfig_(payload));
  if (payload.action === "uploadLogo") return logAndReturn_(account, payload, handleUploadLogo_(payload));
  if (payload.action === "removeLogo") return logAndReturn_(account, payload, handleRemoveLogo_());
  if (payload.action === "uploadCertTemplate") return logAndReturn_(account, payload, handleUploadCertTemplate_(payload));
  if (payload.action === "removeCertTemplate") return logAndReturn_(account, payload, handleRemoveCertTemplate_());
  if (payload.action === "sendCertificate") return logAndReturn_(account, payload, handleSendCertificate_(payload));
  if (payload.action === "sendCertificatesBulk") return logAndReturn_(account, payload, handleSendCertificatesBulk_(payload));
  if (payload.action === "sendTestCertificate") return logAndReturn_(account, payload, handleSendTestCertificate_(payload));
  if (payload.action === "saveFieldConfig") return logAndReturn_(account, payload, handleSaveFieldConfig_(payload));
  if (payload.action === "listAdminAccounts") return handleListAdminAccounts_(); // read-only, not logged — keeps the log focused on actual changes
  if (payload.action === "addAdminAccount") return logAndReturn_(account, payload, handleAddAdminAccount_(payload));
  if (payload.action === "removeAdminAccount") return logAndReturn_(account, payload, handleRemoveAdminAccount_(payload));
  if (payload.action === "exportExcel") return logAndReturn_(account, payload, handleExportExcel_(payload));
  if (payload.action === "getActivityLog") return handleGetActivityLog_(); // read-only, not logged
  return jsonOutput_({ status: "error", message: "Unknown admin action" });
}

// Logs the action (skips logging if the handler itself reported an error —
// failed attempts aren't useful audit history the way successful changes
// are) and passes the handler's own response straight through unchanged.
function logAndReturn_(account, payload, response) {
  try {
    const parsed = JSON.parse(response.getContent());
    if (parsed.status === "success") {
      logActivity_(account.name, payload.action, describeActionForLog_(payload));
    }
  } catch (e) { /* if we can't tell whether it succeeded, don't log a guess */ }
  return response;
}

// Strips passwords for anything sent back to the dashboard.
function publicAccount_(a) {
  return { name: a.name, role: a.role, permissions: a.permissions };
}

// action=listAdminAccounts — names + permissions only, NEVER passwords.
function handleListAdminAccounts_() {
  const accounts = getAdminAccounts_().map(publicAccount_);
  return jsonOutput_({ status: "success", accounts });
}

// action=addAdminAccount — payload: {name, password, permissions: {manageSettings,
// manageFields, manageCertificates, manageAccounts}}. Adding an account with
// a name that already exists overwrites that account (lets you change
// someone's password/permissions without a separate "edit" action).
function handleAddAdminAccount_(payload) {
  const name = String(payload.name || "").trim();
  const password = String(payload.password || "").trim();
  const permissions = sanitizePermissions_(payload.permissions);
  if (!name || !password) {
    return jsonOutput_({ status: "error", message: "لازم اسم وكلمة سر." });
  }
  if (password.length < 4) {
    return jsonOutput_({ status: "error", message: "كلمة السر قصيرة أوي — اكتب حاجة أطول." });
  }
  const accounts = getAdminAccounts_().filter(a => a.name !== name);
  accounts.push({ name, password, permissions });
  saveAdminAccounts_(accounts);
  return jsonOutput_({ status: "success", accounts: accounts.map(publicAccount_) });
}

// action=removeAdminAccount — payload: {name}. Refuses to remove the last
// remaining account that can manage accounts, so you can never lock
// everyone out of the "👥 حسابات الدخول" card entirely.
function handleRemoveAdminAccount_(payload) {
  const name = String(payload.name || "").trim();
  const accounts = getAdminAccounts_();
  const target = accounts.find(a => a.name === name);
  if (!target) return jsonOutput_({ status: "error", message: "الحساب ده مش موجود." });

  const managerCount = accounts.filter(a => a.permissions.manageAccounts).length;
  if (target.permissions.manageAccounts && managerCount <= 1) {
    return jsonOutput_({ status: "error", message: "ده آخر حساب معاه صلاحية إدارة الحسابات — مينفعش تمسحه عشان متتقفلش برة النظام." });
  }

  const remaining = accounts.filter(a => a.name !== name);
  saveAdminAccounts_(remaining);
  return jsonOutput_({ status: "success", accounts: remaining.map(publicAccount_) });
}

// Forces an arbitrary incoming permissions object into exactly the shape we
// trust: every key in PERMISSION_KEYS explicitly true/false, nothing else.
function sanitizePermissions_(incoming) {
  const src = incoming || {};
  const out = {};
  PERMISSION_KEYS.forEach(key => { out[key] = src[key] === true; });
  return out;
}

// Saves form title / sheet base name / registration window, and — only if
// asked to (startNewCycle: true), or if there's no active sheet at all yet —
// creates a brand-new sheet tab and switches the form to write into it.
// This is exactly the "open the form again → it registers into a new Google
// Sheet automatically" behaviour: each cycle gets its own tab, nothing from
// a previous cycle is ever touched or overwritten.
function handleSaveConfig_(payload) {
  const props = PropertiesService.getScriptProperties();

  const formTitle = String(payload.formTitle || "").trim();
  const sheetBaseName = String(payload.sheetBaseName || "").trim();
  const startAt = String(payload.startAt || "").trim();
  const endAt = String(payload.endAt || "").trim();

  props.setProperty("FORM_TITLE", formTitle);
  if (sheetBaseName) props.setProperty("SHEET_BASE_NAME", sheetBaseName);
  props.setProperty("REG_START", startAt);
  props.setProperty("REG_END", endAt);
  // "sendCertAuto" only arrives when the dashboard sends it (see collectConfigPayload
  // in dys_dashboard.html) — if payload doesn't include the key at all we leave the
  // stored value untouched, but the dashboard always sends it explicitly, so this
  // simply mirrors whatever the toggle in Settings was set to.
  if (typeof payload.sendCertAuto !== "undefined") {
    props.setProperty("CERT_AUTO_SEND", payload.sendCertAuto ? "true" : "false");
  }

  let activeSheetName = props.getProperty("ACTIVE_SHEET_NAME") || "";

  if (payload.startNewCycle || !activeSheetName) {
    activeSheetName = startNewCycle_(sheetBaseName || props.getProperty("SHEET_BASE_NAME") || SHEET_NAME);
  }

  return jsonOutput_({ status: "success", config: getRegConfig_() });
}

// Creates a new sheet tab named after the base name (first cycle keeps the
// base name as-is, later cycles get " 2", " 3", ... appended so the name
// stays readable), sets it as the ACTIVE sheet, and bumps CYCLE_NUMBER.
function startNewCycle_(base) {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let cycle = Number(props.getProperty("CYCLE_NUMBER") || "0") + 1;
  let candidate = cycle === 1 ? base : `${base} ${cycle}`;
  while (ss.getSheetByName(candidate)) {
    cycle += 1;
    candidate = `${base} ${cycle}`;
  }

  const sheet = ss.insertSheet(candidate);
  sheet.appendRow(HEADERS);
  sheet.setFrozenRows(1);

  props.setProperty("CYCLE_NUMBER", String(cycle));
  props.setProperty("ACTIVE_SHEET_NAME", candidate);
  props.setProperty("SHEET_BASE_NAME", base);

  return candidate;
}

// Decodes a base64 image sent from the dashboard's Settings tab, stores it
// in Google Drive (shared "anyone with the link can view" so the public
// form can display it), and remembers its URL. The previous logo file (if
// any) is trashed so you don't end up with a pile of old images in Drive.
function handleUploadLogo_(payload) {
  try {
    const raw = String(payload.imageBase64 || "");
    const commaIdx = raw.indexOf(",");
    const base64 = commaIdx > -1 && raw.slice(0, commaIdx).indexOf("base64") > -1 ? raw.slice(commaIdx + 1) : raw;
    const mimeType = payload.mimeType || "image/png";
    const bytes = Utilities.base64Decode(base64);
    const blob = Utilities.newBlob(bytes, mimeType, payload.fileName || "dys-form-logo");

    const props = PropertiesService.getScriptProperties();
    const oldFileId = props.getProperty("LOGO_FILE_ID");
    if (oldFileId) {
      try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (e2) { /* already gone — fine */ }
    }

    const file = DriveApp.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const fileId = file.getId();

    props.setProperty("LOGO_FILE_ID", fileId);
    props.deleteProperty("LOGO_URL"); // legacy key — URL is now always derived from LOGO_FILE_ID, see logoUrlFromFileId_()

    return jsonOutput_({ status: "success", logoUrl: logoUrlFromFileId_(fileId) });
  } catch (err) {
    return jsonOutput_({ status: "error", message: String(err) });
  }
}

// `drive.google.com/uc?export=view&id=...` (the old format this used to
// generate) is Google's classic direct-file link, but it's unreliable for
// hotlinking as an <img src> — it can silently break, get rate-limited, or
// redirect to a "can't scan for viruses" interstitial instead of the image.
// `drive.google.com/thumbnail?id=...` is the endpoint Drive itself uses for
// image previews and is far more reliable for this use case.
function logoUrlFromFileId_(fileId) {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`;
}

// Removes the custom logo — the form falls back to its built-in badge.
function handleRemoveLogo_() {
  const props = PropertiesService.getScriptProperties();
  const oldFileId = props.getProperty("LOGO_FILE_ID");
  if (oldFileId) {
    try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (e2) { /* already gone — fine */ }
  }
  props.deleteProperty("LOGO_FILE_ID");
  props.deleteProperty("LOGO_URL");
  return jsonOutput_({ status: "success" });
}


// ---------------------------------------------------------------------------
// Certificates (PDF, generated from an uploaded Word template on each send)
// ---------------------------------------------------------------------------
// How it works:
//   1. You upload a .docx certificate template from the dashboard's Settings
//      tab. It gets converted to a Google Doc and stored in Drive — this
//      conversion is what lets us fill it in and export a PDF later.
//   2. Anywhere in the template text, you type placeholders like {{name}}
//      or {{membershipNo}} — see PLACEHOLDER FIELDS below for the full list.
//      They can be anywhere: inside a text box, a table cell, styled with
//      any font/color you want — replaceText() finds them regardless.
//   3. When a certificate needs to be sent, we duplicate the template,
//      swap in the real values, export that copy as a PDF, email it, then
//      delete the temporary copy (your original template is never touched).
//
// PLACEHOLDER FIELDS you can use inside the template — matches every column
// in the registration sheet, so you decide which ones actually appear on the
// certificate and where:
//   {{name}}             — الاسم
//   {{membershipNo}}      — رقم العضوية (DYS-000123)
//   {{age}}               — السن
//   {{gender}}            — النوع (Male/Female)
//   {{nationalId}}        — الرقم القومي
//   {{phone}}             — رقم الهاتف
//   {{whatsapp}}          — رقم الواتساب
//   {{email}}             — الإيميل
//   {{faculty}}           — الكلية
//   {{graduate}}          — خريج ولا لأ (Yes/No)
//   {{role}}              — الدور داخل الكيان
//   {{hasJob}}             — بيشتغل ولا لأ (Yes/No)
//   {{currentJob}}         — الوظيفة الحالية
//   {{registrationDate}}   — تاريخ التسجيل الأصلي (من عمود Timestamp)
//   {{date}}               — تاريخ إرسال الشهادة (بيتحسب لحظة الإرسال، مش وقت التسجيل)
//
//   PLUS: أي حقل من الحقول الإضافية اللي فعّلتها من "🧩 حقول الاستمارة" — مثلاً
//   {{birthDate}}, {{governorate}}, {{tshirtSize}} ... (شوف EXTRA_FIELDS فوق
//   للقائمة الكاملة)، وأي حقل مخصص ضفته بنفسك كـ {{c_xxxxx}} — الكود الدقيق
//   بيتعرض جنب كل حقل مخصص في نفس الكارت لما تضيفه.
//
// ⚠️ Requires the "Drive API" advanced service to be enabled once in this
// project (Apps Script editor ▸ Services ▸ + ▸ Drive API). This is what
// lets a .docx upload be converted into an editable Google Doc — see
// BACKEND_SETUP_STEPS.md for the exact steps.

function handleUploadCertTemplate_(payload) {
  try {
    const raw = String(payload.fileBase64 || "");
    const commaIdx = raw.indexOf(",");
    const base64 = commaIdx > -1 && raw.slice(0, commaIdx).indexOf("base64") > -1 ? raw.slice(commaIdx + 1) : raw;
    const mimeType = payload.mimeType || "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const fileName = payload.fileName || "dys-certificate-template.docx";
    const bytes = Utilities.base64Decode(base64);
    const blob = Utilities.newBlob(bytes, mimeType, fileName);

    const props = PropertiesService.getScriptProperties();
    const oldFileId = props.getProperty("CERT_TEMPLATE_FILE_ID");

    // Convert the uploaded .docx straight into a Google Doc so we can fill
    // it in with replaceText() later. Needs the Drive API advanced service.
    //
    // NOTE: enabling "Drive API" in Apps Script today binds to Drive API v3,
    // not the old v2. In v3, Files.insert() was renamed Files.create(), it
    // takes (requestBody, media) instead of (resource, blob, optionalArgs),
    // "title" became "name", and there's no separate {convert:true} flag —
    // conversion happens automatically because requestBody.mimeType asks for
    // a native Google Workspace format while the uploaded media is .docx.
    const converted = Drive.Files.create(
      { name: fileName.replace(/\.docx$/i, ""), mimeType: MimeType.GOOGLE_DOCS },
      blob
    );

    if (oldFileId) {
      try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (e2) { /* already gone — fine */ }
    }

    props.setProperty("CERT_TEMPLATE_FILE_ID", converted.id);
    props.setProperty("CERT_TEMPLATE_NAME", fileName);

    return jsonOutput_({ status: "success", fileName });
  } catch (err) {
    return jsonOutput_({
      status: "error",
      message: "فشل رفع التيمبلت: " + String(err) +
        " — تأكد إنك فعّلت Drive API من Services جوه محرر الكود (شوف BACKEND_SETUP_STEPS.md).",
    });
  }
}

function handleRemoveCertTemplate_() {
  const props = PropertiesService.getScriptProperties();
  const oldFileId = props.getProperty("CERT_TEMPLATE_FILE_ID");
  if (oldFileId) {
    try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (e2) { /* already gone — fine */ }
  }
  props.deleteProperty("CERT_TEMPLATE_FILE_ID");
  props.deleteProperty("CERT_TEMPLATE_NAME");
  props.setProperty("CERT_AUTO_SEND", "false");
  return jsonOutput_({ status: "success" });
}

// Fills the template with the given field values and returns a PDF blob.
// `fields` keys must match the {{placeholder}} names used in the template.
function generateCertificatePdf_(fields) {
  const templateId = PropertiesService.getScriptProperties().getProperty("CERT_TEMPLATE_FILE_ID");
  if (!templateId) throw new Error("لسه مفيش تيمبلت شهادة متحمل من تبويب الإعدادات.");

  const templateFile = DriveApp.getFileById(templateId);
  if (templateFile.getMimeType() !== MimeType.GOOGLE_DOCS) {
    // The upload step asked Drive to convert the .docx into a Google Doc —
    // if this ever isn't true, the conversion silently didn't happen and
    // DocumentApp.openById() below would fail with a much more confusing
    // error, so catch it here with a clear message instead.
    throw new Error("التيمبلت المحفوظ مش Google Doc (mimeType: " + templateFile.getMimeType() +
      ") — جرب تمسحه وترفعه تاني من تبويب الإعدادات.");
  }

  const copy = templateFile.makeCopy("Certificate - temp - " + new Date().getTime());
  try {
    const doc = DocumentApp.openById(copy.getId());
    const body = doc.getBody();
    Object.keys(fields).forEach(key => {
      body.replaceText("\\{\\{" + key + "\\}\\}", escapeForReplaceText_(fields[key]));
    });

    // {{qrcode}} and {{photo}} are IMAGE placeholders, not text — handled
    // separately after the text substitutions above. A template only needs
    // to contain the token if you actually want that image on it; templates
    // without the token are completely unaffected (findText just finds
    // nothing and insertImagePlaceholder_ silently does nothing).
    if (fields.qrPayload) {
      const qrBlob = fetchQrCodeBlob_(fields.qrPayload);
      insertImagePlaceholder_(body, "{{qrcode}}", qrBlob, 90, 90);
    }
    if (fields.photoUrl) {
      const photoBlob = fetchImageBlobFromUrl_(fields.photoUrl);
      insertImagePlaceholder_(body, "{{photo}}", photoBlob, 110, 130);
    }

    doc.saveAndClose();

    const pdfBlob = DriveApp.getFileById(copy.getId()).getAs(MimeType.PDF);
    pdfBlob.setName((fields.name || "Certificate") + ".pdf");
    return pdfBlob;
  } finally {
    try { DriveApp.getFileById(copy.getId()).setTrashed(true); } catch (e2) { /* best-effort cleanup */ }
  }
}

// Replaces a {{token}} in the doc body with an inline image, if both the
// token and the image are present — a template with no {{qrcode}}/{{photo}}
// token, or a registrant with no photo, just silently does nothing here.
// Requires the "https://www.googleapis.com/auth/script.external_request"
// OAuth scope for fetchQrCodeBlob_/fetchImageBlobFromUrl_ to work — see
// BACKEND_SETUP_STEPS.md if this throws an authorization error the same way
// the {{documents}} scope did earlier.
function insertImagePlaceholder_(body, token, blob, widthPt, heightPt) {
  if (!blob) return;
  const found = body.findText(token);
  if (!found) return; // template doesn't use this placeholder — nothing to do
  const textEl = found.getElement().asText();
  const startOffset = found.getStartOffset();
  const endOffsetInclusive = found.getEndOffsetInclusive();
  textEl.deleteText(startOffset, endOffsetInclusive);
  const image = textEl.insertInlineImage(startOffset, blob);
  if (widthPt) image.setWidth(widthPt);
  if (heightPt) image.setHeight(heightPt);
}

// Free, no-API-key QR generator (api.qrserver.com). `data` is whatever text
// should be encoded — we encode the registrant's name + membership number +
// issue date directly INTO the QR code itself (no lookup server needed), so
// scanning it shows the certified info even without a live verification
// page. Returns null on any network failure (never blocks certificate
// generation over a QR image failing).
function fetchQrCodeBlob_(data) {
  try {
    const url = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(data);
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return null;
    return resp.getBlob();
  } catch (err) {
    return null;
  }
}

function fetchImageBlobFromUrl_(url) {
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return null;
    return resp.getBlob();
  } catch (err) {
    return null;
  }
}

// replaceText() treats its first argument as a regex — escape anything a
// real name/value might contain (parentheses, dots, etc.) so it's matched
// as literal text instead.
function escapeForReplaceText_(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Builds the {{placeholder}} field map + sends one certificate email.
// Lets errors PROPAGATE (doesn't catch) — callers that want a real error
// message (the test-send button, single-send) call this directly; callers
// doing a best-effort batch (bulk send, auto-send-on-registration) go
// through sendCertificateEmail_() below instead, which never throws.
//
// `p` can be either a raw form submission payload (camelCase keys, used
// right after a live registration) or a person object built from a sheet
// row via rowToPerson_() (used for manual/bulk sends) — both shapes carry
// the same field names, so this works for either.
function sendCertificateEmailCore_(p, membershipNo) {
  const email = String(p.email || "").trim();
  if (!email) throw new Error("السجل ده مفيهوش إيميل.");
  const str = (v) => String(v || "").trim();

  const fields = {
    name: str(p.name),
    membershipNo: str(membershipNo),
    age: str(p.age),
    gender: str(p.gender),
    nationalId: str(p.nationalId),
    phone: str(p.phone),
    whatsapp: str(p.whatsapp),
    email: email,
    faculty: str(p.faculty),
    graduate: str(p.graduate),
    role: str(p.committee),
    hasJob: str(p.hasJob),
    currentJob: str(p.currentJob),
    // registrationDate: when they actually registered (from the sheet's
    // Timestamp column) — falls back to "now" for a fresh live submission,
    // since there's no Timestamp column value yet at that point.
    registrationDate: p.registrationDate
      ? str(p.registrationDate)
      : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy"),
    // date: when the CERTIFICATE is being sent — always "now".
    date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy"),
  };

  // Every EXTRA_FIELDS key (address, birthDate, tshirtSize, ...) becomes a
  // usable {{key}} placeholder automatically — no need to list them by hand
  // here the way the original fields above are.
  Object.keys(EXTRA_FIELDS).forEach(key => { fields[key] = str(p[key]); });

  // Custom fields become {{c_xxxxx}} placeholders — see sanitizeCustomField_.
  const customValues = p.customFields || {};
  getCustomFields_().forEach(cf => { fields[cf.key] = str(customValues[cf.key]); });

  // {{qrcode}} and {{photo}} — image placeholders, handled inside
  // generateCertificatePdf_ (NOT regular text substitution). qrPayload is
  // the actual text encoded into the QR image, not a placeholder key itself.
  fields.qrPayload = `سند شباب الدلتا | ${fields.name} | عضوية ${fields.membershipNo} | ${fields.date}`;
  fields.photoUrl = str(p.photoUrl);

  const pdf = generateCertificatePdf_(fields);
  MailApp.sendEmail({
    to: email,
    subject: "شهادتك — سند شباب الدلتا",
    body:
      `أهلًا ${fields.name}،\n\n` +
      `تحية طيبة، مرفق شهادتك.\n\n` +
      `تحياتنا،\nفريق سند شباب الدلتا`,
    attachments: [pdf],
  });
}

// Best-effort wrapper around sendCertificateEmailCore_() — swallows errors
// and returns true/false. Use this for batch/automatic sends where one
// failure shouldn't blow up the whole run and there's no one watching for
// a detailed error message in the moment.
function sendCertificateEmail_(p, membershipNo) {
  try {
    sendCertificateEmailCore_(p, membershipNo);
    return true;
  } catch (err) {
    console.error("Certificate email failed:", err);
    return false;
  }
}

// Maps a raw sheet row + its header row into the same field shape
// sendCertificateEmail_() expects, by header NAME (not position) — so this
// keeps working even if columns get reordered.
function rowToPerson_(headers, row) {
  const get = (headerName) => {
    const i = headers.indexOf(headerName);
    return i > -1 ? row[i] : "";
  };
  const ts = get("Timestamp");
  const person = {
    name: get("Name"),
    email: get("Email"),
    age: get("Age"),
    gender: get("Gender"),
    nationalId: get("National ID"),
    phone: get("Phone"),
    whatsapp: get("Whatsapp"),
    address: get("Address"),
    faculty: get("Faculty"),
    graduate: get("Graduate"),
    hasJob: get("Has Job"),
    currentJob: get("Current Job"),
    registrationDate: ts instanceof Date
      ? Utilities.formatDate(ts, Session.getScriptTimeZone(), "dd/MM/yyyy")
      : String(ts || ""),
    committee: get("Role in Entity"),
    membershipNo: get("Membership No"),
  };
  // Generic EXTRA_HEADERS fields, e.g. person.birthDate, person.tshirtSize, ...
  EXTRA_HEADERS.forEach(h => { person[HEADER_TO_EXTRA_FIELD[h]] = get(h); });
  // Custom fields, available to certificate templates as {{c_xxxxx}} — see
  // sendCertificateEmailCore_'s placeholder resolution.
  try {
    person.customFields = JSON.parse(get(CUSTOM_FIELDS_HEADER) || "{}");
  } catch (e) {
    person.customFields = {};
  }
  person.photoUrl = get("Photo URL");
  return person;
}

// action=sendCertificate — single certificate, looked up by National ID
// inside the given (or currently active) sheet/cycle.
function handleSendCertificate_(payload) {
  const cfg = getRegConfig_();
  if (!cfg.certTemplateReady) {
    return jsonOutput_({ status: "error", message: "ارفع تيمبلت الشهادة الأول من تبويب الإعدادات." });
  }
  const sheet = findSheet_(payload.sheet || cfg.activeSheetName);
  if (!sheet) return jsonOutput_({ status: "error", message: "الشيت مش موجود." });

  const data = sheet.getDataRange().getValues();
  const headers = data[0] || [];
  const nidCol = headers.indexOf("National ID");
  const nationalId = String(payload.nationalId || "").trim();
  const row = data.slice(1).find(r => String(r[nidCol]).trim() === nationalId);
  if (!row) return jsonOutput_({ status: "error", message: "السجل مش موجود في الشيت ده." });

  const person = rowToPerson_(headers, row);
  if (!person.email) return jsonOutput_({ status: "error", message: "السجل ده مفيهوش إيميل." });

  try {
    sendCertificateEmailCore_(person, person.membershipNo);
    return jsonOutput_({ status: "success", message: "اترسلت الشهادة ✓" });
  } catch (err) {
    return jsonOutput_({ status: "error", message: "فشل إرسال الشهادة: " + String(err) });
  }
}

// action=sendCertificatesBulk — sends to everyone with a valid email in the
// given (or currently active) sheet/cycle. Best-effort per row: one failure
// doesn't stop the rest.
function handleSendCertificatesBulk_(payload) {
  const cfg = getRegConfig_();
  if (!cfg.certTemplateReady) {
    return jsonOutput_({ status: "error", message: "ارفع تيمبلت الشهادة الأول من تبويب الإعدادات." });
  }
  const sheet = findSheet_(payload.sheet || cfg.activeSheetName);
  if (!sheet) return jsonOutput_({ status: "error", message: "الشيت مش موجود." });

  const data = sheet.getDataRange().getValues();
  const headers = data[0] || [];
  const rows = data.slice(1).filter(r => r.some(c => String(c).trim() !== ""));

  let sent = 0, failed = 0, skippedNoEmail = 0;
  rows.forEach(row => {
    const person = rowToPerson_(headers, row);
    if (!person.email) { skippedNoEmail += 1; return; }
    if (sendCertificateEmail_(person, person.membershipNo)) sent += 1; else failed += 1;
  });

  return jsonOutput_({ status: "success", sent, failed, skippedNoEmail, total: rows.length });
}

// action=sendTestCertificate — sends one certificate with sample data to an
// email the admin types in, WITHOUT touching the sheet. Use this to check a
// newly uploaded template's layout/placeholders before trusting it with a
// real batch.
function handleSendTestCertificate_(payload) {
  const cfg = getRegConfig_();
  if (!cfg.certTemplateReady) {
    return jsonOutput_({ status: "error", message: "ارفع تيمبلت الشهادة الأول من تبويب الإعدادات." });
  }
  const email = String(payload.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonOutput_({ status: "error", message: "اكتب إيميل صحيح للاختبار." });
  }
  const sample = {
    name: "اسم تجريبي",
    email: email,
    faculty: "كلية تجريبية",
    committee: "لجنة تجريبية",
    nationalId: "00000000000000",
  };
  try {
    sendCertificateEmailCore_(sample, "DYS-000000");
    return jsonOutput_({ status: "success", message: "اترسلت شهادة تجريبية ✓ — روح شوف إيميلك." });
  } catch (err) {
    return jsonOutput_({ status: "error", message: "فشل إرسال الشهادة التجريبية: " + String(err) });
  }
}


// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

function getActiveSheetName_() {
  return PropertiesService.getScriptProperties().getProperty("ACTIVE_SHEET_NAME") || SHEET_NAME;
}

// Looks up a sheet WITHOUT creating it. Used anywhere we must never silently
// spawn a new empty tab just because someone passed an unexpected name.
function findSheet_(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

// Gets (and creates, if missing) the CURRENT active sheet — i.e. the one
// this registration cycle is writing into. On a fresh install, this is what
// bootstraps ACTIVE_SHEET_NAME/SHEET_BASE_NAME the very first time, so old
// deployments that never touch the new Settings tab keep behaving exactly
// like before.
function getSheet_(nameOpt) {
  const name = nameOpt || getActiveSheetName_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);

    const props = PropertiesService.getScriptProperties();
    if (!props.getProperty("ACTIVE_SHEET_NAME")) props.setProperty("ACTIVE_SHEET_NAME", name);
    if (!props.getProperty("SHEET_BASE_NAME")) props.setProperty("SHEET_BASE_NAME", name);
  } else {
    healSheetHeaders_(sheet);
  }
  return sheet;
}

// Self-heals an EXISTING sheet/cycle whenever HEADERS grows (like it just
// did — 17 new columns for the extra fields + custom fields). Only ever
// WRITES into columns that are currently blank — if a column already has
// some other value there (a real conflict), this leaves it alone and
// checkHeaders() will report it instead, so real data is never clobbered.
function healSheetHeaders_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  if (lastCol >= HEADERS.length) return; // already has room for every header — nothing to do
  const range = sheet.getRange(1, 1, 1, HEADERS.length);
  const actual = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const full = HEADERS.map((h, i) => (actual[i] ? actual[i] : h));
  range.setValues([full]);
}

function buildRow_(p, membershipNo) {
  const str = (v) => String(v || "").trim();
  // Order MUST match HEADERS above. This first part (15 columns) is
  // unchanged from before — the newer EXTRA_HEADERS + custom-fields column
  // are appended generically right after it.
  const legacyRow = [
    new Date(),
    membershipNo,
    str(p.name),
    str(p.age),
    p.gender,
    str(p.nationalId),
    str(p.phone),
    str(p.whatsapp),
    str(p.email),
    str(p.address), // now a real configurable field again — see EXTRA_FIELDS.address
    str(p.faculty),
    p.graduate,
    str(p.committee),
    p.hasJob,
    str(p.currentJob),
  ];
  const extraRow = EXTRA_HEADERS.map(h => str(p[HEADER_TO_EXTRA_FIELD[h]]));
  const customJson = JSON.stringify(p.customFields || {});
  return legacyRow.concat(extraRow).concat([customJson]).concat([str(p.photoUrl)]);
}

function isDuplicateNid_(nationalId) {
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  const headers = data[0] || [];
  const nidCol = headers.indexOf("National ID");
  if (nidCol === -1) return false;
  return data.slice(1).some(row => String(row[nidCol]).trim() === nationalId);
}

// Sequential membership numbers like DYS-000123, persisted in Script
// Properties so it survives across executions AND across cycles (numbering
// keeps counting up even after a new sheet/cycle is started). First call
// bootstraps the counter from however many rows already exist in the active
// sheet, so numbering picks up naturally even if you're migrating from an
// older sheet.
function generateMembershipNumber_() {
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    let counter = Number(props.getProperty("MEMBERSHIP_COUNTER"));
    if (!counter) {
      const sheet = getSheet_();
      counter = Math.max(0, sheet.getLastRow() - 1); // -1 for header row
    }
    counter += 1;
    props.setProperty("MEMBERSHIP_COUNTER", String(counter));
    return `${MEMBERSHIP_PREFIX}-${String(counter).padStart(6, "0")}`;
  } finally {
    lock.releaseLock();
  }
}


// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

function sendConfirmationEmail_(p, membershipNo) {
  try {
    const subject = "تأكيد التسجيل — سند شباب الدلتا";
    const body =
      `أهلًا ${p.name}،\n\n` +
      `شكرًا لتسجيلك في سند شباب الدلتا.\n` +
      `رقم عضويتك هو: ${membershipNo}\n\n` +
      `هيتم التواصل معاك قريبًا من فريق اللجنة.\n\n` +
      `تحياتنا،\nفريق سند شباب الدلتا`;
    MailApp.sendEmail(p.email.trim(), subject, body);
    return true;
  } catch (err) {
    console.error("Email send failed:", err);
    return false;
  }
}


// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Admin accounts (password + granular permissions)
// ---------------------------------------------------------------------------
// The dashboard login box only ever asks for ONE password — there's no
// separate username field. Whoever's password matches determines which
// account (and therefore which permissions) they're logged in as.
//
// Every account can always view the registrations table/charts and switch
// between cycles once logged in — that's just what "having a valid
// dashboard password" means. On top of that, each account is independently
// granted zero or more of these capabilities (see PERMISSION_KEYS at the
// top of the file):
//   manageSettings     — form title, sheet name, registration window, logo,
//                         cycles, diagnostics
//   manageFields       — which form fields are shown/required
//   manageCertificates — upload/remove the cert template, send certificates
//                         (single/bulk/test), toggle auto-send
//   manageAccounts     — add/remove OTHER admin accounts (this is the
//                         sensitive one — see handleRemoveAdminAccount_)
// An account with none of these is a pure read-only "viewer". An account
// with all four behaves like the old "owner" role.
//
// Stored in Script Properties as ADMIN_ACCOUNTS (a JSON array), managed from
// the dashboard's "👥 حسابات الدخول" settings card (needs manageAccounts) —
// you don't need to edit this file or Script Properties by hand to add
// someone.
//
// Backward compatibility: your original single ADMIN_PASSWORD (set via
// setAdminPassword() below) keeps working forever as an implicit
// full-permissions account — you never have to migrate it, it's just always
// included. Any account saved under the OLD role:"owner"/"viewer" shape
// (from before this granular-permissions version) is transparently upgraded
// to the new permissions shape the moment it's read — see normalizeAccount_.

function normalizeAccount_(a) {
  if (a.permissions) {
    // Already the new shape — just re-derive the display-only `role` label.
    return Object.assign({}, a, { role: roleLabelFromPermissions_(a.permissions) });
  }
  // Old shape: {name, password, role: "owner"|"viewer"}.
  const isOwner = a.role === "owner";
  const permissions = {};
  PERMISSION_KEYS.forEach(key => { permissions[key] = isOwner; });
  return Object.assign({}, a, { permissions, role: roleLabelFromPermissions_(permissions) });
}

// Purely cosmetic label for the dashboard's accounts table — "owner" if
// every capability is granted, "viewer" if none are, "custom" otherwise.
function roleLabelFromPermissions_(permissions) {
  const values = PERMISSION_KEYS.map(key => !!permissions[key]);
  if (values.every(v => v)) return "owner";
  if (values.every(v => !v)) return "viewer";
  return "custom";
}

function getAdminAccounts_() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty("ADMIN_ACCOUNTS");
  let accounts = [];
  if (raw) {
    try { accounts = JSON.parse(raw); } catch (e) { accounts = []; }
  }
  const legacy = props.getProperty("ADMIN_PASSWORD");
  if (legacy && !accounts.some(a => a.password === legacy)) {
    accounts = [{ name: "الحساب الأساسي", password: legacy, role: "owner" }].concat(accounts);
  }
  return accounts.map(normalizeAccount_);
}

function saveAdminAccounts_(accounts) {
  PropertiesService.getScriptProperties().setProperty("ADMIN_ACCOUNTS", JSON.stringify(accounts));
}

// Returns the matching account ({name, password, permissions, role}) or null.
function authenticate_(password) {
  if (!password) return null;
  return getAdminAccounts_().find(a => a.password === password) || null;
}

// Central gate for every password-protected endpoint. `permission` is one of
// PERMISSION_KEYS, or the special value "viewData" which just means "any
// valid logged-in account" (every account can view). Returns the matched
// account on success, or null (and already slept 400ms to blunt
// brute-forcing) on failure — callers just do:
//   const account = requirePermission_(pwd, "manageSettings");
//   if (!account) return jsonOutput_({status:"error", message:"Unauthorized"});
function requirePermission_(password, permission) {
  const account = authenticate_(password);
  const ok = account && (permission === "viewData" || account.permissions[permission] === true);
  if (!ok) {
    Utilities.sleep(400);
    return null;
  }
  return account;
}

// Run this ONCE from the Apps Script editor (select it in the function
// dropdown ▸ Run) to set/change the MAIN dashboard password (always an
// "owner" account). Edit the value below first, then run it. To add MORE
// accounts (e.g. a read-only "viewer" for a teammate), use the "👥 حسابات
// الدخول" card in the dashboard instead — you don't need the editor for that.
function setAdminPassword() {
  const NEW_PASSWORD = "DYS.SANAD"; // <-- edit this line, then Run
  PropertiesService.getScriptProperties().setProperty("ADMIN_PASSWORD", NEW_PASSWORD);
  Logger.log("Admin password updated.");
}


// ---------------------------------------------------------------------------
// One-time setup / diagnostics — run these manually from the editor as needed
// ---------------------------------------------------------------------------

// Creates the sheet + header row if it doesn't exist yet. Safe to run
// multiple times — it does nothing if the sheet is already there.
function setupSheet() {
  const sheet = getSheet_();
  Logger.log(`Sheet "${sheet.getName()}" is ready.`);
}

// Compares your sheet's actual row-1 headers against what this script
// expects, and logs any mismatches. Run this BEFORE going live if you're
// pointing this script at a sheet that already has real data in it.
function checkHeaders() {
  const sheet = getSheet_();
  const actual = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), HEADERS.length)).getValues()[0];

  Logger.log("Sheet checked:    " + sheet.getName());
  Logger.log("Expected headers: " + JSON.stringify(HEADERS));
  Logger.log("Actual headers:   " + JSON.stringify(actual));

  const mismatches = [];
  HEADERS.forEach((h, i) => {
    if (String(actual[i] || "").trim() !== h) {
      mismatches.push(`Column ${i + 1}: expected "${h}", found "${actual[i] || "(empty)"}"`);
    }
  });

  if (mismatches.length === 0) {
    Logger.log("✅ Headers match perfectly.");
  } else {
    Logger.log("⚠️ Mismatches found:\n" + mismatches.join("\n"));
    Logger.log("Fix row 1 in the sheet to match 'Expected headers' above before going live.");
  }
}

// Optional convenience: configure the registration window / form title /
// sheet base name directly from the Apps Script editor instead of the
// dashboard's Settings tab. Edit the values below, then Run this once.
// Leave START_AT / END_AT as "" for "no limit" (registration always open).
function configureRegistration_() {
  const FORM_TITLE = "";              // e.g. "تسجيل دفعة 2026" — leave "" to keep the default
  const SHEET_BASE_NAME = "";         // e.g. "Registrations" — leave "" to keep current
  const START_AT = "";                // e.g. "2026-09-01T09:00:00" — leave "" for no limit
  const END_AT = "";                  // e.g. "2026-09-15T23:59:59" — leave "" for no limit
  const START_NEW_CYCLE = false;      // set true to force-create a brand-new sheet right now

  const result = handleSaveConfig_({
    formTitle: FORM_TITLE, sheetBaseName: SHEET_BASE_NAME,
    startAt: START_AT, endAt: END_AT, startNewCycle: START_NEW_CYCLE,
  });
  Logger.log(result.getContent());
}

// Quick self-test you can run from the editor to sanity-check the whole
// pipeline without going through the actual form. Check the Logger output
// (View ▸ Logs) after running.
function testSubmitLocally() {
  const fakePayload = {
    name: "Test User", age: "22", gender: "Male",
    nationalId: "29901011234567", // NOTE: replace with a syntactically valid test ID before running
    phone: "01012345678", whatsapp: "01012345678", email: "",
    address: "", faculty: "Test Faculty", graduate: "No",
    committee: "Volunteer", hasJob: "No", currentJob: "",
    website: "", loadedAt: Date.now() - 5000,
  };
  const result = handleSubmit_(fakePayload);
  Logger.log(result.getContent());
}


// ---------------------------------------------------------------------------
// Output helper
// ---------------------------------------------------------------------------

function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}