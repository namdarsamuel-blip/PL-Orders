/*** ===== Ticket Tracker core logic (pure functions, no Sheets calls) ===== ***/

var MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};

function tt_money(s) {
  if (s === null || s === undefined || s === '') return null;
  if (typeof s === 'number') return s;
  var n = parseFloat(String(s).replace(/[$,+\s]/g, ''));
  return isNaN(n) ? null : n;
}

// "Oct 21, 2026 4:27 PM EST" or "October 21, 2026" or "Friday, November 13, 2026"
function tt_parseDate(s) {
  if (!s) return null;
  if (Object.prototype.toString.call(s) === '[object Date]') return isNaN(s) ? null : s;
  s = String(s);
  var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(T.*)?$/);
  if (iso) return iso[4] ? new Date(s) : new Date(+iso[1], +iso[2] - 1, +iso[3]);
  var m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:,?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*([AaPp][Mm]))?/);
  if (m && MONTHS[m[1].slice(0,3).toLowerCase()] !== undefined) {
    var h = 0, mi = 0;
    if (m[4]) { h = parseInt(m[4],10) % 12; mi = parseInt(m[5],10); if (/p/i.test(m[6])) h += 12; }
    return new Date(parseInt(m[3],10), MONTHS[m[1].slice(0,3).toLowerCase()], parseInt(m[2],10), h, mi);
  }
  // "10/22/2026, 11:06:16 AM"
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm]))?/);
  if (m) {
    var hh = 0, mm = 0;
    if (m[4]) { hh = parseInt(m[4],10) % 12; mm = parseInt(m[5],10); if (/p/i.test(m[6])) hh += 12; }
    return new Date(parseInt(m[3],10), parseInt(m[1],10)-1, parseInt(m[2],10), hh, mm);
  }
  return null;
}

function tt_monthKey(d) {
  if (!d) return '';
  var mm = d.getMonth() + 1;
  return d.getFullYear() + '-' + (mm < 10 ? '0' : '') + mm;
}

function tt_dayKey(d) {
  if (!d) return '';
  return tt_monthKey(d) + '-' + (d.getDate() < 10 ? '0' : '') + d.getDate();
}

