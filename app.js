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
  // Matches the PL sheet's column names, tolerant of small wording differences.
  function headerKey(h) {
    h = String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (/order/.test(h) && /(number|#|no\b|id)/.test(h)) return 'order_number';
    if (/^event( name)?$|event name|^show$|^artist$/.test(h)) return 'event_name';
    if (/event date|show date|^date$/.test(h)) return 'event_date_raw';
    if (/email/.test(h) && !/cc/.test(h)) return 'email';
    if (/section|seat/.test(h)) return 'seats';
    if (/^(quantity|qty)$/.test(h)) return 'quantity';
    if (/^buyer/.test(h)) return 'buyer';
    if (/date bought|purchase date|bought on|^purchased/.test(h)) return 'date_bought_raw';
    if (/last 4|card|^cc/.test(h)) return 'card';
    if (/per ticket/.test(h)) return 'price_per_ticket';
    if (/total/.test(h)) return 'total';
    if (/^site$|platform/.test(h)) return 'site';
    return null;
  }
  function csvRowToOrder(obj) {
    var r = {};
    Object.keys(obj).forEach(function (h) {
      var k = headerKey(h);
      if (k && r[k] === undefined) r[k] = obj[h] === undefined || obj[h] === null ? '' : String(obj[h]).trim();
    });
    if (!r.order_number) return null;
    // If the event name looks like a date and the date column does not, they were swapped.
    if (tt_looksLikeDate(r.event_name) && r.event_date_raw && !tt_looksLikeDate(r.event_date_raw)) {
      var tmp = r.event_name; r.event_name = r.event_date_raw; r.event_date_raw = tmp;
    }
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
  SupabaseStore.prototype.replaceSales = async function (rows, oldKeys) {   // repair: write corrected rows, then drop the old copies
    var uid = await this.userId(), self = this;
    for (var part of chunk(rows, 500)) {
      var r = await self.sb.from('sales').upsert(part.map(function (x) { return Object.assign({}, x, {user_id: uid}); }), {onConflict: 'user_id,sale_key'});
      if (r.error) throw r.error;
    }
    var plain = oldKeys.filter(function (k) { return k.indexOf('"') < 0; }), quoted = oldKeys.filter(function (k) { return k.indexOf('"') >= 0; });
    for (var ks of chunk(plain, 40)) {
      var d = await self.sb.from('sales').delete().in('sale_key', ks);
      if (d.error) throw d.error;
    }
    for (var q of quoted) {
      var d2 = await self.sb.from('sales').delete().eq('sale_key', q);
      if (d2.error) throw d2.error;
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
  MemoryStore.prototype.replaceSales = async function (rows, oldKeys) { var self = this; rows.forEach(function (r) { self.s[r.sale_key] = Object.assign({}, self.s[r.sale_key] || {}, r); }); oldKeys.forEach(function (k) { delete self.s[k]; }); };
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
    derive();
    if (!S.month) {
      var withSales = S.R.monthly.filter(function (m) { return m.sales; });
      S.month = withSales.length ? withSales[0].month : tt_monthKey(new Date());
      S.year = S.month.slice(0, 4);
    }
  }

  // Sales saved by the earlier version have a timestamp as the artist and the result label as the venue.
  // Every sale still has its order number, so take the artist + show date from the matching PL order.
  var TIER_RE = /^(MASSIVE SALE|FANTASTIC SALE|PROFITABLE|EHH SALE|BREAK EVEN|LOSS)$/i;
  function isScrambled(r) { return tt_notAName(r.event) || TIER_RE.test(String(r.venue || '').trim()); }
  function repairsFromOrders() {
    var byOrder = {};
    S.R.orders.forEach(function (o) { byOrder[o.order] = o; });
    var out = [];
    S.raw.sales.forEach(function (r) {
      if (!isScrambled(r)) return;
      var fix = {sale_key: r.sale_key};
      var o = (r.order_numbers || []).map(function (n) { return byOrder[n]; }).filter(Boolean)[0];
      if (tt_notAName(r.event) && o && o.event) { fix.event = o.event; fix.event_date = o.eventDate ? tt_dayKey(o.eventDate) : r.event_date; }
      if (TIER_RE.test(String(r.venue || '').trim())) { fix.result = String(r.venue).trim(); fix.venue = null; }
      if (Object.keys(fix).length > 1) out.push(fix);
    });
    return out;
  }
  async function reload(noRepair) {
    $('#loading').hidden = false;
    try {
      S.raw = await S.store.loadAll();
      rebuild();
      var fixes = noRepair ? [] : repairsFromOrders();
      if (fixes.length) {
        await S.store.replaceSales(fixes, []);
        S.raw = await S.store.loadAll();
        rebuild();
        var left = S.raw.sales.filter(isScrambled).length;
        toast('Fixed ' + fixes.length.toLocaleString() + ' sales using your PL orders' + (left ? ' (' + left + ' could not be matched to a PL order)' : '') + '.');
      }
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
        var shownV = esc(fmt(v, c.fmt)), href = c.link ? c.link(r) : null;
        if (href && shownV) shownV = '<a href="' + esc(href) + '">' + shownV + '</a>';
        return '<td class="' + cls + '"' + (c.wrap ? '' : ' style="white-space:nowrap"') + '>' + shownV + '</td>';
      }).join('') + (opts.actions ? '<td class="act">' + opts.actions(r, i) + '</td>' : '') + '</tr>';
    }).join('');
    var tools = '<div class="tabletools">' +
      (opts.searchable === false ? '' : '<input type="search" class="' + (opts.bigSearch ? 'big' : '') + '" placeholder="' + esc(opts.bigSearch || 'Search…') + '" data-search="' + id + '" value="' + esc(S.search[id] || '') + '">') +
      (opts.extraTools || '') +
      '<span class="count">' + (list.length > limit ? 'Showing ' + limit + ' of ' : '') + list.length.toLocaleString() + ' rows</span>' +
      (opts.nocsv ? '' : '<button class="ghost" data-csv="' + id + '">Download CSV</button>') + '</div>';
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

  // ---------- derived data (artists, venues, shows) ----------
  function splitVenue(v) {
    var p = String(v || '').split(/\s+•\s+/);
    return {name: (p[0] || '').trim(), city: p.slice(1).join(', ').trim()};
  }
  function showKey(artist, d) { return artist + '|' + (d ? tt_dayKey(d) : ''); }
  function derive() {
    var D = {artists: {}, venues: {}, showVenue: {}};
    S.R.sales.forEach(function (s) { if (s.venue) D.showVenue[showKey(s.artist, s.eventDate)] = s.venue; });
    function A(n) { return D.artists[n] || (D.artists[n] = {name: n, orders: [], sales: []}); }
    function V(full) { var v = splitVenue(full); return D.venues[v.name] || (D.venues[v.name] = {name: v.name, city: v.city, orders: [], sales: []}); }
    S.R.orders.forEach(function (o) {
      o.venueFull = D.showVenue[showKey(o.artist, o.eventDate)] || '';
      A(o.artist).orders.push(o);
      if (o.venueFull) V(o.venueFull).orders.push(o);
    });
    S.R.sales.forEach(function (s) {
      A(s.artist).sales.push(s);
      if (s.venue) V(s.venue).sales.push(s);
    });
    S.D = D;
  }
  function holding(orders) {   // tickets still in hand for upcoming shows
    var t = 0, c = 0;
    orders.forEach(function (o) { if (!/passed/.test(o.status)) { t += o.remaining; c += o.unsoldCost; } });
    return {tickets: t, cost: c};
  }
  function artistLink(n) { return '#artist/' + encodeURIComponent(n); }
  function venueLink(n) { return n ? '#venue/' + encodeURIComponent(n) : null; }

  // ---------- views ----------
  function kpi(label, value, kind, sub) {
    return '<div class="kpi"><div class="kl">' + esc(label) + '</div><div class="kv ' + (kind === 'susd' || kind === 'spct' ? signClass(value) : '') + '">' + esc(fmt(value, kind) || '—') + '</div>' + (sub ? '<div class="ks">' + esc(sub) + '</div>' : '') + '</div>';
  }
  function groupSales(list, keyFn) {
    var by = {};
    list.forEach(function (s) { var k = keyFn(s); (by[k] = by[k] || []).push(s); });
    return Object.keys(by).map(function (k) { var a = aggSales(by[k]); a.key = k; a.list = by[k]; return a; });
  }
  var COL = {
    profit: {label: 'Profit', get: function (r) { return r.profit; }, fmt: 'susd', num: true, signed: true},
    roi: {label: 'ROI', get: function (r) { return r.roi; }, fmt: 'spct', num: true, signed: true},
    revenue: {label: 'Revenue', get: function (r) { return r.revenue; }, fmt: 'usd', num: true},
    sales: {label: 'Sales', get: function (r) { return r.sales; }, fmt: 'int', num: true},
    tickets: {label: 'Tickets sold', get: function (r) { return r.tickets; }, fmt: 'int', num: true}
  };
  function saleCols(opts) {
    opts = opts || {};
    var c = [{label: 'Sold on', get: function (s) { return s.soldAt; }, fmt: 'datetime'}];
    if (!opts.noArtist) c.push({label: 'Artist', get: function (s) { return s.artist; }, link: function (s) { return artistLink(s.artist); }});
    c.push({label: 'Show date', get: function (s) { return s.eventDate; }, fmt: 'date'});
    if (!opts.noVenue) c.push({label: 'Venue', get: function (s) { return splitVenue(s.venue).name; }, link: function (s) { return venueLink(splitVenue(s.venue).name); }});
    c.push({label: 'Seats', get: function (s) { return 'Sec ' + s.section + ' · Row ' + s.row; }},
      {label: 'Qty', get: function (s) { return s.qty; }, fmt: 'int', num: true},
      {label: 'Paid / tkt', get: function (s) { return s.costPer; }, fmt: 'usd', num: true},
      {label: 'Sold / tkt', get: function (s) { return s.soldPer; }, fmt: 'usd', num: true},
      {label: 'Total sale', get: function (s) { return s.total; }, fmt: 'usd', num: true},
      COL.profit, COL.roi,
      {label: 'Sold on site', get: function (s) { return s.marketplace; }},
      {label: 'Time to sell', get: function (s) { return s.timeToSell; }});
    if (opts.orders) c.push({label: 'Order #', get: function (s) { return (s.orders || []).join(', '); }});
    return c;
  }

  function viewOverview() {
    var sales = S.R.sales.filter(function (s) { return inPeriod(s.soldAt); });
    var a = aggSales(sales);
    var spent = 0, boughtTix = 0;
    S.R.orders.forEach(function (o) { if (inPeriod(o.bought)) { spent += o.total; boughtTix += o.qty; } });
    var h = holding(S.R.orders);
    var arts = groupSales(sales, function (s) { return s.artist; });
    var vens = groupSales(sales.filter(function (s) { return s.venue; }), function (s) { return splitVenue(s.venue).name; });
    var sorted = sales.slice().sort(function (x, y) { return y.profit - x.profit; });
    var mini = [
      {label: 'Artist', get: function (s) { return s.artist; }, link: function (s) { return artistLink(s.artist); }},
      {label: 'Seats', get: function (s) { return 'Sec ' + s.section + ' · Row ' + s.row + ' · ×' + s.qty; }},
      COL.profit
    ];
    var bad = S.R.sales.filter(function (s) { return tt_notAName(s.event); }).length;
    var noVenue = S.R.sales.filter(function (s) { return !s.venue; }).length;
    var warn = bad ? '<div class="banner">⚠ ' + bad.toLocaleString() + ' sales have no artist name because their order number is not in your PL orders. Import the newest PL CSV, or re-send them from the extension (<b>Export entire channel</b>) and they will be repaired — not duplicated.</div>' :
      noVenue > 20 ? '<div class="banner">ℹ ' + noVenue.toLocaleString() + ' older sales are missing their venue (the earlier version didn\'t read it). Artist names and profit are correct. To fill in venues: in the extension click <b>Export entire channel</b> — they are updated in place, not duplicated.</div>' : '';
    return warn + '<h2>' + esc(periodLabel()) + '</h2>' +
      '<div class="kpis">' +
      kpi('Profit', a.profit, 'susd') + kpi('Revenue', a.revenue, 'usd') +
      kpi('ROI', a.roi, 'spct', a.winRate === null ? '' : fmt(a.winRate, 'pct') + ' of sales profitable') +
      kpi('Tickets sold', a.tickets, 'int', a.sales + ' sales') +
      kpi('Spent on new orders', spent, 'usd', boughtTix.toLocaleString() + ' tickets bought') +
      kpi('Still holding', h.tickets, 'int', fmt(h.cost, 'usd') + ' in upcoming shows') +
      '</div>' +
      '<section class="card"><h3>Profit by month</h3><p class="hint">Hover for details · click a bar to open that month</p>' + profitChart() + '</section>' +
      '<div class="two">' +
      '<section class="card"><h3>By artist</h3>' + table('ov-artists', [
        {label: 'Artist', get: function (r) { return r.key; }, link: function (r) { return artistLink(r.key); }},
        COL.sales, COL.tickets, COL.profit, COL.roi
      ], arts, {sort: {label: 'Profit', dir: 'desc'}, searchable: false, empty: 'No sales in this period yet.'}) + '</section>' +
      '<section class="card"><h3>By venue</h3>' + table('ov-venues', [
        {label: 'Venue', get: function (r) { return r.key; }, link: function (r) { return venueLink(r.key); }},
        COL.sales, COL.tickets, COL.profit, COL.roi
      ], vens, {sort: {label: 'Profit', dir: 'desc'}, searchable: false, empty: 'No sales in this period yet.'}) + '</section>' +
      '</div>' +
      '<div class="two"><section class="card"><h3>Biggest wins</h3>' + table('wins', mini, sorted.filter(function (s) { return s.profit > 0; }).slice(0, 8), {searchable: false, nocsv: true, empty: 'None yet.'}) +
      '</section><section class="card"><h3>Biggest losses</h3>' + table('losses', mini, sorted.filter(function (s) { return s.profit < 0; }).reverse().slice(0, 8), {searchable: false, nocsv: true, empty: 'No losses — nice.'}) + '</section></div>';
  }

  function viewArtists() {
    var rows = Object.keys(S.D.artists).map(function (n) {
      var A = S.D.artists[n];
      var ps = A.sales.filter(function (s) { return inPeriod(s.soldAt); });
      var a = aggSales(ps);
      var bought = 0, spent = 0;
      A.orders.forEach(function (o) { if (inPeriod(o.bought)) { bought += o.qty; spent += o.total; } });
      var h = holding(A.orders);
      var last = null; A.sales.forEach(function (s) { if (s.soldAt && (!last || s.soldAt > last)) last = s.soldAt; });
      return {artist: n, profit: a.profit, roi: a.roi, sales: a.sales, tickets: a.tickets, revenue: a.revenue, bought: bought, spent: spent, left: h.tickets, leftCost: h.cost, last: last};
    });
    var showAll = S.artistsAll;
    if (!showAll) rows = rows.filter(function (r) { return r.sales || r.bought; });
    var tools = '<label class="chk"><input type="checkbox" id="artistsAll"' + (showAll ? ' checked' : '') + '> Include artists with no activity in this period</label>';
    return '<h2>Artists <span class="sub">' + esc(periodLabel()) + '</span></h2>' +
      '<p class="hint">Type an artist below, then click the name to see every show, venue and sale for them.</p>' +
      '<section class="card">' + table('artists', [
        {label: 'Artist', get: function (r) { return r.artist; }, link: function (r) { return artistLink(r.artist); }},
        COL.profit, COL.roi, COL.sales, COL.tickets, COL.revenue,
        {label: 'Tickets bought', get: function (r) { return r.bought; }, fmt: 'int', num: true},
        {label: 'Spent', get: function (r) { return r.spent; }, fmt: 'usd', num: true},
        {label: 'Still holding', get: function (r) { return r.left; }, fmt: 'int', num: true},
        {label: 'Last sale', get: function (r) { return r.last; }, fmt: 'date'}
      ], rows, {sort: {label: 'Profit', dir: 'desc'}, extraTools: tools, bigSearch: 'Search artists… (e.g. Bruno Mars)', empty: 'No artists with activity in this period. Tick "Include artists with no activity" or pick another month.'}) + '</section>';
  }

  function viewArtist(name) {
    var A = S.D.artists[name];
    if (!A) return '<p><a href="#artists">← Artists</a></p><h2>' + esc(name) + '</h2><p class="hint">No data for this artist.</p>';
    var a = aggSales(A.sales);
    var bought = 0, spent = 0; A.orders.forEach(function (o) { bought += o.qty; spent += o.total; });
    var h = holding(A.orders);
    // shows: one row per show date
    var shows = {};
    function SH(d, venueFull) {
      var k = d ? tt_dayKey(d) : 'unknown';
      var x = shows[k] || (shows[k] = {date: d, venue: '', bought: 0, spent: 0, sold: 0, revenue: 0, cost: 0, profit: 0, left: 0, sales: 0});
      if (venueFull && !x.venue) x.venue = venueFull;
      return x;
    }
    A.orders.forEach(function (o) { var x = SH(o.eventDate, o.venueFull); x.bought += o.qty; x.spent += o.total; x.left += o.remaining; });
    A.sales.forEach(function (s) { var x = SH(s.eventDate, s.venue); x.sold += s.qty; x.revenue += s.total; x.cost += s.total - s.profit; x.profit += s.profit; x.sales++; });
    var showRows = Object.keys(shows).map(function (k) { var x = shows[k]; x.roi = x.cost ? x.profit / x.cost : null; return x; });
    var held = A.orders.filter(function (o) { return o.remaining > 0; });
    return '<p class="crumb"><a href="#artists">← All artists</a></p>' +
      '<h2>' + esc(name) + ' <span class="sub">All time</span> <button class="link small" data-rename="' + esc(name) + '">rename / merge</button></h2>' +
      '<div class="kpis">' +
      kpi('Profit', a.profit, 'susd') + kpi('Revenue', a.revenue, 'usd') +
      kpi('ROI', a.roi, 'spct', a.winRate === null ? '' : fmt(a.winRate, 'pct') + ' of sales profitable') +
      kpi('Tickets sold', a.tickets, 'int', 'of ' + bought.toLocaleString() + ' bought · ' + a.sales + ' sales') +
      kpi('Spent', spent, 'usd', A.orders.length + ' orders') +
      kpi('Still holding', h.tickets, 'int', fmt(h.cost, 'usd') + ' in upcoming shows') +
      '</div>' +
      '<section class="card"><h3>Shows &amp; venues</h3>' + table('a-shows', [
        {label: 'Show date', get: function (r) { return r.date; }, fmt: 'date'},
        {label: 'Venue', get: function (r) { return splitVenue(r.venue).name || '—'; }, link: function (r) { return venueLink(splitVenue(r.venue).name); }},
        {label: 'City', get: function (r) { return splitVenue(r.venue).city; }},
        {label: 'Bought', get: function (r) { return r.bought; }, fmt: 'int', num: true},
        {label: 'Sold', get: function (r) { return r.sold; }, fmt: 'int', num: true},
        {label: 'Left', get: function (r) { return r.left; }, fmt: 'int', num: true},
        {label: 'Spent', get: function (r) { return r.spent; }, fmt: 'usd', num: true},
        COL.revenue, COL.profit, COL.roi
      ], showRows, {sort: {label: 'Show date', dir: 'desc'}, searchable: false}) +
      '<p class="hint">Venue appears once a ticket for that show has sold (the PL file has no venue column).</p></section>' +
      '<section class="card"><h3>Every sale</h3>' + table('a-sales', saleCols({noArtist: true, orders: true}), A.sales, {sort: {label: 'Sold on', dir: 'desc'}, empty: 'No sales logged yet.'}) + '</section>' +
      '<section class="card"><h3>Tickets still in hand</h3>' + table('a-held', [
        {label: 'Show date', get: function (r) { return r.eventDate; }, fmt: 'date'},
        {label: 'Seats', get: function (r) { return r.seats.replace(/\s*[\r\n]+\s*/g, ' / '); }, wrap: true},
        {label: 'Bought', get: function (r) { return r.qty; }, fmt: 'int', num: true},
        {label: 'Sold', get: function (r) { return r.soldQty; }, fmt: 'int', num: true},
        {label: 'Left', get: function (r) { return r.remaining; }, fmt: 'int', num: true},
        {label: 'Cost of what\'s left', get: function (r) { return r.unsoldCost; }, fmt: 'usd', num: true},
        {label: 'Status', get: function (r) { return r.status; }},
        {label: 'Order #', get: function (r) { return r.order; }},
        {label: 'Bought on', get: function (r) { return r.bought; }, fmt: 'date'}
      ], held, {sort: {label: 'Show date', dir: 'asc'}, searchable: false, empty: 'Everything for this artist has sold.'}) + '</section>';
  }

  function viewVenues() {
    var rows = Object.keys(S.D.venues).map(function (n) {
      var V = S.D.venues[n];
      var ps = V.sales.filter(function (s) { return inPeriod(s.soldAt); });
      var a = aggSales(ps);
      var arts = {}; ps.forEach(function (s) { arts[s.artist] = 1; });
      a.venue = n; a.city = V.city; a.artists = Object.keys(arts).length;
      return a;
    }).filter(function (r) { return r.sales; });
    return '<h2>Venues <span class="sub">' + esc(periodLabel()) + '</span></h2>' +
      '<p class="hint">Click a venue to see every artist and sale there.</p>' +
      '<section class="card">' + table('venues', [
        {label: 'Venue', get: function (r) { return r.venue; }, link: function (r) { return venueLink(r.venue); }},
        {label: 'City', get: function (r) { return r.city; }},
        COL.profit, COL.roi, COL.sales, COL.tickets, COL.revenue,
        {label: 'Artists', get: function (r) { return r.artists; }, fmt: 'int', num: true}
      ], rows, {sort: {label: 'Profit', dir: 'desc'}, bigSearch: 'Search venues or cities…', empty: 'No sales in this period.'}) + '</section>';
  }

  function viewVenue(name) {
    var V = S.D.venues[name];
    if (!V) return '<p><a href="#venues">← Venues</a></p><h2>' + esc(name) + '</h2><p class="hint">No data for this venue.</p>';
    var a = aggSales(V.sales);
    var arts = groupSales(V.sales, function (s) { return s.artist; }).map(function (r) {
      var d = {}; r.list.forEach(function (s) { d[s.eventDate ? tt_dayKey(s.eventDate) : ''] = 1; }); r.shows = Object.keys(d).length; return r;
    });
    var h = holding(V.orders);
    return '<p class="crumb"><a href="#venues">← All venues</a></p>' +
      '<h2>' + esc(name) + ' <span class="sub">' + esc(V.city) + ' · All time</span></h2>' +
      '<div class="kpis">' +
      kpi('Profit', a.profit, 'susd') + kpi('Revenue', a.revenue, 'usd') +
      kpi('ROI', a.roi, 'spct', a.winRate === null ? '' : fmt(a.winRate, 'pct') + ' of sales profitable') +
      kpi('Tickets sold', a.tickets, 'int', a.sales + ' sales') +
      kpi('Artists', arts.length, 'int') +
      kpi('Still holding', h.tickets, 'int', fmt(h.cost, 'usd') + ' upcoming here') +
      '</div>' +
      '<section class="card"><h3>By artist</h3>' + table('v-artists', [
        {label: 'Artist', get: function (r) { return r.key; }, link: function (r) { return artistLink(r.key); }},
        {label: 'Shows', get: function (r) { return r.shows; }, fmt: 'int', num: true},
        COL.sales, COL.tickets, COL.revenue, COL.profit, COL.roi
      ], arts, {sort: {label: 'Profit', dir: 'desc'}, searchable: false}) + '</section>' +
      '<section class="card"><h3>Every sale here</h3>' + table('v-sales', saleCols({noVenue: true}), V.sales, {sort: {label: 'Sold on', dir: 'desc'}}) + '</section>';
  }

  function viewSales() {
    var rows = S.R.sales.filter(function (s) { return inPeriod(s.soldAt); });
    return '<h2>Sales <span class="sub">' + esc(periodLabel()) + '</span></h2>' +
      '<section class="card">' + table('sales', saleCols({orders: true}).concat([{label: 'In PL orders?', get: function (r) { return r.matched ? 'Yes' : 'No'; }}]), rows,
        {sort: {label: 'Sold on', dir: 'desc'}, bigSearch: 'Search sales (artist, venue, section, order #)…',
          actions: function (r) { return '<button class="link danger" data-delsale="' + esc(r.key) + '" title="Remove this sale">Remove</button>'; }}) + '</section>';
  }

  function viewImport() {
    var log = (S.importLog || []).slice(-8).reverse().map(function (l) {
      return '<li><b>' + esc(l.when) + '</b> — ' + esc(l.text) + '</li>';
    }).join('');
    return '<h2>Import</h2><p class="hint">Add either one, any time — they are saved as soon as you drop or paste them. Only new or changed data is added; repeats are skipped. The extension fills the sales box for you.</p>' +
      '<div class="two">' +
      '<section class="card"><h3>PL orders CSV</h3><p class="hint">PL Orders sheet → File → Download → Comma-separated values (.csv). Drop it here.</p>' +
      '<label class="drop" id="csvDrop"><input type="file" id="csvFile" accept=".csv,text/csv"><span>Drop the CSV here or click to choose</span></label></section>' +
      '<section class="card"><h3>Discord sales</h3><p class="hint">Paste sale messages here (Ctrl+V) — or use the extension\'s "Export new sales".</p>' +
      '<textarea id="discordText" placeholder="Paste here (Ctrl+V)"></textarea></section>' +
      '</div>' +
      '<section class="card"><h3>Recent imports</h3>' + (log ? '<ul class="log">' + log + '</ul>' : '<p class="hint">Nothing imported in this session yet.</p>') + '</section>';
  }

  function viewExtension() {
    return '<h2>Sales Grabber extension</h2>' +
      '<section class="card"><h3>Install (one time)</h3>' +
      '<p><a class="bm" href="sales-grabber-extension.zip" download>⬇ Download the extension</a></p><ol>' +
      '<li>Right-click the downloaded zip → <b>Extract All</b>. Keep the folder somewhere permanent (e.g. Documents).</li>' +
      '<li>Open <b>chrome://extensions</b>, turn on <b>Developer mode</b> (top right).</li>' +
      '<li>Click <b>Load unpacked</b> → choose the <b>sales-grabber-extension</b> folder.</li>' +
      '<li>Puzzle-piece icon → pin <b>Sales Grabber</b>. Updating later: replace the folder, then press ↻ on the extension.</li></ol></section>' +
      '<section class="card"><h3>Use it</h3><ol>' +
      '<li>Open your sales channel at <b>discord.com</b> and click the blue <b>$</b> button.</li>' +
      '<li>Click <b>Export new sales</b>. It stops by itself when it reaches sales already saved here (first time: the whole channel).</li>' +
      '<li>When it finishes, the sales are saved here automatically.</li></ol>' +
      '<p class="hint">Everything it collects is kept in the extension, so you can <b>Pause</b>, close the tab, and <b>Resume</b> later, or <b>Copy</b>/<b>Send</b> again any time.</p></section>';
  }

  // ---------- import handling (auto-save) ----------
  function logImport(text) {
    S.importLog = S.importLog || [];
    S.importLog.push({when: new Date().toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'}), text: text});
  }
  async function importOrders(name, rows) {
    var seen = {}, skipped = 0;
    rows.forEach(function (obj) { var r = csvRowToOrder(obj); if (!r) { skipped++; return; } seen[r.order_number] = r; });
    var fresh = [], changed = [], same = 0;
    Object.keys(seen).forEach(function (k) {
      var r = seen[k], cur = S.orderIndex[r.order_number];
      if (!cur) fresh.push(r); else if (orderSig(cur) !== orderSig(r)) changed.push(r); else same++;
    });
    var rowsToSave = fresh.concat(changed);
    if (rowsToSave.length) await S.store.upsertOrders(rowsToSave);
    var msg = name + ': ' + fresh.length + ' new orders, ' + changed.length + ' updated, ' + same + ' already saved' + (skipped ? ', ' + skipped + ' blank rows skipped' : '') + '.';
    logImport(msg);
    if (rowsToSave.length) await reload(); else render();
    toast(msg);
    return {added: fresh.length, updated: changed.length, same: same};
  }
  async function importSales(text) {
    var parsed = tt_parseDiscord(text || ''), seen = {}, fresh = [], fixes = [], dupes = 0;
    if (!parsed.length) { toast('No sales found in that text. Make sure it includes the full sale messages.', true); return {parsed: 0, added: 0, dupes: 0}; }
    // Match against what is saved using the stable key (time, seats, qty, total, site, order #) —
    // so a sale saved earlier with a scrambled artist/venue gets repaired instead of duplicated.
    var saved = {};
    S.raw.sales.forEach(function (r) { saved[tt_saleKey(saleFromDb(r))] = r; });
    parsed.forEach(function (s) {
      if (seen[s.key]) { dupes++; return; }
      seen[s.key] = 1;
      var cur = saved[s.key];
      if (!cur) fresh.push(s);
      else if (cur.sale_key !== s.key || (cur.event || '') !== s.event || (cur.venue || '') !== (s.venue || '') ||
        String(cur.event_date || '') !== String(ymd(s.eventDate) || '') || (cur.result || '') !== (s.result || '')) fixes.push({old: cur.sale_key, s: s});
      else dupes++;
    });
    if (fresh.length) await S.store.insertSales(fresh.map(saleToDb));
    if (fixes.length) await S.store.replaceSales(fixes.map(function (f) { return saleToDb(f.s); }),
      fixes.filter(function (f) { return f.old !== f.s.key; }).map(function (f) { return f.old; }));
    var profit = fresh.reduce(function (t, s) { return t + s.profit; }, 0);
    var unmatched = fresh.filter(function (s) { return !s.orders.some(function (o) { return S.orderIndex[o]; }); }).length;
    var msg = 'Discord: ' + fresh.length + ' new sales' + (fresh.length ? ' (' + fmt(profit, 'susd') + ')' : '') +
      (fixes.length ? ', ' + fixes.length + ' repaired' : '') + ', ' + dupes + ' already saved' +
      (unmatched ? ', ' + unmatched + ' not found in PL orders yet (add the newest CSV)' : '') + '.';
    logImport(msg);
    if (fresh.length || fixes.length) await reload(); else render();
    toast(msg);
    return {parsed: parsed.length, added: fresh.length, fixed: fixes.length, dupes: dupes, unmatched: unmatched};
  }
  function readCsvFile(file) {
    Papa.parse(file, {header: true, skipEmptyLines: true, complete: function (res) {
      var keys = (res.meta.fields || []).map(headerKey);
      if (keys.indexOf('order_number') < 0) { toast('That CSV has no "Order Number" column — is it the PL orders export?', true); return; }
      importOrders(file.name, res.data).catch(function (e) { toast('Save failed: ' + (e.message || e), true); });
    }, error: function (e) { toast('Could not read CSV: ' + e.message, true); }});
  }

  // ---------- routing + render ----------
  function route() {
    var h = decodeURIComponent(location.hash.replace(/^#/, ''));
    var m = h.match(/^(artist|venue)\/(.+)$/);
    if (m) { S.tab = m[1] + 's'; S.detail = {type: m[1], name: m[2]}; }
    else { S.detail = null; S.tab = ['overview', 'artists', 'venues', 'sales', 'import', 'extension'].indexOf(h) >= 0 ? h : (S.tab || 'overview'); }
    render();
    window.scrollTo(0, 0);
  }
  function render() {
    if (!S.R) return;
    if (!S.D) derive();
    document.querySelectorAll('nav [data-tab]').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === S.tab); });
    var usesPeriod = !S.detail && ['overview', 'artists', 'venues', 'sales'].indexOf(S.tab) >= 0;
    $('#period').hidden = !usesPeriod;
    if (usesPeriod) renderPeriodControls();
    var main = $('#view');
    var html;
    if (S.detail) html = S.detail.type === 'artist' ? viewArtist(S.detail.name) : viewVenue(S.detail.name);
    else html = ({overview: viewOverview, artists: viewArtists, venues: viewVenues, sales: viewSales, import: viewImport, extension: viewExtension}[S.tab] || viewOverview)();
    main.innerHTML = html;
    wireTables(main); wireChart(main);
    main.querySelectorAll('[data-rename]').forEach(function (b) {
      b.onclick = async function () {
        var old = b.dataset.rename, nn = window.prompt('Rename "' + old + '" to (type an existing artist name to merge them):', old);
        if (!nn || !nn.trim() || nn.trim() === old) return;
        var rows = S.R.artistMap.filter(function (m) { return m.artist === old; }).map(function (m) { return {raw_name: m.raw, artist: nn.trim()}; });
        if (!rows.length) rows = [{raw_name: tt_norm(old), artist: nn.trim()}];
        try { await S.store.setOverrides(rows); await reload(); location.hash = artistLink(nn.trim()); toast('Renamed to ' + nn.trim()); } catch (e) { toast('Rename failed: ' + (e.message || e), true); }
      };
    });
    main.querySelectorAll('[data-delsale]').forEach(function (b) {
      b.onclick = async function () {
        if (!window.confirm('Remove this sale from your tracker? (Discord is not affected. If it is imported again later it will come back.)')) return;
        try { await S.store.deleteSale(b.dataset.delsale); await reload(); toast('Sale removed.'); } catch (e) { toast('Remove failed: ' + (e.message || e), true); }
      };
    });
    var all = $('#artistsAll'); if (all) all.onchange = function () { S.artistsAll = all.checked; render(); };
    if (S.tab === 'import' && !S.detail) {
      $('#csvFile').onchange = function (e) { if (e.target.files[0]) readCsvFile(e.target.files[0]); e.target.value = ''; };
      var drop = $('#csvDrop');
      drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = function () { drop.classList.remove('over'); };
      drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) readCsvFile(e.dataTransfer.files[0]); };
      var ta = $('#discordText'), t;
      ta.oninput = function () {
        clearTimeout(t);
        t = setTimeout(function () {
          var v = ta.value; if (!v.trim()) return;
          importSales(v).catch(function (e) { toast('Save failed: ' + (e.message || e), true); });
        }, 700);
      };
    }
    var n = S.R.sales.length, o = S.R.orders.length;
    $('#status').textContent = (S.store.demo ? 'Demo mode — nothing is saved · ' : '') + o.toLocaleString() + ' orders · ' + n.toLocaleString() + ' sales';
  }

  // ---------- auth / boot ----------
  function cfg() {
    var c = window.TRACKER_CONFIG || {};
    var url = String(c.supabaseUrl || lsGet('tt_url') || '').trim().replace(/\/+$/, '').replace(/\/(rest|auth)\/v1.*$/i, '').replace(/\/+$/, '');
    return {url: url, key: String(c.supabaseAnonKey || lsGet('tt_key') || '').trim()};
  }
  function showScreen(id) { ['#setup', '#login', '#app'].forEach(function (s) { $(s).hidden = s !== id; }); }

  async function startApp(store) {
    S.store = store;
    showScreen('#app');
    if (store.demo) { $('#signOut').textContent = 'Exit demo'; $('#signOut').onclick = function () { location.href = location.pathname; }; }
    document.querySelectorAll('nav [data-tab]').forEach(function (b) { b.onclick = function () { location.hash = b.dataset.tab; }; });
    window.addEventListener('hashchange', route);
    await reload();
    if (!location.hash && !S.raw.orders.length && !S.raw.sales.length) location.hash = 'import';
    else route();
  }

  async function boot() {
    $('#demoBtn').onclick = $('#demoBtn2').onclick = function () { startApp(new MemoryStore()); };
    if (/[?&]demo\b/.test(location.search)) return startApp(new MemoryStore());
    var c = cfg();
    if (!c.url || !c.key) {
      showScreen('#setup');
      $('#setupForm').onsubmit = async function (e) {
        e.preventDefault();
        var url = $('#sbUrl').value.trim().replace(/\/+$/, '').replace(/\/(rest|auth)\/v1.*$/i, '').replace(/\/+$/, ''), key = $('#sbKey').value.trim();
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

  window.TT_APP = {S: S, MemoryStore: MemoryStore, SupabaseStore: SupabaseStore, csvRowToOrder: csvRowToOrder, saleToDb: saleToDb, saleFromDb: saleFromDb,
    ready: function () { return !!(S.R && S.store); }, reload: function () { return reload(); },
    importSales: function (text) { return importSales(text); },   // used by the Sales Grabber extension
    latestSaleMs: function () { var m = 0; (S.R ? S.R.sales : []).forEach(function (s) { if (s.soldAt && +s.soldAt > m) m = +s.soldAt; }); return m || null; }};
  document.addEventListener('DOMContentLoaded', boot);
})();
