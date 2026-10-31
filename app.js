/* Keuanganku — versi Google Sheet.
   Data utama ada di Google Sheet (lewat Apps Script). HP menyimpan salinan
   untuk dibuka offline, plus antrean transaksi yang belum terkirim. */
(function () {
  'use strict';

  const K_CFG = 'kk_cfg', K_DATA = 'kk_data', K_PENDING = 'kk_pending', K_MODE = 'kk_mode';
  const MONTHS = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const MON3 = MONTHS.map(m => m.slice(0, 3));
  const DAYS = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];

  // ---------- util ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const rp = (n) => (n < 0 ? '-' : '') + 'Rp' + Math.abs(Math.round(n)).toLocaleString('id-ID');
  const rpShort = (n) => {
    const a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e9) return s + (a / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace('.', ',') + 'M';
    if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',') + 'jt';
    if (a >= 1e3) return s + Math.round(a / 1e3) + 'rb';
    return s + Math.round(a);
  };
  const parseNum = (v) => parseInt(String(v).replace(/[^\d]/g, ''), 10) || 0;
  const fmtInput = (n) => n ? n.toLocaleString('id-ID') : '';
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = fromIso(s); d.setDate(d.getDate() + n); return iso(d); };
  const todayStr = () => iso(new Date());
  const fmtDay = (s) => { const d = fromIso(s); return `${d.getDate()} ${MON3[d.getMonth()]}`; };
  const fmtDayY = (s) => { const d = fromIso(s); return `${d.getDate()} ${MON3[d.getMonth()]} ${d.getFullYear()}`; };

  const store = {
    get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), ms || 2400);
  }

  // ---------- state ----------
  let cfg = store.get(K_CFG, { url: '', token: '' });
  let data = store.get(K_DATA, { tx: [], master: { jenis: [], categories: [] }, budgetHist: {}, missionHist: {}, alokasi: null, loadedAt: null });
  let pending = store.get(K_PENDING, []);
  let mode = store.get(K_MODE, 'gaji');
  let periodIdx = -1;          // -1 = periode terbaru
  let currentView = 'dashboard';
  let selectedCat = null;
  let editing = null;          // transaksi yang sedang diubah
  let formJenis = null;
  let busy = false;

  // ---------- klasifikasi ----------
  const isIncome = (t) => /^pemasuk/i.test(t.jenis);
  const isSaving = (t) => !isIncome(t) && /tabungan/i.test(t.category);
  const isExpense = (t) => !isIncome(t) && !isSaving(t);
  const kindOf = (t) => isIncome(t) ? 'in' : isSaving(t) ? 'save' : 'out';
  const isGaji = (t) => isIncome(t) && /^gaji$/i.test(t.category);

  function allTx() {
    return data.tx.concat(pending.map(p => ({ ...p, pending: true, periode: p.periode || periodeFor(p) })));
  }
  // sama dengan aturan di Code.gs: tanggal gaji terakhir <= tanggal transaksi
  function periodeFor(t) {
    if (isGaji(t)) return t.date;
    let best = '';
    data.tx.concat(pending).forEach(r => { if (isGaji(r) && r.date <= t.date && r.date > best) best = r.date; });
    if (best) return best;
    data.tx.forEach(r => { if (r.date <= t.date && r.periode > best) best = r.periode; });
    return best || t.date;
  }

  // ---------- periode ----------
  function periods() {
    const tx = allTx();
    let list;
    if (mode === 'bulan') {
      const keys = new Set(tx.map(t => t.date.slice(0, 7)));
      keys.add(todayStr().slice(0, 7));
      list = [...keys].sort().map(k => {
        const [y, m] = k.split('-').map(Number);
        return { key: k, start: `${k}-01`, end: iso(new Date(y, m, 0)), label: `${MONTHS[m - 1]} ${y}`, ongoing: false,
                 match: (t) => t.date.startsWith(k) };
      });
    } else {
      const keys = [...new Set(tx.map(t => t.periode).filter(Boolean))].sort();
      list = keys.map((k, i) => {
        const next = keys[i + 1];
        const ongoing = !next;
        let end;
        if (next) end = addDays(next, -1);
        else { const d = fromIso(k); d.setMonth(d.getMonth() + 1); d.setDate(d.getDate() - 1); end = iso(d); }
        const label = ongoing ? `${fmtDay(k)} – sekarang` : `${fmtDay(k)} – ${fmtDayY(end)}`;
        return { key: k, start: k, end, label, ongoing, match: (t) => t.periode === k };
      });
    }
    return list;
  }
  function currentPeriod() {
    const list = periods();
    if (!list.length) return null;
    if (periodIdx < 0 || periodIdx >= list.length) periodIdx = list.length - 1;
    return list[periodIdx];
  }

  // ---------- API ----------
  async function api(action, payload) {
    if (!cfg.url || !cfg.token) throw Object.assign(new Error('Belum tersambung ke Google Sheet.'), { setup: true });
    let res;
    try {
      res = await fetch(cfg.url, { method: 'POST', body: JSON.stringify({ token: cfg.token, action, ...payload }) });
    } catch (e) {
      throw Object.assign(new Error('Tidak ada koneksi internet.'), { offline: true });
    }
    let json;
    try { json = await res.json(); } catch (e) {
      throw new Error('Respons Apps Script tidak terbaca. Cek URL dan pengaturan akses deployment ("Siapa saja").');
    }
    if (!json.ok) throw new Error(json.error || 'Gagal.');
    return json;
  }
  function applyData(json) {
    data = { tx: json.tx || [], master: json.master || { jenis: [], categories: [] }, budgetHist: json.budgetHist || {}, missionHist: json.missionHist || {}, alokasi: json.alokasi || null,
             icons: json.icons || {}, loadedAt: new Date().toISOString(), sheetName: json.sheetName };
    store.set(K_DATA, data);
  }
  function setSync(text, err) {
    const s = $('#syncStatus');
    s.textContent = text;
    s.classList.toggle('err', !!err);
  }
  function syncLabel() {
    if (!data.loadedAt) return '';
    const d = new Date(data.loadedAt);
    return `Sinkron ${pad(d.getHours())}:${pad(d.getMinutes())}${fromIso(iso(d)).getTime() === fromIso(todayStr()).getTime() ? '' : ', ' + fmtDay(iso(d))}`;
  }

  async function reload(silent) {
    if (!cfg.url) { render(); return; }
    setSync('Memuat…');
    try {
      if (pending.length) await flushPending(true);
      applyData(await api('load', {}));
      setSync(syncLabel());
      if (!silent) toast('Data terbaru dimuat');
    } catch (e) {
      setSync(e.offline ? 'Offline — ' + syncLabel() : 'Gagal memuat', !e.offline);
      if (!silent || !e.offline) toast(e.message, 4000);
    }
    render();
  }

  async function flushPending(inner) {
    if (!pending.length) return;
    const list = pending.map(({ localId, periode, ...t }) => t);
    const json = await api('addMany', { list });
    pending = []; store.set(K_PENDING, pending);
    applyData(json);
    if (!inner) { setSync(syncLabel()); toast(`${list.length} transaksi terkirim ke sheet`); render(); }
  }

  // ---------- navigasi ----------
  function showView(v) {
    currentView = v;
    $$('.view').forEach(el => el.classList.toggle('hidden', el.id !== 'view-' + v));
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    $('.topbar').classList.toggle('hidden', v === 'settings' || v === 'budget');
    render();
    window.scrollTo(0, 0);
  }
  $$('.nav-btn').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  document.addEventListener('click', e => { const g = e.target.closest('[data-goto]'); if (g) showView(g.dataset.goto); });
  $('#prevPeriod').addEventListener('click', () => { const n = periods().length; if (periodIdx < 0) periodIdx = n - 1; if (periodIdx > 0) periodIdx--; render(); });
  $('#nextPeriod').addEventListener('click', () => { const n = periods().length; if (periodIdx < n - 1) periodIdx++; render(); });
  $('#syncStatus').addEventListener('click', () => reload());
  $('#syncNow').addEventListener('click', async () => {
    try { await flushPending(); } catch (e) { toast(e.message, 4000); }
  });
  window.addEventListener('online', () => { if (pending.length) flushPending().catch(() => {}); });

  // ---------- render ----------
  function render() {
    const p = currentPeriod();
    const list = periods();
    $('#periodLabel').textContent = p ? p.label : 'Belum ada data';
    $('#prevPeriod').disabled = !p || periodIdx <= 0;
    $('#nextPeriod').disabled = !p || periodIdx >= list.length - 1;
    $('#setupNotice').classList.toggle('hidden', !!cfg.url);
    $('#pendingNotice').classList.toggle('hidden', !pending.length);
    $('#pendingText').textContent = `${pending.length} transaksi belum terkirim ke sheet.`;
    if (currentView === 'dashboard') renderDashboard(p, list);
    if (currentView === 'history') renderHistory(p);
    if (currentView === 'budget') { renderBudgetTable(); renderBudgetForm(); }
    if (currentView === 'settings') renderSettings();
  }

  // ---------- ikon & warna kategori ----------
  const ico = (name, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const ICON_CHOICES = ['home','receipt','bolt','droplet','wifi','device-mobile','gift','heart-handshake','alert-triangle','first-aid-kit','pill',
    'shopping-cart','basket','shirt','tools-kitchen-2','coffee','pizza','bread','beer','motorbike','car','bus','gas-station','plane',
    'ball-tennis','barbell','device-gamepad-2','movie','music','sparkles','school','book','baby-carriage','paw','building-church','users','friends',
    'cake','scissors','tools','package','truck','building-store','credit-card','building-bank','receipt-tax','briefcase','pig-money','cash','heart','tag','dots'];
  const ICON_RULES = [
    [/sewa|kos|kontrak|rumah/i, 'home'], [/tagihan|listrik|spl|iuran/i, 'receipt'], [/air|pdam/i, 'droplet'],
    [/pulsa|internet|wifi|kuota/i, 'wifi'], [/donasi|hadiah|persembahan|perpuluhan/i, 'gift'], [/tak terduga|darurat/i, 'alert-triangle'],
    [/kesehatan|obat|dokter/i, 'first-aid-kit'], [/belanja|groceries/i, 'shopping-cart'], [/makan|kuliner|food/i, 'tools-kitchen-2'],
    [/kopi|coffee/i, 'coffee'], [/transport|bensin|ojol|parkir/i, 'motorbike'], [/hiburan|olahraga|badmin/i, 'ball-tennis'],
    [/pendidikan|kursus|sekolah|buku/i, 'school'], [/keluarga|orang tua|mamak|adik/i, 'users'], [/gereja|ibadah/i, 'building-church'],
    [/pakaian|baju/i, 'shirt'], [/tabungan|investasi/i, 'pig-money'], [/gaji|bonus|freelance|proyek/i, 'cash'], [/transfer/i, 'credit-card'],
    [/hewan|kucing|anjing/i, 'paw'], [/liburan|travel/i, 'plane']
  ];
  const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948', '#0f8b8d', '#8c5a3c', '#5b6b7f', '#7a8b2a'];
  function catIcon(name) {
    if (data.icons && data.icons[name]) return data.icons[name];
    const r = ICON_RULES.find(([re]) => re.test(name));
    return r ? r[1] : 'tag';
  }
  // warna tetap per kategori: mengikuti urutan di tab master, bukan peringkat pengeluaran
  function catOrder() {
    const names = data.master.categories.map(c => c.name).filter(n => !/^gaji$/i.test(n) && !/tabungan/i.test(n));
    allTx().filter(isExpense).forEach(t => { if (!names.includes(t.category)) names.push(t.category); });
    return names;
  }
  const catColor = (name) => { const i = catOrder().indexOf(name); return PALETTE[(i < 0 ? 0 : i) % PALETTE.length]; };
  function shade(hex, k) {   // campur warna kategori dengan putih untuk sub kategori
    const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v + (255 - v) * (1 - k)));
    return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
  }
  const budgetState = (spent, b) => !b ? 'none' : spent > b ? 'over' : spent / b > 0.85 ? 'warn' : 'good';

  function selectCat(c) { selectedCat = selectedCat === c ? null : c; render(); }

  function renderDashboard(p, list) {
    const tx = p ? allTx().filter(p.match) : [];
    const sum = (f) => tx.filter(f).reduce((s, t) => s + t.amount, 0);
    const inc = sum(isIncome), exp = sum(isExpense), sav = sum(isSaving);
    $('#heroValue').textContent = rp(inc - exp - sav);
    $('#heroSub').textContent = inc ? `${Math.round((exp / inc) * 100)}% pemasukan terpakai, ${Math.round((sav / inc) * 100)}% ditabung` : '';
    $('#sumIncome').textContent = rpShort(inc);
    $('#sumExpense').textContent = rpShort(exp);
    $('#sumSaving').textContent = rpShort(sav);

    const byCat = {};
    tx.filter(isExpense).forEach(t => byCat[t.category] = (byCat[t.category] || 0) + t.amount);
    const budget = effective(data.budgetHist, snapKey(p)) || {};
    renderCatGrid(byCat, budget, exp, tx);

    // harian (ikut tersaring kategori terpilih)
    const f = (t) => isExpense(t) && (!selectedCat || t.category === selectedCat);
    $('#dailyTitle').textContent = selectedCat ? `Harian · ${selectedCat}` : 'Pengeluaran harian';
    if (p) {
      const days = [];
      for (let d = p.start; d <= p.end; d = addDays(d, 1)) days.push({ date: d, value: 0 });
      tx.filter(f).forEach(t => { const x = days.find(d => d.date === t.date); if (x) x.value += t.amount; });
      renderColumns($('#dailyChart'), days.map((d, i) => ({
        value: d.value, tip: `${DAYS[fromIso(d.date).getDay()]}, ${fmtDay(d.date)}: ${rp(d.value)}`,
        tick: (i === 0 || i === days.length - 1 || (i % 7 === 0 && days.length - 1 - i >= 3)) ? fmtDay(d.date) : '',
        hl: d.date === todayStr()
      })), selectedCat ? `Belum ada pengeluaran ${selectedCat} di periode ini.` : 'Belum ada pengeluaran di periode ini.', false, selectedCat && catColor(selectedCat));
    } else $('#dailyChart').innerHTML = '<div class="empty">Belum ada data.</div>';

    renderBudgetMini(p, byCat, budget);
    if (p) renderMissions(p, list); else $('#missionList').innerHTML = '<div class="empty">Belum ada data.</div>';

    // tren 6 periode (ikut tersaring)
    $('#trendTitle').textContent = selectedCat ? `${selectedCat} · 6 periode terakhir` : 'Pengeluaran 6 periode terakhir';
    const end = periodIdx < 0 ? list.length - 1 : periodIdx;
    const last = list.slice(Math.max(0, end - 5), end + 1);
    const all = allTx();
    renderColumns($('#trendChart'), last.map((q, i) => {
      const v = all.filter(q.match).filter(f).reduce((s, t) => s + t.amount, 0);
      const lbl = mode === 'bulan' ? MON3[Number(q.key.slice(5, 7)) - 1] : fmtDay(q.start);
      return { value: v, tip: `${q.label}: ${rp(v)}`, tick: lbl, hl: i === last.length - 1 };
    }), 'Belum ada data.', true, selectedCat && catColor(selectedCat));
  }

  // ---------- grid ikon kategori + donat ----------
  function renderCatGrid(byCat, budget, exp, tx) {
    const el = $('#catGrid');
    const names = [...new Set([...Object.keys(byCat), ...Object.keys(budget).filter(c => budget[c] > 0)])]
      .filter(c => !/tabungan/i.test(c));
    if (selectedCat && !names.includes(selectedCat)) names.push(selectedCat);
    names.sort((a, b) => (byCat[b] || 0) - (byCat[a] || 0) || catOrder().indexOf(a) - catOrder().indexOf(b));
    if (!names.length) { el.innerHTML = '<div class="empty">Belum ada pengeluaran di periode ini.</div>'; $('#catDetail').innerHTML = ''; return; }

    const icons = names.map(c => {
      const spent = byCat[c] || 0, b = budget[c] || 0, st = budgetState(spent, b);
      const C = 2 * Math.PI * 21, p = b ? Math.min(1, spent / b) : 0;
      return `<button class="cat${selectedCat && selectedCat !== c ? ' dim' : ''}${selectedCat === c ? ' on' : ''}" data-cat="${esc(c)}" aria-label="${esc(c)}">
        <span class="cat-ic"><svg viewBox="0 0 50 50" class="ring" aria-hidden="true"><circle cx="25" cy="25" r="21" class="ring-track"/>
          ${b ? `<circle cx="25" cy="25" r="21" class="ring-val ${st}" stroke-dasharray="${(p * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 25 25)"/>` : ''}
          <circle cx="25" cy="25" r="15.5" fill="${catColor(c)}"/></svg>${ico(catIcon(c), 'cat-glyph')}</span>
        <span class="cat-nm">${esc(c)}</span><span class="cat-am ${st}">${rpShort(spent)}</span></button>`;
    });
    el.innerHTML = `<div class="donut-cell">${donutSvg(byCat, names, tx)}</div>` + icons.join('');
    $$('.cat', el).forEach(b => b.addEventListener('click', () => selectCat(b.dataset.cat)));
    $('.donut-cell', el).addEventListener('click', () => { if (selectedCat) selectCat(selectedCat); });
    renderCatDetail(byCat, budget, tx);
  }

  function arcPath(cx, cy, r, a0, a1) {
    const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  function subTotals(tx, cat) {
    const by = {};
    tx.filter(t => isExpense(t) && t.category === cat).forEach(t => { const k = t.sub || '(tanpa sub)'; by[k] = (by[k] || 0) + t.amount; });
    return Object.entries(by).sort((a, b) => b[1] - a[1]);
  }
  function donutSvg(byCat, names, tx) {
    let segs, label, total, sub;
    if (selectedCat) {
      const base = catColor(selectedCat);
      segs = subTotals(tx, selectedCat).map(([n, v], i) => ({ v, c: shade(base, [1, 0.72, 0.5, 0.36, 0.26][i] || 0.2) }));
      total = byCat[selectedCat] || 0; label = selectedCat;
      const b = (effective(data.budgetHist, snapKey(currentPeriod())) || {})[selectedCat];
      sub = b ? `dari ${rpShort(b)}` : 'tanpa budget';
    } else {
      segs = names.filter(n => byCat[n]).map(n => ({ v: byCat[n], c: catColor(n) }));
      total = segs.reduce((s, x) => s + x.v, 0); label = 'Pengeluaran'; sub = 'ketuk ikon';
    }
    let a = -Math.PI / 2, out = '';
    const gap = segs.length > 1 ? 0.03 : 0;
    if (!total) out = `<circle cx="80" cy="80" r="62" class="ring-track" style="stroke-width:16"/>`;
    segs.forEach(s => {
      const a1 = a + (s.v / total) * 2 * Math.PI;
      out += s.v / total > 0.9999 ? `<circle cx="80" cy="80" r="62" fill="none" stroke="${s.c}" stroke-width="16"/>`
        : `<path d="${arcPath(80, 80, 62, a + gap / 2, Math.max(a + gap / 2 + 0.002, a1 - gap / 2))}" stroke="${s.c}" stroke-width="16" fill="none"/>`;
      a = a1;
    });
    return `<svg viewBox="0 0 160 160" class="donut" role="img" aria-label="Proporsi pengeluaran">${out}
      <text x="80" y="66" text-anchor="middle" class="d-lbl">${esc(label.length > 16 ? label.slice(0, 15) + '…' : label)}</text>
      <text x="80" y="89" text-anchor="middle" class="d-val">${rpShort(total)}</text>
      <text x="80" y="106" text-anchor="middle" class="d-sub">${esc(sub)}</text></svg>`;
  }

  function renderCatDetail(byCat, budget, tx) {
    const el = $('#catDetail');
    if (!selectedCat) { el.innerHTML = '<div class="legend"><span><i class="dot good"></i>aman</span><span><i class="dot warn"></i>hampir habis</span><span><i class="dot over"></i>lewat budget</span><span class="muted-s">· cincin = budget</span></div>'; return; }
    const c = selectedCat, spent = byCat[c] || 0, b = budget[c] || 0, st = budgetState(spent, b);
    const subs = subTotals(tx, c);
    const base = catColor(c);
    el.innerHTML = `<div class="detail">
      <div class="detail-head"><button class="chip" id="clearCat" style="background:${base}">${ico(catIcon(c))}${esc(c)}${ico('x')}</button>
        <span class="detail-b ${st}">${b ? (spent > b ? `lewat ${rp(spent - b)}` : `sisa ${rp(b - spent)}`) : 'tanpa budget'}</span></div>
      ${subs.length ? subs.map(([n, v], i) => `<div class="sub-row"><i class="sw" style="background:${shade(base, [1, 0.72, 0.5, 0.36, 0.26][i] || 0.2)}"></i><span class="sub-n">${esc(n)}</span><span class="sub-p">${Math.round(v / spent * 100)}%</span><span class="sub-v">${rp(v)}</span></div>`).join('')
        : '<div class="empty">Belum ada transaksi di kategori ini.</div>'}
      <div class="detail-actions"><button class="btn small" id="catHistory">${ico('list')} Riwayat ${esc(c)}</button><button class="btn small primary" id="catAdd">${ico('plus')} Catat ${esc(c)}</button></div>
    </div>`;
    $('#clearCat').addEventListener('click', () => selectCat(c));
    $('#catHistory').addEventListener('click', () => showView('history'));
    $('#catAdd').addEventListener('click', () => openSheet(null));
  }

  // ringkasan anggaran di Ringkasan (tabel lengkap ada di Rencana)
  function renderBudgetMini(p, byCat, b) {
    const el = $('#budgetMini');
    const cats = Object.keys(b).filter(c => b[c] > 0);
    if (!cats.length) { el.innerHTML = '<div class="empty">Belum ada anggaran. <button class="btn small" data-goto="budget">Atur anggaran</button></div>'; return; }
    const tb = cats.reduce((s, c) => s + b[c], 0), ts = cats.reduce((s, c) => s + (byCat[c] || 0), 0);
    const over = cats.filter(c => (byCat[c] || 0) > b[c]);
    const st = budgetState(ts, tb);
    let alloc = '';
    if (mode === 'gaji' && p && data.alokasi?.aktif) {
      const tx = allTx().filter(p.match);
      if (!p.ongoing) { const a = tx.find(isAuto); alloc = a ? `✓ ${rp(a.amount)} sudah dialokasikan ke ${esc(data.alokasi.sub)}` : ''; }
      else { const pr = projectAlokasi(tx, b); alloc = pr.amount > 0 ? `Perkiraan ke ${esc(data.alokasi.sub)}: <b>${rp(pr.amount)}</b>` : `Belum ada sisa untuk ${esc(data.alokasi.sub)}`; }
    }
    el.innerHTML = `<div class="bud-head"><span>${rpShort(ts)} dari ${rpShort(tb)}</span><span class="${st}">${ts > tb ? `lewat ${rp(ts - tb)}` : `sisa ${rp(tb - ts)}`}</span></div>
      <div class="bud-track"><div class="bud-fill ${st === 'over' ? 'over' : st === 'warn' ? 'warn' : ''}" style="width:${Math.min(100, ts / tb * 100)}%"></div></div>
      ${over.length ? `<div class="bud-status">✕ Lewat budget: ${over.map(c => `<button class="link" data-cat="${esc(c)}">${esc(c)}</button>`).join(', ')}</div>` : '<div class="bud-status">✓ Semua kategori masih dalam budget</div>'}
      ${alloc ? `<div class="alloc">${alloc}</div>` : ''}
      <button class="btn small" data-goto="budget" style="margin-top:10px">Lihat tabel anggaran ›</button>`;
    $$('.link', el).forEach(b => b.addEventListener('click', () => { selectedCat = b.dataset.cat; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
  }

  // tabel anggaran lengkap (tab Rencana)
  function renderBudgetTable() {
    const el = $('#budgetTable');
    const p = currentPeriod();
    const tx = p ? allTx().filter(p.match) : [];
    const byCat = {};
    tx.filter(isExpense).forEach(t => byCat[t.category] = (byCat[t.category] || 0) + t.amount);
    const b = effective(data.budgetHist, snapKey(p)) || {};
    $('#budgetTableTitle').textContent = p ? `Anggaran · ${p.label}` : 'Anggaran';
    const rows = [...new Set([...Object.keys(b).filter(c => b[c] > 0), ...Object.keys(byCat)])]
      .map(c => ({ c, s: byCat[c] || 0, b: b[c] || 0 }))
      .sort((x, y) => (y.b ? y.s / y.b : 9) - (x.b ? x.s / x.b : 9) || y.s - x.s);
    if (!rows.length) { el.innerHTML = '<div class="empty">Belum ada anggaran maupun pengeluaran.</div>'; return; }
    const tb = rows.reduce((s, r) => s + r.b, 0), ts = rows.filter(r => r.b).reduce((s, r) => s + r.s, 0);
    const icon = { good: '✓', warn: '!', over: '✕', none: '' };
    let html = `<table class="btable"><colgroup><col style="width:42%"><col style="width:19%"><col style="width:19%"><col style="width:20%"></colgroup>
      <thead><tr><th>Category</th><th>Terpakai</th><th>Budget</th><th>Sisa</th></tr></thead><tbody>`;
    rows.forEach(r => {
      const st = budgetState(r.s, r.b);
      html += `<tr data-cat="${esc(r.c)}"><td><span class="tcat">${ico(catIcon(r.c))}<span>${esc(r.c)}</span></span>
        ${r.b ? `<div class="mini-track"><div class="mini-fill ${st}" style="width:${Math.min(100, r.s / r.b * 100)}%"></div></div>` : ''}</td>
        <td>${rpShort(r.s)}</td><td class="muted-c">${r.b ? rpShort(r.b) : '–'}</td><td class="${st}">${r.b ? `${icon[st]} ${rpShort(r.b - r.s)}` : ''}</td></tr>`;
    });
    html += `</tbody><tfoot><tr><td>Total dianggarkan</td><td>${rpShort(ts)}</td><td>${rpShort(tb)}</td><td class="${ts > tb ? 'over' : ''}">${rpShort(tb - ts)}</td></tr></tfoot></table>`;
    if (mode === 'gaji' && p && data.alokasi?.aktif && Object.keys(b).length) {
      const pr = projectAlokasi(tx, b), sub = esc(data.alokasi.sub);
      const auto = !p.ongoing && tx.find(isAuto);
      html += `<div class="alloc">${auto ? `✓ ${rp(auto.amount)} sudah dialokasikan ke ${sub}.`
        : pr.amount > 0 ? `Perkiraan <b>${rp(pr.amount)}</b> masuk ke ${sub} saat gaji berikutnya dicatat.`
        : `Belum ada sisa untuk ${sub}${pr.sisa < 0 ? ` — total lewat ${rp(-pr.sisa)}` : ''}.`}</div>`;
    }
    el.innerHTML = html;
    $$('tr[data-cat]', el).forEach(tr => tr.addEventListener('click', () => { selectedCat = tr.dataset.cat; showView('dashboard'); }));
  }

  // ---------- chart: kolom vertikal (harian & tren) ----------
  function renderColumns(el, data, emptyMsg, valueLabels, color) {
    const max = Math.max(0, ...data.map(d => d.value));
    if (!max) { el.innerHTML = `<div class="empty">${emptyMsg}</div>`; return; }
    const W = 340, H = valueLabels ? 160 : 150, padL = valueLabels ? 4 : 34, padB = 20, padT = valueLabels ? 18 : 8;
    const plotW = W - padL, plotH = H - padB - padT;
    const n = data.length, slot = plotW / n;
    const bw = valueLabels ? Math.min(36, slot * 0.6) : Math.max(3, slot - 2);
    const top = valueLabels ? max : niceCeil(max);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
    if (!valueLabels) {
      [0, 0.5, 1].forEach(f => {
        const y = padT + plotH - f * plotH;
        svg += `<line class="grid" x1="${padL}" x2="${W}" y1="${y}" y2="${y}"></line>`;
        svg += `<text x="${padL - 4}" y="${y + 4}" text-anchor="end">${rpShort(top * f)}</text>`;
      });
    } else {
      svg += `<line class="grid" x1="${padL}" x2="${W}" y1="${padT + plotH}" y2="${padT + plotH}"></line>`;
    }
    data.forEach((d, i) => {
      const cx = padL + i * slot + slot / 2, x = cx - bw / 2;
      const h = (d.value / top) * plotH;
      svg += `<rect class="hit" x="${padL + i * slot}" y="0" width="${slot}" height="${H}" data-tip="${esc(d.tip)}"></rect>`;
      if (d.value > 0) {
        const r = Math.min(valueLabels ? 4 : 2, bw / 2, h);
        const fill = color ? ` style="fill:${valueLabels && !d.hl ? shade(color, 0.45) : color}"` : '';
        svg += `<path${fill} class="bar${valueLabels ? (d.hl ? ' cur' : ' soft') : ''}" d="M${x},${padT + plotH} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r} h${bw - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z"></path>`;
        if (valueLabels) svg += `<text class="val" x="${cx}" y="${padT + plotH - h - 5}" text-anchor="middle">${rpShort(d.value)}</text>`;
      } else svg += '<g></g>';
      if (d.tick) {
        const anchor = valueLabels ? 'middle' : (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle');
        const tx = valueLabels ? cx : (i === 0 ? x : i === n - 1 ? x + bw : cx);
        svg += `<text x="${tx}" y="${H - 4}" text-anchor="${anchor}"${d.hl ? ' class="lbl"' : ''}>${esc(d.tick)}</text>`;
      }
    });
    el.innerHTML = svg + '</svg>';
    bindTips(el);
  }
  function niceCeil(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  function bindTips(el) {
    const tip = $('#tooltip');
    $$('.hit', el).forEach(h => {
      const show = (e) => {
        $$('.bar.hover', el).forEach(b => b.classList.remove('hover'));
        const bar = h.nextElementSibling;
        if (bar && bar.classList.contains('bar')) bar.classList.add('hover');
        tip.textContent = h.dataset.tip;
        tip.classList.remove('hidden');
        tip.style.left = Math.min(window.innerWidth - 100, Math.max(100, e.clientX)) + 'px';
        tip.style.top = e.clientY + 'px';
      };
      h.addEventListener('pointerenter', show);
      h.addEventListener('pointermove', show);
      h.addEventListener('pointerdown', show);
      h.addEventListener('pointerleave', hideTip);
    });
  }
  function hideTip() { $('#tooltip').classList.add('hidden'); $$('.bar.hover').forEach(b => b.classList.remove('hover')); }
  window.addEventListener('scroll', hideTip, { passive: true });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.hit')) hideTip(); });

  // ---------- anggaran, alokasi & misi ----------
  const isAuto = (t) => (t.note || '').startsWith((data.alokasi && data.alokasi.penanda) || '[AUTO]');
  function gajiKeys() { return [...new Set(allTx().filter(isGaji).map(t => t.date))].sort(); }
  // kunci periode gaji yang berlaku pada tanggal d
  function gajiKeyAt(d) { let k = ''; gajiKeys().forEach(g => { if (g <= d) k = g; }); return k; }
  function currentGajiKey() { const g = gajiKeys(); return g.length ? g[g.length - 1] : todayStr(); }
  function effective(hist, key) {
    const ks = Object.keys(hist || {}).filter(k => k <= key).sort();
    return ks.length ? hist[ks[ks.length - 1]] : null;
  }
  const snapKey = (p) => (p ? (mode === 'gaji' ? p.key : (gajiKeyAt(p.end) || p.end)) : currentGajiKey());
  function elapsedOf(p) {
    const t = todayStr();
    if (!p || t < p.start || t > p.end) return t > (p ? p.end : t) ? 1 : 0;
    const total = (fromIso(p.end) - fromIso(p.start)) / 864e5 + 1;
    return ((fromIso(t) - fromIso(p.start)) / 864e5 + 1) / total;
  }
  const daysLeft = (p) => { const t = todayStr(); return p && t >= p.start && t <= p.end ? (fromIso(p.end) - fromIso(t)) / 864e5 + 1 : 0; };

  // sama dengan hitungAlokasi di Code.gs
  function projectAlokasi(tx, budget) {
    const real = tx.filter(t => !isAuto(t));
    const sum = (f) => real.filter(f).reduce((s, t) => s + t.amount, 0);
    const byCat = {};
    real.filter(isExpense).forEach(t => byCat[t.category] = (byCat[t.category] || 0) + t.amount);
    let sisa = 0;
    Object.keys(budget).forEach(c => { const s = budget[c] - (byCat[c] || 0); sisa += data.alokasi?.mode === 'positif' ? Math.max(0, s) : s; });
    const uang = sum(isIncome) - sum(isExpense) - sum(isSaving);
    return { sisa, uang, amount: Math.max(0, Math.min(sisa, uang)) };
  }

  // ----- misi -----
  const missionLabel = (m) => m.sub || m.category;
  const missionMatch = (m) => (t) => isExpense(t) && t.category === m.category && (!m.sub || t.sub === m.sub);
  const missionId = (m) => m.category + '›' + (m.sub || '');
  function renderMissions(p, list) {
    const el = $('#missionList');
    const ms = effective(data.missionHist, snapKey(p)) || [];
    if (!ms.length) {
      el.innerHTML = '<div class="empty">Belum ada misi. <button class="btn small" data-goto="budget">Buat misi</button></div>';
      return;
    }
    const idx = list.findIndex(q => q.key === p.key);
    const prev = idx > 0 ? list[idx - 1] : null;
    const all = allTx();
    const closed = !p.ongoing && todayStr() > p.end;
    const left = daysLeft(p), elapsed = elapsedOf(p);
    el.innerHTML = ms.map(m => {
      const f = missionMatch(m);
      const cur = all.filter(p.match).filter(f).reduce((s, t) => s + t.amount, 0);
      const last = prev ? all.filter(prev.match).filter(f).reduce((s, t) => s + t.amount, 0) : null;
      const ratio = m.target ? cur / m.target : 0;
      let cls = '', status;
      if (cur > m.target) { cls = 'over'; status = `✕ Gagal — lewat ${rp(cur - m.target)}`; }
      else if (closed) status = `✓ Berhasil — hemat ${rp(m.target - cur)}`;
      else {
        const perDay = left ? (m.target - cur) / left : 0;
        if (ratio > Math.max(0.8, elapsed + 0.1)) cls = 'warn';
        status = `${cls ? '!' : '✓'} Sisa ${rp(m.target - cur)}${left ? ` · maks ${rp(perDay)}/hari, ${left} hari lagi` : ''}`;
      }
      const vsLast = last === null ? '' : last > 0
        ? (cur <= last ? `turun ${Math.round((1 - cur / last) * 100)}% dari periode lalu (${rpShort(last)})` : `naik dari periode lalu (${rpShort(last)})`)
        : 'periode lalu Rp0';
      const rec = missionRecord(m, list, idx);
      return `<div class="mission">
        <div class="bud-head"><span><b>${esc(missionLabel(m))}</b>${m.sub ? `<span class="pill">${esc(m.category)}</span>` : ''}</span><span>${rpShort(cur)} / ${rpShort(m.target)}</span></div>
        <div class="bud-track"><div class="bud-fill ${cls}" style="width:${Math.min(100, ratio * 100)}%"></div></div>
        <div class="bud-status">${status}</div>
        <div class="mission-meta">${[vsLast, rec].filter(Boolean).join(' · ')}</div>
      </div>`;
    }).join('');
  }
  // rekor: berapa periode selesai (sebelum periode ini) misi yang sama berhasil
  function missionRecord(m, list, idx) {
    let win = 0, n = 0;
    const all = allTx();
    for (let i = 0; i < idx; i++) {
      const q = list[i];
      const ms = effective(data.missionHist, snapKey(q)) || [];
      const same = ms.find(x => missionId(x) === missionId(m));
      if (!same || Object.keys(data.missionHist || {}).sort()[0] > snapKey(q)) continue;
      n++;
      const v = all.filter(q.match).filter(missionMatch(same)).reduce((s, t) => s + t.amount, 0);
      if (v <= same.target) win++;
    }
    return n ? `rekor ${win}/${n} periode berhasil` : '';
  }

  // ----- form anggaran & misi -----
  function expenseCategories() {
    const names = data.master.categories.map(c => c.name).filter(n => !/tabungan|gaji/i.test(n));
    return names.length ? names : [...new Set(data.tx.filter(isExpense).map(t => t.category))];
  }
  // asal nilai anggaran/misi yang berlaku di periode sekarang
  function scopeInfo(hist, what) {
    const key = currentGajiKey();
    const ks = Object.keys(hist || {}).filter(k => k <= key).sort();
    if (!ks.length) return `<b>Periode ${fmtDay(key)}</b> · belum ada ${what}.`;
    const src = ks[ks.length - 1];
    return src === key
      ? `<b>Periode ${fmtDay(key)}</b> · diatur khusus mulai periode ini. Periode berikutnya otomatis memakai angka yang sama.`
      : `<b>Periode ${fmtDay(key)}</b> · diteruskan otomatis dari periode ${fmtDayY(src)}. Tidak perlu input ulang.`;
  }
  function prevGajiKey() { const g = gajiKeys(); return g.length >= 2 ? g[g.length - 2] : null; }
  function fillBudgetInputs(b) {
    $$('#budgetForm input').forEach(i => { i.value = fmtInput((b || {})[i.dataset.cat] || 0); });
  }
  function renderBudgetForm() {
    const key = currentGajiKey();
    $('#budgetScope').innerHTML = scopeInfo(data.budgetHist, 'anggaran');
    $('#missionScope').innerHTML = scopeInfo(data.missionHist, 'misi');
    const b = effective(data.budgetHist, key) || {};
    const cats = expenseCategories();
    Object.keys(b).forEach(c => { if (!cats.includes(c)) cats.push(c); });   // kategori di anggaran tapi tidak ada di master
    $('#budgetForm').innerHTML = cats.map(c =>
      `<div class="bud-input-row"><span>${esc(c)}</span>
       <input type="text" inputmode="numeric" data-cat="${esc(c)}" value="${fmtInput(b[c] || 0)}" placeholder="0"></div>`).join('')
      || '<div class="empty">Kategori belum termuat. Sambungkan ke sheet dulu.</div>';
    $$('#budgetForm input').forEach(i => i.addEventListener('input', () => { i.value = fmtInput(parseNum(i.value)); }));
    missionDraft = JSON.parse(JSON.stringify(effective(data.missionHist, key) || []));
    renderMissionForm();
  }
  $('#copyBudget').addEventListener('click', () => {
    const pk = prevGajiKey();
    const b = pk && effective(data.budgetHist, pk);
    if (!b) { toast('Periode sebelumnya belum punya anggaran'); return; }
    fillBudgetInputs(b);
    toast(`Diisi dari periode ${fmtDay(pk)} — ketuk Simpan anggaran`, 3500);
  });
  $('#copyMissions').addEventListener('click', () => {
    const pk = prevGajiKey();
    const m = pk && effective(data.missionHist, pk);
    if (!m) { toast('Periode sebelumnya belum punya misi'); return; }
    missionDraft = JSON.parse(JSON.stringify(m));
    renderMissionForm();
    toast(`Diisi dari periode ${fmtDay(pk)} — ketuk Simpan misi`, 3500);
  });
  let missionDraft = [];
  function missionOptions() {
    const opts = [];
    expenseCategories().forEach(c => {
      opts.push({ v: c + '›', l: `${c} (semua)` });
      const m = data.master.categories.find(x => x.name === c);
      (m ? m.subs : []).forEach(s => opts.push({ v: c + '›' + s, l: `${s} (${c})` }));
    });
    return opts;
  }
  function renderMissionForm() {
    const opts = missionOptions();
    $('#missionForm').innerHTML = missionDraft.map((m, i) => {
      const id = missionId(m);
      const has = opts.some(o => o.v === id);
      return `<div class="row-edit" data-i="${i}">
        <select class="name">${has ? '' : `<option value="${esc(id)}">${esc(m.category + (m.sub ? ' › ' + m.sub : ''))}</option>`}${opts.map(o => `<option value="${esc(o.v)}"${o.v === id ? ' selected' : ''}>${esc(o.l)}</option>`).join('')}</select>
        <input class="num" inputmode="numeric" value="${fmtInput(m.target)}" placeholder="Target">
        <button type="button" class="del" aria-label="Hapus misi">✕</button></div>`;
    }).join('') || '<p class="muted">Belum ada misi. Contoh: Makanan › Kopi maksimal Rp40.000.</p>';
    $$('#missionForm .row-edit').forEach(row => {
      const m = missionDraft[row.dataset.i];
      $('select', row).addEventListener('change', e => { const [c, s] = e.target.value.split('›'); m.category = c; m.sub = s || ''; });
      const n = $('.num', row);
      n.addEventListener('input', () => { n.value = fmtInput(parseNum(n.value)); m.target = parseNum(n.value); });
      $('.del', row).addEventListener('click', () => { missionDraft.splice(row.dataset.i, 1); renderMissionForm(); });
    });
  }
  $('#addMission').addEventListener('click', () => {
    const o = missionOptions().find(x => !x.v.endsWith('›')) || missionOptions()[0];
    if (!o) { toast('Kategori belum termuat'); return; }
    const [c, s] = o.v.split('›');
    missionDraft.push({ category: c, sub: s || '', target: 0 });
    renderMissionForm();
  });
  async function saveWithBtn(btn, action, payload, msg) {
    btn.classList.add('loading');
    try { applyData(await api(action, payload)); toast(msg); render(); }
    catch (e) { toast(e.message, 4000); }
    btn.classList.remove('loading');
  }
  $('#saveBudget').addEventListener('click', () => {
    const b = {};
    $$('#budgetForm input').forEach(i => { const n = parseNum(i.value); if (n > 0) b[i.dataset.cat] = n; });
    saveWithBtn($('#saveBudget'), 'setBudgets', { periode: currentGajiKey(), budgets: b }, 'Anggaran disimpan');
  });
  $('#saveMissions').addEventListener('click', () => {
    const list = missionDraft.filter(m => m.target > 0);
    const ids = list.map(missionId);
    if (new Set(ids).size !== ids.length) { toast('Ada misi ganda untuk kategori yang sama'); return; }
    if (list.length < missionDraft.length) toast('Misi tanpa target diabaikan');
    saveWithBtn($('#saveMissions'), 'setMissions', { periode: currentGajiKey(), missions: list }, 'Misi disimpan');
  });

  // ---------- riwayat ----------
  $('#searchBox').addEventListener('input', () => renderHistory(currentPeriod()));
  $('#filterType').addEventListener('change', () => renderHistory(currentPeriod()));
  function renderHistory(p) {
    const q = $('#searchBox').value.trim().toLowerCase();
    const ft = $('#filterType').value;
    let list = allTx();
    if (!q && p) list = list.filter(p.match);
    if (selectedCat) list = list.filter(t => t.category === selectedCat);
    $('#histChip').innerHTML = selectedCat
      ? `<button class="chip" id="histClear" style="background:${catColor(selectedCat)}">${ico(catIcon(selectedCat))}${esc(selectedCat)}${ico('x')}</button><span class="muted-s">${list.length} transaksi · ${rp(list.reduce((s, t) => s + t.amount, 0))}</span>`
      : '';
    if (selectedCat) $('#histClear').addEventListener('click', () => selectCat(selectedCat));
    list = list.filter(t => !ft || kindOf(t) === ft)
      .filter(t => !q || [t.note, t.category, t.sub].join(' ').toLowerCase().includes(q))
      .sort((a, b) => b.date.localeCompare(a.date) || (b.row || 1e9) - (a.row || 1e9));
    const el = $('#txList');
    if (!list.length) { el.innerHTML = `<div class="empty">${q ? 'Tidak ada yang cocok.' : 'Tidak ada transaksi di periode ini.'}</div>`; return; }
    const shown = list.slice(0, 300);
    const groups = {};
    shown.forEach(t => (groups[t.date] = groups[t.date] || []).push(t));
    el.innerHTML = (q ? `<p class="muted">${list.length} hasil di semua periode${list.length > 300 ? ' (300 ditampilkan)' : ''}</p>` : '')
      + Object.entries(groups).map(([date, items]) => {
        const d = fromIso(date);
        const out = items.filter(t => !isIncome(t)).reduce((s, t) => s + t.amount, 0);
        return `<div class="day-group"><div class="day-head"><span>${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}</span><span>${out ? '-' + rp(out) : ''}</span></div>
          ${items.map(txItem).join('')}</div>`;
      }).join('');
    $$('.tx', el).forEach(b => b.addEventListener('click', () => {
      const t = allTx().find(x => (b.dataset.row && String(x.row) === b.dataset.row) || (b.dataset.local && x.localId === b.dataset.local));
      if (t && isAuto(t)) { toast('Baris otomatis — dihitung ulang sendiri dari sisa budget', 3500); return; }
      if (t) openSheet(t);
    }));
  }
  function txItem(t) {
    const k = kindOf(t);
    const sign = k === 'in' ? '+' : '-';
    const cls = k === 'in' ? 'income' : k === 'save' ? 'saving' : 'expense';
    const sub = [t.sub, t.note && t.note !== '-' ? t.note : ''].filter(Boolean).join(' · ');
    const dot = k === 'in' ? 'var(--income)' : k === 'save' ? 'var(--text-2)' : catColor(t.category);
    return `<button class="tx${t.pending ? ' pending' : ''}" ${t.pending ? `data-local="${t.localId}"` : `data-row="${t.row}"`}>
      <span class="icon-dot tx-dot" style="background:${dot}">${ico(catIcon(t.category))}</span>
      <div class="tx-main"><div class="tx-title">${esc(t.category)}${t.pending ? '<span class="pill">belum terkirim</span>' : ''}${isAuto(t) ? '<span class="pill">otomatis</span>' : ''}</div>
      <div class="tx-sub">${esc(sub)}</div></div><div class="tx-amt ${cls}">${sign}${rp(t.amount)}</div></button>`;
  }

  // ---------- form transaksi ----------
  const sheet = $('#sheet'), amt = $('#fAmount');
  $('#openAdd').addEventListener('click', () => openSheet(null));
  $('#closeSheet').addEventListener('click', closeSheet);
  sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });
  amt.addEventListener('input', () => { amt.value = fmtInput(parseNum(amt.value)); });
  const NEW = '__new';
  $('#fCategory').addEventListener('change', () => { fillSubs(); });
  $('#fSub').addEventListener('change', () => toggleNew(true));
  ['#fCategoryNew', '#fSubNew'].forEach(id => $(id).addEventListener('input', () => toggleNew(false)));
  // samakan dengan nama yang sudah ada (abaikan huruf besar/kecil & spasi ganda)
  const tidy = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  function canon(v, list) {
    const t = tidy(v);
    return list.find(x => x.toLowerCase() === t.toLowerCase()) || t;
  }
  function allSubs(cat) {
    const m = data.master.categories.find(c => c.name === cat);
    const fromTx = data.tx.filter(t => !cat || t.category === cat).map(t => t.sub);
    return [...new Set([...(m ? m.subs : []), ...fromTx].filter(Boolean))];
  }
  function chosenCategory() {
    return $('#fCategory').value === NEW ? canon($('#fCategoryNew').value, categoryNames()) : $('#fCategory').value;
  }
  function chosenSub() {
    if ($('#fSub').value !== NEW) return $('#fSub').value;
    const cat = chosenCategory();
    return canon($('#fSubNew').value, allSubs(cat).length ? allSubs(cat) : allSubs());
  }
  function isNewName() {
    const cat = chosenCategory(), sub = chosenSub();
    const m = data.master.categories.find(c => c.name === cat);
    return !!cat && (!m || (!!sub && !m.subs.includes(sub)));
  }
  function toggleNew(lists) {
    const catNew = $('#fCategory').value === NEW, subNew = $('#fSub').value === NEW;
    $('#fCategoryNew').classList.toggle('hidden', !catNew);
    $('#fSubNew').classList.toggle('hidden', !subNew);
    if (lists !== false) {
      $('#dlCategory').innerHTML = categoryNames().map(c => `<option value="${esc(c)}">`).join('');
      $('#dlSub').innerHTML = allSubs(catNew ? '' : $('#fCategory').value).map(x => `<option value="${esc(x)}">`).join('');
    }
    $('#lblSaveMaster').classList.toggle('hidden', !((catNew || subNew) && isNewName()));
  }

  function jenisList() {
    const j = data.master.jenis.length ? data.master.jenis : ['Pengeluaran', 'Pemasukkan'];
    return [...j].sort((a, b) => (isIncome({ jenis: a }) ? 1 : 0) - (isIncome({ jenis: b }) ? 1 : 0));
  }
  function categoryNames() {
    const m = data.master.categories.map(c => c.name);
    return m.length ? m : [...new Set(data.tx.map(t => t.category))];
  }
  function setJenis(j, keepCat) {
    formJenis = j;
    $$('#jenisSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.v === j));
    const cats = categoryNames();
    const sel = $('#fCategory');
    sel.innerHTML = cats.map(c => `<option>${esc(c)}</option>`).join('') + `<option value="${NEW}">✎ Category baru…</option>`;
    $('#fCategoryNew').value = '';
    if (keepCat) {
      if (!cats.includes(keepCat)) sel.insertAdjacentHTML('beforeend', `<option>${esc(keepCat)}</option>`);
      sel.value = keepCat;
    } else if (isIncome({ jenis: j })) {
      const g = cats.find(c => /^gaji$/i.test(c)); if (g) sel.value = g;
    } else {
      const firstExp = cats.find(c => !/^gaji$/i.test(c)); if (firstExp) sel.value = firstExp;
    }
    fillSubs();
  }
  function fillSubs(keepSub) {
    const cat = $('#fCategory').value;
    const m = data.master.categories.find(c => c.name === cat);
    const subs = m ? [...m.subs] : [];
    if (keepSub && !subs.includes(keepSub)) subs.push(keepSub);
    $('#fSub').innerHTML = subs.map(s => `<option>${esc(s)}</option>`).join('')
      + '<option value="">(kosong)</option>'
      + `<option value="${NEW}">✎ Ketik sendiri…</option>`;
    $('#fSubNew').value = '';
    if (keepSub !== undefined) $('#fSub').value = keepSub;
    else if (cat === NEW) $('#fSub').value = '';
    toggleNew();
  }
  function openSheet(t) {
    editing = t;
    $('#jenisSeg').innerHTML = jenisList().map(j => `<button type="button" class="seg-btn" data-v="${esc(j)}">${esc(isIncome({ jenis: j }) ? 'Pemasukan' : j)}</button>`).join('');
    $$('#jenisSeg .seg-btn').forEach(b => b.addEventListener('click', () => setJenis(b.dataset.v)));
    $('#sheetTitle').textContent = t ? 'Ubah transaksi' : 'Tambah transaksi';
    $('#deleteTx').classList.toggle('hidden', !t);
    if (t) {
      setJenis(t.jenis, t.category);
      fillSubs(t.sub);
      amt.value = fmtInput(t.amount);
      $('#fDate').value = t.date;
      $('#fNote').value = t.note || '';
    } else {
      setJenis(jenisList()[0], selectedCat || undefined);
      if (selectedCat) fillSubs();
      amt.value = '';
      $('#fDate').value = todayStr();
      $('#fNote').value = '';
    }
    sheet.classList.remove('hidden');
    if (!t) setTimeout(() => { if (!sheet.contains(document.activeElement)) amt.focus(); }, 50);
  }
  function closeSheet() { sheet.classList.add('hidden'); editing = null; }

  $('#txForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (busy) return;
    const tx = {
      jenis: formJenis, amount: parseNum(amt.value), date: $('#fDate').value || todayStr(),
      category: chosenCategory(), sub: chosenSub(), note: $('#fNote').value.trim()
    };
    if (tx.amount <= 0) { toast('Jumlah harus lebih dari 0'); return; }
    if (!tx.category) { toast($('#fCategory').value === NEW ? 'Ketik nama Category baru' : 'Pilih Category'); return; }
    if ($('#fSub').value === NEW && !tx.sub) { toast('Ketik Sub Category, atau pilih (kosong)'); return; }
    if (isNewName() && $('#fSaveMaster').checked) tx.saveMaster = true;

    // edit transaksi yang belum terkirim: cukup ubah antrean lokal
    if (editing && editing.pending) {
      const i = pending.findIndex(p => p.localId === editing.localId);
      pending[i] = { ...pending[i], ...tx, periode: undefined };
      store.set(K_PENDING, pending); closeSheet(); render(); toast('Diperbarui (belum terkirim)');
      return;
    }
    busy = true; $('#submitTx').classList.add('loading'); $('#submitTx').textContent = 'Menyimpan…';
    try {
      if (editing) {
        applyData(await api('update', { row: editing.row, orig: origOf(editing), tx }));
        toast('Transaksi diperbarui di sheet');
      } else {
        applyData(await api('add', { tx }));
        toast('Tersimpan ke Google Sheet');
      }
      setSync(syncLabel());
      closeSheet();
      jumpToDate(tx.date);
    } catch (err) {
      if (!editing && (err.offline || err.setup)) {
        pending.push({ ...tx, localId: 'p' + Date.now() });
        store.set(K_PENDING, pending);
        toast(err.setup ? 'Disimpan di HP. Sambungkan ke sheet agar terkirim.' : 'Offline — disimpan di HP, dikirim saat online', 3500);
        closeSheet();
        jumpToDate(tx.date);
      } else {
        toast(err.message, 4500);
      }
    }
    busy = false; $('#submitTx').classList.remove('loading'); $('#submitTx').textContent = 'Simpan';
  });
  const origOf = (t) => ({ date: t.date, amount: t.amount, category: t.category });

  $('#deleteTx').addEventListener('click', async () => {
    if (!editing || !confirm('Hapus transaksi ini dari Google Sheet?')) return;
    if (editing.pending) {
      pending = pending.filter(p => p.localId !== editing.localId);
      store.set(K_PENDING, pending); closeSheet(); render(); return;
    }
    try {
      applyData(await api('delete', { row: editing.row, orig: origOf(editing) }));
      toast('Transaksi dihapus'); closeSheet(); render();
    } catch (err) { toast(err.message, 4500); }
  });

  function jumpToDate(date) {
    const list = periods();
    const tx = allTx();
    const t = tx.filter(x => x.date === date).pop();
    const i = list.findIndex(p => t ? p.match(t) : (date >= p.start && date <= p.end));
    periodIdx = i >= 0 ? i : list.length - 1;
    render();
  }

  // ---------- scan screenshot (Gemini lewat Apps Script) ----------
  const scanSheet = $('#scanSheet');
  let scanItems = [];
  function scanMode(m) {
    $('#scanSetup').classList.toggle('hidden', m !== 'setup');
    $('#scanBusy').classList.toggle('hidden', m !== 'busy');
    $('#scanReview').classList.toggle('hidden', m !== 'review');
  }
  function openScan() {
    closeSheet();
    scanItems = [];
    $('#scanTitle').textContent = 'Scan screenshot';
    scanMode('setup');
    scanSheet.classList.remove('hidden');
  }
  $('#openScan').addEventListener('click', openScan);
  $('#closeScan').addEventListener('click', () => {
    if (scanItems.length && !confirm('Tutup tanpa menyimpan hasil scan?')) return;
    scanSheet.classList.add('hidden'); scanItems = [];
  });
  $('#pickScan').addEventListener('click', () => $('#scanFile').click());
  $('#scanAgain').addEventListener('click', () => $('#scanFile').click());
  $('#scanFile').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) scanFiles(f); });

  // perkecil gambar supaya cepat dikirim (sisi terpanjang maks 2000px)
  function compress(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 2000, k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('File bukan gambar yang bisa dibaca.')); };
      img.src = url;
    });
  }

  async function scanFiles(files) {
    if (!cfg.url) { toast('Sambungkan ke Google Sheet dulu (menu Lainnya)', 3500); return; }
    scanSheet.classList.remove('hidden');
    const warns = [];
    for (let i = 0; i < files.length; i++) {
      scanMode('busy');
      $('#scanBusyText').textContent = files.length > 1 ? `Membaca gambar ${i + 1} dari ${files.length}…` : 'Membaca gambar… (±5–15 detik)';
      try {
        const image = await compress(files[i]);
        const res = await api('scan', { image, mime: 'image/jpeg', hint: $('#scanHint').value.trim(), detail: $('#scanDetail').checked });
        res.items.forEach(t => scanItems.push(prepItem(t)));
        if (res.warning) warns.push(res.warning);
        if (!res.items.length && !res.warning) warns.push('Tidak ada transaksi yang terbaca dari gambar ini.');
      } catch (err) {
        warns.push((files.length > 1 ? `Gambar ${i + 1}: ` : '') + (err.offline ? 'Butuh koneksi internet untuk scan.' : err.message));
      }
    }
    if (!scanItems.length) {
      scanMode('setup');
      toast(warns.join(' ') || 'Tidak ada transaksi terbaca', 5000);
      return;
    }
    $('#scanWarn').innerHTML = warns.map(w => `<div class="alloc warn">${esc(w)}</div>`).join('');
    renderScanItems();
    scanMode('review');
  }

  function prepItem(t) {
    const jl = jenisList();
    const jenis = jl.find(j => j.toLowerCase() === (t.jenis || '').toLowerCase())
      || (/masuk/i.test(t.jenis) ? jl.find(j => isIncome({ jenis: j })) : jl.find(j => !isIncome({ jenis: j }))) || jl[0];
    const category = canon(t.category, categoryNames());
    const sub = canon(t.sub, allSubs(category).length ? allSubs(category) : allSubs());
    const dup = allTx().some(x => x.date === t.date && x.amount === t.amount && !isAuto(x));
    return { ...t, jenis, category, sub, dup, include: !dup };
  }

  function renderScanItems() {
    const jl = jenisList(), cats = categoryNames();
    $('#scanTitle').textContent = `Review ${scanItems.length} transaksi`;
    $('#scanItems').innerHTML = scanItems.map((t, i) => {
      const flags = [
        t.dup ? '<span class="flag warn">mungkin sudah tercatat</span>' : '',
        t.confidence === 'low' ? '<span class="flag warn">AI ragu, cek angka</span>' : '',
        t.dateGuessed ? '<span class="flag">tanggal ditebak</span>' : '',
        isGaji(t) ? '<span class="flag warn">Gaji → mulai periode baru</span>' : '',
        !cats.includes(t.category) ? '<span class="flag">category baru</span>'
          : (t.sub && !allSubs(t.category).includes(t.sub) ? '<span class="flag">sub baru</span>' : '')
      ].join('');
      const catOpts = (cats.includes(t.category) ? cats : [t.category, ...cats]).map(c => `<option${c === t.category ? ' selected' : ''}>${esc(c)}</option>`).join('');
      return `<div class="scan-item${t.include ? '' : ' off'}" data-i="${i}">
        <div class="scan-top">
          <label class="check"><input type="checkbox" class="s-inc"${t.include ? ' checked' : ''}> Simpan</label>
          <div class="flags">${flags}</div>
        </div>
        <div class="scan-grid">
          <select class="s-jenis">${jl.map(j => `<option value="${esc(j)}"${j === t.jenis ? ' selected' : ''}>${esc(isIncome({ jenis: j }) ? 'Pemasukan' : j)}</option>`).join('')}</select>
          <input class="s-amt" inputmode="numeric" value="${fmtInput(t.amount)}">
          <input class="s-date" type="date" value="${t.date}">
          <select class="s-cat">${catOpts}</select>
          <input class="s-sub" list="dlScanSub${i}" value="${esc(t.sub)}" placeholder="Sub Category">
          <datalist id="dlScanSub${i}">${allSubs(t.category).map(s => `<option value="${esc(s)}">`).join('')}</datalist>
          <input class="s-note" value="${esc(t.note)}" placeholder="Keterangan" maxlength="200">
        </div>
      </div>`;
    }).join('');
    $$('#scanItems .scan-item').forEach(el => {
      const t = scanItems[el.dataset.i];
      $('.s-inc', el).addEventListener('change', e => { t.include = e.target.checked; el.classList.toggle('off', !t.include); updateScanSave(); });
      $('.s-jenis', el).addEventListener('change', e => { t.jenis = e.target.value; refreshFlags(el, t); });
      const a = $('.s-amt', el); a.addEventListener('input', () => { t.amount = parseNum(a.value); a.value = fmtInput(t.amount); updateScanSave(); });
      $('.s-date', el).addEventListener('change', e => t.date = e.target.value);
      $('.s-cat', el).addEventListener('change', e => {
        t.category = e.target.value;
        refreshFlags(el, t);
        $(`#dlScanSub${el.dataset.i}`).innerHTML = allSubs(t.category).map(s => `<option value="${esc(s)}">`).join('');
      });
      $('.s-sub', el).addEventListener('input', e => t.sub = e.target.value);
      $('.s-note', el).addEventListener('input', e => t.note = e.target.value);
    });
    updateScanSave();
  }
  function refreshFlags(el, t) {
    const g = isGaji(t), f = $('.flags', el);
    const has = f.querySelector('.gaji-flag');
    if (g && !has) f.insertAdjacentHTML('beforeend', '<span class="flag warn gaji-flag">Gaji → mulai periode baru</span>');
    if (!g && has) has.remove();
    $$('.flag', f).forEach(x => { if (!x.classList.contains('gaji-flag') && /periode baru/.test(x.textContent)) x.classList.add('gaji-flag'); if (!g && /periode baru/.test(x.textContent)) x.remove(); });
  }
  function updateScanSave() {
    const sel = scanItems.filter(t => t.include);
    const total = sel.reduce((s, t) => s + t.amount, 0);
    $('#scanSave').textContent = sel.length ? `Simpan ${sel.length} transaksi (${rp(total)})` : 'Pilih minimal satu';
    $('#scanSave').disabled = !sel.length;
  }

  $('#scanSave').addEventListener('click', async () => {
    const list = scanItems.filter(t => t.include).map(t => {
      const category = canon(t.category, categoryNames());
      const sub = canon(t.sub, allSubs(category).length ? allSubs(category) : allSubs());
      const m = data.master.categories.find(c => c.name === category);
      const isNew = !m || (sub && !m.subs.includes(sub));
      return { jenis: t.jenis, amount: t.amount, date: t.date, category, sub, note: tidy(t.note), saveMaster: isNew || undefined };
    });
    if (list.some(t => !(t.amount > 0) || !t.date || !t.category)) { toast('Ada transaksi tanpa jumlah, tanggal, atau category'); return; }
    const btn = $('#scanSave'); btn.classList.add('loading');
    try {
      applyData(await api('addMany', { list }));
      setSync(syncLabel());
      toast(`${list.length} transaksi tersimpan ke Google Sheet`);
    } catch (err) {
      if (err.offline) {
        list.forEach((t, i) => pending.push({ ...t, localId: 'p' + Date.now() + i }));
        store.set(K_PENDING, pending);
        toast('Offline — disimpan di HP, dikirim saat online', 3500);
      } else { btn.classList.remove('loading'); toast(err.message, 4500); return; }
    }
    btn.classList.remove('loading');
    scanItems = []; scanSheet.classList.add('hidden');
    jumpToDate(list[list.length - 1].date);
  });

  // gambar yang dibagikan dari galeri/aplikasi lain (Bagikan → Keuanganku)
  async function checkShared() {
    if (!/[?&]share=1/.test(location.search) || !('caches' in window)) return;
    history.replaceState(null, '', location.pathname);
    try {
      const c = await caches.open('kk-share');
      const keys = await c.keys();
      const files = [];
      for (const k of keys) { const r = await c.match(k); files.push(new File([await r.blob()], 'shared', { type: r.headers.get('content-type') || 'image/jpeg' })); await c.delete(k); }
      if (files.length) { scanItems = []; scanFiles(files); }
    } catch (e) { toast('Gagal membuka gambar yang dibagikan'); }
  }

  // ---------- pengaturan ----------
  function renderSettings() {
    $('#cfgUrl').value = cfg.url || '';
    $('#cfgToken').value = cfg.token || '';
    $$('#modeSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.v === mode));
    $('#cfgInfo').textContent = data.loadedAt
      ? `Tersambung ke tab "${data.sheetName || '?'}" — ${data.tx.length} transaksi, ${data.master.categories.length} kategori.`
      : 'Belum pernah memuat data.';
    renderIconList();
  }
  $('#saveCfg').addEventListener('click', async () => {
    const url = $('#cfgUrl').value.trim(), token = $('#cfgToken').value;
    if (!/^https:\/\/script\.google(usercontent)?\.com\/.+\/exec/.test(url)) {
      toast('URL harus berupa URL deployment Apps Script yang berakhiran /exec', 4000); return;
    }
    cfg = { url, token }; store.set(K_CFG, cfg);
    $('#cfgInfo').textContent = 'Menguji koneksi…';
    periodIdx = -1;
    await reload(true);
    if (data.loadedAt) toast('Tersambung!');
  });
  $$('#modeSeg .seg-btn').forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.v; store.set(K_MODE, mode); periodIdx = -1; selectedCat = null; render();
  }));
  $('#reloadData').addEventListener('click', () => reload());

  // ----- ikon kategori -----
  function renderIconList() {
    const cats = [...catOrder(), ...data.master.categories.map(c => c.name).filter(n => /^gaji$|tabungan/i.test(n))];
    $('#iconList').innerHTML = cats.map(c => `<button class="icon-row" data-cat="${esc(c)}">
      <span class="icon-dot" style="background:${/^gaji$|tabungan/i.test(c) ? 'var(--text-2)' : catColor(c)}">${ico(catIcon(c))}</span><span>${esc(c)}</span>${ico('chevron-right', 'muted-ico')}</button>`).join('')
      || '<div class="empty">Kategori belum termuat.</div>';
    $$('#iconList .icon-row').forEach(b => b.addEventListener('click', () => openIconPicker(b.dataset.cat)));
  }
  function openIconPicker(cat) {
    $('#iconTitle').textContent = `Ikon untuk ${cat}`;
    const cur = catIcon(cat);
    $('#iconGrid').innerHTML = ICON_CHOICES.map(n => `<button class="pick${n === cur ? ' on' : ''}" data-i="${n}" aria-label="${n}">${ico(n)}</button>`).join('');
    $$('#iconGrid .pick').forEach(b => b.addEventListener('click', async () => {
      const icons = { ...(data.icons || {}), [cat]: b.dataset.i };
      $('#iconSheet').classList.add('hidden');
      data.icons = icons; render(); renderIconList();
      try { applyData(await api('setIcons', { icons })); toast('Ikon disimpan'); }
      catch (e) { toast(e.offline ? 'Offline — ikon hanya berubah di HP ini sampai online' : e.message, 3500); store.set(K_DATA, data); }
    }));
    $('#iconSheet').classList.remove('hidden');
  }
  $('#closeIcon').addEventListener('click', () => $('#iconSheet').classList.add('hidden'));
  $('#iconSheet').addEventListener('click', e => { if (e.target.id === 'iconSheet') $('#iconSheet').classList.add('hidden'); });

  // sprite ikon disisipkan ke halaman supaya bisa dipakai dengan <use href="#i-…">
  fetch('icons.svg').then(r => r.text()).then(t => {
    const d = document.createElement('div'); d.style.display = 'none'; d.innerHTML = t; document.body.prepend(d);
  }).catch(() => {});

  // ---------- PWA ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  setSync(syncLabel());
  render();
  reload(true).then(checkShared);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && cfg.url && data.loadedAt && Date.now() - new Date(data.loadedAt) > 5 * 60e3) reload(true);
  });
})();
