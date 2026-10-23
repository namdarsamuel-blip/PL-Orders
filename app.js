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
    if (!S.period) {
      var cur = tt_monthKey(new Date());
      S.period = S.R.monthly.some(function (m) { return m.month === cur && m.sales; }) ? 'this-month' : 'all';
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

  // ---------- kept helpers ----------
  function groupSales(list, keyFn) {
    var by = {};
    list.forEach(function (s) { var k = keyFn(s); (by[k] = by[k] || []).push(s); });
    return Object.keys(by).map(function (k) { var a = aggSales(by[k]); a.key = k; a.list = by[k]; return a; });
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

  // ---------- period (chips) ----------
  function monthKeyOffset(k, n) { var p = k.split('-'); var d = new Date(+p[0], +p[1] - 1 + n, 1); return tt_monthKey(d); }
  function periodRange() {
    var cur = tt_monthKey(new Date()), p = S.period || 'this-month';
    if (p === 'this-month') return {from: cur, to: cur};
    if (p === 'last-month') { var lm = monthKeyOffset(cur, -1); return {from: lm, to: lm}; }
    if (p === 'last-3') return {from: monthKeyOffset(cur, -2), to: cur};
    if (p === 'this-year') return {from: cur.slice(0, 4) + '-01', to: cur.slice(0, 4) + '-12'};
    if (p === 'all') return {from: '0000-00', to: '9999-99'};
    if (/^m:/.test(p)) return {from: p.slice(2), to: p.slice(2)};
    if (/^y:/.test(p)) return {from: p.slice(2) + '-01', to: p.slice(2) + '-12'};
    return {from: cur, to: cur};
  }
  function inPeriod(d) {
    if (!d) return false;
    var k = tt_monthKey(d), r = periodRange();
    return k >= r.from && k <= r.to;
  }
  function periodLabel() {
    var p = S.period || 'this-month';
    return {'this-month': 'This month', 'last-month': 'Last month', 'last-3': 'Last 3 months', 'this-year': 'This year', 'all': 'All time'}[p] ||
      (/^m:/.test(p) ? monthLabel(p.slice(2)) : /^y:/.test(p) ? p.slice(2) : '');
  }
  function allMonths() {
    var set = {};
    S.R.monthly.forEach(function (m) { if (m.month) set[m.month] = 1; });
    set[tt_monthKey(new Date())] = 1;
    return Object.keys(set).sort();
  }
  function periodChips() {
    var p = S.period || 'this-month';
    var chips = [['this-month', 'This month'], ['last-month', 'Last month'], ['last-3', 'Last 3 months'], ['this-year', 'This year'], ['all', 'All time']];
    var months = allMonths().slice().reverse();
    var years = {}; months.forEach(function (m) { years[m.slice(0, 4)] = 1; });
    var pick = '<select class="chip-select" id="pickPeriod"><option value="">Pick a month…</option>' +
      months.map(function (m) { return '<option value="m:' + m + '"' + (p === 'm:' + m ? ' selected' : '') + '>' + monthLabel(m) + '</option>'; }).join('') +
      Object.keys(years).sort().reverse().map(function (y) { return '<option value="y:' + y + '"' + (p === 'y:' + y ? ' selected' : '') + '>All of ' + y + '</option>'; }).join('') + '</select>';
    return '<div class="chips">' + chips.map(function (c) { return '<button class="chip' + (p === c[0] ? ' on' : '') + '" data-period="' + c[0] + '">' + c[1] + '</button>'; }).join('') + pick + '</div>';
  }

  function aggSales(list) {
    var a = {sales: 0, tickets: 0, revenue: 0, cost: 0, profit: 0, wins: 0};
    list.forEach(function (s) { a.sales++; a.tickets += s.qty; a.revenue += s.total; a.cost += s.total - s.profit; a.profit += s.profit; if (s.profit > 0) a.wins++; });
    a.roi = a.cost ? a.profit / a.cost : null; a.winRate = a.sales ? a.wins / a.sales : null;
    return a;
  }

  // ---------- chart ----------
  function chartMonths() {
    var r = periodRange(), cur = tt_monthKey(new Date());
    if (r.from.slice(0, 4) === r.to.slice(0, 4) && r.from !== '0000-00') {
      var y = r.from.slice(0, 4), out = [];
      for (var i = 1; i <= 12; i++) out.push(y + '-' + (i < 10 ? '0' : '') + i);
      return out;
    }
    var out2 = []; for (var j = 11; j >= 0; j--) out2.push(monthKeyOffset(cur, -j)); return out2;
  }
  function profitChart() {
    var months = chartMonths(), sel = periodRange();
    var by = {}; S.R.monthly.forEach(function (m) { by[m.month] = m; });
    var vals = months.map(function (k) { return by[k] ? by[k].profit : 0; });
    var max = Math.max(0, Math.max.apply(null, vals)), min = Math.min(0, Math.min.apply(null, vals));
    if (max === min) max = 1;
    var W = 720, H = 190, padL = 56, padR = 8, padT = 12, padB = 26;
    var iw = W - padL - padR, ih = H - padT - padB, bw = iw / months.length;
    var y = function (v) { return padT + (max - v) / (max - min) * ih; };
    var ticks = [min, 0, max].filter(function (v, i, a) { return a.indexOf(v) === i; });
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" role="img" aria-label="Profit by month">';
    ticks.forEach(function (t) {
      svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(t) + '" y2="' + y(t) + '" class="' + (t === 0 ? 'axis' : 'grid') + '"/>' +
        '<text x="' + (padL - 6) + '" y="' + (y(t) + 4) + '" class="tick" text-anchor="end">' + esc(fmt(t, 'usd0')) + '</text>';
    });
    months.forEach(function (k, i) {
      var v = vals[i], x = padL + i * bw, w = Math.max(2, Math.min(34, bw - 8)), cx = x + (bw - w) / 2;
      var top = y(Math.max(v, 0)), h = Math.abs(y(v) - y(0));
      var inSel = k >= sel.from && k <= sel.to;
      if (v !== 0) {
        var r = Math.min(4, w / 2, h);
        var path = v > 0
          ? 'M' + cx + ',' + (top + h) + 'V' + (top + r) + 'Q' + cx + ',' + top + ' ' + (cx + r) + ',' + top + 'H' + (cx + w - r) + 'Q' + (cx + w) + ',' + top + ' ' + (cx + w) + ',' + (top + r) + 'V' + (top + h) + 'Z'
          : 'M' + cx + ',' + top + 'V' + (top + h - r) + 'Q' + cx + ',' + (top + h) + ' ' + (cx + r) + ',' + (top + h) + 'H' + (cx + w - r) + 'Q' + (cx + w) + ',' + (top + h) + ' ' + (cx + w) + ',' + (top + h - r) + 'V' + top + 'Z';
        svg += '<path d="' + path + '" class="bar ' + (v > 0 ? 'up' : 'down') + (inSel ? '' : ' dim') + '"/>';
      }
      svg += '<text x="' + (x + bw / 2) + '" y="' + (H - 8) + '" class="tick" text-anchor="middle">' + esc(monthLabel(k).split(' ')[0]) + '</text>';
      svg += '<rect x="' + x + '" y="' + padT + '" width="' + bw + '" height="' + ih + '" class="hit" data-m="' + k + '"/>';
    });
    return '<div class="chartbox">' + svg + '</svg><div class="tip" hidden></div></div>';
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
      r.onclick = function () { S.period = 'm:' + r.dataset.m; render(); };
    });
  }

  // ---------- small building blocks ----------
  function pl(n, w) { return (n || 0).toLocaleString() + ' ' + w + (n === 1 ? '' : 's'); }
  function pill(value, label, kind) {
    return '<div class="pill2"><b class="' + (kind === 'susd' || kind === 'spct' ? signClass(value) : '') + '">' + esc(fmt(value, kind) || '—') + '</b><span>' + esc(label) + '</span></div>';
  }
  function money(v) { return '<span class="' + signClass(v) + '">' + esc(fmt(v, 'susd')) + '</span>'; }
  function searchBox(id, ph) {
    return '<input type="search" class="bigsearch" data-q="' + id + '" placeholder="' + esc(ph) + '" value="' + esc(S.search[id] || '') + '">';
  }
  function sortChips(id, opts) {
    var cur = S.sort[id] || opts[0][0];
    return '<div class="chips"><span class="chiplabel">Sort</span>' + opts.map(function (o) {
      return '<button class="chip' + (cur === o[0] ? ' on' : '') + '" data-sortchip="' + id + '" data-v="' + o[0] + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function matches(id, text) { var q = (S.search[id] || '').toLowerCase().trim(); return !q || String(text).toLowerCase().indexOf(q) >= 0; }
  function moreBtn(id, shown, total) {
    return total > shown ? '<button class="more" data-more="' + id + '">Show more (' + (total - shown).toLocaleString() + ' more)</button>' : '';
  }
  function limitFor(id, base) { return (S.limit && S.limit[id]) || base; }
  function entityRow(href, title, sub, profit, roi) {
    return '<a class="row" href="' + esc(href) + '"><div class="rmain"><div class="rtitle">' + esc(title) + '</div><div class="rsub">' + sub + '</div></div>' +
      '<div class="rnum"><div class="rprofit ' + signClass(profit) + '">' + esc(fmt(profit, 'susd')) + '</div><div class="rsub">' + (roi === null || roi === undefined ? '' : esc(fmt(roi, 'spct')) + ' ROI') + '</div></div></a>';
  }
  function saleRow(s, opts) {
    opts = opts || {};
    var v = splitVenue(s.venue);
    var who = opts.noArtist ? '' : '<a href="' + esc(artistLink(s.artist)) + '" class="strong">' + esc(s.artist) + '</a>';
    var where = v.name && !opts.noVenue ? '<a href="' + esc(venueLink(v.name)) + '">' + esc(v.name) + '</a>' + (v.city ? ', ' + esc(v.city) : '') : esc(v.city || '');
    return '<div class="row sale"><div class="rdate">' + esc(fmt(s.soldAt, 'date')) + '<br><span>' + esc(s.soldAt ? s.soldAt.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'}) : '') + '</span></div>' +
      '<div class="rmain"><div class="rtitle">' + who + (who && where ? ' <span class="dot">·</span> ' : '') + where + '</div>' +
      '<div class="rsub">Show ' + esc(fmt(s.eventDate, 'date')) + ' · Sec ' + esc(s.section) + ' · Row ' + esc(s.row) + ' · ' + s.qty + ' tkt' + (s.qty === 1 ? '' : 's') +
      ' · paid ' + esc(fmt(s.costPer, 'usd')) + ' → sold ' + esc(fmt(s.soldPer, 'usd')) + ' each · ' + esc(s.marketplace || '') + (s.timeToSell ? ' · ' + esc(s.timeToSell) : '') + '</div></div>' +
      '<div class="rnum"><div class="rprofit ' + signClass(s.profit) + '">' + esc(fmt(s.profit, 'susd')) + '</div><div class="rsub">' + esc(fmt(s.total, 'usd')) + ' · ' + esc(fmt(s.roi, 'spct')) + '</div></div>' +
      (opts.del ? '<button class="x" data-delsale="' + esc(s.key) + '" title="Remove this sale">×</button>' : '') + '</div>';
  }
  function list(rows, empty) { return rows.length ? '<div class="list">' + rows.join('') + '</div>' : '<p class="empty">' + esc(empty || 'Nothing here yet.') + '</p>'; }

  // ---------- views ----------
  function banner() {
    var bad = S.R.sales.filter(function (s) { return tt_notAName(s.event); }).length;
    var noVenue = S.R.sales.filter(function (s) { return !s.venue; }).length;
    if (bad) return '<div class="banner">⚠ ' + bad.toLocaleString() + ' sales have no artist name because their order number is not in your PL orders. Import the newest PL CSV, or re-send them from the extension (<b>Export entire channel</b>).</div>';
    if (noVenue > 20) return '<div class="banner">ℹ ' + noVenue.toLocaleString() + ' older sales are missing their venue. To fill them in, run <b>Export entire channel</b> in the extension once — nothing gets duplicated.</div>';
    return '';
  }
  function viewOverview() {
    var sales = S.R.sales.filter(function (s) { return inPeriod(s.soldAt); });
    var a = aggSales(sales);
    var spent = 0; S.R.orders.forEach(function (o) { if (inPeriod(o.bought)) spent += o.total; });
    var h = holding(S.R.orders);
    var arts = groupSales(sales, function (s) { return s.artist; }).sort(function (x, y) { return y.profit - x.profit; });
    var vens = groupSales(sales.filter(function (s) { return s.venue; }), function (s) { return splitVenue(s.venue).name; }).sort(function (x, y) { return y.profit - x.profit; });
    var recent = sales.slice().sort(function (x, y) { return (y.soldAt || 0) - (x.soldAt || 0); }).slice(0, 8);
    function top(rows, link, n) {
      return rows.slice(0, n).map(function (r) { return entityRow(link(r.key), r.key, pl(r.sales, 'sale') + ' · ' + pl(r.tickets, 'ticket'), r.profit, r.roi); });
    }
    return banner() + chipsBar() +
      '<div class="pills">' + pill(a.profit, 'profit', 'susd') + pill(a.revenue, 'revenue', 'usd') + pill(a.roi, 'ROI', 'spct') +
      pill(a.tickets, 'tickets sold', 'int') + pill(a.sales, 'sales', 'int') + pill(spent, 'spent on new orders', 'usd') + pill(h.tickets, 'tickets still holding', 'int') + '</div>' +
      '<section class="card"><div class="cardhead"><h3>Profit by month</h3><span class="hint">click a month to open it</span></div>' + profitChart() + '</section>' +
      '<div class="two">' +
      '<section class="card"><div class="cardhead"><h3>Top artists</h3><a href="#artists">See all →</a></div>' + list(top(arts, artistLink, 8), 'No sales in this period.') +
      (arts.length > 8 ? '<div class="foot">Bottom: ' + arts.slice(-3).reverse().map(function (r) { return '<a href="' + esc(artistLink(r.key)) + '">' + esc(r.key) + '</a> ' + money(r.profit); }).join(' · ') + '</div>' : '') + '</section>' +
      '<section class="card"><div class="cardhead"><h3>Top venues</h3><a href="#venues">See all →</a></div>' + list(top(vens, venueLink, 8), 'No venues yet in this period.') + '</section>' +
      '</div>' +
      '<section class="card"><div class="cardhead"><h3>Latest sales</h3><a href="#sales">See all →</a></div>' + list(recent.map(function (s) { return saleRow(s); }), 'No sales in this period.') + '</section>';
  }
  function chipsBar() { return '<div class="toolbar"><h2>' + esc(periodLabel()) + '</h2>' + periodChips() + '</div>'; }

  function artistRows() {
    return Object.keys(S.D.artists).map(function (n) {
      var A = S.D.artists[n];
      var a = aggSales(A.sales.filter(function (s) { return inPeriod(s.soldAt); }));
      var h = holding(A.orders);
      var last = null; A.sales.forEach(function (s) { if (s.soldAt && (!last || s.soldAt > last)) last = s.soldAt; });
      a.name = n; a.left = h.tickets; a.leftCost = h.cost; a.last = last;
      return a;
    });
  }
  function viewArtists() {
    var mode = S.sort.artists || 'profit';
    var rows = artistRows().filter(function (r) { return matches('artists', r.name) && (S.search.artists || r.sales || (mode === 'holding' && r.left)); });
    var sorters = {profit: function (x, y) { return y.profit - x.profit; }, worst: function (x, y) { return x.profit - y.profit; }, sales: function (x, y) { return y.tickets - x.tickets; },
      recent: function (x, y) { return (y.last || 0) - (x.last || 0); }, holding: function (x, y) { return y.left - x.left; }, az: function (x, y) { return x.name.localeCompare(y.name); }};
    rows.sort(sorters[mode] || sorters.profit);
    var lim = limitFor('artists', 40);
    return chipsBar() +
      '<section class="card">' + searchBox('artists', 'Search any artist…') +
      sortChips('artists', [['profit', 'Most profit'], ['worst', 'Biggest losses'], ['sales', 'Most tickets sold'], ['recent', 'Recently sold'], ['holding', 'Most still holding'], ['az', 'A–Z']]) +
      '<p class="hint">' + rows.length + ' artists' + (S.search.artists ? '' : ' with sales in ' + periodLabel().toLowerCase()) + ' · click one to see every show, venue and sale</p>' +
      list(rows.slice(0, lim).map(function (r) {
        return entityRow(artistLink(r.name), r.name, pl(r.sales, 'sale') + ' · ' + pl(r.tickets, 'ticket') + ' sold' + (r.left ? ' · <b>' + r.left + '</b> still holding' : '') + (r.last ? ' · last sale ' + esc(fmt(r.last, 'date')) : ''), r.profit, r.roi);
      }), S.search.artists ? 'No artist matches "' + S.search.artists + '".' : 'No sales in this period — try "All time".') + moreBtn('artists', lim, rows.length) + '</section>';
  }

  function viewArtist(name) {
    var A = S.D.artists[name];
    if (!A) return '<p class="crumb"><a href="#artists">← Artists</a></p><h2>' + esc(name) + '</h2><p class="empty">No data for this artist.</p>';
    var a = aggSales(A.sales);
    var bought = 0, spent = 0; A.orders.forEach(function (o) { bought += o.qty; spent += o.total; });
    var h = holding(A.orders);
    var shows = {};
    function SH(d, venueFull) {
      var k = d ? tt_dayKey(d) : 'unknown';
      var x = shows[k] || (shows[k] = {k: k, date: d, venue: '', bought: 0, spent: 0, left: 0, sales: []});
      if (venueFull && !x.venue) x.venue = venueFull;
      return x;
    }
    A.orders.forEach(function (o) { var x = SH(o.eventDate, o.venueFull); x.bought += o.qty; x.spent += o.total; x.left += o.remaining; });
    A.sales.forEach(function (s) { SH(s.eventDate, s.venue).sales.push(s); });
    var showRows = Object.keys(shows).map(function (k) { return shows[k]; }).sort(function (x, y) { return (y.date || 0) - (x.date || 0); });
    var open = S.openShow || {};
    var showHtml = showRows.map(function (x) {
      var g = aggSales(x.sales), v = splitVenue(x.venue), key = name + '|' + x.k, isOpen = open[key];
      var past = x.date && x.date < new Date(new Date().setHours(0, 0, 0, 0));
      return '<div class="show' + (isOpen ? ' open' : '') + '">' +
        '<button class="row showrow" data-show="' + esc(key) + '"><div class="rdate">' + esc(x.date ? fmt(x.date, 'date') : 'Date unknown') + '<br><span>' + (past ? 'past' : 'upcoming') + '</span></div>' +
        '<div class="rmain"><div class="rtitle">' + (v.name ? esc(v.name) : '<span class="muted">Venue shows once a ticket sells</span>') + (v.city ? ' <span class="muted">· ' + esc(v.city) + '</span>' : '') + '</div>' +
        '<div class="rsub">Bought ' + x.bought + ' · sold ' + g.tickets + ' · <b>' + x.left + ' left</b> · spent ' + esc(fmt(x.spent, 'usd')) + (g.sales ? ' · ' + g.sales + ' sale' + (g.sales === 1 ? '' : 's') : '') + '</div></div>' +
        '<div class="rnum"><div class="rprofit ' + signClass(g.profit) + '">' + (g.sales ? esc(fmt(g.profit, 'susd')) : '—') + '</div><div class="rsub">' + (g.roi === null ? '' : esc(fmt(g.roi, 'spct')) + ' ROI') + '</div></div>' +
        '<span class="chev">' + (g.sales ? (isOpen ? '▾' : '▸') : '') + '</span></button>' +
        (isOpen && g.sales ? '<div class="sublist">' + x.sales.slice().sort(function (p, q) { return (q.soldAt || 0) - (p.soldAt || 0); }).map(function (s) { return saleRow(s, {noArtist: true, noVenue: true}); }).join('') + '</div>' : '') +
        '</div>';
    }).join('');
    return '<p class="crumb"><a href="#artists">← All artists</a></p>' +
      '<div class="toolbar"><h2>' + esc(name) + '</h2><button class="chip" data-rename="' + esc(name) + '">Rename / merge</button></div>' +
      '<div class="pills">' + pill(a.profit, 'profit (all time)', 'susd') + pill(a.revenue, 'revenue', 'usd') + pill(a.roi, 'ROI', 'spct') +
      pill(a.tickets, 'sold of ' + bought.toLocaleString() + ' bought', 'int') + pill(spent, 'spent', 'usd') + pill(h.tickets, 'still holding', 'int') + pill(h.cost, 'cost of what\'s left', 'usd') + '</div>' +
      '<section class="card"><div class="cardhead"><h3>Shows</h3><span class="hint">click a show to see its sales</span></div>' + (showHtml ? '<div class="list">' + showHtml + '</div>' : '<p class="empty">No shows.</p>') + '</section>';
  }

  function viewVenues() {
    var mode = S.sort.venues || 'profit';
    var rows = Object.keys(S.D.venues).map(function (n) {
      var V = S.D.venues[n];
      var a = aggSales(V.sales.filter(function (s) { return inPeriod(s.soldAt); }));
      var arts = {}; V.sales.forEach(function (s) { if (inPeriod(s.soldAt)) arts[s.artist] = 1; });
      a.name = n; a.city = V.city; a.artists = Object.keys(arts);
      return a;
    }).filter(function (r) { return r.sales && matches('venues', r.name + ' ' + r.city + ' ' + r.artists.join(' ')); });
    var sorters = {profit: function (x, y) { return y.profit - x.profit; }, worst: function (x, y) { return x.profit - y.profit; }, sales: function (x, y) { return y.tickets - x.tickets; }, az: function (x, y) { return x.name.localeCompare(y.name); }};
    rows.sort(sorters[mode] || sorters.profit);
    var lim = limitFor('venues', 40);
    return chipsBar() + '<section class="card">' + searchBox('venues', 'Search a venue or city…') +
      sortChips('venues', [['profit', 'Most profit'], ['worst', 'Biggest losses'], ['sales', 'Most tickets sold'], ['az', 'A–Z']]) +
      '<p class="hint">' + rows.length + ' venues with sales in ' + periodLabel().toLowerCase() + '</p>' +
      list(rows.slice(0, lim).map(function (r) {
        return entityRow(venueLink(r.name), r.name, esc(r.city) + ' · ' + pl(r.sales, 'sale') + ' · ' + pl(r.tickets, 'ticket') + ' · ' + esc(r.artists.slice(0, 3).join(', ')) + (r.artists.length > 3 ? ' +' + (r.artists.length - 3) : ''), r.profit, r.roi);
      }), 'No venues with sales in this period.') + moreBtn('venues', lim, rows.length) + '</section>';
  }

  function viewVenue(name) {
    var V = S.D.venues[name];
    if (!V) return '<p class="crumb"><a href="#venues">← Venues</a></p><h2>' + esc(name) + '</h2><p class="empty">No data for this venue.</p>';
    var a = aggSales(V.sales);
    var arts = groupSales(V.sales, function (s) { return s.artist; }).sort(function (x, y) { return y.profit - x.profit; });
    var sales = V.sales.slice().sort(function (x, y) { return (y.soldAt || 0) - (x.soldAt || 0); });
    var lim = limitFor('vsales', 30);
    return '<p class="crumb"><a href="#venues">← All venues</a></p>' +
      '<div class="toolbar"><h2>' + esc(name) + ' <span class="sub">' + esc(V.city) + '</span></h2></div>' +
      '<div class="pills">' + pill(a.profit, 'profit (all time)', 'susd') + pill(a.revenue, 'revenue', 'usd') + pill(a.roi, 'ROI', 'spct') +
      pill(a.tickets, 'tickets sold', 'int') + pill(a.sales, 'sales', 'int') + pill(arts.length, 'artists', 'int') + '</div>' +
      '<div class="two"><section class="card"><div class="cardhead"><h3>Artists here</h3></div>' +
      list(arts.map(function (r) { return entityRow(artistLink(r.key), r.key, pl(r.sales, 'sale') + ' · ' + pl(r.tickets, 'ticket'), r.profit, r.roi); })) + '</section>' +
      '<section class="card"><div class="cardhead"><h3>Every sale here</h3></div>' + list(sales.slice(0, lim).map(function (s) { return saleRow(s, {noVenue: true}); })) + moreBtn('vsales', lim, sales.length) + '</section></div>';
  }

  function viewSales() {
    var f = S.sort.salesf || 'all';
    var rows = S.R.sales.filter(function (s) {
      if (!inPeriod(s.soldAt)) return false;
      if (f === 'win' && s.profit <= 0) return false;
      if (f === 'loss' && s.profit >= 0) return false;
      return matches('sales', [s.artist, s.venue, s.section, 'row ' + s.row, s.marketplace, (s.orders || []).join(' ')].join(' '));
    }).sort(function (x, y) { return (y.soldAt || 0) - (x.soldAt || 0); });
    var a = aggSales(rows), lim = limitFor('sales', 50);
    S._csv = rows;
    return chipsBar() + '<section class="card">' + searchBox('sales', 'Search sales — artist, venue, section, site, order #…') +
      '<div class="chips"><span class="chiplabel">Show</span>' + [['all', 'All sales'], ['win', 'Profitable'], ['loss', 'Losses']].map(function (o) {
        return '<button class="chip' + (f === o[0] ? ' on' : '') + '" data-sortchip="salesf" data-v="' + o[0] + '">' + o[1] + '</button>'; }).join('') +
      '<button class="chip ghostchip" id="csvBtn">⬇ Download CSV</button></div>' +
      '<p class="hint">' + rows.length.toLocaleString() + ' sales · ' + a.tickets.toLocaleString() + ' tickets · profit ' + money(a.profit) + '</p>' +
      list(rows.slice(0, lim).map(function (s) { return saleRow(s, {del: true}); }), 'No sales match.') + moreBtn('sales', lim, rows.length) + '</section>';
  }

  function viewImport() {
    var log = (S.importLog || []).slice(-8).reverse().map(function (l) { return '<li><b>' + esc(l.when) + '</b> — ' + esc(l.text) + '</li>'; }).join('');
    return '<h2>Import</h2><p class="hint">Add either one, any time — it saves the moment you drop or paste. Only new or changed data is added; repeats are skipped.</p>' +
      '<div class="two">' +
      '<section class="card"><h3>PL orders CSV</h3><p class="hint">PL Orders sheet → File → Download → Comma-separated values (.csv).</p>' +
      '<label class="drop" id="csvDrop"><input type="file" id="csvFile" accept=".csv,text/csv"><span>Drop the CSV here or click to choose</span></label></section>' +
      '<section class="card"><h3>Discord sales</h3><p class="hint">The extension does this for you. Or paste sale messages here (Ctrl+V).</p>' +
      '<textarea id="discordText" placeholder="Paste here (Ctrl+V)"></textarea></section>' +
      '</div>' +
      '<section class="card"><h3>Recent imports</h3>' + (log ? '<ul class="log">' + log + '</ul>' : '<p class="hint">Nothing imported in this session yet.</p>') + '</section>';
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
  function downloadCsv(rows) {
    var head = ['Sold on', 'Artist', 'Show date', 'Venue', 'City', 'Section', 'Row', 'Qty', 'Paid per ticket', 'Sold per ticket', 'Total sale', 'Profit', 'ROI', 'Sold on site', 'Time to sell', 'Order #s'];
    var lines = [head].concat(rows.map(function (s) {
      var v = splitVenue(s.venue);
      return [fmt(s.soldAt, 'datetime'), s.artist, fmt(s.eventDate, 'date'), v.name, v.city, s.section, s.row, s.qty, s.costPer, s.soldPer, s.total, s.profit, s.roi, s.marketplace, s.timeToSell, (s.orders || []).join(' ')];
    }));
    var csv = lines.map(function (l) { return l.map(function (v) { v = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n');
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], {type: 'text/csv'})); a.download = 'sales.csv'; a.click();
  }
  function render() {
    if (!S.R) return;
    if (!S.D) derive();
    var counts = {artists: Object.keys(S.D.artists).filter(function (n) { return S.D.artists[n].sales.length; }).length, venues: Object.keys(S.D.venues).filter(function (n) { return S.D.venues[n].sales.length; }).length, sales: S.R.sales.length};
    document.querySelectorAll('nav [data-tab]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.tab === S.tab);
      var c = counts[b.dataset.tab]; var base = b.dataset.label || (b.dataset.label = b.textContent);
      b.innerHTML = esc(base) + (c ? ' <span class="cnt">' + c.toLocaleString() + '</span>' : '');
    });
    var main = $('#view');
    var html;
    if (S.detail) html = S.detail.type === 'artist' ? viewArtist(S.detail.name) : viewVenue(S.detail.name);
    else html = ({overview: viewOverview, artists: viewArtists, venues: viewVenues, sales: viewSales, import: viewImport, extension: viewExtension}[S.tab] || viewOverview)();
    main.innerHTML = html;
    wireChart(main);
    main.querySelectorAll('[data-period]').forEach(function (b) { b.onclick = function () { S.period = b.dataset.period; render(); }; });
    var pp = $('#pickPeriod'); if (pp) pp.onchange = function () { if (pp.value) { S.period = pp.value; render(); } };
    main.querySelectorAll('[data-sortchip]').forEach(function (b) { b.onclick = function () { S.sort[b.dataset.sortchip] = b.dataset.v; render(); }; });
    main.querySelectorAll('[data-more]').forEach(function (b) { b.onclick = function () { S.limit = S.limit || {}; S.limit[b.dataset.more] = limitFor(b.dataset.more, 40) + 100; render(); }; });
    main.querySelectorAll('[data-show]').forEach(function (b) { b.onclick = function () { S.openShow = S.openShow || {}; S.openShow[b.dataset.show] = !S.openShow[b.dataset.show]; var y = window.scrollY; render(); window.scrollTo(0, y); }; });
    main.querySelectorAll('input[data-q]').forEach(function (inp) {
      inp.oninput = function () {
        var id = inp.dataset.q, pos = inp.selectionStart;
        S.search[id] = inp.value; render();
        var again = $('input[data-q="' + id + '"]'); if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) {} }
      };
    });
    var cb = $('#csvBtn'); if (cb) cb.onclick = function () { downloadCsv(S._csv || []); };
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
      b.onclick = async function (e) {
        e.preventDefault();
        if (!window.confirm('Remove this sale from your tracker? (Discord is not affected. If it is imported again later it will come back.)')) return;
        try { await S.store.deleteSale(b.dataset.delsale); await reload(); toast('Sale removed.'); } catch (err) { toast('Remove failed: ' + (err.message || err), true); }
      };
    });
    if (S.tab === 'import' && !S.detail) {
      $('#csvFile').onchange = function (e) { if (e.target.files[0]) readCsvFile(e.target.files[0]); e.target.value = ''; };
      var drop = $('#csvDrop');
      drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = function () { drop.classList.remove('over'); };
      drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) readCsvFile(e.dataTransfer.files[0]); };
      var ta = $('#discordText'), t;
      ta.oninput = function () {
        clearTimeout(t);
        t = setTimeout(function () { var v = ta.value; if (!v.trim()) return; importSales(v).catch(function (e) { toast('Save failed: ' + (e.message || e), true); }); }, 700);
      };
    }
    $('#status').textContent = (S.store.demo ? 'Demo mode — nothing is saved · ' : '') + S.R.orders.length.toLocaleString() + ' orders · ' + S.R.sales.length.toLocaleString() + ' sales';
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
