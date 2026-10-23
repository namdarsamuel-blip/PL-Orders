/* Ticket P&L Tracker — app logic. Data lives in Supabase (or in memory in demo mode). */
(function () {
  'use strict';

  // ---------- helpers ----------
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var esc = function (v) { return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); };
  var usdF = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'});
  var usd0 = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0});
  function fmt(v, kind) {
    if (v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v))) return '';
    switch (kind) {
      case 'usd': return usdF.format(v);
      case 'usd0': return usd0.format(v);
      case 'susd': return (v > 0 ? '+' : '') + usdF.format(v);
      case 'pct': return (v * 100).toFixed(1) + '%';
      case 'spct': return (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
      case 'int': return Math.round(v).toLocaleString('en-US');
      case 'date': return v instanceof Date ? v.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'}) : String(v);
      case 'datetime': return v instanceof Date ? v.toLocaleString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'}) : String(v);
      default: return String(v);
    }
  }
  function signClass(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : ''; }
  function ymd(d) { return d ? tt_dayKey(d) : null; }
  function monthLabel(k) {
    if (!k) return '';
    var p = k.split('-');
    return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString('en-US', {month: 'short', year: 'numeric'});
  }
  function toast(msg, isErr) {
    var t = $('#toast');
    t.textContent = msg; t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = 'toast'; }, isErr ? 8000 : 4000);
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }

  // ---------- row mapping ----------
  var ORDER_FIELDS = ['order_number', 'email', 'event_name', 'event_date_raw', 'seats', 'quantity', 'buyer', 'date_bought_raw', 'card', 'total', 'price_per_ticket', 'site'];
  var CSV_MAP = {
    'order number': 'order_number', 'email used': 'email', 'event name': 'event_name', 'event date': 'event_date_raw',
    'section & row & seat #s': 'seats', 'quantity': 'quantity', 'buyer': 'buyer', 'date bought': 'date_bought_raw',
    'last 4 cc': 'card', 'total price': 'total', 'price per ticket': 'price_per_ticket', 'site': 'site'
  };
  function csvRowToOrder(obj) {
    var r = {};
    Object.keys(obj).forEach(function (h) {
      var k = CSV_MAP[String(h).trim().toLowerCase()];
      if (k) r[k] = obj[h] === undefined || obj[h] === null ? '' : String(obj[h]).trim();
    });
    if (!r.order_number) return null;
    ORDER_FIELDS.forEach(function (f) { if (r[f] === undefined || r[f] === '') r[f] = null; });
    r.quantity = r.quantity ? (parseInt(parseFloat(r.quantity), 10) || null) : null;
    r.total = r.total ? tt_money(r.total) : null;
    return r;
  }
  function orderSig(r) { return ORDER_FIELDS.map(function (f) { var v = r[f]; return v === null || v === undefined ? '' : String(typeof v === 'number' ? +v.toFixed(2) : v); }).join('\u0001'); }
  function orderForBuild(r) {
    return {order: r.order_number, email: r.email || '', event: r.event_name || '', eventDateRaw: r.event_date_raw || '', seats: r.seats || '',
      qty: Number(r.quantity) || 0, buyer: r.buyer || '', dateBought: r.date_bought_raw || '', card: r.card || '', total: Number(r.total) || 0,
      ppt: r.price_per_ticket || '', site: r.site || ''};
  }
  function saleToDb(s) {
    return {sale_key: s.key, sold_at: s.soldAt ? s.soldAt.toISOString() : null, sold_raw: s.soldRaw || null, result: s.result || null,
      event: s.event, event_date: ymd(s.eventDate), venue: s.venue || null, section: s.section, row_name: s.row, qty: s.qty,
      total: s.total, profit: s.profit, roi: s.roi, cost_per: s.costPer, sold_per: s.soldPer,
      purchased_at: s.purchased ? s.purchased.toISOString() : null, time_to_sell: s.timeToSell || null, marketplace: s.marketplace || null,
      public_notes: s.publicNotes || null, order_numbers: s.orders || [], internal_notes: s.internalNotes || null};
  }
  function saleFromDb(r) {
    return {key: r.sale_key, soldAt: r.sold_at ? new Date(r.sold_at) : null, soldRaw: r.sold_raw || '', result: r.result || '', event: r.event || '',
      eventDate: r.event_date ? tt_parseDate(String(r.event_date)) : null, venue: r.venue || '', section: r.section || '', row: r.row_name || '',
      qty: Number(r.qty) || 0, total: Number(r.total) || 0, profit: Number(r.profit) || 0, roi: Number(r.roi) || 0,
      costPer: Number(r.cost_per) || 0, soldPer: Number(r.sold_per) || 0, purchased: r.purchased_at ? new Date(r.purchased_at) : null,
      timeToSell: r.time_to_sell || '', marketplace: r.marketplace || '', publicNotes: r.public_notes || '',
      orders: r.order_numbers || [], internalNotes: r.internal_notes || ''};
  }

  // ---------- stores ----------
  function chunk(a, n) { var o = []; for (var i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

  function SupabaseStore(client) {
    this.sb = client; this.demo = false;
  }
  SupabaseStore.prototype.userId = async function () {
    var r = await this.sb.auth.getUser();
    if (r.error || !r.data.user) throw new Error('You are signed out. Please sign in again.');
    return r.data.user.id;
  };
  var PKEY = {orders: 'order_number', sales: 'sale_key', artist_overrides: 'raw_name'};
  SupabaseStore.prototype.pageAll = async function (table) {
    var out = [], from = 0, size = 1000;
    for (;;) {
      var r = await this.sb.from(table).select('*').order(PKEY[table]).range(from, from + size - 1);
      if (r.error) throw r.error;
      out = out.concat(r.data || []);
      if (!r.data || r.data.length < size) break;
      from += size;
    }
    return out;
  };
  SupabaseStore.prototype.loadAll = async function () {
    var res = await Promise.all([this.pageAll('orders'), this.pageAll('sales'), this.pageAll('artist_overrides')]);
    return {orders: res[0], sales: res[1], overrides: res[2]};
  };
  SupabaseStore.prototype.upsertOrders = async function (rows) {
    var uid = await this.userId(), now = new Date().toISOString(), self = this;
    for (var part of chunk(rows, 500)) {
      var r = await self.sb.from('orders').upsert(part.map(function (x) { return Object.assign({}, x, {user_id: uid, updated_at: now}); }), {onConflict: 'user_id,order_number'});
      if (r.error) throw r.error;
    }
  };
  SupabaseStore.prototype.insertSales = async function (rows) {
    var uid = await this.userId(), self = this;
    for (var part of chunk(rows, 500)) {
      var r = await self.sb.from('sales').upsert(part.map(function (x) { return Object.assign({}, x, {user_id: uid}); }), {onConflict: 'user_id,sale_key', ignoreDuplicates: true});
      if (r.error) throw r.error;
    }
  };
  SupabaseStore.prototype.setOverrides = async function (rows) {
    var uid = await this.userId();
    var r = await this.sb.from('artist_overrides').upsert(rows.map(function (x) { return {user_id: uid, raw_name: x.raw_name, artist: x.artist}; }), {onConflict: 'user_id,raw_name'});
    if (r.error) throw r.error;
  };
  SupabaseStore.prototype.deleteSale = async function (key) {
    var r = await this.sb.from('sales').delete().eq('sale_key', key);
    if (r.error) throw r.error;
  };

  function MemoryStore() { this.o = {}; this.s = {}; this.m = {}; this.demo = true; }
  MemoryStore.prototype.loadAll = async function () {
    var self = this;
    return {orders: Object.keys(this.o).map(function (k) { return Object.assign({}, self.o[k]); }),
      sales: Object.keys(this.s).map(function (k) { return Object.assign({}, self.s[k]); }),
      overrides: Object.keys(this.m).map(function (k) { return {raw_name: k, artist: self.m[k]}; })};
  };
  MemoryStore.prototype.upsertOrders = async function (rows) { var self = this; rows.forEach(function (r) { self.o[r.order_number] = Object.assign({}, self.o[r.order_number] || {}, r); }); };
  MemoryStore.prototype.insertSales = async function (rows) { var self = this; rows.forEach(function (r) { if (!self.s[r.sale_key]) self.s[r.sale_key] = r; }); };
  MemoryStore.prototype.setOverrides = async function (rows) { var self = this; rows.forEach(function (r) { self.m[r.raw_name] = r.artist; }); };
  MemoryStore.prototype.deleteSale = async function (key) { delete this.s[key]; };

  // ---------- state ----------
  var S = {store: null, raw: {orders: [], sales: [], overrides: []}, R: null, tab: 'overview', year: null, month: null,
    pendingOrders: null, pendingSales: null, sort: {}, search: {}, invStatus: 'all'};

  function rebuild() {
    var ov = {};
    S.raw.overrides.forEach(function (r) { ov[tt_norm(r.raw_name)] = r.artist; });
    S.R = tt_build(S.raw.orders.map(orderForBuild), S.raw.sales.map(saleFromDb), ov, new Date());
    S.orderIndex = {};
    S.raw.orders.forEach(function (r) { S.orderIndex[r.order_number] = r; });
    S.saleIndex = {};
    S.raw.sales.forEach(function (r) { S.saleIndex[r.sale_key] = true; });
    if (!S.month) {
      var withSales = S.R.monthly.filter(function (m) { return m.sales; });
      S.month = withSales.length ? withSales[0].month : tt_monthKey(new Date());
      S.year = S.month.slice(0, 4);
    }
  }

  async function reload() {
    $('#loading').hidden = false;
    try {
      S.raw = await S.store.loadAll();
      rebuild();
      render();
    } catch (e) {
      toast('Could not load your data: ' + (e.message || e), true);
    } finally {
      $('#loading').hidden = true;
    }
  }

  // ---------- period ----------
  function inPeriod(d) {
    if (!d) return false;
    if (S.month && S.month !== 'all') return tt_monthKey(d) === S.month;
    if (S.year && S.year !== 'all') return String(d.getFullYear()) === S.year;
    return true;
  }
  function periodLabel() {
    if (S.month && S.month !== 'all') return monthLabel(S.month);
    if (S.year && S.year !== 'all') return S.year;
    return 'All time';
  }
  function allMonths() {
    var set = {};
    S.R.monthly.forEach(function (m) { set[m.month] = 1; });
    set[tt_monthKey(new Date())] = 1;
    return Object.keys(set).filter(String).sort();
  }
  function renderPeriodControls() {
    var months = allMonths();
    var years = {}; months.forEach(function (m) { years[m.slice(0, 4)] = 1; });
    var ys = Object.keys(years).sort().reverse();
    var yearSel = '<option value="all">All years</option>' + ys.map(function (y) { return '<option' + (y === S.year ? ' selected' : '') + '>' + y + '</option>'; }).join('');
    var ms = months.filter(function (m) { return S.year === 'all' || m.slice(0, 4) === S.year; }).reverse();
    var monthSel = '<option value="all">' + (S.year === 'all' ? 'Every month' : 'Whole year') + '</option>' +
      ms.map(function (m) { return '<option value="' + m + '"' + (m === S.month ? ' selected' : '') + '>' + monthLabel(m) + '</option>'; }).join('');
    $('#period').innerHTML = '<label>Year <select id="yearSel">' + yearSel + '</select></label>' +
      '<label>Month <select id="monthSel">' + monthSel + '</select></label>';
    if (S.year === 'all') $('#yearSel').value = 'all';
    if (S.month === 'all') $('#monthSel').value = 'all';
    $('#yearSel').onchange = function (e) { S.year = e.target.value; S.month = 'all'; render(); };
    $('#monthSel').onchange = function (e) { S.month = e.target.value; render(); };
  }

  function aggSales(list) {
    var a = {sales: 0, tickets: 0, revenue: 0, cost: 0, profit: 0, wins: 0};
    list.forEach(function (s) { a.sales++; a.tickets += s.qty; a.revenue += s.total; a.cost += s.total - s.profit; a.profit += s.profit; if (s.profit > 0) a.wins++; });
    a.roi = a.cost ? a.profit / a.cost : null; a.winRate = a.sales ? a.wins / a.sales : null;
    return a;
  }

  // ---------- generic table ----------
  function table(id, cols, rows, opts) {
    opts = opts || {};
    var st = S.sort[id] || opts.sort || null;
    var q = (S.search[id] || '').toLowerCase().trim();
    var list = rows;
    if (q) list = rows.filter(function (r) { return cols.some(function (c) { return String(fmt(c.get(r), c.fmt)).toLowerCase().indexOf(q) >= 0 || String(c.get(r) || '').toLowerCase().indexOf(q) >= 0; }); });
    if (st) {
      var col = cols.filter(function (c) { return c.label === st.label; })[0];
      if (col) list = list.slice().sort(function (a, b) {
        var x = col.get(a), y = col.get(b);
        if (x instanceof Date) x = +x; if (y instanceof Date) y = +y;
        if (x === null || x === undefined || x === '') return 1; if (y === null || y === undefined || y === '') return -1;
        var r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return st.dir === 'asc' ? r : -r;
      });
    }
    var limit = opts.limit || 400, shown = list.slice(0, limit);
    var head = cols.map(function (c) {
      var arrow = st && st.label === c.label ? (st.dir === 'asc' ? ' ▲' : ' ▼') : '';
      return '<th class="' + (c.num ? 'num' : '') + '" data-sort="' + esc(c.label) + '">' + esc(c.label) + arrow + '</th>';
    }).join('') + (opts.actions ? '<th></th>' : '');
    var body = shown.map(function (r, i) {
      return '<tr>' + cols.map(function (c) {
        var v = c.get(r), cls = (c.num ? 'num ' : '') + (c.signed ? signClass(v) : '') + (c.cls ? ' ' + c.cls : '');
        return '<td class="' + cls + '"' + (c.wrap ? '' : ' style="white-space:nowrap"') + '>' + esc(fmt(v, c.fmt)) + '</td>';
      }).join('') + (opts.actions ? '<td class="act">' + opts.actions(r, i) + '</td>' : '') + '</tr>';
    }).join('');
    var tools = '<div class="tabletools">' +
      (opts.searchable === false ? '' : '<input type="search" placeholder="Search…" data-search="' + id + '" value="' + esc(S.search[id] || '') + '">') +
      (opts.extraTools || '') +
      '<span class="count">' + (list.length > limit ? 'Showing ' + limit + ' of ' : '') + list.length.toLocaleString() + ' rows</span>' +
      '<button class="ghost" data-csv="' + id + '">Download CSV</button></div>';
    S._tables = S._tables || {};
    S._tables[id] = {cols: cols, rows: list};
    return tools + '<div class="tablewrap"><table data-table="' + id + '"><thead><tr>' + head + '</tr></thead><tbody>' +
      (body || '<tr><td colspan="' + (cols.length + 1) + '" class="empty">' + esc(opts.empty || 'Nothing here yet.') + '</td></tr>') + '</tbody></table></div>';
  }
  function wireTables(root) {
    root.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.onclick = function () {
        var id = th.closest('table').dataset.table, label = th.dataset.sort, cur = S.sort[id];
        S.sort[id] = {label: label, dir: cur && cur.label === label && cur.dir === 'desc' ? 'asc' : 'desc'};
        render();
      };
    });
    root.querySelectorAll('input[data-search]').forEach(function (inp) {
      inp.oninput = function () {
        S.search[inp.dataset.search] = inp.value;
        var pos = inp.selectionStart; render();
        var again = $('input[data-search="' + inp.dataset.search + '"]');
        if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) {} }
      };
    });
    root.querySelectorAll('[data-csv]').forEach(function (b) {
      b.onclick = function () {
        var t = S._tables[b.dataset.csv];
        var lines = [t.cols.map(function (c) { return c.label; })].concat(t.rows.map(function (r) {
          return t.cols.map(function (c) { var v = c.get(r); return v instanceof Date ? fmt(v, c.fmt) : (v === null || v === undefined ? '' : v); });
        }));
        var csv = lines.map(function (l) { return l.map(function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n');
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], {type: 'text/csv'}));
        a.download = b.dataset.csv + '.csv'; a.click();
      };
    });
  }

  // ---------- chart ----------
  function chartMonths() {
    var months = allMonths();
    if (S.year && S.year !== 'all') {
      var out = []; for (var i = 1; i <= 12; i++) out.push(S.year + '-' + (i < 10 ? '0' : '') + i); return out;
    }
    return months.slice(-24);
  }
  function profitChart() {
    var months = chartMonths();
    var by = {}; S.R.monthly.forEach(function (m) { by[m.month] = m; });
    var vals = months.map(function (k) { return by[k] ? by[k].profit : 0; });
    var max = Math.max(0, Math.max.apply(null, vals)), min = Math.min(0, Math.min.apply(null, vals));
    if (max === min) max = 1;
    var W = 720, H = 220, padL = 56, padR = 8, padT = 12, padB = 28;
    var iw = W - padL - padR, ih = H - padT - padB, bw = iw / months.length;
    var y = function (v) { return padT + (max - v) / (max - min) * ih; };
    var ticks = [min, 0, max].filter(function (v, i, a) { return a.indexOf(v) === i; });
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" role="img" aria-label="Profit by month">';
    ticks.forEach(function (t) {
      svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(t) + '" y2="' + y(t) + '" class="' + (t === 0 ? 'axis' : 'grid') + '"/>' +
        '<text x="' + (padL - 6) + '" y="' + (y(t) + 4) + '" class="tick" text-anchor="end">' + esc(fmt(t, 'usd0')) + '</text>';
    });
    months.forEach(function (k, i) {
      var v = vals[i], x = padL + i * bw, w = Math.max(2, Math.min(36, bw - 6)), cx = x + (bw - w) / 2;
      var top = y(Math.max(v, 0)), h = Math.abs(y(v) - y(0));
      if (v !== 0) {
        var r = Math.min(4, w / 2, h);
        var path = v > 0
          ? 'M' + cx + ',' + (top + h) + 'V' + (top + r) + 'Q' + cx + ',' + top + ' ' + (cx + r) + ',' + top + 'H' + (cx + w - r) + 'Q' + (cx + w) + ',' + top + ' ' + (cx + w) + ',' + (top + r) + 'V' + (top + h) + 'Z'
          : 'M' + cx + ',' + top + 'V' + (top + h - r) + 'Q' + cx + ',' + (top + h) + ' ' + (cx + r) + ',' + (top + h) + 'H' + (cx + w - r) + 'Q' + (cx + w) + ',' + (top + h) + ' ' + (cx + w) + ',' + (top + h - r) + 'V' + top + 'Z';
        svg += '<path d="' + path + '" class="bar ' + (v > 0 ? 'up' : 'down') + (k === S.month ? ' sel' : '') + '"/>';
      }
      var lab = monthLabel(k).split(' ');
      if (months.length <= 12 || i % 2 === 0) svg += '<text x="' + (x + bw / 2) + '" y="' + (H - 10) + '" class="tick" text-anchor="middle">' + esc(months.length <= 12 ? lab[0] : lab[0] + ' ' + lab[1].slice(2)) + '</text>';
      svg += '<rect x="' + x + '" y="' + padT + '" width="' + bw + '" height="' + ih + '" class="hit" data-m="' + k + '"/>';
    });
    svg += '</svg>';
    return '<div class="chartbox">' + svg + '<div class="tip" hidden></div></div>';
  }
  function wireChart(root) {
    var box = root.querySelector('.chartbox'); if (!box) return;
    var tip = box.querySelector('.tip');
    var by = {}; S.R.monthly.forEach(function (m) { by[m.month] = m; });
    box.querySelectorAll('.hit').forEach(function (r) {
      r.onmousemove = function (e) {
        var m = by[r.dataset.m] || {profit: 0, revenue: 0, sales: 0, tickets: 0};
        tip.innerHTML = '<b>' + esc(monthLabel(r.dataset.m)) + '</b><br>Profit <span class="' + signClass(m.profit) + '">' + esc(fmt(m.profit, 'susd')) + '</span><br>Revenue ' + esc(fmt(m.revenue, 'usd')) + '<br>' + m.sales + ' sales · ' + m.tickets + ' tickets';
        tip.hidden = false;
        var b = box.getBoundingClientRect();
        var x = e.clientX - b.left + 12; if (x > b.width - 170) x = e.clientX - b.left - 170;
        tip.style.left = x + 'px'; tip.style.top = Math.max(0, e.clientY - b.top - 20) + 'px';
      };
      r.onmouseleave = function () { tip.hidden = true; };
      r.onclick = function () { S.month = r.dataset.m; S.year = r.dataset.m.slice(0, 4); render(); };
    });
  }

  // ---------- views ----------
  function kpi(label, value, kind, sub) {
    return '<div class="kpi"><div class="kl">' + esc(label) + '</div><div class="kv ' + (kind === 'susd' || kind === 'spct' ? signClass(value) : '') + '">' + esc(fmt(value, kind) || '—') + '</div>' + (sub ? '<div class="ks">' + esc(sub) + '</div>' : '') + '</div>';
  }

  function viewOverview() {
    var sales = S.R.sales.filter(function (s) { return inPeriod(s.soldAt); });
    var a = aggSales(sales);
    var spent = 0, boughtTix = 0;
    S.R.orders.forEach(function (o) { if (inPeriod(o.bought)) { spent += o.total; boughtTix += o.qty; } });
    var byArtist = {};
    sales.forEach(function (s) { (byArtist[s.artist] = byArtist[s.artist] || []).push(s); });
    var arts = Object.keys(byArtist).map(function (k) { var x = aggSales(byArtist[k]); x.artist = k; return x; });
    var sorted = sales.slice().sort(function (x, y) { return y.profit - x.profit; });
    var saleCols = [
      {label: 'Artist', get: function (s) { return s.artist; }},
      {label: 'Seats', get: function (s) { return 'Sec ' + s.section + ' · Row ' + s.row + ' · ×' + s.qty; }},
      {label: 'Profit', get: function (s) { return s.profit; }, fmt: 'susd', num: true, signed: true}
    ];
    var html = '<h2>' + esc(periodLabel()) + '</h2>' +
      '<div class="kpis">' +
      kpi('Profit', a.profit, 'susd') + kpi('Revenue', a.revenue, 'usd') + kpi('ROI', a.roi, 'spct') +
      kpi('Tickets sold', a.tickets, 'int', a.sales + ' sales') + kpi('Win rate', a.winRate, 'pct', a.wins + ' profitable') +
      kpi('Spent on new orders', spent, 'usd', boughtTix.toLocaleString() + ' tickets bought') +
      '</div>' +
      '<section class="card"><h3>Profit by month</h3><p class="hint">Hover for details · click a bar to open that month</p>' + profitChart() + '</section>' +
      '<section class="card"><h3>Profit by artist — ' + esc(periodLabel()) + '</h3>' +
      table('period-artists', [
        {label: 'Artist', get: function (r) { return r.artist; }},
        {label: 'Sales', get: function (r) { return r.sales; }, fmt: 'int', num: true},
        {label: 'Tickets', get: function (r) { return r.tickets; }, fmt: 'int', num: true},
        {label: 'Revenue', get: function (r) { return r.revenue; }, fmt: 'usd', num: true},
        {label: 'Cost', get: function (r) { return r.cost; }, fmt: 'usd', num: true},
        {label: 'Profit', get: function (r) { return r.profit; }, fmt: 'susd', num: true, signed: true},
        {label: 'ROI', get: function (r) { return r.roi; }, fmt: 'spct', num: true, signed: true},
        {label: 'Win rate', get: function (r) { return r.winRate; }, fmt: 'pct', num: true}
      ], arts, {sort: {label: 'Profit', dir: 'desc'}, empty: 'No sales logged in this period yet. Add some on the Import tab.'}) + '</section>' +
      '<div class="two"><section class="card"><h3>Biggest wins</h3>' + table('wins', saleCols, sorted.filter(function (s) { return s.profit > 0; }).slice(0, 8), {searchable: false, empty: 'None yet.'}) +
      '</section><section class="card"><h3>Biggest losses</h3>' + table('losses', saleCols, sorted.filter(function (s) { return s.profit < 0; }).reverse().slice(0, 8), {searchable: false, empty: 'No losses — nice.'}) + '</section></div>';
    return html;
  }

  function viewArtists() {
    var by = {};
    function A(n) { return by[n] || (by[n] = {artist: n, bought: 0, spent: 0, sold: 0, revenue: 0, cost: 0, profit: 0, sales: 0, wins: 0, open: 0, openCost: 0, dead: 0, deadCost: 0}); }
    S.R.orders.forEach(function (o) {
      var a = A(o.artist);
      if (inPeriod(o.bought) || (S.year === 'all' && S.month === 'all')) { a.bought += o.qty; a.spent += o.total; }
      if (/passed/.test(o.status)) { a.dead += o.remaining; a.deadCost += o.unsoldCost; } else { a.open += o.remaining; a.openCost += o.unsoldCost; }
    });
    S.R.sales.forEach(function (s) {
      if (!inPeriod(s.soldAt)) return;
      var a = A(s.artist); a.sold += s.qty; a.revenue += s.total; a.cost += s.total - s.profit; a.profit += s.profit; a.sales++; if (s.profit > 0) a.wins++;
    });
    var rows = Object.keys(by).map(function (k) { var a = by[k]; a.roi = a.cost ? a.profit / a.cost : null; return a; })
      .filter(function (a) { return a.sales || a.bought || a.open; });
    return '<h2>Artists — ' + esc(periodLabel()) + '</h2><p class="hint">Sales, profit and money spent follow the period you picked. "Unsold" columns are your inventory right now. Use <b>Rename</b> to fix or merge artist names (type an existing name to merge).</p>' +
      '<section class="card">' + table('artists', [
        {label: 'Artist', get: function (r) { return r.artist; }},
        {label: 'Bought', get: function (r) { return r.bought; }, fmt: 'int', num: true},
        {label: 'Spent', get: function (r) { return r.spent; }, fmt: 'usd', num: true},
        {label: 'Sold', get: function (r) { return r.sold; }, fmt: 'int', num: true},
        {label: 'Revenue', get: function (r) { return r.revenue; }, fmt: 'usd', num: true},
        {label: 'Profit', get: function (r) { return r.profit; }, fmt: 'susd', num: true, signed: true},
        {label: 'ROI', get: function (r) { return r.roi; }, fmt: 'spct', num: true, signed: true},
        {label: 'Unsold (upcoming)', get: function (r) { return r.open; }, fmt: 'int', num: true},
        {label: 'Unsold cost (upcoming)', get: function (r) { return r.openCost; }, fmt: 'usd', num: true},
        {label: 'Unsold (event passed)', get: function (r) { return r.dead; }, fmt: 'int', num: true}
      ], rows, {sort: {label: 'Profit', dir: 'desc'}, actions: function (r) { return '<button class="link" data-rename="' + esc(r.artist) + '">Rename</button>'; }}) + '</section>';
  }

  function viewShows() {
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var which = S.showWhich || 'all';
    var rows = S.R.shows.filter(function (s) {
      if (which === 'upcoming') return s.date && s.date >= today;
      if (which === 'past') return s.date && s.date < today;
      return true;
    });
    var tools = '<select id="showWhich">' + [['all', 'All shows'], ['upcoming', 'Upcoming'], ['past', 'Past']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === which ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>';
    return '<h2>Shows</h2><p class="hint">One row per artist per show date, across everything you have ever logged.</p><section class="card">' + table('shows', [
      {label: 'Show date', get: function (r) { return r.date; }, fmt: 'date'},
      {label: 'Artist', get: function (r) { return r.artist; }},
      {label: 'Venue', get: function (r) { return r.venue; }, wrap: true},
      {label: 'Bought', get: function (r) { return r.bought; }, fmt: 'int', num: true},
      {label: 'Spent', get: function (r) { return r.spent; }, fmt: 'usd', num: true},
      {label: 'Sold', get: function (r) { return r.sold; }, fmt: 'int', num: true},
      {label: 'Revenue', get: function (r) { return r.revenue; }, fmt: 'usd', num: true},
      {label: 'Profit', get: function (r) { return r.profit; }, fmt: 'susd', num: true, signed: true},
      {label: 'ROI', get: function (r) { return r.roi; }, fmt: 'spct', num: true, signed: true},
      {label: 'Left', get: function (r) { return r.open; }, fmt: 'int', num: true},
      {label: 'Unsold cost', get: function (r) { return r.openCost; }, fmt: 'usd', num: true}
    ], rows, {sort: {label: 'Show date', dir: 'asc'}, extraTools: tools}) + '</section>';
  }

  function viewInventory() {
    var statuses = {}; S.R.orders.forEach(function (o) { statuses[o.status] = (statuses[o.status] || 0) + 1; });
    var rows = S.R.orders.filter(function (o) { return S.invStatus === 'all' || o.status === S.invStatus; });
    var tools = '<select id="invStatus"><option value="all">All statuses (' + S.R.orders.length + ')</option>' +
      Object.keys(statuses).sort().map(function (k) { return '<option' + (k === S.invStatus ? ' selected' : '') + ' value="' + esc(k) + '">' + esc(k) + ' (' + statuses[k] + ')</option>'; }).join('') + '</select>';
    return '<h2>Inventory</h2><p class="hint">Every PL order and how much of it has sold. "No sale logged" just means no Discord sale for that order has been imported.</p><section class="card">' + table('inventory', [
      {label: 'Show date', get: function (r) { return r.eventDate; }, fmt: 'date'},
      {label: 'Artist', get: function (r) { return r.artist; }},
      {label: 'Seats', get: function (r) { return r.seats.replace(/\s*\n\s*/g, ' / '); }, wrap: true},
      {label: 'Bought', get: function (r) { return r.qty; }, fmt: 'int', num: true},
      {label: 'Sold', get: function (r) { return r.soldQty; }, fmt: 'int', num: true},
      {label: 'Left', get: function (r) { return r.remaining; }, fmt: 'int', num: true},
      {label: 'Status', get: function (r) { return r.status; }},
      {label: 'Cost', get: function (r) { return r.total; }, fmt: 'usd', num: true},
      {label: 'Revenue', get: function (r) { return r.revenue; }, fmt: 'usd', num: true},
      {label: 'Profit', get: function (r) { return r.profit; }, fmt: 'susd', num: true, signed: true},
      {label: 'Unsold cost', get: function (r) { return r.unsoldCost; }, fmt: 'usd', num: true},
      {label: 'Order #', get: function (r) { return r.order; }},
      {label: 'Bought on', get: function (r) { return r.bought; }, fmt: 'date'},
      {label: 'Site', get: function (r) { return r.site; }}
    ], rows, {sort: {label: 'Show date', dir: 'asc'}, extraTools: tools}) + '</section>';
  }

  function viewSales() {
    var rows = S.R.sales.filter(function (s) { return inPeriod(s.soldAt); });
    return '<h2>Sales — ' + esc(periodLabel()) + '</h2><section class="card">' + table('sales', [
      {label: 'Sold', get: function (r) { return r.soldAt; }, fmt: 'datetime'},
      {label: 'Artist', get: function (r) { return r.artist; }},
      {label: 'Show date', get: function (r) { return r.eventDate; }, fmt: 'date'},
      {label: 'Venue', get: function (r) { return r.venue; }, wrap: true},
      {label: 'Section', get: function (r) { return r.section; }},
      {label: 'Row', get: function (r) { return r.row; }},
      {label: 'Qty', get: function (r) { return r.qty; }, fmt: 'int', num: true},
      {label: 'Cost / tkt', get: function (r) { return r.costPer; }, fmt: 'usd', num: true},
      {label: 'Sold / tkt', get: function (r) { return r.soldPer; }, fmt: 'usd', num: true},
      {label: 'Total sale', get: function (r) { return r.total; }, fmt: 'usd', num: true},
      {label: 'Profit', get: function (r) { return r.profit; }, fmt: 'susd', num: true, signed: true},
      {label: 'ROI', get: function (r) { return r.roi; }, fmt: 'spct', num: true, signed: true},
      {label: 'Marketplace', get: function (r) { return r.marketplace; }},
      {label: 'Time to sell', get: function (r) { return r.timeToSell; }},
      {label: 'Order #s', get: function (r) { return (r.orders || []).join(', '); }},
      {label: 'In PL orders?', get: function (r) { return r.matched ? 'Yes' : 'No'; }}
    ], rows, {sort: {label: 'Sold', dir: 'desc'}, actions: function (r) { return '<button class="link danger" data-delsale="' + esc(r.key) + '" title="Remove this sale">Remove</button>'; }}) + '</section>';
  }

  function viewImport() {
    var po = S.pendingOrders, ps = S.pendingSales;
    var oSum = '', sSum = '';
    if (po) oSum = '<div class="pill ok">' + po.fresh.length + ' new orders</div><div class="pill">' + po.changed.length + ' updated</div><div class="pill muted">' + po.same + ' already saved</div>' +
      (po.skipped ? '<div class="pill muted">' + po.skipped + ' rows without an order number skipped</div>' : '');
    if (ps) {
      var known = {}; S.raw.orders.forEach(function (r) { known[r.order_number] = 1; });
      if (po) po.fresh.forEach(function (r) { known[r.order_number] = 1; });
      var unmatched = ps.fresh.filter(function (s) { return !s.orders.some(function (o) { return known[o]; }); });
      var profit = ps.fresh.reduce(function (t, s) { return t + s.profit; }, 0);
      sSum = '<div class="pill ok">' + ps.fresh.length + ' new sales</div><div class="pill muted">' + ps.dupes + ' already saved</div>' +
        (ps.fresh.length ? '<div class="pill ' + signClass(profit) + '">New profit ' + esc(fmt(profit, 'susd')) + '</div>' : '') +
        (unmatched.length ? '<div class="pill warn">' + unmatched.length + ' not found in PL orders: ' + esc(unmatched.slice(0, 4).map(function (s) { return s.event + ' (' + (s.orders.join(', ') || 'no order #') + ')'; }).join('; ')) + (unmatched.length > 4 ? '…' : '') + '</div>' : '');
    }
    var ready = (po && (po.fresh.length || po.changed.length)) || (ps && ps.fresh.length);
    return '<h2>Import</h2><p class="hint">Add your newest PL orders CSV and/or Discord sales. Only new or changed data is saved — re-importing the same thing is always safe. Nothing is ever deleted.</p>' +
      '<div class="two">' +
      '<section class="card"><h3>1 · PL orders CSV</h3><p class="hint">In the PL Orders sheet: File → Download → Comma-separated values (.csv).</p>' +
      '<label class="drop" id="csvDrop"><input type="file" id="csvFile" accept=".csv,text/csv"><span>' + (po ? esc(po.name) : 'Drop the CSV here or click to choose') + '</span></label>' + oSum + '</section>' +
      '<section class="card"><h3>2 · Discord sales</h3><p class="hint">Use the Sales Grabber (Help tab) → Copy all, then paste here. Copying straight from Discord works too.</p>' +
      '<textarea id="discordText" placeholder="Paste here (Ctrl+V)">' + esc(S.pendingText || '') + '</textarea>' + sSum + '</section>' +
      '</div>' +
      '<div class="savebar"><button id="saveBtn" class="primary"' + (ready ? '' : ' disabled') + '>' + (S.store.demo ? 'Add (demo – not saved)' : 'Add to my database') + '</button>' +
      '<button id="clearBtn" class="ghost">Clear</button></div>';
  }

  function viewHelp() {
    return '<h2>Help</h2>' +
      '<section class="card"><h3>Sales Grabber (Discord exporter)</h3>' +
      '<p><b>Set it up once:</b> show your bookmarks bar (Ctrl+Shift+B), then drag this button onto it:</p>' +
      '<p><a class="bm" id="bmLink" href="#">📋 Sales Grabber</a></p>' +
      '<p class="hint">Can\'t drag it? Right-click your bookmarks bar → Add page → name it "Sales Grabber" and paste this as the URL: <button class="link" id="copyBm">copy bookmark code</button></p>' +
      '<p><b>Each time:</b></p><ol><li>Open Discord in Chrome at <b>discord.com</b> (not the desktop app) and go to your sales channel.</li>' +
      '<li>Click the <b>Sales Grabber</b> bookmark. A small panel appears bottom-right.</li>' +
      '<li>Scroll up until you pass the last sale you imported — or press <b>Auto-scroll up</b> to collect everything.</li>' +
      '<li>Press <b>Copy all</b>, come back here → <b>Import</b> tab → paste into the Discord box → <b>Add to my database</b>.</li></ol>' +
      '<p class="hint">It only reads what is on your screen. It does not use your login token or Discord\'s API.</p></section>' +
      '<section class="card"><h3>How the numbers work</h3><ul>' +
      '<li><b>Profit / revenue / ROI</b> come straight from each Discord sale and count in the month the sale happened.</li>' +
      '<li><b>Spent on new orders</b> counts in the month you bought the tickets (from the PL CSV).</li>' +
      '<li>Sales are linked to orders by the order number in Discord\'s Internal Notes.</li>' +
      '<li>Duplicate sales are detected by sold time + event + section + row + qty + total.</li></ul></section>';
  }

  // ---------- import handling ----------
  function prepareOrders(name, rows) {
    var seen = {}, list = [], skipped = 0;
    rows.forEach(function (obj) { var r = csvRowToOrder(obj); if (!r) { skipped++; return; } seen[r.order_number] = r; });
    Object.keys(seen).forEach(function (k) { list.push(seen[k]); });
    var fresh = [], changed = [], same = 0;
    list.forEach(function (r) {
      var cur = S.orderIndex[r.order_number];
      if (!cur) fresh.push(r); else if (orderSig(cur) !== orderSig(r)) changed.push(r); else same++;
    });
    S.pendingOrders = {name: name, fresh: fresh, changed: changed, same: same, skipped: skipped};
  }
  function prepareSales(text) {
    S.pendingText = text;
    if (!text.trim()) { S.pendingSales = null; return; }
    var parsed = tt_parseDiscord(text), seen = {}, fresh = [], dupes = 0;
    parsed.forEach(function (s) { if (S.saleIndex[s.key] || seen[s.key]) { dupes++; return; } seen[s.key] = 1; fresh.push(s); });
    S.pendingSales = {fresh: fresh, dupes: dupes, total: parsed.length};
    if (!parsed.length) toast('No sales found in that text. Make sure it includes the full sale messages.', true);
  }
  async function saveImport() {
    var btn = $('#saveBtn'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      var nO = 0, nS = 0;
      if (S.pendingOrders) { var rows = S.pendingOrders.fresh.concat(S.pendingOrders.changed); nO = rows.length; if (rows.length) await S.store.upsertOrders(rows); }
      if (S.pendingSales && S.pendingSales.fresh.length) { nS = S.pendingSales.fresh.length; await S.store.insertSales(S.pendingSales.fresh.map(saleToDb)); }
      S.pendingOrders = S.pendingSales = null; S.pendingText = '';
      await reload();
      toast('Saved ' + nO + ' orders and ' + nS + ' sales.');
    } catch (e) {
      toast('Save failed: ' + (e.message || e), true);
      btn.disabled = false; btn.textContent = 'Add to my database';
    }
  }
  function readCsvFile(file) {
    Papa.parse(file, {header: true, skipEmptyLines: true, complete: function (res) {
      var headers = (res.meta.fields || []).map(function (h) { return String(h).trim().toLowerCase(); });
      if (headers.indexOf('order number') < 0) { toast('That CSV has no "Order Number" column — is it the PL orders export?', true); return; }
      prepareOrders(file.name, res.data); render();
    }, error: function (e) { toast('Could not read CSV: ' + e.message, true); }});
  }

  // ---------- render ----------
  var VIEWS = {overview: viewOverview, artists: viewArtists, shows: viewShows, inventory: viewInventory, sales: viewSales, import: viewImport, help: viewHelp};
  function render() {
    if (!S.R) return;
    document.querySelectorAll('nav [data-tab]').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === S.tab); });
    var usesPeriod = ['overview', 'artists', 'sales'].indexOf(S.tab) >= 0;
    $('#period').hidden = !usesPeriod;
    if (usesPeriod) renderPeriodControls();
    var main = $('#view');
    main.innerHTML = VIEWS[S.tab]();
    wireTables(main); wireChart(main);
    main.querySelectorAll('[data-rename]').forEach(function (b) {
      b.onclick = async function () {
        var old = b.dataset.rename, nn = window.prompt('Rename "' + old + '" to (type an existing artist name to merge):', old);
        if (!nn || !nn.trim() || nn.trim() === old) return;
        var rows = S.R.artistMap.filter(function (m) { return m.artist === old; }).map(function (m) { return {raw_name: m.raw, artist: nn.trim()}; });
        if (!rows.length) rows = [{raw_name: tt_norm(old), artist: nn.trim()}];
        try { await S.store.setOverrides(rows); await reload(); toast('Renamed to ' + nn.trim()); } catch (e) { toast('Rename failed: ' + (e.message || e), true); }
      };
    });
    main.querySelectorAll('[data-delsale]').forEach(function (b) {
      b.onclick = async function () {
        if (!window.confirm('Remove this sale from your tracker? (Only your tracker — Discord is not affected. If you paste this sale again later it will be added back.)')) return;
        try { await S.store.deleteSale(b.dataset.delsale); await reload(); toast('Sale removed.'); } catch (e) { toast('Remove failed: ' + (e.message || e), true); }
      };
    });
    if (S.tab === 'shows') $('#showWhich').onchange = function (e) { S.showWhich = e.target.value; render(); };
    if (S.tab === 'inventory') $('#invStatus').onchange = function (e) { S.invStatus = e.target.value; render(); };
    if (S.tab === 'import') {
      $('#csvFile').onchange = function (e) { if (e.target.files[0]) readCsvFile(e.target.files[0]); };
      var drop = $('#csvDrop');
      drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = function () { drop.classList.remove('over'); };
      drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) readCsvFile(e.dataTransfer.files[0]); };
      var ta = $('#discordText'), t;
      ta.oninput = function () { clearTimeout(t); t = setTimeout(function () { prepareSales(ta.value); render(); var n = $('#discordText'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 400); };
      $('#saveBtn').onclick = saveImport;
      $('#clearBtn').onclick = function () { S.pendingOrders = S.pendingSales = null; S.pendingText = ''; render(); };
    }
    if (S.tab === 'help') {
      var bm = window.SALES_GRABBER || '';
      $('#bmLink').setAttribute('href', bm);
      $('#bmLink').onclick = function (e) { e.preventDefault(); toast('Drag this button to your bookmarks bar, then click it while on Discord.'); };
      $('#copyBm').onclick = function () { navigator.clipboard.writeText(bm).then(function () { toast('Bookmark code copied.'); }); };
    }
    var n = S.R.sales.length, o = S.R.orders.length;
    $('#status').textContent = (S.store.demo ? 'Demo mode — nothing is saved · ' : '') + o.toLocaleString() + ' orders · ' + n.toLocaleString() + ' sales';
  }

  // ---------- auth / boot ----------
  function cfg() {
    var c = window.TRACKER_CONFIG || {};
    return {url: c.supabaseUrl || lsGet('tt_url') || '', key: c.supabaseAnonKey || lsGet('tt_key') || ''};
  }
  function showScreen(id) { ['#setup', '#login', '#app'].forEach(function (s) { $(s).hidden = s !== id; }); }

  async function startApp(store) {
    S.store = store;
    showScreen('#app');
    if (store.demo) { $('#signOut').textContent = 'Exit demo'; $('#signOut').onclick = function () { location.href = location.pathname; }; }
    document.querySelectorAll('nav [data-tab]').forEach(function (b) { b.onclick = function () { S.tab = b.dataset.tab; render(); }; });
    await reload();
    if (!S.raw.orders.length && !S.raw.sales.length) { S.tab = 'import'; render(); }
  }

  async function boot() {
    $('#demoBtn').onclick = $('#demoBtn2').onclick = function () { startApp(new MemoryStore()); };
    if (/[?&]demo\b/.test(location.search)) return startApp(new MemoryStore());
    var c = cfg();
    if (!c.url || !c.key) {
      showScreen('#setup');
      $('#setupForm').onsubmit = async function (e) {
        e.preventDefault();
        var url = $('#sbUrl').value.trim().replace(/\/+$/, '').replace(/\/(rest|auth)\/v1.*$/, ''), key = $('#sbKey').value.trim();
        if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) { toast('Project URL should look like https://abcdefgh.supabase.co (copy it from Supabase → Settings → Data API).', true); return; }
        var ok = false, status = 0;
        try { var res = await fetch(url + '/auth/v1/settings', {headers: {apikey: key}}); status = res.status; ok = res.ok; } catch (err) { status = -1; }
        if (status === -1) { toast('Could not reach ' + url + ' — the Project URL is probably mistyped (or Supabase is down). Copy it again from Supabase → Settings → Data API.', true); return; }
        if (!ok) { toast('Supabase rejected that key (error ' + status + '). Use the "anon public" key from the Legacy API keys tab.', true); return; }
        lsSet('tt_url', url); lsSet('tt_key', key);
        boot();
      };
      return;
    }
    if (!window.supabase) { toast('Could not load Supabase. Check your internet connection.', true); return; }
    var client = window.supabase.createClient(c.url, c.key);
    var sess = await client.auth.getSession();
    $('#signOut').onclick = async function () { await client.auth.signOut(); location.reload(); };
    $('#resetConn').onclick = function () { lsSet('tt_url', null); lsSet('tt_key', null); location.reload(); };
    if (sess.data && sess.data.session) return startApp(new SupabaseStore(client));
    showScreen('#login');
    $('#loginForm').onsubmit = async function (e) {
      e.preventDefault();
      var b = $('#loginBtn'); b.disabled = true;
      var r = await client.auth.signInWithPassword({email: $('#email').value.trim(), password: $('#password').value});
      b.disabled = false;
      if (r.error) {
        var msg = r.error.message || String(r.error);
        if (/fetch/i.test(msg)) msg = 'Could not reach your Supabase project (' + c.url + '). Click "Change Supabase connection" and re-enter the Project URL.';
        else if (/invalid login/i.test(msg)) msg = 'Wrong email or password.';
        else if (/not confirmed/i.test(msg)) msg = 'This user is not confirmed yet — confirm it in Supabase → Authentication → Users.';
        toast(msg, true); return;
      }
      startApp(new SupabaseStore(client));
    };
  }

  window.TT_APP = {S: S, MemoryStore: MemoryStore, SupabaseStore: SupabaseStore, csvRowToOrder: csvRowToOrder, saleToDb: saleToDb, saleFromDb: saleFromDb};
  document.addEventListener('DOMContentLoaded', boot);
})();
