'use strict';

/* =====================================================================
   Hub Tracker — all data is stored locally on the device (localStorage).
   ===================================================================== */

const STORE_KEY = 'hubtracker:v1';
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// `mileage: true` = a car cost that the IRS standard mileage rate already covers,
// so it is only deductible when using the actual-expense method.
const CATS = [
  { id: 'fuel', label: 'Fuel', mileage: true },
  { id: 'maintenance', label: 'Maintenance & repairs', mileage: true },
  { id: 'carwash', label: 'Car wash', mileage: true },
  { id: 'insurance', label: 'Car insurance', mileage: true },
  { id: 'registration', label: 'Registration & car fees', mileage: true },
  { id: 'tolls', label: 'Tolls & parking', mileage: false },
  { id: 'phone', label: 'Phone & data', mileage: false },
  { id: 'subscriptions', label: 'Apps & subscriptions', mileage: false },
  { id: 'supplies', label: 'Supplies & equipment', mileage: false },
  { id: 'other', label: 'Other business cost', mileage: false },
];
const catOf = (id) => CATS.find((c) => c.id === id) || CATS[CATS.length - 1];

// Quick picks for common recurring business costs.
const RECURRING_SUGGESTIONS = [
  { name: 'Phone bill', category: 'phone', frequency: 'monthly', bizPct: 50, hint: 'Enter the full bill and the share you use for deliveries.' },
  { name: 'Car insurance', category: 'insurance', frequency: 'monthly', interval: 6, hint: 'Most policies bill every 6 months; enter that vehicle’s premium. Split automatically by its business use.' },
  { name: 'Registration', category: 'registration', frequency: 'yearly', hint: 'Split automatically by the vehicle’s business use.' },
  { name: 'Apps & subscriptions', category: 'subscriptions', frequency: 'monthly', bizPct: 100, hint: 'Navigation, cloud storage, etc. Use the business share if you also use it personally.' },
  { name: 'Car wash membership', category: 'carwash', frequency: 'monthly', hint: 'Split automatically by the vehicle’s business use.' },
];
const FREQS = { weekly: 'week', monthly: 'month', yearly: 'year' };
const everyLabel = (r) => { const n = +r.interval || 1; return n === 1 ? FREQS[r.frequency] : `${n} ${FREQS[r.frequency]}s`; };

/* ---------- small utils ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (n) => moneyFmt.format(n || 0);
const num = (n, d = 0) => (n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const numOrNull = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
const sum = (arr, fn) => arr.reduce((t, x) => t + (+fn(x) || 0), 0);

const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayISO = () => toISO(new Date());
const curYear = () => todayISO().slice(0, 4);
const addDays = (s, n) => { const d = fromISO(s); d.setDate(d.getDate() + n); return toISO(d); };
const weekStart = (s) => { const d = fromISO(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return toISO(d); }; // Monday
const fmtShort = (s) => fromISO(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtLong = (s) => fromISO(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fmtMonth = (s) => fromISO(s).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const daysSince = (s) => Math.round((fromISO(todayISO()) - fromISO(s)) / 86400000);

/* ---------- state ---------- */
function defaultState() {
  const areaId = uid(), vehicleId = uid();
  return {
    version: 1,
    settings: {
      workDays: [1, 2, 3, 4, 5],
      deduction: 'best',      // 'best' | 'standard' | 'actual'
      taxMode: 'flat',        // 'flat' | 'se'
      flatRate: 30,           // % of taxable profit
      incomeRate: 12,         // % federal+state income tax bracket, used with 'se'
      // IRS business standard mileage rate; 2026 rose mid-year (Notice 2026-10 update)
      mileageRates: { 2024: 0.67, 2025: 0.70, 2026: 0.725, '2026-07-01': 0.76 },
      defaultAreaId: areaId,
      defaultVehicleId: vehicleId,
    },
    areas: [{ id: areaId, name: 'My area', rate: 0 }],
    vehicles: [{ id: vehicleId, name: 'Car 1' }],
    days: [],
    expenses: [],
    recurring: [], // { id, name, category, amount, bizPct, vehicleId, frequency, interval, startDate, endDate, lastGenerated }
    taxPaid: {},
    lastBackup: null,
  };
}