/** Parse the text copied from the Discord sales channel into sale objects. */
function tt_parseDiscord(text) {
  text = String(text || '').replace(/\r/g, '');
  text = text.replace(/\*\*|__|`{1,3}/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  var chunks = text.split(/(?:🦁\s*)?Prime Lion Inc/);
  var orderRe = /\b(\d{1,3}-\d{4,6}\/[A-Z0-9]{2,4}|[A-Z0-9]{3}-[A-Z0-9]{7})\b/g;
  var out = [];
  chunks.forEach(function (b) {
    if (b.indexOf('TICKETS SOLD') < 0) return;
    var lines = b.split('\n').map(function (l) { return l.trim(); }).filter(function (l) {
      return l !== '' && l !== 'Sales-Notifier' && l !== 'APP' && !/^—\s/.test(l);
    });
    function after(key) {
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].replace(/^[^A-Za-z]+/, '') === key) return i + 1 < lines.length ? lines[i + 1] : '';
      }
      return '';
    }
    var di = -1;
    for (var i = 0; i < lines.length; i++) if (/^\W*(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}/.test(lines[i])) { di = i; break; }
    if (di < 1) return;
    var tierLine = di >= 2 ? lines[di - 2] : '';
    var m = b.match(/Section (.+?) • Row (.+?) • Qty: (\d+)/);
    if (!m) return;
    var notes = '';
    var ni = b.indexOf('Internal Notes');
    if (ni >= 0) notes = b.slice(ni + 'Internal Notes'.length).trim();
    var orders = [];
    var om; orderRe.lastIndex = 0;
    while ((om = orderRe.exec(notes)) !== null) if (orders.indexOf(om[1]) < 0) orders.push(om[1]);
    var costM = b.match(/Cost: \$([\d.,]+)/), soldM = b.match(/Sold: \$([\d.,]+)/);
    var sale = {
      soldAt: tt_parseDate(after('Sold')),
      soldRaw: after('Sold'),
      result: tierLine.replace(/^[^A-Za-z]+/, ''),
      event: lines[di - 1],
      eventDate: tt_parseDate(lines[di]),
      venue: (lines[di + 1] || '').replace(/^[^A-Za-z0-9]+/, ''),
      section: m[1].replace(/^SECTION\s+/i, '').trim(),
      row: m[2].trim(),
      qty: parseInt(m[3], 10),
      total: tt_money(after('TOTAL SALE')),
      profit: tt_money(after('PROFIT')),
      roi: (tt_money(String(after('ROI')).replace('%', '')) || 0) / 100,
      costPer: costM ? tt_money(costM[1]) : null,
      soldPer: soldM ? tt_money(soldM[1]) : null,
      purchased: tt_parseDate(after('Purchased')),
      timeToSell: after('Time to Sell'),
      marketplace: after('Customer'),
      publicNotes: b.indexOf('Public Notes') >= 0 ? after('Public Notes') : '',
      orders: orders,
      internalNotes: notes.split('\n').map(function (x) { return x.trim(); }).filter(String).join(' | ')
    };
    if (sale.total === null && sale.soldPer !== null) sale.total = Math.round(sale.soldPer * sale.qty * 100) / 100;
    if ((sale.profit === null || isNaN(sale.profit)) && sale.costPer !== null) sale.profit = Math.round((sale.total - sale.costPer * sale.qty) * 100) / 100;
    if (!sale.roi && sale.costPer) sale.roi = sale.profit / (sale.costPer * sale.qty);
    sale.key = tt_saleKey(sale);
    out.push(sale);
  });
  return out;
}

function tt_saleKey(s) {
  var d = s.soldAt ? tt_dayKey(s.soldAt) + ' ' + s.soldAt.getHours() + ':' + s.soldAt.getMinutes() : s.soldRaw;
  return [d, s.event, s.section, s.row, s.qty, Number(s.total).toFixed(2)].join('|');
}

/** Best-guess artist name from a raw event title. */
function tt_baseArtist(raw) {
  var s = String(raw || '').trim();
  try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
  s = s.replace(/^.*?\bPresents?:?\s+/i, function (x) { return /^disney/i.test(x) ? '' : x; });
  s = s.split(/\s*[-–—]\s+|:|\s+"|\s+w\/\s+|\s+\(|\s+\[/)[0];
  s = s.replace(/^"(.*)"$/, '$1');
  s = s.replace(/\s+Presents?$/i, '');
  s = s.replace(/\s+(\d{4}\s+)?(US\s+|USA\s+|World\s+|Arena\s+|North America\s+)?Tour(\s+\d{4})?$/i, '');
  s = s.replace(/\s+Live(\s+'\d\d|\s+in\s+.+)?$/i, '').replace(/\s+(19|20)\d\d$/, '');
  s = s.replace(/\s+&\s+/g, ' and ').replace(/\s+/g, ' ').trim();
  if (s && s === s.toUpperCase() && /[A-Z]{3}/.test(s)) {
    s = s.toLowerCase().replace(/\b([a-z])/g, function (c) { return c.toUpperCase(); });
  }
  return s || String(raw || '').trim();
}

function tt_norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

/** Count tickets in a seat string when Quantity is blank. */
function tt_seatCount(seats) {
  var total = 0, found = false;
  String(seats || '').split(/\n/).forEach(function (line) {
    var m = line.match(/Seats?\s+([\d,\s\-]+)/i);
    if (!m) return;
    m[1].split(',').forEach(function (part) {
      var r = part.match(/(\d+)\s*-\s*(\d+)/);
      if (r) { total += Math.abs(parseInt(r[2], 10) - parseInt(r[1], 10)) + 1; found = true; }
      else if (/\d/.test(part)) { total += 1; found = true; }
    });
  });
  return found ? total : null;
}

/**
 * orders: [{order, email, event, eventDateRaw, seats, qty, dateBought, card, total, ppt, site}]
 * sales:  objects from tt_parseDiscord (or read back from the Sales tab)
 * overrides: {rawEventNameLowercase: artist}
 */
function tt_build(orders, sales, overrides, today) {
  overrides = overrides || {};
  today = today || new Date();
  var byOrder = {};
  orders.forEach(function (o) {
    o.qty = o.qty || tt_seatCount(o.seats) || 0;
    o.total = tt_money(o.total) || 0;
    o.bought = tt_parseDate(o.dateBought);
    o.eventDate = tt_parseDate(o.eventDateRaw);
    if (!o.eventDate) {  // e.g. "Fri, Jul 17 at 5:30pm" (no year): pick the first matching date on/after purchase
      var nm = String(o.eventDateRaw || '').match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b/g);
      var base = o.bought || today;
      if (nm) {
        var last = nm[nm.length - 1];
        var y = base.getFullYear(), d = tt_parseDate(last + ', ' + y);
        if (d && d < new Date(base.getFullYear(), base.getMonth(), base.getDate())) d = tt_parseDate(last + ', ' + (y + 1));
        o.eventDate = d;
      }
    }
    o.soldQty = 0; o.revenue = 0; o.cost = 0; o.profit = 0; o.sales = 0;
    byOrder[o.order] = o;
  });

  // --- artist mapping: Discord's clean name wins for any order it is linked to
  var auto = {};
  function setAuto(raw, artist) { var k = tt_norm(raw); if (k && !auto[k]) auto[k] = artist; }
  sales.forEach(function (s) {
    var a = tt_baseArtist(s.event);
    setAuto(s.event, a);
    (s.orders || []).forEach(function (on) { if (byOrder[on]) setAuto(byOrder[on].event, a); });
  });
  orders.forEach(function (o) { setAuto(o.event, tt_baseArtist(o.event)); });
  function artistOf(raw) { var k = tt_norm(raw); return overrides[k] || auto[k] || tt_baseArtist(raw); }

  // --- allocate each sale's tickets to its orders (chronological, matching section first)
  var links = [];
  var sorted = sales.slice().sort(function (a, b) { return (a.soldAt || 0) - (b.soldAt || 0); });
  sorted.forEach(function (s) {
    s.artist = artistOf(s.event);
    var cands = (s.orders || []).map(function (on) { return byOrder[on]; }).filter(Boolean);
    s.matched = cands.length > 0;
    var need = s.qty;
    var secRe = new RegExp('\\b' + String(s.section).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    cands.sort(function (a, b) { return (secRe.test(b.seats) ? 1 : 0) - (secRe.test(a.seats) ? 1 : 0); });
    var parts = [];
    cands.forEach(function (o) {
      if (need <= 0) return;
      var take = Math.min(need, Math.max(0, o.qty - o.soldQty));
      if (take > 0) { parts.push([o, take]); o.soldQty += take; need -= take; }
    });
    if (need > 0 && cands.length) { parts.push([cands[0], need]); cands[0].soldQty += need; need = 0; }
    parts.forEach(function (p) {
      var o = p[0], q = p[1];
      var rev = q * s.soldPer, cost = q * s.costPer;
      o.revenue += rev; o.cost += cost; o.profit += rev - cost; o.sales += 1;
      links.push({key: s.key, order: o.order, qty: q, revenue: rev, cost: cost, profit: rev - cost});
    });
    if (!s.matched) links.push({key: s.key, order: '(not in PL orders)', qty: s.qty, revenue: s.total, cost: s.total - s.profit, profit: s.profit});
  });

  // --- inventory status per order
  orders.forEach(function (o) {
    o.artist = artistOf(o.event);
    o.remaining = Math.max(0, o.qty - o.soldQty);
    var past = o.eventDate && o.eventDate < new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (o.qty && o.soldQty >= o.qty) o.status = 'Sold out';
    else if (o.soldQty > 0) o.status = past ? 'Partial – event passed' : 'Partially sold';
    else o.status = past ? 'No sale logged – event passed' : (o.eventDate ? 'Listed / unsold' : 'Unsold (date unknown)');
    o.unsoldCost = o.qty ? o.remaining * (o.total / o.qty) : 0;
  });

  // --- Monthly (realized by sale date)
  var months = {};
  function M(k) { return months[k] || (months[k] = {month: k, sales: 0, tickets: 0, revenue: 0, cost: 0, profit: 0, wins: 0, spent: 0, bought: 0}); }
  sales.forEach(function (s) {
    var m = M(tt_monthKey(s.soldAt));
    m.sales++; m.tickets += s.qty; m.revenue += s.total; m.cost += s.total - s.profit; m.profit += s.profit;
    if (s.profit > 0) m.wins++;
  });
  orders.forEach(function (o) { if (o.bought) { var m = M(tt_monthKey(o.bought)); m.spent += o.total; m.bought += o.qty; } });
  var monthly = Object.keys(months).sort().reverse().map(function (k) {
    var m = months[k]; m.roi = m.cost ? m.profit / m.cost : null; m.winRate = m.sales ? m.wins / m.sales : null; return m;
  });

  // --- Artists (all time) and Artist x Month
  var arts = {};
  function A(n) { return arts[n] || (arts[n] = {artist: n, bought: 0, spent: 0, sold: 0, revenue: 0, cost: 0, profit: 0, sales: 0, wins: 0, openTix: 0, openCost: 0, deadTix: 0, deadCost: 0}); }
  orders.forEach(function (o) {
    var a = A(o.artist); a.bought += o.qty; a.spent += o.total;
    if (/passed/.test(o.status)) { a.deadTix += o.remaining; a.deadCost += o.unsoldCost; }
    else { a.openTix += o.remaining; a.openCost += o.unsoldCost; }
  });
  var am = {};
  sales.forEach(function (s) {
    var a = A(s.artist); a.sold += s.qty; a.revenue += s.total; a.cost += s.total - s.profit; a.profit += s.profit; a.sales++; if (s.profit > 0) a.wins++;
    var k = tt_monthKey(s.soldAt) + '|' + s.artist;
    var r = am[k] || (am[k] = {month: tt_monthKey(s.soldAt), artist: s.artist, sales: 0, tickets: 0, revenue: 0, cost: 0, profit: 0});
    r.sales++; r.tickets += s.qty; r.revenue += s.total; r.cost += s.total - s.profit; r.profit += s.profit;
  });
  var artists = Object.keys(arts).map(function (k) { var a = arts[k]; a.roi = a.cost ? a.profit / a.cost : null; return a; })
    .sort(function (x, y) { return (y.profit - x.profit) || (y.spent - x.spent); });
  var artistMonths = Object.keys(am).map(function (k) { var r = am[k]; r.roi = r.cost ? r.profit / r.cost : null; return r; })
    .sort(function (x, y) { return x.month < y.month ? 1 : x.month > y.month ? -1 : y.profit - x.profit; });

  // --- Shows (artist + event date)
  var shows = {};
  function S(artist, d) {
    var k = artist + '|' + tt_dayKey(d);
    return shows[k] || (shows[k] = {artist: artist, date: d, venue: '', bought: 0, spent: 0, sold: 0, revenue: 0, cost: 0, profit: 0, sales: 0, open: 0, openCost: 0});
  }
  orders.forEach(function (o) {
    var s = S(o.artist, o.eventDate); s.bought += o.qty; s.spent += o.total; s.open += o.remaining; s.openCost += o.unsoldCost;
  });
  sales.forEach(function (x) {
    var s = S(x.artist, x.eventDate); s.venue = s.venue || x.venue;
    s.sold += x.qty; s.revenue += x.total; s.cost += x.total - x.profit; s.profit += x.profit; s.sales++;
  });
  var showList = Object.keys(shows).map(function (k) { var s = shows[k]; s.roi = s.cost ? s.profit / s.cost : null; return s; })
    .sort(function (a, b) { return (b.date || 0) - (a.date || 0); });

  var mapList = Object.keys(auto).map(function (k) { return {raw: k, artist: overrides[k] || auto[k]}; });

  return {orders: orders, sales: sales, links: links, monthly: monthly, artists: artists, artistMonths: artistMonths, shows: showList, artistMap: mapList};
}

if (typeof module !== 'undefined') module.exports = {
  parseDiscord: tt_parseDiscord, build: tt_build, baseArtist: tt_baseArtist, parseDate: tt_parseDate,
  monthKey: tt_monthKey, seatCount: tt_seatCount, saleKey: tt_saleKey
};