function normalize(s) {
  const d = defaultState();
  return {
    ...d, ...s,
    settings: { ...d.settings, ...(s.settings || {}), mileageRates: { ...d.settings.mileageRates, ...(s.settings?.mileageRates || {}) } },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (err) { console.error(err); }
  return defaultState();
}

/* ---------- recurring costs ---------- */
// Dates a recurring cost falls on, from its start through `through` (and its end date, if any).
// Monthly/yearly keep the start date's day, clamped to short months (e.g. the 31st → Feb 28).
function occurrenceDates(r, through) {
  const out = [], s = fromISO(r.startDate), last = r.endDate && r.endDate < through ? r.endDate : through;
  const n = Math.max(1, Math.round(+r.interval || 1)); // e.g. every 6 months
  for (let i = 0; i < 1000; i++) {
    let d;
    if (r.frequency === 'weekly') d = addDays(r.startDate, 7 * i * n);
    else {
      const m = s.getMonth() + (r.frequency === 'yearly' ? 12 : 1) * i * n;
      d = toISO(new Date(s.getFullYear(), m, Math.min(s.getDate(), new Date(s.getFullYear(), m + 1, 0).getDate())));
    }
    if (d > last) break;
    out.push(d);
  }
  return out;
}

const recurringShare = (r) => (catOf(r.category).mileage ? 100 : r.bizPct ?? 100);
const nextDue = (r) => occurrenceDates(r, addDays(todayISO(), 3700)).find((d) => !r.lastGenerated || d > r.lastGenerated);

// Add an expense for every occurrence that has come due since the last one we generated.
// Generated expenses are ordinary costs (editable/deletable) and are never re-created.
function materializeRecurring() {
  let changed = false;
  for (const r of state.recurring) {
    for (const date of occurrenceDates(r, todayISO())) {
      if (r.lastGenerated && date <= r.lastGenerated) continue;
      const pct = recurringShare(r);
      state.expenses.push({
        id: uid(), date, category: r.category, amount: Math.round(r.amount * pct) / 100,
        vehicleId: r.vehicleId || null, gallons: null, odometer: null,
        notes: r.name + (pct < 100 ? ` (${pct}% of ${money(r.amount)})` : ''), recurringId: r.id,
      });
      r.lastGenerated = date;
      changed = true;
    }
  }
  if (changed) save();
  return changed;
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (err) { alert('Could not save! Storage may be full. Export a backup now.\n\n' + err.message); }
}

let state = load();
const ui = { tab: 'log', period: 'month', year: curYear(), weekOf: weekStart(todayISO()) };

/* ---------- lookups ---------- */
const areaById = (id) => state.areas.find((a) => a.id === id);
const vehicleById = (id) => state.vehicles.find((v) => v.id === id);
const areaName = (id) => areaById(id)?.name ?? '—';
const vehicleName = (id) => vehicleById(id)?.name ?? '—';
const activeAreas = () => state.areas.filter((a) => !a.archived);
const activeVehicles = () => state.vehicles.filter((v) => !v.archived);

function yearsList() {
  const ys = new Set([curYear(), ...state.days.map((d) => d.date.slice(0, 4)), ...state.expenses.map((e) => e.date.slice(0, 4))]);
  return [...ys].sort().reverse();
}

/* ---------- calculations ---------- */
const dayPay = (d) => (d.packages || 0) * (d.rate || 0) + (d.bonus || 0);
const dayMiles = (d) => (d.odoStart != null && d.odoEnd != null && d.odoEnd >= d.odoStart ? d.odoEnd - d.odoStart : 0);
function dayHours(d) {
  if (!d.startTime || !d.endTime) return 0;
  const [sh, sm] = d.startTime.split(':').map(Number);
  const [eh, em] = d.endTime.split(':').map(Number);
  let m = eh * 60 + em - (sh * 60 + sm);
  if (m < 0) m += 1440;
  return m / 60;
}

// Rate keys are a year ("2026", effective Jan 1) or a mid-year change date ("2026-07-01").
const rateKeyDate = (k) => (k.length === 4 ? `${k}-01-01` : k);
function mileageRate(dateOrYear) {
  const date = rateKeyDate(dateOrYear);
  const r = state.settings.mileageRates;
  const known = Object.keys(r).sort((a, b) => rateKeyDate(a).localeCompare(rateKeyDate(b)));
  const prior = known.filter((k) => rateKeyDate(k) <= date);
  return +r[(prior.length ? prior : known).at(-1)] || 0;
}

function estTax(taxable) {
  if (taxable <= 0) return 0;
  const s = state.settings;
  if (s.taxMode === 'flat') return taxable * s.flatRate / 100;
  const se = taxable * 0.9235 * 0.153; // self-employment tax (Social Security + Medicare)
  // Income tax applies after deducting half the SE tax and the 20% qualified business income (QBI) deduction.
  const qbi = 0.2 * Math.max(0, taxable - se / 2);
  return se + Math.max(0, taxable - se / 2 - qbi) * s.incomeRate / 100;
}

// Business-use % for a vehicle in a year = delivery miles ÷ total miles driven.
// Total miles come from the spread of every odometer reading that year (delivery days,
// fill-ups, and the optional Jan 1 reading), so gaps between one day's ending odometer and
// the next day's starting odometer count as personal driving.
function businessUse(vehicleId, year) {
  const v = vehicleById(vehicleId);
  const days = state.days.filter((d) => d.vehicleId === vehicleId && d.date.startsWith(year));
  const business = sum(days, dayMiles);
  const readings = [
    ...days.flatMap((d) => [d.odoStart, d.odoEnd]),
    ...state.expenses.filter((e) => e.vehicleId === vehicleId && e.date.startsWith(year)).map((e) => e.odometer),
    v?.startOdo?.[year],
  ].filter((x) => x != null && x > 0);
  const total = Math.max(business, readings.length ? Math.max(...readings) - Math.min(...readings) : 0);
  const calc = total > 0 ? business / total : 0;
  const override = v?.usePct?.[year];
  return { business, total, personal: total - business, calc, pct: override != null ? override / 100 : calc, overridden: override != null };
}

const useCache = new Map(); // cleared on every render
function useFor(vehicleId, year) {
  const k = vehicleId + '|' + year;
  if (!useCache.has(k)) useCache.set(k, businessUse(vehicleId, year));
  return useCache.get(k);
}
// The deductible / business part of a cost. Car costs tied to a vehicle are scaled by its business-use %.
const bizPct = (e) => (e.vehicleId && catOf(e.category).mileage && vehicleById(e.vehicleId) ? useFor(e.vehicleId, e.date.slice(0, 4)).pct : 1);
const bizAmount = (e) => (e.amount || 0) * bizPct(e);

// `forceMethods` = { vehicleId: 'standard' | 'actual' } — used so quarters follow the full-year choice.
function summarize(from, to, forceMethods) {
  const days = state.days.filter((d) => d.date >= from && d.date <= to);
  const exps = state.expenses.filter((e) => e.date >= from && e.date <= to);
  const gross = sum(days, dayPay);
  const packages = sum(days, (d) => d.packages);
  const miles = sum(days, dayMiles);
  const hours = sum(days, dayHours);
  const workDays = new Set(days.map((d) => d.date)).size;
  const mileageDeduction = sum(days, (d) => dayMiles(d) * mileageRate(d.date));
  const carExps = exps.filter((e) => catOf(e.category).mileage);
  const vehicleExpFull = sum(carExps, (e) => e.amount);
  const vehicleExp = sum(carExps, bizAmount); // only the business-use share of car costs counts
  const personalCarExp = vehicleExpFull - vehicleExp;
  const otherExp = sum(exps.filter((e) => !catOf(e.category).mileage), (e) => e.amount);
  const totalExp = vehicleExp + otherExp;

  // The IRS lets you pick standard mileage or actual expenses separately for each vehicle.
  const perVehicle = state.vehicles.map((v) => {
    const vDays = days.filter((d) => d.vehicleId === v.id);
    const standard = sum(vDays, (d) => dayMiles(d) * mileageRate(d.date));
    const actual = sum(carExps.filter((e) => e.vehicleId === v.id), bizAmount);
    const pref = forceMethods?.[v.id] || v.deduction || state.settings.deduction;
    const method = pref === 'best' ? (standard >= actual ? 'standard' : 'actual') : pref;
    return { v, miles: sum(vDays, dayMiles), standard, actual, method, deduction: method === 'standard' ? standard : actual };
  }).filter((x) => x.miles || x.actual);
  // Car costs not tied to any vehicle can only be deducted as actual expenses.
  const unassignedCarExp = sum(carExps.filter((e) => !e.vehicleId || !vehicleById(e.vehicleId)), bizAmount);

  const standard = mileageDeduction + otherExp; // every car on standard mileage, for comparison
  const actual = totalExp;                      // every car on actual expenses, for comparison
  const deduction = sum(perVehicle, (x) => x.deduction) + unassignedCarExp + otherExp;
  const taxable = gross - deduction;
  const tax = estTax(taxable);
  const cashProfit = gross - totalExp;
  return {
    days, exps, gross, packages, miles, hours, workDays, mileageDeduction, vehicleExp, personalCarExp, otherExp, totalExp,
    standard, actual, perVehicle, unassignedCarExp, deduction, taxable, tax, cashProfit, takeHome: cashProfit - tax,
  };
}

function vehicleStats(from, to) {
  return state.vehicles.map((v) => {
    const days = state.days.filter((d) => d.vehicleId === v.id && d.date >= from && d.date <= to);
    const exps = state.expenses.filter((e) => e.vehicleId === v.id && e.date >= from && e.date <= to);
    const miles = sum(days, dayMiles);
    const fuel = sum(exps.filter((e) => e.category === 'fuel'), (e) => e.amount);
    const carCost = sum(exps.filter((e) => catOf(e.category).mileage), (e) => e.amount);
    // MPG from consecutive fill-ups that have both gallons and odometer (assumes filling to full)
    const fills = exps.filter((e) => e.category === 'fuel' && e.gallons > 0 && e.odometer > 0).sort((a, b) => a.odometer - b.odometer);
    let mpg = null;
    if (fills.length >= 2) {
      const dist = fills.at(-1).odometer - fills[0].odometer;
      const gal = sum(fills.slice(1), (e) => e.gallons);
      if (dist > 0 && gal > 0) mpg = dist / gal;
    }
    return { v, miles, fuel, carCost, bizCost: sum(exps.filter((e) => catOf(e.category).mileage), bizAmount), mpg, use: useFor(v.id, from.slice(0, 4)) };
  }).filter((x) => !x.v.archived || x.miles || x.carCost);
}

// Running year-to-date miles per vehicle, keyed by day-entry id.
function vehicleYtdMap() {
  const map = {}, totals = {};
  [...state.days]
    .sort((a, b) => a.date.localeCompare(b.date) || (a.odoStart ?? 0) - (b.odoStart ?? 0))
    .forEach((d) => {
      const k = d.vehicleId + '|' + d.date.slice(0, 4);
      totals[k] = (totals[k] || 0) + dayMiles(d);
      map[d.id] = totals[k];
    });
  return map;
}

// Best guess for today's starting odometer: the highest ending reading for that vehicle so far.
function suggestOdo(vehicleId, date, excludeId) {
  const readings = state.days
    .filter((d) => d.vehicleId === vehicleId && d.id !== excludeId && d.date <= date && d.odoEnd != null)
    .map((d) => d.odoEnd);
  return readings.length ? Math.max(...readings) : null;
}

function lastVehicleId() {
  const recent = [...state.days].sort((a, b) => b.date.localeCompare(a.date)).find((d) => vehicleById(d.vehicleId) && !vehicleById(d.vehicleId).archived);
  return recent?.vehicleId || state.settings.defaultVehicleId || activeVehicles()[0]?.id;
}

const quarters = (y) => [
  { label: 'Q1', range: 'Jan–Mar', from: `${y}-01-01`, to: `${y}-03-31`, due: `Apr 15` },
  { label: 'Q2', range: 'Apr–May', from: `${y}-04-01`, to: `${y}-05-31`, due: `Jun 15` },
  { label: 'Q3', range: 'Jun–Aug', from: `${y}-06-01`, to: `${y}-08-31`, due: `Sep 15` },
  { label: 'Q4', range: 'Sep–Dec', from: `${y}-09-01`, to: `${y}-12-31`, due: `Jan 15, ${+y + 1}` },
];

/* =====================================================================
   Views
   ===================================================================== */

const TITLES = { dash: 'Summary', log: 'Daily log', costs: 'Costs', settings: 'Settings' };

function render() {
  useCache.clear();
  $('#title').textContent = TITLES[ui.tab];
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  const views = { dash: viewDash, log: viewLog, costs: viewCosts, settings: viewSettings };
  $('#view').innerHTML = views[ui.tab]();
  $('#top-actions').innerHTML =
    ui.tab === 'log' ? `<button class="btn primary small" data-action="add-day">+ Add day</button>`
    : ui.tab === 'costs' ? `<button class="btn primary small" data-action="add-exp">+ Add cost</button>`
    : '';
}

function yearSelect() {
  return `<select class="inline" data-ui="year">${yearsList().map((y) => `<option ${y === ui.year ? 'selected' : ''}>${y}</option>`).join('')}</select>`;
}

function setupBanners() {
  const out = [];
  if (state.areas.every((a) => !a.rate)) {
    out.push(`<div class="banner">Welcome! Start by setting your per-package rate and vehicles in <button class="link" data-action="tab" data-tab="settings">Settings</button>.</div>`);
  }
  if (state.days.length + state.expenses.length > 0 && (!state.lastBackup || daysSince(state.lastBackup) > 14)) {
    out.push(`<div class="banner warn">Your data is stored only on this phone. ${state.lastBackup ? `Last backup was ${daysSince(state.lastBackup)} days ago.` : 'You haven’t backed up yet.'} <button class="link" data-action="export-json">Back up now</button></div>`);
  }
  return out.join('');
}

/* ---------- Summary ---------- */
function periodRange() {
  const t = todayISO();
  if (ui.period === 'week') { const s = weekStart(t); return [s, addDays(s, 6), 'This week']; }
  if (ui.period === 'month') return [t.slice(0, 8) + '01', t.slice(0, 8) + '31', fmtMonth(t)];
  return [`${ui.year}-01-01`, `${ui.year}-12-31`, ui.year === curYear() ? `${ui.year} year to date` : ui.year];
}

function viewDash() {
  const [from, to, label] = periodRange();
  const s = summarize(from, to);
  const st = state.settings;
  const taxDesc = st.taxMode === 'flat' ? `${st.flatRate}% of taxable profit` : `15.3% self-employment + ${st.incomeRate}% income tax`;

  const stat = (lbl, val, show = true) => (show ? `<div class="stat"><span>${lbl}</span><b>${val}</b></div>` : '');

  const vstats = vehicleStats(from, to);
  const vehicleCard = `
    <section class="card">
      <h3>Vehicles</h3>
      ${vstats.map((x) => `
        <div class="veh">
          <div class="veh-head"><b>${esc(x.v.name)}</b><span class="badge">${num(x.use.pct * 100)}% business${x.use.overridden ? ' (set)' : ''}</span></div>
          <dl class="kv">
            <dt>Delivery miles</dt><dd>${num(x.miles)}</dd>
            <dt>${from.slice(0, 4)} total / personal miles<small>from all odometer readings</small></dt><dd>${num(x.use.total)} / ${num(x.use.personal)}</dd>
            <dt>Fuel</dt><dd>${money(x.fuel)}</dd>
            <dt>Car costs → business share</dt><dd>${money(x.carCost)} → ${money(x.bizCost)}</dd>
            <dt>MPG</dt><dd>${x.mpg ? num(x.mpg, 1) : '—'}</dd>
          </dl>
        </div>`).join('')}
      <p class="hint">Business % = delivery miles ÷ total miles for the year. Miles between one day's ending odometer and the next starting odometer count as personal. For a shared car, log fill-ups with the odometer (or set a Jan 1 reading under Settings → Vehicles) so total miles are accurate. MPG needs two or more fill-ups with gallons + odometer.</p>
    </section>`;

  let quarterCard = '';
  if (ui.period === 'year') {
    const annual = summarize(`${ui.year}-01-01`, `${ui.year}-12-31`);
    const annualMethods = Object.fromEntries(annual.perVehicle.map((x) => [x.v.id, x.method]));
    const paid = state.taxPaid[ui.year] || [];
    const qs = quarters(ui.year).map((q) => summarize(q.from, q.to, annualMethods).tax);
    const totalEst = sum(qs, (x) => x), totalPaid = sum(paid, (x) => x);
    quarterCard = `
      <section class="card">
        <h3>Quarterly estimated payments</h3>
        <table class="tbl">
          <thead><tr><th>Period</th><th>Due</th><th class="r">Estimate</th><th class="r">Paid</th></tr></thead>
          <tbody>${quarters(ui.year).map((q, i) => `
            <tr><td>${q.label}<small class="muted sub">${q.range}</small></td><td>${q.due}</td><td class="r">${money(qs[i])}</td>
            <td class="r"><input type="number" inputmode="decimal" step="0.01" data-taxpaid="${i}" value="${paid[i] ?? ''}" placeholder="0"></td></tr>`).join('')}
          </tbody>
          <tfoot><tr><td colspan="2">Total</td><td class="r">${money(totalEst)}</td><td class="r">${money(totalPaid)}</td></tr></tfoot>
        </table>
        <p class="hint">${totalEst - totalPaid > 0 ? `Still to set aside / pay: <b>${money(totalEst - totalPaid)}</b>.` : 'You’re covered for the estimate so far.'} Pay at irs.gov/payments (and your state, if it has income tax).</p>
      </section>`;
  }

  return `
    ${setupBanners()}
    <div class="controls">
      <div class="seg">${[['week', 'Week'], ['month', 'Month'], ['year', 'Year']].map(([p, l]) => `<button data-action="period" data-period="${p}" class="${ui.period === p ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${ui.period === 'year' ? yearSelect() : ''}
    </div>

    <section class="card hero">
      <div class="label">${esc(label)} · take-home after costs &amp; tax</div>
      <div class="big ${s.takeHome < 0 ? 'bad' : ''}">${money(s.takeHome)}</div>
      <div class="row3">
        <div><span>Earned</span><b>${money(s.gross)}</b></div>
        <div><span>Costs</span><b>${money(s.totalExp)}</b></div>
        <div><span>Tax set-aside</span><b>${money(s.tax)}</b></div>
      </div>
    </section>

    <div class="stats">
      ${stat('Packages', num(s.packages))}
      ${stat('Days worked', num(s.workDays))}
      ${stat('Miles', num(s.miles))}
      ${stat('Pkgs / day', s.workDays ? num(s.packages / s.workDays, 1) : '—')}
      ${stat('Earned / day', s.workDays ? money(s.gross / s.workDays) : '—')}
      ${stat('Earned / mile', s.miles ? money(s.gross / s.miles) : '—')}
      ${stat('Cost / mile', s.miles ? money(s.vehicleExp / s.miles) : '—')}
      ${stat('Profit / hour', s.hours ? money(s.cashProfit / s.hours) : '—')}
    </div>

    <section class="card">
      <h3>Taxes <small>(estimate)</small></h3>
      <dl class="kv">
        <dt>Gross earnings</dt><dd>${money(s.gross)}</dd>
        ${s.perVehicle.map((x) => {
          const std = `${num(x.miles)} mi × $${x.miles ? (x.standard / x.miles).toFixed(3).replace(/0$/, "") : "0"}/mi = ${money(x.standard)}`;
          const act = `business share of car costs = ${money(x.actual)}`;
          return `<dt>${esc(x.v.name)}: ${x.method === 'standard' ? 'standard mileage' : 'actual costs'}
              <small>${x.method === 'standard' ? std : act}</small>
              <small>vs. ${x.method === 'standard' ? act : std}</small></dt>
            <dd>−${money(x.deduction)}</dd>`;
        }).join('')}
        ${s.unassignedCarExp > 0.005 ? `<dt>Car costs with no vehicle<small>actual costs only</small></dt><dd>−${money(s.unassignedCarExp)}</dd>` : ''}
        <dt>Other business costs<small>phone, supplies, tolls &amp; parking…</small></dt><dd>−${money(s.otherExp)}</dd>
        <dt class="total">Total deduction</dt><dd class="total">−${money(s.deduction)}</dd>
        ${s.personalCarExp > 0.005 ? `<dt>Personal car use left out<small>not deductible</small></dt><dd class="dim">${money(s.personalCarExp)}</dd>` : ''}
        <dt class="total">Taxable profit</dt><dd class="total">${money(s.taxable)}</dd>
        <dt>Estimated tax<small>${taxDesc}</small></dt><dd>${money(s.tax)}</dd>
      </dl>
      <p class="hint">Each vehicle gets its own method${st.deduction === 'best' ? ' (whichever is larger, unless you lock one in Settings → Vehicles)' : ''}. IRS rules: to ever use standard mileage for a car you must use it the first year the car is used for business, and once you take actual costs with depreciation you can't switch that car back. Once you've filed, lock each car's method. This is an estimate, not tax advice.</p>
    </section>

    ${quarterCard}
    ${vehicleCard}`;
}

/* ---------- Daily log ---------- */
function viewLog() {
  const start = ui.weekOf, end = addDays(start, 6);
  const ytd = vehicleYtdMap();
  const today = todayISO();
  let rows = '';
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i), dow = fromISO(date).getDay();
    const entries = state.days.filter((d) => d.date === date);
    const scheduled = state.settings.workDays.includes(dow);
    const head = `<span class="day-date ${date === today ? 'today' : ''}"><b>${DOW[dow]}</b><span>${fromISO(date).getDate()}</span></span>`;
    if (entries.length) {
      rows += entries.map((d) => `
        <button class="day-row" data-action="edit-day" data-id="${d.id}">
          ${head}
          <span class="day-main">
            <span class="day-top"><b>${num(d.packages)} packages</b><b>${money(dayPay(d))}</b></span>
            <span class="day-sub">${esc(areaName(d.areaId))} · ${esc(vehicleName(d.vehicleId))} · ${num(dayMiles(d))} mi (YTD ${num(ytd[d.id])})${d.bonus ? ` · +${money(d.bonus)} bonus` : ''}</span>
          </span>
        </button>`).join('');
    } else {
      rows += `
        <button class="day-row ${scheduled ? 'empty' : 'off'}" data-action="add-day" data-date="${date}">
          ${head}
          <span class="day-main muted">${scheduled ? (date <= today ? 'Not logged — tap to add' : 'Scheduled') : 'Off — tap to add'}</span>
        </button>`;
    }
  }
  const w = summarize(start, end);
  return `
    ${setupBanners()}
    <div class="weeknav">
      <button class="icon-btn" data-action="week" data-delta="-7" aria-label="Previous week">‹</button>
      <div><b>${fmtShort(start)} – ${fmtShort(end)}</b>${ui.weekOf !== weekStart(today) ? `<button class="link" data-action="week" data-delta="0">Back to this week</button>` : ''}</div>
      <button class="icon-btn" data-action="week" data-delta="7" aria-label="Next week">›</button>
    </div>
    <div class="list">${rows}</div>
    <section class="card">
      <h3>Week totals</h3>
      <div class="row3">
        <div><span>Packages</span><b>${num(w.packages)}</b></div>
        <div><span>Earned</span><b>${money(w.gross)}</b></div>
        <div><span>Miles</span><b>${num(w.miles)}</b></div>
      </div>
    </section>`;
}

/* ---------- Costs ---------- */
function viewCosts() {
  const exps = state.expenses.filter((e) => e.date.startsWith(ui.year)).sort((a, b) => b.date.localeCompare(a.date));
  const byCat = CATS.map((c) => ({ c, total: sum(exps.filter((e) => e.category === c.id), (e) => e.amount) })).filter((x) => x.total > 0);

  let list = '', month = '';
  for (const e of exps) {
    const m = e.date.slice(0, 7);
    if (m !== month) {
      month = m;
      const mt = sum(exps.filter((x) => x.date.startsWith(m)), (x) => x.amount);
      list += `<div class="month-head"><span>${fmtMonth(m + '-01')}</span><span>${money(mt)}</span></div>`;
    }
    const detail = [fmtShort(e.date)];
    if (e.vehicleId && vehicleById(e.vehicleId)) detail.push(vehicleName(e.vehicleId));
    if (e.gallons) detail.push(`${num(e.gallons, 2)} gal @ ${money(e.amount / e.gallons)}`);
    if (e.notes) detail.push(e.notes);
    list += `
      <button class="list-row" data-action="edit-exp" data-id="${e.id}">
        <span class="grow">${esc(catOf(e.category).label)}${e.recurringId ? ' <span class="muted" title="Recurring">↻</span>' : ''}<small>${esc(detail.join(' · '))}</small></span>
        <span class="amt">${money(e.amount)}</span>
      </button>`;
  }

  const recurringCard = `
    <section class="card">
      <h3>Recurring</h3>
      ${state.recurring.length ? `<div class="list">${state.recurring.map((r) => {
        const due = nextDue(r), pct = recurringShare(r);
        const sub = [catOf(r.category).label];
        if (r.vehicleId && vehicleById(r.vehicleId)) sub.push(vehicleName(r.vehicleId));
        if (pct < 100) sub.push(`${pct}% business`);
        sub.push(due ? `next ${fmtShort(due)}` : 'ended');
        return `
          <button class="list-row" data-action="edit-rec" data-id="${r.id}">
            <span class="grow">${esc(r.name)}<small>${esc(sub.join(' · '))}</small></span>
            <span class="amt">${money(r.amount)}<span class="muted"> /${everyLabel(r)}</span></span>
          </button>`;
      }).join('')}</div>` : '<p class="hint" style="margin-top:0">Set up bills that repeat, like your phone or car insurance, and they’ll be added to your costs automatically.</p>'}
      <button class="btn small" data-action="add-rec">+ Add recurring cost</button>
    </section>`;

  return `
    <div class="controls"><span class="muted" style="flex:1">Costs for</span>${yearSelect()}</div>
    ${recurringCard}
    ${byCat.length ? `
      <section class="card">
        <h3>${ui.year} by category</h3>
        <dl class="kv">
          ${byCat.map((x) => `<dt>${esc(x.c.label)}</dt><dd>${money(x.total)}</dd>`).join('')}
          <dt class="total">Total</dt><dd class="total">${money(sum(byCat, (x) => x.total))}</dd>
        </dl>
      </section>` : ''}
    <div class="list">${list || `<div class="empty-state">No costs logged for ${ui.year} yet.<br>Tap <b>+ Add cost</b> to log a fill-up, repair, phone bill, etc.</div>`}</div>`;
}

/* ---------- Settings ---------- */
let installEvt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function viewSettings() {
  const st = state.settings;
  const ytd = `${curYear()}-01-01`, ytdEnd = `${curYear()}-12-31`;
  const vmiles = Object.fromEntries(vehicleStats(ytd, ytdEnd).map((x) => [x.v.id, x.miles]));

  let install = '';
  if (!isStandalone()) {
    if (installEvt) install = `<div class="banner">Install Hub Tracker as an app. <button class="link" data-action="install">Install</button></div>`;
    else if (isIOS()) install = `<div class="banner">To install: tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>.</div>`;
  }

  return `
    ${install}
    <section class="card">
      <h3>Delivery areas &amp; pay rates</h3>
      <div class="list">
        ${activeAreas().map((a) => `
          <button class="list-row" data-action="edit-area" data-id="${a.id}">
            <span class="grow">${esc(a.name)}${a.id === st.defaultAreaId ? '<span class="badge">DEFAULT</span>' : ''}</span>
            <span class="amt">${money(a.rate)}<span class="muted"> /pkg</span></span>
          </button>`).join('')}
      </div>
      <button class="btn small" data-action="add-area">+ Add area</button>
      <p class="hint">Changing a rate only affects days you log afterwards — past days keep the rate they were saved with.</p>
    </section>

    <section class="card">
      <h3>Vehicles</h3>
      <div class="list">
        ${activeVehicles().map((v) => `
          <button class="list-row" data-action="edit-vehicle" data-id="${v.id}">
            <span class="grow">${esc(v.name)}${v.id === st.defaultVehicleId ? '<span class="badge">DEFAULT</span>' : ''}</span>
            <span class="amt">${num(vmiles[v.id])}<span class="muted"> mi ${curYear()}</span></span>
          </button>`).join('')}
      </div>
      <button class="btn small" data-action="add-vehicle">+ Add vehicle</button>
    </section>

    <section class="card">
      <h3>Work schedule</h3>
      <div class="chips">
        ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label class="chip"><input type="checkbox" data-workday="${d}" ${st.workDays.includes(d) ? 'checked' : ''}><span>${DOW[d]}</span></label>`).join('')}
      </div>
      <div class="btn-row">
        <button class="btn small" data-action="workday-preset" data-days="[1,2,3,4,5]">Mon–Fri</button>
        <button class="btn small" data-action="workday-preset" data-days="[1,2,3,4,5,6]">Mon–Sat</button>
        <button class="btn small" data-action="workday-preset" data-days="[0,1,2,3,4,5,6]">Every day</button>
      </div>
      <p class="hint">Scheduled days show up in the log ready to fill in. You can still log any other day.</p>
    </section>

    <section class="card">
      <h3>Taxes</h3>
      <div class="field-row">
        <label for="s-deduction">Car deduction<small>Decided per vehicle; lock one under Vehicles</small></label>
        <select id="s-deduction" data-setting="deduction">
          ${[['best', 'Auto (larger)'], ['standard', 'Standard mileage'], ['actual', 'Actual expenses']].map(([v, l]) => `<option value="${v}" ${st.deduction === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      ${yearsList().flatMap((y) => [y, ...Object.keys(st.mileageRates).filter((k) => k.length > 4 && k.startsWith(y)).sort()]).map((k) => `
        <div class="field-row">
          <label for="mr-${k}">IRS mileage rate ${k.length === 4 ? k : `from ${fmtShort(k)}, ${k.slice(0, 4)}`}<small>$ per business mile — check irs.gov</small></label>
          <input id="mr-${k}" type="number" inputmode="decimal" step="0.005" data-mrate="${k}" value="${mileageRate(k)}">
        </div>`).join('')}
      <div class="field-row">
        <label for="s-taxmode">Tax estimate<small>How tax set-aside is calculated</small></label>
        <select id="s-taxmode" data-setting="taxMode">
          <option value="flat" ${st.taxMode === 'flat' ? 'selected' : ''}>Flat % of profit</option>
          <option value="se" ${st.taxMode === 'se' ? 'selected' : ''}>Self-employment + bracket</option>
        </select>
      </div>
      ${st.taxMode === 'flat' ? `
        <div class="field-row">
          <label for="s-flat">Set-aside rate<small>% of taxable profit</small></label>
          <input id="s-flat" type="number" inputmode="decimal" step="0.5" data-setting="flatRate" value="${st.flatRate}">
        </div>` : `
        <div class="field-row">
          <label for="s-inc">Income tax rate<small>Your federal bracket + state %</small></label>
          <input id="s-inc" type="number" inputmode="decimal" step="0.5" data-setting="incomeRate" value="${st.incomeRate}">
        </div>`}
      <p class="hint">"Self-employment + bracket" = 15.3% Social Security/Medicare tax on 92.35% of profit, plus your income tax rate on what's left after half of that and the 20% small-business (QBI) deduction. Usually more accurate than a flat %.</p>
    </section>

    <section class="card">
      <h3>Backup &amp; export</h3>
      <p class="hint" style="margin-top:0">Data is saved only on this device. Back up regularly (save it to Files, Google Drive, or email it to yourself). ${state.lastBackup ? `Last backup: ${fmtLong(state.lastBackup)}.` : 'No backup yet.'}</p>
      <div class="btn-row">
        <button class="btn primary small" data-action="export-json">Back up</button>
        <button class="btn small" data-action="import-json">Restore backup</button>
      </div>
      <div class="btn-row">
        <button class="btn small" data-action="export-csv" data-kind="days">Days → CSV</button>
        <button class="btn small" data-action="export-csv" data-kind="expenses">Costs → CSV</button>
      </div>
      <p class="hint">CSV files open in Excel / Google Sheets — handy for your tax preparer.</p>
    </section>

    <section class="card">
      <h3>Danger zone</h3>
      <button class="btn danger small" data-action="reset">Erase all data</button>
    </section>`;
}

/* =====================================================================
   Modal forms
   ===================================================================== */
const modal = $('#modal');
const modalForm = $('#modal-form');
let modalHandlers = {};

function openModal(title, body, { onSubmit, onDelete, onInput } = {}) {
  modalForm.innerHTML = `
    <h2 id="modal-title">${esc(title)}</h2>
    ${body}
    <div class="modal-actions">
      ${onDelete ? '<button type="button" class="btn danger" data-modal="delete">Delete</button>' : ''}
      <span class="spacer"></span>
      <button type="button" class="btn" data-modal="cancel">Cancel</button>
      <button type="submit" class="btn primary">Save</button>
    </div>`;
  modalHandlers = { onSubmit, onDelete, onInput };
  modal.showModal();
  // Don't pop the keyboard/date picker on the first field unless a field asks for focus.
  const af = modalForm.querySelector('[autofocus]');
  if (af) af.focus(); else document.activeElement?.blur();
  onInput?.({ target: {}, type: 'init' });
}

modalForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(modalForm));
  if (modalHandlers.onSubmit?.(fd) === false) return;
  modal.close(); save(); render();
});
modalForm.addEventListener('click', (e) => {
  const sug = e.target.closest('[data-suggest]');
  if (sug) return modalHandlers.onInput?.({ target: sug, type: 'suggest' });
  const b = e.target.closest('[data-modal]');
  if (!b) return;
  if (b.dataset.modal === 'cancel') modal.close();
  if (b.dataset.modal === 'delete' && confirm(modalHandlers.deleteMsg || 'Delete this?')) {
    if (modalHandlers.onDelete() !== false) { modal.close(); save(); render(); }
  }
});
modalForm.addEventListener('input', (e) => modalHandlers.onInput?.(e));
modalForm.addEventListener('change', (e) => modalHandlers.onInput?.(e));

const field = (label, html, cls = '') => `<label class="fld ${cls}"><span>${label}</span>${html}</label>`;
const options = (items, selected) => items.map((x) => `<option value="${x.id}" ${x.id === selected ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
// include an archived item if the record still points at it
const withCurrent = (active, all, id) => (active.some((x) => x.id === id) || !all.find((x) => x.id === id) ? active : [...active, all.find((x) => x.id === id)]);

/* ---------- day entry ---------- */
function openDayForm(entry) {
  const isNew = !entry.id;
  const st = state.settings;
  let d = entry;
  if (isNew) {
    const areaId = areaById(st.defaultAreaId) && !areaById(st.defaultAreaId).archived ? st.defaultAreaId : activeAreas()[0]?.id;
    const vehicleId = lastVehicleId();
    const date = entry.date || todayISO();
    d = { date, areaId, rate: areaById(areaId)?.rate ?? 0, vehicleId, packages: null, bonus: null, odoStart: suggestOdo(vehicleId, date), odoEnd: null, startTime: '', endTime: '', notes: '' };
  }
  const v = (x) => (x == null ? '' : x);
  const dayTitle = (date) => (isNew ? 'Log ' : '') + fmtLong(date);
  // Open "More details" straight away if this day uses anything in it.
  const usesExtras = d.bonus || d.notes || d.startTime || d.endTime
    || (d.areaId !== st.defaultAreaId && activeAreas().length > 1)
    || (areaById(d.areaId) && +d.rate !== +areaById(d.areaId).rate);

  const body = `
    ${field('Packages delivered', `<input type="number" name="packages" inputmode="numeric" min="0" step="1" value="${v(d.packages)}" placeholder="0" ${isNew ? 'autofocus' : ''}>`)}
    ${field('Vehicle', `<select name="vehicleId">${options(withCurrent(activeVehicles(), state.vehicles, d.vehicleId), d.vehicleId)}</select>`)}
    <div class="grid2">
      ${field('Odometer start', `<input type="number" name="odoStart" inputmode="decimal" step="0.1" min="0" value="${v(d.odoStart)}">`)}
      ${field('Odometer end', `<input type="number" name="odoEnd" inputmode="decimal" step="0.1" min="0" value="${v(d.odoEnd)}">`)}
    </div>
    <div class="preview" id="day-preview"></div>
    <details class="more" ${usesExtras ? 'open' : ''}>
      <summary>More details <span class="muted" id="more-sum"></span></summary>
      ${field('Date', `<input type="date" name="date" required value="${d.date}">`)}
      <div class="grid2">
        ${field('Area', `<select name="areaId">${options(withCurrent(activeAreas(), state.areas, d.areaId), d.areaId)}</select>`)}
        ${field('Rate $ / package', `<input type="number" name="rate" inputmode="decimal" step="0.01" min="0" value="${v(d.rate)}">`)}
      </div>
      ${field('Bonus / adjustment $', `<input type="number" name="bonus" inputmode="decimal" step="0.01" value="${v(d.bonus || null)}" placeholder="0.00">`)}
      <div class="grid2">
        ${field('Start time', `<input type="time" name="startTime" value="${v(d.startTime)}">`)}
        ${field('End time', `<input type="time" name="endTime" value="${v(d.endTime)}">`)}
      </div>
      ${field('Notes', `<textarea name="notes" rows="2" placeholder="Route, weather, issues…">${esc(d.notes)}</textarea>`)}
    </details>`;

  openModal(dayTitle(d.date), body, {
    onInput(e) {
      const f = modalForm.elements;
      if (f.date.value) $('#modal-title').textContent = dayTitle(f.date.value);
      $('#more-sum').textContent = [fmtShort(f.date.value || d.date), areaName(f.areaId.value), money(+f.rate.value || 0) + '/pkg', +f.bonus.value ? '+' + money(+f.bonus.value) : ''].filter(Boolean).join(' · ');
      if (e.type === 'change' && e.target.name === 'areaId') f.rate.value = areaById(f.areaId.value)?.rate ?? '';
      if (e.type === 'change' && isNew && (e.target.name === 'vehicleId' || e.target.name === 'date')) {
        f.odoStart.value = suggestOdo(f.vehicleId.value, f.date.value, d.id) ?? '';
      }
      const tmp = {
        packages: +f.packages.value || 0, rate: +f.rate.value || 0, bonus: +f.bonus.value || 0,
        odoStart: numOrNull(f.odoStart.value), odoEnd: numOrNull(f.odoEnd.value),
        startTime: f.startTime.value, endTime: f.endTime.value,
      };
      const hrs = dayHours(tmp);
      // Miles since this car's last logged delivery = personal driving (feeds business-use %).
      const last = suggestOdo(f.vehicleId.value, f.date.value, d.id);
      const personal = last != null && tmp.odoStart != null ? tmp.odoStart - last : 0;
      $('#day-preview').innerHTML = `
        <div>Earnings<b>${money(dayPay(tmp))}</b></div>
        <div>Miles<b>${tmp.odoEnd != null && tmp.odoStart != null && tmp.odoEnd < tmp.odoStart ? '<span class="bad">check</span>' : num(dayMiles(tmp), 1)}</b></div>
        ${hrs ? `<div>Hours<b>${num(hrs, 1)}</b></div>` : ''}
        ${personal > 0 ? `<div>Personal since last<b>${num(personal, 1)} mi</b></div>` : ''}`;
    },
    onSubmit(fd) {
      const rec = {
        id: d.id || uid(),
        date: fd.date,
        packages: +fd.packages || 0,
        bonus: numOrNull(fd.bonus) || 0,
        areaId: fd.areaId,
        rate: +fd.rate || 0,
        vehicleId: fd.vehicleId,
        odoStart: numOrNull(fd.odoStart),
        odoEnd: numOrNull(fd.odoEnd),
        startTime: fd.startTime || '',
        endTime: fd.endTime || '',
        notes: (fd.notes || '').trim(),
      };
      if (!rec.date) { alert('Please pick a date.'); return false; }
      if (rec.odoStart != null && rec.odoEnd != null && rec.odoEnd < rec.odoStart) {
        alert('Ending odometer is lower than the starting odometer.'); return false;
      }
      if (rec.odoStart != null && rec.odoEnd != null && rec.odoEnd - rec.odoStart > 1000 && !confirm(`That’s ${num(rec.odoEnd - rec.odoStart)} miles in one day. Save anyway?`)) return false;
      const i = state.days.findIndex((x) => x.id === rec.id);
      if (i >= 0) state.days[i] = rec; else state.days.push(rec);
      ui.weekOf = weekStart(rec.date);
    },
    onDelete: isNew ? null : () => { state.days = state.days.filter((x) => x.id !== d.id); },
  });
}

/* ---------- expense ---------- */
function openExpenseForm(exp) {
  const isNew = !exp;
  const e = exp || { date: todayISO(), category: 'fuel', amount: null, vehicleId: lastVehicleId(), gallons: null, odometer: null, notes: '' };
  const v = (x) => (x == null ? '' : x);
  const vehicles = withCurrent(activeVehicles(), state.vehicles, e.vehicleId);

  const body = `
    <div class="grid2">
      ${field('Date', `<input type="date" name="date" required value="${e.date}">`)}
      ${field('Amount $', `<input type="number" name="amount" inputmode="decimal" step="0.01" min="0" required value="${v(e.amount)}" placeholder="0.00">`)}
    </div>
    ${field('Category', `<select name="category">${CATS.map((c) => `<option value="${c.id}" ${c.id === e.category ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`)}
    ${field('Vehicle', `<select name="vehicleId"><option value="">— Not for a vehicle —</option>${options(vehicles, e.vehicleId)}</select>`)}
    <div class="grid2 fuel-only">
      ${field('Gallons', `<input type="number" name="gallons" inputmode="decimal" step="0.001" min="0" value="${v(e.gallons)}">`)}
      ${field('Odometer', `<input type="number" name="odometer" inputmode="decimal" step="0.1" min="0" value="${v(e.odometer)}">`)}
    </div>
    ${field('Notes', `<input type="text" name="notes" value="${esc(e.notes)}" placeholder="Station, shop, what it was for…">`)}
    <p class="hint" id="cat-hint"></p>`;

  openModal(isNew ? 'Add a cost' : 'Edit cost', body, {
    onInput() {
      const f = modalForm.elements;
      const cat = catOf(f.category.value);
      modalForm.querySelector('.fuel-only').hidden = cat.id !== 'fuel';
      const ppg = +f.amount.value && +f.gallons.value ? ` That’s ${money(f.amount.value / f.gallons.value)}/gal.` : '';
      $('#cat-hint').textContent = (cat.mileage
        ? 'Car cost: deductible only with the actual-expense method (the mileage rate already covers it), but still counts against your real profit.'
        : 'Deductible with either method.') + (cat.id === 'fuel' ? ppg : '');
    },
    onSubmit(fd) {
      const rec = {
        id: e.id || uid(),
        date: fd.date,
        category: fd.category,
        amount: +fd.amount || 0,
        vehicleId: fd.vehicleId || null,
        gallons: fd.category === 'fuel' ? numOrNull(fd.gallons) : null,
        odometer: fd.category === 'fuel' ? numOrNull(fd.odometer) : null,
        notes: (fd.notes || '').trim(),
        ...(e.recurringId ? { recurringId: e.recurringId } : {}),
      };
      if (!rec.date) { alert('Please pick a date.'); return false; }
      if (!rec.amount) { alert('Please enter an amount.'); return false; }
      if (catOf(rec.category).mileage && !rec.vehicleId) {
        alert('Pick which vehicle this was for. Car costs are split by that vehicle’s business use.'); return false;
      }
      const i = state.expenses.findIndex((x) => x.id === rec.id);
      if (i >= 0) state.expenses[i] = rec; else state.expenses.push(rec);
      ui.year = rec.date.slice(0, 4);
    },
    onDelete: isNew ? null : () => { state.expenses = state.expenses.filter((x) => x.id !== e.id); },
  });
}

/* ---------- recurring cost ---------- */
function openRecurringForm(rec) {
  const isNew = !rec;
  const r = rec || { name: '', category: 'phone', amount: null, bizPct: 100, vehicleId: null, frequency: 'monthly', interval: 1, startDate: todayISO(), endDate: '' };
  const v = (x) => (x == null ? '' : x);
  const vehicles = withCurrent(activeVehicles(), state.vehicles, r.vehicleId);

  const body = `
    ${isNew ? `<div class="chips" style="margin-bottom:12px">${RECURRING_SUGGESTIONS.map((s, i) => `<button type="button" class="chip-btn" data-suggest="${i}">${esc(s.name)}</button>`).join('')}</div>` : ''}
    ${field('Name', `<input type="text" name="name" required value="${esc(r.name)}" placeholder="e.g. Phone bill">`)}
    <div class="grid2">
      ${field('Amount $', `<input type="number" name="amount" inputmode="decimal" step="0.01" min="0" value="${v(r.amount)}" placeholder="0.00">`)}
      ${field('Every', `<span class="pair"><input type="number" name="interval" inputmode="numeric" min="1" step="1" value="${r.interval || 1}"><select name="frequency">${Object.entries(FREQS).map(([k, l]) => `<option value="${k}" ${r.frequency === k ? 'selected' : ''}>${l}(s)</option>`).join('')}</select></span>`)}
    </div>
    ${field('Category', `<select name="category">${CATS.map((c) => `<option value="${c.id}" ${c.id === r.category ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`)}
    <div class="rec-car">${field('Vehicle', `<select name="vehicleId"><option value="">— Pick a vehicle —</option>${options(vehicles, r.vehicleId)}</select>`)}</div>
    <div class="rec-pct">${field('Business use %', `<input type="number" name="bizPct" inputmode="decimal" step="1" min="0" max="100" value="${v(r.bizPct ?? 100)}">`)}</div>
    <div class="grid2">
      ${field(isNew ? 'First charge' : 'Started', `<input type="date" name="startDate" value="${r.startDate}" ${isNew ? '' : 'disabled'}>`)}
      ${field('Ends (optional)', `<input type="date" name="endDate" value="${v(r.endDate)}">`)}
    </div>
    <p class="hint" id="rec-hint"></p>`;

  openModal(isNew ? 'Add recurring cost' : 'Edit recurring cost', body, {
    onInput(e) {
      const f = modalForm.elements;
      const sug = e.target?.dataset?.suggest != null ? RECURRING_SUGGESTIONS[+e.target.dataset.suggest] : null;
      if (sug) {
        f.name.value = sug.name; f.category.value = sug.category; f.frequency.value = sug.frequency; f.interval.value = sug.interval || 1;
        if (sug.bizPct != null) f.bizPct.value = sug.bizPct;
        f.amount.focus();
      }
      const cat = catOf(f.category.value);
      modalForm.querySelector('.rec-car').hidden = !cat.mileage;
      modalForm.querySelector('.rec-pct').hidden = cat.mileage;
      const share = cat.mileage ? 100 : +f.bizPct.value || 0;
      const amt = +f.amount.value || 0;
      const past = isNew && f.startDate.value && f.startDate.value <= todayISO()
        ? occurrenceDates({ startDate: f.startDate.value, frequency: f.frequency.value, interval: f.interval.value, endDate: f.endDate.value }, todayISO()).length : 0;
      $('#rec-hint').textContent = [
        sug?.hint || (cat.mileage ? 'Car cost: split automatically by the vehicle’s business use.' : ''),
        !cat.mileage && share < 100 && amt ? `Counts ${money(amt * share / 100)} of each ${money(amt)} charge.` : '',
        past ? `${past} charge${past > 1 ? 's' : ''} up to today will be added now.` : '',
        isNew ? '' : 'Changes apply to future charges; costs already added stay as they are.',
      ].filter(Boolean).join(' ');
    },
    onSubmit(fd) {
      const rec2 = {
        ...r, id: r.id || uid(),
        name: (fd.name || '').trim(), category: fd.category, amount: +fd.amount || 0,
        bizPct: Math.min(100, Math.max(0, numOrNull(fd.bizPct) ?? 100)),
        vehicleId: catOf(fd.category).mileage ? fd.vehicleId || null : null,
        frequency: fd.frequency, interval: Math.max(1, Math.round(+fd.interval || 1)), startDate: isNew ? fd.startDate : r.startDate, endDate: fd.endDate || '',
      };
      if (!rec2.name) { alert('Please enter a name.'); return false; }
      if (!rec2.amount) { alert('Please enter an amount.'); return false; }
      if (!rec2.startDate) { alert('Please pick the date of the first charge.'); return false; }
      if (catOf(rec2.category).mileage && !rec2.vehicleId) { alert('Pick which vehicle this is for. Car costs are split by that vehicle’s business use.'); return false; }
      const i = state.recurring.findIndex((x) => x.id === rec2.id);
      if (i >= 0) state.recurring[i] = rec2; else state.recurring.push(rec2);
      materializeRecurring();
    },
    onDelete: isNew ? null : () => { state.recurring = state.recurring.filter((x) => x.id !== r.id); },
  });
  modalHandlers.deleteMsg = 'Stop this recurring cost? Costs already added will stay in your list.';
}

/* ---------- areas & vehicles ---------- */
function openAreaForm(area) {
  const isNew = !area;
  const a = area || { name: '', rate: null };
  openModal(isNew ? 'Add area' : 'Edit area', `
    ${field('Name', `<input type="text" name="name" required value="${esc(a.name)}" placeholder="e.g. North side">`)}
    ${field('Pay per package $', `<input type="number" name="rate" inputmode="decimal" step="0.01" min="0" value="${a.rate ?? ''}" placeholder="0.00">`)}
    ${field('Use as default for new days', `<input type="checkbox" name="isDefault" ${state.settings.defaultAreaId === a.id ? 'checked' : ''}>`, 'check')}`, {
    onSubmit(fd) {
      if (!fd.name.trim()) { alert('Please enter a name.'); return false; }
      const rec = { ...a, id: a.id || uid(), name: fd.name.trim(), rate: +fd.rate || 0 };
      const i = state.areas.findIndex((x) => x.id === rec.id);
      if (i >= 0) state.areas[i] = rec; else state.areas.push(rec);
      if (fd.isDefault) state.settings.defaultAreaId = rec.id;
    },
    onDelete: isNew ? null : () => removeItem('areas', a.id, 'areaId', 'defaultAreaId'),
  });
}

function openVehicleForm(veh) {
  const isNew = !veh;
  const v = veh || { name: '' };
  const y = curYear();
  const use = isNew ? null : businessUse(v.id, y);
  const setYear = (obj, val) => { const o = { ...(obj || {}) }; if (val == null) delete o[y]; else o[y] = val; return o; };
  openModal(isNew ? 'Add vehicle' : 'Edit vehicle', `
    ${field('Name', `<input type="text" name="name" required value="${esc(v.name)}" placeholder="e.g. 2018 Civic">`)}
    ${field(`Odometer on Jan 1, ${y} (optional)`, `<input type="number" name="startOdo" inputmode="decimal" step="0.1" min="0" value="${v.startOdo?.[y] ?? ''}" placeholder="Makes business-use % more accurate">`)}
    ${field(`Business use % for ${y} (optional)`, `<input type="number" name="usePct" inputmode="decimal" step="0.1" min="0" max="100" value="${v.usePct?.[y] ?? ''}" placeholder="${use ? `Calculated: ${num(use.calc * 100, 1)}%` : 'Leave blank to calculate'}">`)}
    <p class="hint" style="margin-top:-4px">Leave blank and the app calculates it from your odometer readings${use ? ` (${num(use.business)} delivery mi of ${num(use.total)} total so far)` : ''}. Only fill it in if you keep a separate mileage record.</p>
    ${field('Tax deduction method for this vehicle', `<select name="deduction">
      ${[['', 'Follow tax setting'], ['standard', 'Lock: standard mileage'], ['actual', 'Lock: actual costs']].map(([val, l]) => `<option value="${val}" ${(v.deduction || '') === val ? 'selected' : ''}>${l}</option>`).join('')}
    </select>`)}
    ${field('Use as default for new days', `<input type="checkbox" name="isDefault" ${state.settings.defaultVehicleId === v.id ? 'checked' : ''}>`, 'check')}`, {
    onSubmit(fd) {
      if (!fd.name.trim()) { alert('Please enter a name.'); return false; }
      const pct = numOrNull(fd.usePct);
      if (pct != null && (pct < 0 || pct > 100)) { alert('Business use % must be between 0 and 100.'); return false; }
      const rec = { ...v, id: v.id || uid(), name: fd.name.trim(), startOdo: setYear(v.startOdo, numOrNull(fd.startOdo)), usePct: setYear(v.usePct, pct), deduction: fd.deduction || null };
      const i = state.vehicles.findIndex((x) => x.id === rec.id);
      if (i >= 0) state.vehicles[i] = rec; else state.vehicles.push(rec);
      if (fd.isDefault) state.settings.defaultVehicleId = rec.id;
    },
    onDelete: isNew ? null : () => removeItem('vehicles', v.id, 'vehicleId', 'defaultVehicleId'),
  });
}

// Items already used in the log are archived (hidden) rather than deleted, so history stays intact.
function removeItem(listKey, id, refKey, defaultKey) {
  const active = state[listKey].filter((x) => !x.archived);
  if (active.length <= 1) { alert('You need at least one.'); return false; }
  const used = state.days.some((d) => d[refKey] === id) || state.expenses.some((e) => e[refKey] === id);
  if (used) state[listKey].find((x) => x.id === id).archived = true;
  else state[listKey] = state[listKey].filter((x) => x.id !== id);
  if (state.settings[defaultKey] === id) state.settings[defaultKey] = state[listKey].find((x) => !x.archived).id;
}

/* =====================================================================
   Backup / export
   ===================================================================== */
async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (err) { if (err.name === 'AbortError') return false; }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

async function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  if (await shareOrDownload(blob, `hub-tracker-backup-${todayISO()}.json`)) {
    state.lastBackup = todayISO(); save(); render();
  }
}

function importFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.days) || !Array.isArray(data.expenses)) throw new Error('Not a Hub Tracker backup file.');
      if (!confirm(`Restore backup with ${data.days.length} days and ${data.expenses.length} costs? This replaces everything currently in the app.`)) return;
      state = normalize(data);
      save(); render();
      alert('Backup restored.');
    } catch (err) { alert('Could not restore: ' + err.message); }
  };
  reader.readAsText(file);
  $('#import-file').value = '';
}

function exportCSV(kind) {
  const csv = (rows) => rows.map((r) => r.map((x) => { const s = String(x ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');
  let rows;
  if (kind === 'days') {
    rows = [['Date', 'Area', 'Rate', 'Packages', 'Bonus', 'Earnings', 'Vehicle', 'Odometer start', 'Odometer end', 'Miles', 'Start time', 'End time', 'Hours', 'Notes']];
    [...state.days].sort((a, b) => a.date.localeCompare(b.date)).forEach((d) => rows.push([
      d.date, areaName(d.areaId), d.rate, d.packages, d.bonus, dayPay(d).toFixed(2), vehicleName(d.vehicleId),
      d.odoStart, d.odoEnd, dayMiles(d).toFixed(1), d.startTime, d.endTime, dayHours(d) ? dayHours(d).toFixed(2) : '', d.notes,
    ]));
  } else {
    useCache.clear();
    rows = [['Date', 'Category', 'Amount', 'Business %', 'Business amount', 'Vehicle', 'Gallons', 'Odometer', 'Notes']];
    [...state.expenses].sort((a, b) => a.date.localeCompare(b.date)).forEach((e) => rows.push([
      e.date, catOf(e.category).label, e.amount.toFixed(2), (bizPct(e) * 100).toFixed(1), bizAmount(e).toFixed(2),
      e.vehicleId ? vehicleName(e.vehicleId) : '', e.gallons, e.odometer, e.notes,
    ]));
  }
  shareOrDownload(new Blob([csv(rows)], { type: 'text/csv' }), `hub-tracker-${kind}-${todayISO()}.csv`);
}

/* =====================================================================
   Events
   ===================================================================== */
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-action]');
  if (!b || b.closest('#modal')) return;
  const id = b.dataset.id;
  switch (b.dataset.action) {
    case 'tab': ui.tab = b.dataset.tab; window.scrollTo(0, 0); break;
    case 'period': ui.period = b.dataset.period; break;
    case 'week': ui.weekOf = +b.dataset.delta ? addDays(ui.weekOf, +b.dataset.delta) : weekStart(todayISO()); break;
    case 'add-day': return openDayForm({ date: b.dataset.date });
    case 'edit-day': return openDayForm(state.days.find((d) => d.id === id));
    case 'add-exp': return openExpenseForm(null);
    case 'edit-exp': return openExpenseForm(state.expenses.find((x) => x.id === id));
    case 'add-rec': return openRecurringForm(null);
    case 'edit-rec': return openRecurringForm(state.recurring.find((x) => x.id === id));
    case 'add-area': return openAreaForm(null);
    case 'edit-area': return openAreaForm(areaById(id));
    case 'add-vehicle': return openVehicleForm(null);
    case 'edit-vehicle': return openVehicleForm(vehicleById(id));
    case 'workday-preset': state.settings.workDays = JSON.parse(b.dataset.days); save(); break;
    case 'export-json': return exportJSON();
    case 'import-json': return $('#import-file').click();
    case 'export-csv': return exportCSV(b.dataset.kind);
    case 'install':
      if (installEvt) { installEvt.prompt(); await installEvt.userChoice; installEvt = null; }
      break;
    case 'reset':
      if (confirm('Erase ALL days, costs and settings from this device?') && confirm('Are you sure? This cannot be undone unless you have a backup.')) {
        state = defaultState(); save();
      }
      break;
    default: return;
  }
  render();
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.closest('#modal')) return;
  if (t.id === 'import-file') return importFile(t.files[0]);
  if (t.dataset.ui === 'year') ui.year = t.value;
  else if (t.dataset.setting) {
    state.settings[t.dataset.setting] = t.type === 'number' ? +t.value || 0 : t.value;
    save();
  } else if (t.dataset.mrate) {
    state.settings.mileageRates[t.dataset.mrate] = +t.value || 0;
    save();
  } else if (t.dataset.workday != null) {
    const days = new Set(state.settings.workDays);
    t.checked ? days.add(+t.dataset.workday) : days.delete(+t.dataset.workday);
    state.settings.workDays = [...days].sort();
    save();
  } else if (t.dataset.taxpaid != null) {
    const arr = state.taxPaid[ui.year] || [null, null, null, null];
    arr[+t.dataset.taxpaid] = numOrNull(t.value);
    state.taxPaid[ui.year] = arr;
    save();
  } else return;
  render();
});

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (ui.tab === 'settings') render(); });

// Re-render when the app comes back to the foreground on a new day, so "today" stays correct.
let lastRenderDay = todayISO();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && todayISO() !== lastRenderDay) {
    lastRenderDay = todayISO();
    ui.weekOf = weekStart(lastRenderDay);
    materializeRecurring();
    render();
  }
});

/* ---------- boot ---------- */
materializeRecurring();
render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);
navigator.storage?.persist?.(); // ask the browser not to evict our data
