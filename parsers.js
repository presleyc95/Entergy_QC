/* ================= shared text helpers ================= */
function pfPageLines(items, vpTransform, mult) {
  const rows = [];
  for (const it of items) {
    const s = it.str; if (!s || !s.trim()) continue;
    const t = mult(vpTransform, it.transform);
    const x = t[4], y = t[5];
    let row = rows.find(r => Math.abs(r.y - y) < 2.5);
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, w: it.width || 0, s: s.trim() });
  }
  rows.sort((a, b) => a.y - b.y);
  return rows.map(r => {
    r.parts.sort((a, b) => a.x - b.x);
    const cells = [], xs = [], xe = []; let prev = null;
    for (const p of r.parts) {
      const gap = prev ? p.x - (prev.x + prev.w) : 99;
      if (prev && gap < 3) { cells[cells.length - 1] += (gap > 0.8 ? ' ' : '') + p.s; xe[xe.length - 1] = p.x + p.w; } else { cells.push(p.s); xs.push(p.x); xe.push(p.x + p.w); }
      prev = p;
    }
    return { y: r.y, cells, xs, xe, text: cells.join(' ').replace(/\s+/g, ' ').trim() };
  });
}
const pfNum = s => { if (s == null) return null; const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; };
const numOrNull = s => (s == null || /^\s*(NA|N\/A|-|–)?\s*$/i.test(String(s))) ? null : pfNum(s);
function pfLoad(s) {
  s = String(s || '').trim();
  if (!s || /^NA$/i.test(s)) return { pct: null, mode: '' };
  const m = s.match(/^(-?[\d.]+)\s*%?\s*-?\s*([A-Za-z]*)$/);
  return m ? { pct: parseFloat(m[1]), mode: m[2] || '' } : { pct: null, mode: s };
}
const allText = pages => pages.map(p => p.lines.map(l => l.text).join('\n')).join('\n');
const isNumCell = s => /^-?[\d,]+(\.\d+)?%?$/.test(String(s).trim());
const isNA = s => /^(NA|N\/A)$/i.test(String(s).trim());

/* A guy-wire row: size, attach, tension, strength, %load, then insulator groups (name, strength, %load) */
function parseGuyRow(c) {
  if (!c || c.length < 5 || !/["\/]/.test(c[0])) return null;
  const nums = c.slice(1, 5).map(numOrNull);
  if (nums.slice(0, 4).some(v => v == null)) return null;
  const rest = [];
  c.slice(5).forEach(cell => {
    const s = String(cell).trim();
    if (isNumCell(s) || isNA(s)) { rest.push({ v: s }); return; }
    // a name cell with values merged onto its end ("96" FG Link 15k 15,000 14")
    const m = s.match(/^(.*?[A-Za-z"'][^\s]*)((?:\s+(?:[\d,]+(?:\.\d+)?|NA))+)$/);
    if (m && m[1].trim()) { rest.push({ n: m[1].trim() }); m[2].trim().split(/\s+/).forEach(v => rest.push({ v })); }
    else rest.push({ n: s });
  });
  const groups = []; let g = null;
  rest.forEach(t => { if (t.n != null) { g = { name: t.n, vals: [] }; groups.push(g); } else if (g) g.vals.push(t.v); });
  const ins = groups.map(x => ({ name: x.name, strength: numOrNull(x.vals[0]), load: numOrNull(x.vals[1]) }));
  return { size: c[0], attach: nums[0], tension: nums[1], strength: nums[2], load: nums[3], ins };
}

/* ================= PoleForeman ================= */
function pfFooter(lines) {
  for (const L of lines) { const m = L.text.match(/([^\\\/]+\.pdf)\s*$/i); if (m && /[\\\/]/.test(L.text)) return m[1]; }
  return null;
}
function pfPageOf(lines) { for (const L of lines) { const m = L.text.match(/^(\d+) of (\d+)$/); if (m) return { k: +m[1], n: +m[2] }; } return null; }
/* Split a combined PoleForeman PDF into one page group per report */
function pfSplit(pages) {
  const segs = []; let cur = null;
  pages.forEach(pg => {
    const foot = pfFooter(pg.lines), po = pfPageOf(pg.lines);
    const lab = (pg.lines.map(l => l.text.match(/Label:\s*(\S+)/)).find(Boolean) || [])[1] || null;
    const brk = !cur || (foot && cur.footer && foot !== cur.footer) || (po && po.k === 1 && cur.pages.length) || (lab && cur.label && lab !== cur.label);
    if (brk) { cur = { pages: [], footer: foot, label: lab }; segs.push(cur); }
    cur.pages.push(pg); if (foot && !cur.footer) cur.footer = foot; if (lab && !cur.label) cur.label = lab;
  });
  return segs;
}
function pfParse(pages) {
  const R = { label: '', poleSpec: '', species: '', grade: '', district: '', edition: '', sw: '', db: '', licensed: '', opco: '', user: '', date: '', notes: '', summary: [], summaryPage: null, rules: {}, ruleOrder: [], statusTargets: [], pages: pages.length, pageNos: pages.map(p => p.pageNo) };
  let rule = null, sec = 'head', span = null, wire = null, circuit = null, comm = false, anchor = null, guyPart = '', equipCat = '', sguy = null;
  const newRule = (r, pg) => { if (!R.rules[r]) { R.rules[r] = { rule: r, firstPage: pg, pages: [], head: {}, spans: [], anchors: [], spanGuys: [], equipment: [], nesc: {}, statusKeys: {} }; R.ruleOrder.push(r); } return R.rules[r]; };
  const target = (key, pg, x, y) => R.statusTargets.push({ key, page: pg, x, y });
  pages.forEach(({ lines, pageNo }) => {
    let isSummary = false;
    for (const L of lines) {
      const t = L.text, c = L.cells; let m;
      if (/^Licensed:/i.test(t)) { R.licensed = t.replace(/^Licensed:\s*/i, ''); continue; }
      if (/^Op Co:/i.test(t)) { R.opco = t.replace(/^Op Co:\s*/i, ''); continue; }
      if (/^Project:/i.test(t)) continue;
      if ((m = t.match(/SW:\s*(V[\d.]+),\s*DB:\s*(V[\d.]+)/))) { R.sw = m[1]; R.db = m[2]; }
      if ((m = t.match(/\b(250[A-Z])\s+Summary:/))) {
        const nr = m[1];
        if (nr !== rule) { rule = nr; sec = 'head'; span = wire = anchor = sguy = null; equipCat = ''; comm = false; }
        const ro = newRule(rule, pageNo); if (!ro.pages.includes(pageNo)) ro.pages.push(pageNo);
        if (ro.firstPage === pageNo) c.forEach((cell, i) => { if (/^(Pole|Framings|Guying)$/.test(cell)) target(`${rule}|comp|${cell}`, pageNo, L.xs[i], L.y); });
        continue;
      }
      if (/Analysis Summary/.test(t)) { isSummary = true; R.summaryPage = pageNo; continue; }
      if (/^ser:|^User:/i.test(t)) { if ((m = t.match(/^u?ser:\s*(\S+)/i))) R.user = m[1]; if ((m = t.match(/Date:\s*(.+)$/))) R.date = m[1].trim(); continue; }
      if (/^\d+ of \d+$/.test(t) || /^[A-Z]?:\\/.test(t) || /^:\\/.test(t)) continue;
      if ((m = t.match(/^Design Notes:\s*(.*)$/i))) { R.notes = R.notes ? R.notes + '; ' + m[1] : m[1]; continue; }
      if (isSummary) {
        const i = c.findIndex(x => /^250[A-Z]$/.test(x));
        if (i >= 0) {
          const v = c.slice(i);
          const row = { rule: v[0], temp: pfNum(v[1]), wind: v[2], ice: pfNum(v[3]), poleH: pfNum(v[4]), poleV: pfNum(v[5]), framings: /NA/i.test(v[6]) ? null : pfNum(v[6]), guying: /NA/i.test(v[7]) ? null : pfNum(v[7]) };
          R.summary.push(row);
          ['poleH', 'poleV', 'framings', 'guying'].forEach((k, j) => { if (L.xs[i + 4 + j] != null && row[k] != null) target(`summary|${row.rule}|${k}`, pageNo, L.xs[i + 4 + j], L.y); });
        }
        c.forEach(cell => {
          if ((m = cell.match(/^Pole:\s*(.+)$/))) R.poleSpec = R.poleSpec || m[1];
          if ((m = cell.match(/^Label:\s*(.+)$/))) R.label = R.label || m[1];
          if ((m = cell.match(/^Species:\s*(.+)$/))) R.species = R.species || m[1];
          if ((m = cell.match(/^Grade:\s*(.+)$/))) R.grade = R.grade || m[1];
          if ((m = cell.match(/^District:\s*(.+)$/))) R.district = R.district || m[1];
          if ((m = cell.match(/^Edition:\s*(.+)$/))) R.edition = R.edition || m[1];
        });
        continue;
      }
      if (!rule) continue;
      const ro = R.rules[rule];
      if (!ro.pages.includes(pageNo)) ro.pages.push(pageNo);
      if (/^Spans$/.test(t)) { sec = 'spans'; continue; }
      if (/^Span Guys:?$/i.test(t) || c.some(x => /^Span Guys:?$/i.test(x))) { sec = 'spanguys'; sguy = null; continue; }
      if (/^Guying$/.test(t)) { sec = 'guying'; continue; }
      if (/^Equipment$/.test(t)) { sec = 'equipment'; continue; }
      if (/^NESC$/.test(t)) { sec = 'nesc'; continue; }
      // anchors can follow span guys without a new "Guying" heading
      if ((sec === 'spanguys' || sec === 'spans') && /^Anchor\s+\d+:/.test(t)) sec = 'guying';
      if (sec === 'head') {
        c.forEach((cell, i) => {
          const h = ro.head;
          if ((m = cell.match(/^Pole:\s*(.+)$/))) { h.poleSpec = m[1]; target(`${rule}|comp|Overall`, pageNo, L.xs[i], L.y); }
          else if ((m = cell.match(/^Species:\s*(.+)$/))) h.species = m[1];
          else if ((m = cell.match(/^Pole Strength Remaining\s*([\d.]+)%/))) h.strength = parseFloat(m[1]);
          else if ((m = cell.match(/^Horz Loading:\s*([\d.]+)%/))) h.horz = parseFloat(m[1]);
          else if ((m = cell.match(/^Vert Loading:\s*([\d.]+)%/))) h.vert = parseFloat(m[1]);
          else if ((m = cell.match(/^Label:\s*(.+)$/))) h.label = m[1];
          else if ((m = cell.match(/^Setting Depth:\s*([\d.]+)/))) h.setting = parseFloat(m[1]);
          else if ((m = cell.match(/^Soil:\s*(.+)$/))) h.soil = m[1];
          else if ((m = cell.match(/^Rule:\s*(.+)$/))) h.rule = m[1];
          else if ((m = cell.match(/^Grade:\s*(.+)$/))) h.grade = m[1];
          else if ((m = cell.match(/^District:\s*(.+)$/))) h.district = m[1];
          else if ((m = cell.match(/^Edition:\s*(.+)$/))) h.edition = m[1];
          else if ((m = cell.match(/^Temp:\s*(-?[\d.]+)/))) h.temp = parseFloat(m[1]);
          else if ((m = cell.match(/^Wind:\s*([\d.]+)\s*(psf|mph)?/i))) { h.wind = parseFloat(m[1]); h.windUnit = (m[2] || '').toLowerCase(); }
          else if ((m = cell.match(/^Ice:\s*([\d.]+)/))) h.ice = parseFloat(m[1]);
          else if ((m = cell.match(/^Lat:\s*(-?[\d.]+)/))) h.lat = parseFloat(m[1]);
          else if ((m = cell.match(/^Long:\s*(-?[\d.]+)/))) h.lon = parseFloat(m[1]);
          else if ((m = cell.match(/^Elevation:\s*(-?[\d.]+)/))) h.elev = parseFloat(m[1]);
          else if (/^(Initial|Final|Creep)$/i.test(cell)) h.state = cell;
          else if (/^\d+\/[A-Z]?\d+\s/.test(cell) && !h.spec2) h.spec2 = cell;
        });
        continue;
      }
      if (sec === 'spanguys') {
        if ((m = t.match(/^Span\s+(\d+):\s*([\d.]+)'\s*<\s*([\d.]+)°?/))) { sguy = { n: +m[1], length: +m[2], bearing: +m[3], wires: [] }; ro.spanGuys.push(sguy); target(`${rule}|spanguy|${sguy.n}`, pageNo, L.xs[0], L.y); continue; }
        if (!sguy) continue;
        const g = parseGuyRow(c);
        if (g) { const near = g.ins[0] || {}, far = g.ins[1] || {}; sguy.wires.push({ size: g.size, attach: g.attach, tension: g.tension, strength: g.strength, load: g.load, nearIns: near.name || '', nearStr: near.strength ?? null, nearLoad: near.load ?? null, farIns: far.name || '', farStr: far.strength ?? null, farLoad: far.load ?? null }); }
        continue;
      }
      if (sec === 'spans') {
        if ((m = t.match(/^Span\s+(\d+):\s*([\d.]+)'\s*<\s*([\d.]+)°?/))) { span = { n: +m[1], length: +m[2], bearing: +m[3], wires: [], comms: [] }; ro.spans.push(span); wire = null; comm = false; target(`${rule}|span|${span.n}`, pageNo, L.xs[0], L.y); continue; }
        if (!span) continue;
        if (/^Power:$/.test(t)) { comm = false; continue; }
        if ((m = t.match(/^Circuit:\s*(\S+)\s*Circuit Type:\s*(.+)$/))) { circuit = { id: m[1], type: m[2] }; continue; }
        if (/^Communication:$/.test(t)) { comm = true; wire = null; continue; }
        const rsI = c.findIndex(x => /^Ruling Span=/.test(x));
        if (rsI >= 0) {
          const head = c[0]; const di = head.indexOf(' - ');
          wire = { kind: di > 0 ? head.slice(0, di).trim() : head, conductor: di > 0 ? head.slice(di + 3).trim() : '', ruling: pfNum(c[rsI]), tension: pfNum((c.find(x => /^Design Tension=/.test(x)) || '')), framing: ((c.find(x => /^Framing:/.test(x)) || '').replace(/^Framing:\s*/, '')), circuit: circuit ? circuit.id : '', circuitType: circuit ? circuit.type : '', phases: [] };
          span.wires.push(wire); comm = false; continue;
        }
        if (/^(Phase|Insulator|Support|Cable)\b/.test(c[0])) continue;
        if (comm && c.length >= 8 && pfNum(c[1]) != null && !/"\s*(HS|EHS|SM|Utility)/i.test(c[0])) {
          span.comms.push({ cable: c[0], ruling: pfNum(c[1]), attach: pfNum(c[2]), offset: pfNum(c[3]), dia: pfNum(c[4]), weight: pfNum(c[5]), tension: pfNum(c[6]), sag: pfNum(c[7]), owner: c[8] || '' });
          continue;
        }
        if (wire && c.length >= 10 && /^[A-Z0-9]{1,3}$/.test(c[0]) && pfNum(c[1]) != null) {
          const b = pfLoad(c[4]), s = pfLoad(c[6]), ins = pfLoad(c[8]);
          wire.phases.push({ phase: c[0], attach: pfNum(c[1]), offset: pfNum(c[2]), bracket: c[3], bracketLoad: b.pct, bracketMode: b.mode, support: c[5], supportLoad: s.pct, supportMode: s.mode, insulator: c[7], insLoad: ins.pct, insMode: ins.mode, angle: pfNum(c[9]) });
          continue;
        }
      }
      if (sec === 'guying') {
        if ((m = t.match(/^Anchor\s+(\d+):\s*([\d.]+)'\s*<\s*([\d.]+)°?/))) { anchor = { n: +m[1], lead: +m[2], bearing: +m[3], wires: [], anchor: null }; ro.anchors.push(anchor); guyPart = ''; target(`${rule}|anchor|${anchor.n}`, pageNo, L.xs[0], L.y); continue; }
        if (/^Guy Wires:$/.test(t)) { guyPart = 'wires'; continue; }
        if (/^Anchor:$/.test(t)) { guyPart = 'anchor'; continue; }
        if (!anchor) continue;
        if (guyPart === 'wires') {
          const g = parseGuyRow(c);
          if (g) { const i0 = g.ins[0] || {}; anchor.wires.push({ size: g.size, attach: g.attach, tension: g.tension, strength: g.strength, load: g.load, insulator: i0.name || '', insStrength: i0.strength ?? null, insLoad: i0.load ?? null }); }
          continue;
        }
        if (guyPart === 'anchor' && c.length >= 5 && pfNum(c[2]) != null && pfNum(c[3]) != null && !/^Anchor$/.test(c[0])) {
          anchor.anchor = { type: c[0], soil: c[1], tension: pfNum(c[2]), holding: pfNum(c[3]), load: pfNum(c[4]), rod: c[5] || '', rodStrength: pfNum(c[6]), rodLoad: pfNum(c[7]) };
          continue;
        }
      }
      if (sec === 'equipment') {
        if (c[1] === 'Attach (in)') { equipCat = c[0]; continue; }
        if (equipCat && c.length >= 3 && pfNum(c[1]) != null) { ro.equipment.push({ cat: equipCat, name: c[0], attach: pfNum(c[1]), weight: pfNum(c[2]), dir: pfNum(c[3]) }); continue; }
      }
      if (sec === 'nesc') {
        if (/^(Pole|Guy|Crossarm|Anchor)$/.test(c[0]) && c.length >= 5) { ro.nesc[c[0]] = { tension: pfNum(c[1]), wind: pfNum(c[2]), vertical: pfNum(c[3]), sf: pfNum(c[4]) }; continue; }
      }
    }
  });
  // the designer's callout box under the 3D view: pole number, then DLOC, LAT and LONG stacked under it
  for (const { lines, pageNo } of pages) {
    const cells = lines.flatMap(L => L.cells.map((t, j) => ({ t, x: L.xs[j], y: L.y, nx: L.cells[j + 1] })));
    const d = cells.find(c => /^DLOC\b/i.test(c.t) && /\d{6,}/.test(c.t + ' ' + (c.nx || ''))); if (!d) continue;
    const by = (re, up) => cells.filter(c => re.test(c.t) && Math.abs(c.x - d.x) < 25 && (up ? c.y < d.y && d.y - c.y < 30 : c.y > d.y && c.y - d.y < 45)).sort((a, b) => Math.abs(a.y - d.y) - Math.abs(b.y - d.y))[0];
    const num = c => c ? pfNum(((c.t + ' ' + (c.nx || '')).match(/-?\d{1,3}\.\d+/) || [])[0]) : null;
    const id = by(/^(P|PL|POLE)\s?-?\d{1,3}[A-Z]?$/i, true);
    R.callout = { id: id ? id.t.replace(/\s|-/g, '').toUpperCase() : null, dloc: (d.t + ' ' + (d.nx || '')).match(/\d{6,}/)[0], lat: num(by(/^LAT/i)), lon: num(by(/^LON/i)), page: pageNo };
    break;
  }
  const first = R.rules[R.ruleOrder[0]];
  if (first) { const h = first.head; R.label = R.label || h.label || ''; R.poleSpec = R.poleSpec || h.poleSpec || ''; R.species = R.species || h.species || ''; R.grade = R.grade || h.grade || ''; R.district = R.district || h.district || ''; R.edition = R.edition || h.edition || ''; }
  return R;
}

/* ================= document type detection ================= */
function docClassify(pages, name) {
  const T = allText(pages), n = String(name || '');
  const has = re => re.test(T);
  if (has(/\b250[A-Z] Summary:/) && (has(/Licensed:/) || has(/SW:\s*V/))) return 'pf';
  if (has(/Scid:\s*\S+/) && has(/DLOC Number/i)) return 'photos';
  if (has(/Change Order \(DCO\)/)) return 'dco';
  if (has(/Voltage Drop and Flicker Worksheet/)) return 'vd';
  if (has(/^JOB JACKET\.?(\s|$)/m) || (has(/JOB JACKET/i) && has(/ETRLOCALOFFICE|WORKORDER/))) return 'jacket';
  if (has(/Device ID Generator/)) return 'deviceid';
  if (has(/IFC: Cover Page/) || (has(/Design Summary Table/) && has(/Station Details/))) return 'ifc';
  if (has(/Design Mapping Request Form/)) return 'mapreq';
  if (has(/CUE Station/) && has(/Maximo WO/) && has(/Installed/) && !has(/CUE Estimate/)) return 'design';
  if (has(/CUE Estimate Station Details/)) return 'station';
  if (has(/CUE Estimate - Job Cost Summary/)) return 'jobcost';
  if (has(/CUE Estimate - Cost Distribution/)) return 'costdist';
  if (has(/CUE Estimate - Labor Summary/)) return 'labor';
  if (has(/CUE Estimate - Material Summary/)) return 'material';
  if (has(/^Work Order Details$/m) && has(/Task ID/)) return 'wo';
  if (has(/NJUNS Ticket/)) return 'njuns';
  if (has(/^Ticket \d{6,}/m) && has(/Excavat/i)) return 't811';
  if (has(/Environmental Checklist/)) return 'env';
  if (has(/Job Hazard Analysis/)) return 'jha';
  if (has(/Circuit Bkr ID/) && has(/Scale\s*1"/)) return permitOf(n) ? 'permitsketch' : 'sketch';
  if (has(/Vicinity Map/) || /vicinity/i.test(n)) return 'vicinity';
  if (/inspection/i.test(n) || has(/Inspection (Sheet|Form|Report)/i)) return 'inspection';
  const pgT = p => [...p.lines.map(l=>l.text), ...(p.annots||[]).map(a=>a.text)].join(' ');
  if (pages.length && pages.every(p => p.lines.length <= 10) && !has(/Ticket|Excavat|Work Order|Station Details|Estimate/i) && pages.filter(p => /DLOC/i.test(pgT(p)) && /\bLAT(itude)?\b/i.test(pgT(p))).length >= Math.max(1, pages.length * 0.6)) return 'photos';
  if (!T.trim() && !pages.some(p => (p.annots || []).length)) { // scanned / image-only: go by the file name
    const byName = [[/811|locate|ticket/i,'t811'],[/njuns/i,'njuns'],[/sketch/i,'sketch'],[/vicinity/i,'vicinity'],[/jacket/i,'jacket'],[/\bdco\b|change.?order/i,'dco'],[/jha|hazard/i,'jha'],[/envir|enviro/i,'env'],[/inspect/i,'inspection'],[/station/i,'station'],[/photo/i,'photos']];
    const hit = byName.find(([re]) => re.test(n)); return hit ? (hit[1] === 'sketch' && permitOf(n) ? 'permitsketch' : hit[1]) : 'photos'; }
  if (/photo/i.test(n)) return 'photos';
  if (/sketch/i.test(n)) return permitOf(n) ? 'permitsketch' : 'sketch';
  return 'unknown';
}
// permit sketches and requests are named for the agency: "JOB SKETCH TXDOT.pdf", "RR MAPPING REQUEST.png"
function permitOf(s) {
  const t = ' ' + String(s || '').replace(/[_\-.]+/g, ' ') + ' ';
  if (/txdot|\bdotd\b|\b[a-z]?dot\b/i.test(t)) return /txdot/i.test(t) ? 'TxDOT' : /dotd/i.test(t) ? 'DOTD' : 'DOT';
  if (/railroad|\brr\b|\brail\b/i.test(t)) return 'Railroad';
  for (const [re, n] of [[/\bcounty\b/i, 'County'], [/\bparish\b/i, 'Parish'], [/\bcity\b/i, 'City'], [/\bpermit\b/i, 'Permit']]) if (re.test(t)) return n;
  return null;
}

/* ================= Design mapping request form (email confirmation screenshot or PDF) ================= */
// lines: [{text,x0,y0,x1,y1}]; labels sit in a left column, each value to the right of its (possibly wrapped) label
function parseMapReq(lines, W) {
  const LBL = [['createdBy', /^Created\s*by/i], ['group', /^Design\s*Group/i], ['client', /^Client\b/i], ['wo', /^WO\s*(?:Number|No\.?|#)/i], ['woName', /^WO\s*Name/i], ['charge', /^Charge\s*time/i], ['needDate', /^Need\s*Date/i], ['revision', /^Revision/i], ['type', /^Request\s*Type/i], ['dates', /^Estimated/i], ['stations', /^#?\s*of\s*Work/i], ['scope', /^Scope\s*of\s*Work/i], ['link', /^File\s*Link/i]];
  lines = lines.map(l => ({ ...l, text: String(l.text).replace(/\s+/g, ' ').trim() })).filter(l => l.text).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const att = lines.find(l => /^File\s*Attachments/i.test(l.text));
  const body = lines.filter(l => !att || l.y0 < att.y0 - 2);
  const starts = [], vals = [];
  body.forEach(l => { const hit = LBL.find(([, re]) => re.test(l.text)); if (hit) starts.push({ k: hit[0], l, rest: l.text.replace(hit[1], '').replace(/^[\s:;]+/, '').replace(/^(?:Number|Name|Date|Type|time|by)\b[\s:;]*/i, '') }); });
  const left = starts.length ? Math.min(...starts.map(s => s.l.x0)) : 0, cut = left + 0.12 * W;
  body.forEach(l => { if (l.x0 >= cut && !starts.some(s => s.l === l)) vals.push(l); });
  const F = {};
  starts.forEach(s => { if (s.rest && s.l.x1 > cut) (F[s.k] = F[s.k] || []).push(s.rest); });
  vals.forEach(v => { const cy = (v.y0 + v.y1) / 2, tol = (v.y1 - v.y0) * 0.6; const s = starts.filter(x => x.l.y0 - tol <= cy).pop(); if (s) (F[s.k] = F[s.k] || []).push(v.text); });
  const fields = {}; Object.keys(F).forEach(k => { fields[k] = F[k].join(' ').trim(); });
  // one entry per pole in the scope: "P01, replace pole with 55'/C1 WP, transfer recloser. DLOC: … LAT: … LONG: …"
  const poles = String(fields.scope || '').split(/(?:^|\s)(?=(?:P|PL|POLE)\s?-?\d{1,3}[A-Z]?\s*[,:;-])/i).map(t => t.trim()).filter(t => /^(?:P|PL|POLE)\s?-?\d/i.test(t)).map(t => {
    const g = re => (t.match(re) || [])[1] || null, dl = g(/D\s?L\s?O\s?C\s*[:#;.]?\s*([0-9OoIl]{6,})/i);
    return { id: (t.match(/^((?:P|PL|POLE)\s?-?\d{1,3}[A-Z]?)/i) || [])[1], text: t, dloc: dl ? ocrDigits(dl) : null, lat: pfNum(g(/\bLAT\w*\s*[:;.]?\s*(-?\d{1,3}\.\d+)/i)), lon: pfNum(g(/\bLON\w*\s*[:;.]?\s*(-?\d{1,3}\.\d+)/i)) };
  });
  const attachments = [];
  if (att) { const rows = []; lines.filter(l => l.y0 > att.y1 - 2).forEach(l => { const r = rows.find(r => Math.abs(r.y - (l.y0 + l.y1) / 2) < (l.y1 - l.y0) * 0.6); if (r) r.parts.push(l); else rows.push({ y: (l.y0 + l.y1) / 2, parts: [l] }); });
    rows.forEach(r => { const t = r.parts.sort((a, b) => a.x0 - b.x0).map(p => p.text).join(' '); const m = t.match(/(.+?\.(?:pdf|kmz|kml|png|jpe?g|docx?|xlsx?|dwg|dxf|zip|shp))\b/i); if (m) attachments.push(m[1].trim()); }); }
  return { fields, poles, attachments, stations: pfNum(fields.stations) };
}
// dates as typed on a form: 2026-02-20, 4/4/2026. Returns null when it isn't a real calendar date
function formDate(s) {
  const t = String(s || '').trim(); let m, y, mo, d;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [mo, d, y] = [+m[1], +m[2], +m[3]];
  else return null;
  const D = new Date(y, mo - 1, d); return y >= 2000 && y <= 2100 && D.getMonth() === mo - 1 && D.getDate() === d ? D : null;
}

/* ================= CUE Station Details & Job Instructions ================= */
const CU_WF = /^(I|R|T|X|A|M|RR|RI|IR|RP)$/;
function parseStation(pages) {
  const out = { meta: {}, services: [], stations: {}, order: [], pages: [] };
  let cur = null, lastCU = null;
  pages.forEach(({ lines, pageNo }) => {
    for (const L of lines) {
      const c = L.cells, t = L.text; let m;
      if ((m = t.match(/Onsite labor Hours:\s*([\d.]+)/i)) || (c[0] === 'Onsite labor Hours:' && (m = [0, c[1]]))) out.meta.onsite = pfNum(m[1]);
      { const i = c.indexOf('Onsite labor Hours:'); if (i >= 0) out.meta.onsite = pfNum(c[i + 1]); }
      { const i = c.indexOf('Doc/travel Time'); if (i >= 0) out.meta.doc = pfNum(c[i + 1]); }
      { const i = c.indexOf('Total WO hours'); if (i >= 0) out.meta.total = pfNum(c[i + 1]); }
      { const i = c.indexOf('Estimated On:'); if (i >= 0) out.meta.estimated = c[i + 1]; }
      if ((m = t.match(/^Master WO:\s*(\d+)/))) out.meta.wo = m[1];
      if (/STDSERVICE/.test(t)) { out.services.push({ task: c[0], item: c[2], desc: c[3], qty: pfNum(c[4]), cost: pfNum(c[c.length - 2]) }); continue; }
      const hi = c.indexOf('Labor Hours :');
      if (hi === 1) {
        const id = c[0];
        if (!out.stations[id]) { out.stations[id] = { id, hours: pfNum(c[2]), cus: [], inacc: '', congested: '', pages: [] }; out.order.push(id); }
        cur = out.stations[id]; if (!cur.pages.includes(pageNo)) cur.pages.push(pageNo); lastCU = null; continue;
      }
      if (!cur) continue;
      if (/^(Estimate Request|Work Site|Master WO|Estimate Version|Estimated On|By:|Hours$|WO\/Task|Contractor|CPR Location|Operating Location|Coastal\?|Work$|Standards Sheets)/.test(t)) { lastCU = null; continue; }
      if (/^\d+\/\d+\/\d+ \d+:\d+/.test(t)) { lastCU = null; continue; }
      if (/^(TRUCK|FOOT|OT|ST|NONE)(\s+(OT|ST|Y|N))?$/.test(t) && !cur.cus.length) { cur.inacc = c[0]; cur.congested = c[1] || ''; continue; }
      if (c.length >= 5 && CU_WF.test(c[1])) {
        const nums = c.slice(3);
        // H/C sits right after the quantity: C, H or 3 (the quantity can be 3 too, so go by position first)
        const hc = /^[HC3]$/.test(c[4] || '') ? c[4] : (c.slice(4).find(x => /^[HC3]$/.test(x)) || '');
        const qty = pfNum(c[3]), hrs = pfNum(c[c.length - 1]);
        lastCU = { cu: c[0], wf: c[1], desc: c[2], qty, hc, hours: hrs, page: pageNo };
        cur.cus.push(lastCU); continue;
      }
      if (lastCU && c.length === 1 && !/Labor Hours/.test(t)) { lastCU.desc += ' ' + t; continue; }
    }
  });
  return out;
}

/* ================= Work Order Details (Maximo) ================= */
function parseWO(pages) {
  const W = { tasks: [], labor: [], materials: [], services: [], notes: {}, noteOrder: [], log: [], meta: {} };
  const L0 = pages.flatMap(p => p.lines.map(l => ({ ...l, pageNo: p.pageNo })));
  let sec = '', wd = null, pn = null, lastMat = null, glNext = false;
  const T = allText(pages);
  let m;
  if ((m = T.match(/^(\d{6,}):\s*(.+)$/m))) { W.meta.wo = m[1]; W.meta.title = m[2].trim(); }
  if ((m = T.match(/Pole Count:\s*(\d+)/))) W.meta.poleCount = +m[1];
  if ((m = T.match(/Start:\s*DLOC\s*(\d+)/))) W.meta.startDloc = m[1];
  if ((m = T.match(/End:\s*DLOC\s*(\d+)/))) W.meta.endDloc = m[1];
  if ((m = T.match(/(The scope of this work order[\s\S]*?)\n\s*Asset:/i))) W.meta.scope = m[1].replace(/\s+/g,' ').trim();
  if (W.meta.scope && (m = W.meta.scope.match(/contains\s+(\d+)\s+work\s+points/i))) W.meta.scopePoints = +m[1];
  const approvals = [...T.matchAll(/Approval Amount-\s*\$\s*([\d,]+\.\d{2})/g)].map(x => pfNum(x[1]));
  W.meta.approvals = approvals;
  const addr = T.match(/Street Address -\s*(.+)/); if (addr) W.meta.address = addr[1].trim();
  const swt = T.match(/Sub Work Type -\s*(\S+)/); if (swt) W.meta.subType = swt[1];
  const cityM = T.match(/City\s*-\s*(\S.*)/); if (cityM) W.meta.city = cityM[1].trim();
  L0.forEach(L => {
    const c = L.cells, t = L.text;
    const kv = (lab) => { const i = c.indexOf(lab); return i >= 0 && c[i + 1] && !/:$/.test(c[i + 1]) ? c[i + 1] : null; };
    [['Target Start:', 'targetStart'], ['Target Finish:', 'targetFinish'], ['Report Date:', 'reportDate'], ['Reported By:', 'reportedBy'], ['Supervisor:', 'supervisor'], ['Lead:', 'lead'], ['Owner:', 'owner'], ['Status:', 'status'], ['Work Type:', 'workType'], ['Site:', 'site'], ['Job Plan:', 'jobPlan'], ['Failure Class:', 'failureClass']].forEach(([l, k]) => { const v = kv(l); if (v && !W.meta[k]) W.meta[k] = v; });
    if (c[0] === 'GL Account:') { W.meta.gl = c[1]; glNext = true; return; }
    if (glNext) { glNext = false; if (/^~/.test(t)) { W.meta.gl += t; return; } }
    if (/^Task IDs$/.test(t)) { sec = 'tasks'; return; }
    if (/^Planned Labor$/.test(t)) { sec = 'labor'; return; }
    if (/^Planned Materials$/.test(t)) { sec = 'mat'; return; }
    if (/^Planned Services$/.test(t)) { sec = 'svc'; return; }
    if (/^Log$/.test(t)) { sec = 'log'; return; }
    if (/^Work Order Details$/.test(t) || /^\d{6,}:/.test(t) || /^\d+\/\d+\/\d+ \d+:\d+ [AP]M/.test(t) || /^(Task ID|Date)\b/.test(c[0])) { lastMat = null; return; }
    if ((m = t.match(/^Total Planned Labor:\s*([\d.,]+)/))) { W.meta.laborTotal = pfNum(m[1]); return; }
    if ((m = t.match(/^Total Planned Materials:\s*([\d.,]+)/))) { W.meta.matTotal = pfNum(m[1]); return; }
    if ((m = t.match(/^Total Planned Services:\s*([\d.,]+)/))) { W.meta.svcTotal = pfNum(m[1]); return; }
    if (sec === 'tasks' && /^\d+$/.test(c[0]) && c.length >= 3) { W.tasks.push({ id: c[0], desc: c[1], status: c[2] }); return; }
    if (sec === 'labor' && /^\d+$/.test(c[0])) { const hm = c.find(x => /^\d+:\d{2}$/.test(x)); const hrs = hm ? (+hm.split(':')[0] + (+hm.split(':')[1]) / 60) : null; W.labor.push({ task: c[0], hoursText: hm, hours: hrs, rate: pfNum(c[c.length - 2]), cost: pfNum(c[c.length - 1]) }); return; }
    if (sec === 'mat') {
      if (/^\d+$/.test(c[0]) && /^\d{6,}$/.test(c[1]) && c.length >= 5) { lastMat = { item: c[1], desc: c[2].replace(/&quot;/g, '"').replace(/&apos;/g, "'"), qty: pfNum(c[c.length - 3]), unit: pfNum(c[c.length - 2]), cost: pfNum(c[c.length - 1]) }; W.materials.push(lastMat); return; }
      if (lastMat && c.length === 1) { lastMat.desc += ' ' + t.replace(/&quot;/g, '"').replace(/&apos;/g, "'"); return; }
    }
    if (sec === 'svc' && /^\d+$/.test(c[0]) && c.length >= 4) { W.services.push({ task: c[0], item: c[1], desc: c[2], qty: pfNum(c[3]), cost: pfNum(c[c.length - 1]) }); return; }
    if (sec === 'log') {
      if (/^\d+\/\d+\/\d+$/.test(c[0]) && c.length >= 3) {
        const e = { date: c[0], cls: c[1], by: c[2], desc: c.slice(3).join(' '), text: [], page: L.pageNo }; W.log.push(e);
        wd = /Work Description/.test(t); pn = /Purpose (&|and) Necessity/i.test(t) ? '' : null;
        if (pn != null) { pn = t.replace(/^.*Purpose (&|and) Necessity\s*/i, ''); W.meta.pn = pn; }
        if (wd) { const lastCell = c[c.length - 1]; if (/^[A-Z]{0,3}\d{1,4}$/.test(lastCell)) startNote(lastCell, L.pageNo); }
        return;
      }
      const le = W.log[W.log.length - 1]; if (le) le.text.push(t);
      if (pn != null) { W.meta.pn = (W.meta.pn + ' ' + t).trim(); return; }
      if (wd) {
        if (/^[A-Z]{0,3}\d{1,4}$/.test(t)) { startNote(t, L.pageNo); return; }
        let sm; if ((sm = t.match(/^(?:Station|Point|Work\s*Point|Pole)\s*#?\s*0*(\d{1,4})\s*:?$/i))) { startNote('P' + sm[1], L.pageNo); W.notes['P' + sm[1]].heading = t; return; }
        if ((sm = t.match(/(?:job|WO|work order)\s+contains\s+(\d+)\s+work\s+points/i))) W.meta.wdPoints = +sm[1];
        const cur = W.notes[W.noteOrder[W.noteOrder.length - 1]]; if (!cur) return;
        if ((m = t.match(/^DLOC:\s*(\d+)/i))) { cur.dloc = m[1]; return; }
        if ((m = t.match(/^LAT:\s*(-?[\d.]+)/i))) { cur.lat = parseFloat(m[1]); cur.latText = m[1]; return; }
        if ((m = t.match(/^LONG:\s*(-?[\d.]+)/i))) { cur.lon = parseFloat(m[1]); cur.lonText = m[1]; return; }
        if (/^(Notes|Scope|Description|Work):/i.test(t)) { cur.inNotes = true; const rest = t.replace(/^(Notes|Scope|Description|Work):\s*/i, ''); if (rest) cur.raw.push(rest); return; }
        if (/^(Latitude|Longitude|Lat|Long):?\s*$/i.test(t)) return;
        if (cur.inNotes) cur.raw.push(t);
      }
    }
  });
  function startNote(id, pg) { W.notes[id] = { id, dloc: null, lat: null, lon: null, raw: [], notes: [], page: pg }; W.noteOrder.push(id); }
  Object.values(W.notes).forEach(n => { n.notes = sentences(n.raw.join(' ')); delete n.inNotes; });
  W.log.forEach(e => { e.text = e.text.join('\n'); e.kind = /Auto Generated Notification|Please be informed/i.test(e.text + ' ' + e.desc) ? 'notification' : /Work Description/i.test(e.desc) ? 'workdesc' : /Purpose (&|and) Necessity/i.test(e.desc) ? 'pn' : 'note'; });
  if (W.meta.pn) { const mm = W.meta.pn.match(/total cost[^$]*\$\s*([\d.,]+)/i); if (mm) { W.meta.pnCostText = mm[1].replace(/\.$/, ''); } }
  return W;
}
function sentences(s) { return String(s || '').replace(/\s+/g, ' ').split(/(?<=\.)\s+(?=[A-Z])/).map(x => x.trim()).filter(Boolean); }

/* ================= IFC package ================= */
function parseIFC(pages) {
  const I = { meta: {}, rows: {}, order: [], sketchPage: null, stationPages: [], specText: '', specPages: [] };
  const T = allText(pages); let m;
  if ((m = T.match(/FP #\s*(\S+)/))) I.meta.fp = m[1];
  if ((m = T.match(/PowerPlan WO\s*\n?\s*(C\w{6,})/))) I.meta.powerplan = m[1];
  if ((m = T.match(/Maximo WO\s*\n?\s*(\d{6,})/))) I.meta.maximo = m[1];
  if ((m = T.match(/Designer\s+([A-Z][a-z]+ [A-Z][a-z]+)/))) I.meta.designer = m[1];
  if ((m = T.match(/System Voltage, L-L\s+([\d.]+\s*KV)/i))) I.meta.voltage = m[1];
  if ((m = T.match(/Substation\s+([A-Z][A-Z ]+?)\s+Maximo/))) I.meta.substation = m[1].trim();
  if ((m = T.match(/Maximo WO Description[ \t]*\n?[ \t]*(\S[^\n]*)/))) I.meta.title = m[1].trim();
  pages.forEach(p => {
    const txt = p.lines.map(l => l.text).join('\n');
    if (/Circuit Bkr ID/.test(txt)) { if (!I.sketchPage) I.sketchPage = p.pageNo; (I.sketchPages = I.sketchPages || []).push(p.pageNo); return; }
    if (/CUE Estimate Station Details|Labor Hours :/.test(txt)) { I.stationPages.push(p); return; }
    const hdr = p.lines.find(l => l.cells[0] === 'CUE Station');
    if (hdr) { I.tablePage = I.tablePage || p.pageNo; parseDesignTable(p, hdr, I); return; }
    if (/Brief Description|OH-|COMPATIBLE UNIT|Applies to/i.test(txt) || p.lines.length === 0) { I.specPages.push(p.pageNo); I.specText += '\n' + txt; }
  });
  I.station = I.stationPages.length ? parseStation(I.stationPages) : null;
  return I;
}
function parseDesignTable(p, hdr, I) {
  const keys = { 'CUE Station': 'station', 'Existing': 'dev', 'DLOC': 'dloc', 'Latitude': 'lat', 'Longitude': 'lon', 'Installed Pole': 'setting', 'Equipment': 'equip', 'Anchor': 'anchor', 'Comments': 'comments' };
  let inst = 0; const cols = [];
  hdr.cells.forEach((c, i) => { let k = keys[c]; if (c === 'Installed') k = inst++ === 0 ? 'inst' : 'frame'; if (k) cols.push({ k, c: (hdr.xs[i] + (hdr.xe ? hdr.xe[i] : hdr.xs[i] + 40)) / 2, x0: hdr.xs[i] }); });
  const hdr2 = p.lines.find(l => l.y > hdr.y && l.y < hdr.y + 40 && l.cells.some(c => /^Design Basis/.test(c)));
  let cmX = null;
  if (hdr2) { const wf = hdr2.cells.lastIndexOf('Work Function'); cmX = wf >= 0 && hdr2.xe ? hdr2.xe[wf] + 4 : hdr2.xs[hdr2.cells.findIndex(c => /^Design Basis/.test(c))] - 40; }
  const colOf = (x0, x1) => { if (cmX != null && x0 >= cmX) return 'comments'; const mid = (x0 + x1) / 2; let best = cols[0], bd = 1e9; cols.forEach(cc => { if (cmX != null && cc.k === 'comments') return; const d = Math.abs(cc.c - mid); if (d < bd) { bd = d; best = cc; } }); return best.k; };
  const isRow = l => /^[A-Z]{0,3}\d{1,4}$/.test(l.cells[0]) && l.cells.some(c => /^\d{6,}$/.test(c));
  const rowsL = p.lines.filter(l => l.y > hdr.y && isRow(l));
  const rows = rowsL.map(l => ({ id: l.cells[0], y: l.y, parts: {} }));
  const frags = [];
  p.lines.forEach(l => {
    if (l.y <= hdr.y + 1 || l === hdr2) return;
    if (['(Protective)', 'Trouble', 'Device ID'].includes(l.cells[0]) || /^See Sketch/.test(l.text)) return;
    const own = rowsL.indexOf(l);
    l.cells.forEach((c, i) => { if (own >= 0 && i === 0) return; frags.push({ k: colOf(l.xs[i], l.xe ? l.xe[i] : l.xs[i] + c.length * 4), y: l.y, c, row: own >= 0 ? rows[own] : null }); });
  });
  if (!rows.length) return;
  const lastIn = {};
  frags.sort((a, b) => a.y - b.y).forEach(f => {
    if (!f.row) {
      const prev = lastIn[f.k];
      if (prev && f.y - prev.y < 15.5 && !/\.$/.test(prev.c)) f.row = prev.row;
      else f.row = rows.slice().sort((a, b) => Math.abs(a.y - f.y) - Math.abs(b.y - f.y))[0];
    }
    (f.row.parts[f.k] = f.row.parts[f.k] || []).push(f); lastIn[f.k] = f;
  });
  rows.forEach(r => {
    const get = k => (r.parts[k] || []).sort((a, b) => a.y - b.y).map(x => x.c).filter(x => x !== '-').join(' ').trim();
    const row = { id: r.id, device: get('dev'), dloc: get('dloc'), latText: get('lat'), lonText: get('lon'), lat: pfNum(get('lat')), lon: pfNum(get('lon')), poleMacro: get('inst'), setting: numOrNull(get('setting')), framing: get('frame'), equipment: get('equip'), anchor: get('anchor'), comments: get('comments') };
    I.rows[row.id] = row; I.order.push(row.id);
  });
}

/* ================= Job sketch ================= */
const SKGAP = 40; // gap between stacked sketch pages, in PDF points
// sketch pages: every page with the title block; a sketch file with none uses all its pages
function sketchPageNos(pages, whole) {
  const tb = pages.filter(x => x.lines.some(l => /Circuit Bkr ID/.test(l.text))).map(x => x.pageNo);
  return tb.length ? tb : whole ? pages.map(x => x.pageNo) : [pages[0].pageNo];
}
// a multi-page sketch is read as one drawing: pages stacked top to bottom, narrower ones centred
function parseSketch(pages, pageNos) {
  if (!Array.isArray(pageNos)) pageNos = pageNos ? [pageNos] : sketchPageNos(pages, true);
  const ps = pageNos.map(n => pages.find(x => x.pageNo === n)).filter(Boolean); if (!ps.length) ps.push(pages[0]);
  const W = Math.max(...ps.map(p => p.w)); let top = 0;
  const K = { page: ps[0].pageNo, pages: [], labels: [], fields: {} };
  const map = { 'WO': 'wo', 'Work Order ID': 'powerplan', 'Address': 'address', 'ARC Flash': 'arc', 'Sub': 'sub', 'Circuit Bkr ID': 'circuit', 'Phase': 'phase', 'Date': 'date', 'Designer': 'designer', 'Latitude': 'lat', 'Longitude': 'lon', 'WO Title': 'title', 'Rev#': 'rev', 'WO Type': 'woType', 'Contact Person': 'contact', 'Phone#': 'phone', 'County/Parish': 'county', 'Local Office': 'office', 'Page': 'pageOf' };
  const tl = [], annCallouts = [];
  ps.forEach(p0 => {
    const dx = (W - p0.w) / 2, dy = top; top += p0.h + SKGAP;
    K.pages.push({ page: p0.pageNo, x0: dx, y0: dy, w: p0.w, h: p0.h, info: sketchInfoBox(p0), hasText: p0.lines.length > 3 || (p0.annots || []).length > 0 });
    const p = { ...p0, lines: p0.lines.map(l => ({ ...l, y: l.y + dy, xs: l.xs.map(x => x + dx), xe: l.xe && l.xe.map(x => x + dx) })),
      annots: (p0.annots || []).map(a => ({ ...a, x: a.x + dx, x0: a.x0 + dx, x1: a.x1 + dx, y: a.y + dy, y0: a.y0 + dy, y1: a.y1 + dy })) };
    sketchPageRead(p, K, map, tl, annCallouts);
  });
  K.w = W; K.h = top - SKGAP;
  const box = (K.pages.find(x => x.info && x.info.voltage) || {}).info; // an info box drawn as page text rather than a text box
  if (box) { if (!K.fields.voltage) K.fields.voltage = box.voltage; if (!K.fields.feeder && box.feeder) K.fields.feeder = box.feeder.split(/\s/)[0]; }
  const textCallouts = ocrCallouts(tl).filter(c => !annCallouts.some(a => a.dloc && a.dloc === c.dloc));
  K.callouts = [...annCallouts, ...textCallouts].filter((c, i, a) => a.findIndex(x => x.id === c.id && x.dloc === c.dloc && x.lines.join('|') === c.lines.join('|')) === i);
  annCallouts.forEach(c => c.lines.forEach((t, i) => tl.push({ text: t, x0: c.box.x0, x1: c.box.x1, y0: c.box.y0 + i * 10, y1: c.box.y0 + i * 10 + 9, h: 9 })));
  K.textLines = tl.map(l => ({ t: l.text, x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 }));
  return K;
}
// the project info box every sketch page should carry: primary voltage, feeder, substation, upstream device, arc
function sketchInfoBox(p) {
  const texts = [...(p.annots || []).map(a => String(a.text)), p.lines.flatMap(l => l.cells).join('\n')];
  const T = texts.find(t => /Primary\s*Voltage/i.test(t)); if (!T) return null;
  const g = re => { const m = T.match(re); return m ? m[1].trim() : null; };
  return { voltage: g(/Primary\s*Voltage\s*:\s*([\d.]+\s*kV)/i), kv: pfNum(g(/Primary\s*Voltage\s*:\s*([\d.]+)\s*kV/i)), feeder: g(/Feeder\s*:\s*([^\r\n]+)/i), sub: g(/Substation\s*:\s*([^\r\n]+)/i), upstream: g(/Upstream\s*Device\s*:\s*([^\r\n]+)/i), arc: g(/(?:^|[\r\n])\s*Arc(?:\s*Flash)?\s*:\s*([\d.]+)/i) };
}
function sketchPageRead(p, K, map, tl, annCallouts) {
  p.lines.forEach(l => {
    l.cells.forEach((c, i) => {
      const m = c.match(/^([A-Za-z#/ ]+?):\s*(.*)$/);
      if (m && map[m[1].trim()] && K.fields[map[m[1].trim()]] == null) K.fields[map[m[1].trim()]] = m[2].trim();
      if (/^Scale/.test(c) && !K.fields.scale) K.fields.scale = c.replace(/^Scale\s*/, '');
      if (/^[A-Z]{0,3}\d{1,4}$/.test(c) && l.cells.length === 1 && !K.labels.some(x => x.id === c)) K.labels.push({ id: c, x: l.xs[i], y: l.y });
      // hyphenated pole labels (P-1, PL-12); span labels like S-3 are left out. Labels close together can share a cell ("P-9 P-18")
      const hy = c.trim().split(/\s+/);
      if (hy.every(t => /^[A-Z]{1,4}-\d{1,4}[A-Z]?$/.test(t))) { const x0 = l.xs[i], x1 = (l.xe || [])[i] ?? x0 + 24 * hy.length;
        hy.forEach((t, j) => { if (!/^(?:P|PL|POLE|STA)-/.test(t)) return; const at = { x: x0 + (x1 - x0) * j / hy.length, y: l.y };
          // a label repeated at a match line is kept once; the other spots are remembered so the one nearest its callout can be used
          const had = K.labels.find(x => x.id === t); if (had) (had.alts = had.alts || [{ x: had.x, y: had.y }]).push(at); else K.labels.push({ id: t, ...at }); }); }
    });
  });
  p.lines.forEach(l => tl.push({ text: l.text, x0: l.xs[0], x1: (l.xe || l.xs)[l.cells.length - 1] || l.xs[0] + 40, y0: l.y - 9, y1: l.y + 1, h: 10 }));
  (p.annots || []).forEach(a => { const parts = String(a.text).split(/[\r\n]+/).map(t => t.trim()).filter(Boolean); if (!parts.length || a.x0 == null) return;
    const lh = Math.max(8, Math.min(14, (a.y1 - a.y0) / parts.length)); const al = parts.map((t, i) => ({ text: t, x0: a.x0 + 2, x1: a.x1, y0: a.y0 + i * lh, y1: a.y0 + (i + 1) * lh - 1, h: lh - 1 }));
    const T = parts.join('\n'); let m;
    if ((m = T.match(/Primary Voltage:\s*([\d.]+\s*kV)/i)) && !K.fields.voltage) K.fields.voltage = m[1];
    if ((m = T.match(/Protection Device:\s*(.+)/i)) && !K.fields.protection) K.fields.protection = m[1].trim();
    if ((m = T.match(/Feeder:\s*(\S+)/i)) && !K.fields.feeder) K.fields.feeder = m[1];
    if ((m = T.match(/ARC Flash:\s*([\d.]+)/i)) && !K.fields.arc) K.fields.arc = m[1];
    if (/DLOC/i.test(T) || (/^Lat/im.test(T) && /^Lon/im.test(T))) { const c = ocrCallouts(al)[0]; if (c) { c.box = { x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 }; c.fromAnnot = true; annCallouts.push(c); } }
    else al.forEach(l => tl.push(l)); });
}

/* ================= CUE summaries ================= */
function parseJobCost(pages) {
  const J = {}; const T = allText(pages); let m;
  const row = (lab) => { for (const p of pages) for (const l of p.lines) if (l.cells[0] === lab) return l.cells.slice(1).map(pfNum).filter(v => v != null); return []; };
  const last = a => a.length ? a[a.length - 1] : null;
  J.onsite = last(row('Labor Hours - On Site:')); J.offsite = last(row('Labor Hours - Off Site:')); J.hours = last(row('= Total Labor Hours:'));
  J.labor = last(row('Labor Cost:')); J.services = last(row('+ Services Cost:')); J.tools = last(row('+ Tools Cost:'));
  J.newMat = last(row('New Material Cost:')); J.salvage = last(row('Less Salvage:')); J.material = last(row('= Total Material Cost:'));
  J.overheads = last(row('Total Overheads:')); J.gross = last(row('Total Gross Cost:')); J.contrib = last(row('Less Applied Contributions:')); J.net = last(row('Total Net Cost:')); J.total = last(row('Total Estimate Cost:'));
  if ((m = T.match(/Commit Date:\s*\n?\s*([A-Za-z]+ \d+, \d{4})/))) J.commit = m[1];
  J.stationParams = [];
  pages.forEach(p => p.lines.forEach(l => { if (/^[A-Z]{0,3}\d{1,4}$/.test(l.cells[0]) && /^\d$/.test(l.cells[1] || '') && /^[HC]$/.test(l.cells[2] || '')) J.stationParams.push({ id: l.cells[0], set: l.cells[1], hc: l.cells[2], inacc: l.cells[3] || '', rates: l.cells[4] || '', override: l.cells[5] || '' }); }));
  if ((m = T.match(/Master WO:\s*(\d+)/))) J.wo = m[1];
  return J;
}
function parseCostDist(pages) {
  const D = { grand: [] };
  pages.forEach(p => p.lines.forEach(l => { if (l.cells[0] === 'Grand Totals:') D.grand.push(l.cells.slice(1).join(' ').split(/\s+/).map(pfNum)); }));
  const g = D.grand[D.grand.length - 1];
  if (g) { D.material = g[0]; D.labor = g[1]; D.services = g[2]; D.direct = g[4]; D.overhead = g[5]; D.total = g[8]; }
  return D;
}
function parseLabor(pages) {
  const Lb = {};
  pages.forEach(p => p.lines.forEach(l => { const t = l.text; let m; if ((m = t.match(/^Sub-total for Work Group \(or Contractor\):\s*\S+\s+([\d.]+)\s+([\d.]+)/))) { Lb.hours = +m[1]; Lb.cost = +m[2]; } }));
  return Lb;
}
function parseMaterial(pages) {
  const M = { items: [] }; let last = null;
  pages.forEach(p => p.lines.forEach(l => {
    const c = l.cells, t = l.text; let m;
    if ((m = t.match(/Total for Direct Purchases:\s*([\d.,]+)/))) { M.total = pfNum(m[1]); return; }
    if (/^\d{8,}$/.test(c[0]) && c.length >= 6) { last = { item: c[0], desc: c[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'"), qty: pfNum(c[2]), uom: c[3], unit: pfNum(c[4]), cost: pfNum(c[5]) }; M.items.push(last); return; }
    if (last && c.length === 1 && !/^(Item|Estimate|Work Site|Master|Storeroom)/.test(t) && !/^\d+\/\d+\/\d+/.test(t)) last.desc += ' ' + t.replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    else last = /^\d{8,}$/.test(c[0]) ? last : (c.length > 1 ? null : last);
  }));
  return M;
}

/* ================= 811 ticket ================= */
function parse811(pages) {
  const X = { gps: [], responses: [], members: [] }; const T = allText(pages); let m;
  const kv = lab => { for (const p of pages) for (const l of p.lines) { const i = l.cells.indexOf(lab); if (i >= 0 && l.cells[i + 1]) return l.cells[i + 1]; } return null; };
  if ((m = T.match(/^Ticket (\d{6,})/m))) X.ticket = m[1];
  X.type = kv('Type:'); X.oldTicket = kv('Old Ticket:'); X.date = kv('Date:'); X.job = kv('Job Number:'); X.workDate = kv('Work Date:'); X.duration = kv('Duration:');
  X.nature = kv('Nature of Work:'); X.depth = pfNum(kv('Excavation Depth:')); X.doneFor = kv('Work Done For:'); X.street = kv('Street:'); X.city = kv('City:'); X.county = kv('County:'); X.equipment = kv('Equipment Type:'); X.contact = kv('Contact:');
  const gpsLine = (T.match(/Excavator Supplied GPS\s*\n(.+)/) || [])[1] || '';
  for (const g of gpsLine.matchAll(/([A-Z ]*\d+)\s*:\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/g)) X.gps.push({ label: g[1].trim(), lat: +g[2], lon: +g[3] });
  const dir = (T.match(/Driving Directions To Work Site\s*\n([\s\S]*?)\nWork Site Locate/) || [])[1] || '';
  X.directions = dir.replace(/\s+/g, ' ').trim();
  for (const g of X.directions.matchAll(/GPS:\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/g)) X.gps.push({ label: 'directions', lat: +g[1], lon: +g[2], precise: true });
  const loc = (T.match(/Work Site Locate Instructions\s*\n(.+)/) || [])[1] || ''; X.locate = loc.trim();
  const r = loc.match(/(\d+)\s*FT\s*RADIUS/i); X.radius = r ? +r[1] : null;
  // positive responses
  const pr = (T.match(/Positive Response\s*\n([\s\S]*?)\nCompany Information/) || [])[1] || '';
  const blocks = pr.split(/\nCode:\s*/).slice(1);
  if (!blocks.length) { for (const b of pr.matchAll(/Code:\s*(\S+)\s*\nName:\s*(.+)\s*\n([^\n]*?):\s*(\w[\w ]*)/g)) X.responses.push({ code: b[1], name: b[2].trim(), status: b[4].trim() }); }
  pages.forEach(p => { let code = null; p.lines.forEach(l => { if (l.cells[0] === 'Code:') code = l.cells[1]; else if (l.cells[0] === 'Name:' && code) { X.members.push({ code, name: l.cells[1] }); code = null; } }); });
  const prText = pr;
  for (const mm of prText.matchAll(/Code:\s*(\S+)\s*\nName:\s*(.+)\n([^\n]*by [^\n:]+):\s*(.+)/g)) X.responses.push({ code: mm[1], name: mm[2].trim(), when: mm[3].replace(/\s*by.*$/, ''), status: mm[4].trim() });
  X.members = X.members.filter((v, i, a) => a.findIndex(z => z.code === v.code) === i);
  const wd = X.workDate ? new Date(X.workDate.replace(/(\d{4})\s+\d.*$/, '$1')) : null;
  const dur = pfNum(X.duration);
  if (wd && !isNaN(wd)) { X.workDateObj = wd.toISOString().slice(0, 10); if (dur) { const e = new Date(wd); e.setDate(e.getDate() + dur); X.endDate = e.toISOString().slice(0, 10); } }
  const dd = X.date ? new Date(X.date.replace(/,\s*\d+:\d+.*$/, '')) : null; if (dd && !isNaN(dd)) X.dateObj = dd.toISOString().slice(0, 10);
  return X;
}

/* ================= NJUNS ================= */
function parseNJUNS(pages) {
  const N = { assets: [], steps: [], parties: [] }; const T = allText(pages); let m;
  const kv = lab => { for (const p of pages) for (const l of p.lines) { const i = l.cells.indexOf(lab); if (i >= 0 && l.cells[i + 1] && !/:$/.test(l.cells[i + 1])) return l.cells[i + 1]; } return null; };
  if ((m = T.match(/NJUNS Ticket:\s*(\S+)/))) N.ticket = m[1];
  N.number = kv('Ticket Number:'); N.status = kv('Status:'); N.type = kv('Ticket Type:'); N.created = kv('Created On:'); N.requested = kv('Work Requested Date:'); N.start = kv('Start Date:'); N.misc = kv('Misc Id:'); N.count = pfNum(kv('# of Assets/Poles:')); N.contact = kv('Contact Name:'); N.state = kv('State:'); N.county = kv('County:'); N.place = kv('Place:');
  let sec = '', last = null;
  pages.forEach(p => p.lines.forEach(l => {
    const c = l.cells, t = l.text;
    if (/^Assets$/.test(t)) { sec = 'assets'; return; } if (/^Steps$/.test(t)) { sec = 'steps'; return; } if (/^Parties$/.test(t)) { sec = 'parties'; return; } if (/^Comments$/.test(t)) { sec = ''; return; }
    if (/^Remarks:/.test(t)) { if (last) last.remarks = t.replace(/^Remarks:\s*/, ''); else N.remarks = t.replace(/^Remarks:\s*/, ''); return; }
    if (sec === 'assets' && /^\d+$/.test(c[0]) && /^\d{6,}$/.test(c[1] || '')) { const lat = c.find(x => /^\d{1,2}\.\d{4,}$/.test(x)), lon = c.find(x => /^-\d{1,3}\.\d{4,}$/.test(x)); last = { seq: c[0], pole: c[1], house: c[2], street: c[3], lat: lat ? +lat : null, lon: lon ? +lon : null }; N.assets.push(last); return; }
    if (sec === 'steps' && /^\d+$/.test(c[0]) && c.length >= 5) { last = { seq: c[0], type: c[1], status: c[2], member: c[3], desc: c[4], dates: c.slice(5).filter(x => /\d+\/\d+\/\d{4}/.test(x)) }; N.steps.push(last); return; }
    if (sec === 'parties' && /^(Creator|Owner|Step)$/.test(c[0])) { N.parties.push({ type: c[0], member: c[2], company: c[3] }); return; }
  }));
  N.steps.forEach(s => { const wp = (s.remarks || '').match(/Work Points?\s*([^)]+)/i); s.points = wp ? wp[1].split(/[,\s]+/).filter(Boolean) : []; });
  return N;
}

/* ================= Environmental checklist ================= */
function parseEnv(pages, rawItems) {
  const E = { q: [], meta: {} };
  const p = pages[0]; if (!p) return E;
  const hdr = p.lines.find(l => l.cells.includes('YES') && l.cells.includes('NO') && l.cells.length <= 3);
  const xYes = hdr ? hdr.xs[hdr.cells.indexOf('YES')] : null, xNo = hdr ? hdr.xs[hdr.cells.indexOf('NO')] : null;
  p.lines.forEach((l, li) => {
    const i = l.cells.findIndex(x => /^\d{1,2}\.$/.test(x));
    if (i !== 0) return;
    const n = parseInt(l.cells[0]);
    const xi = l.cells.findIndex((x, k) => k > 0 && /^[Xx✓✔]$/.test(x));
    let ans = null;
    if (xi > 0 && xYes != null) { const x = l.xs[xi]; ans = Math.abs(x - xYes) < Math.abs(x - xNo) ? 'YES' : 'NO'; }
    let text = l.cells.slice(xi > 0 ? xi + 1 : 1).join(' ');
    if (!text) { const prev = p.lines[li - 1], next = p.lines[li + 1]; text = [prev && prev.cells.length === 1 ? prev.text : '', next && next.cells.length === 1 ? next.text : ''].join(' ').trim(); }
    E.q.push({ n, ans, text });
  });
  const T = allText(pages); let m;
  if ((m = T.match(/(WO\s*\d{6,})/))) E.meta.code = m[1].replace(/\s+/, ' ');
  if ((m = T.match(/Project Name:\s*(.+)/))) E.meta.name = m[1].trim();
  if ((m = T.match(/Entergy\s+(TX\d+|LA\d+|AR\d+|MS\d+|NO\d+)/))) E.meta.bu = m[1];
  const lines = p.lines.map(l => l.cells);
  let pmX = null, pmY = null;
  p.lines.forEach(l => l.cells.forEach((c, i) => { const m = c.match(/^Project Manager:?\s*(.*)$/); if (m) { E.meta.pm = m[1] || l.cells[i + 1] || ''; pmX = l.xs[i]; pmY = l.y; } }));
  const pd = p.lines.find(l => l.cells.some(c => /^Project Designer/.test(c)));
  if (pd) { const lx = pd.xs[pd.cells.findIndex(c => /^Project Designer/.test(c))]; const cand = [];
    p.lines.forEach(l => l.cells.forEach((c, i) => { if (Math.abs(l.y - pd.y) < 14 && l.xs[i] > lx + 20 && (pmX == null || l.xs[i] < pmX - 5) && !/^Project /.test(c)) cand.push(c); }));
    const inline = pd.cells.find(c => /^Project Designer\s*:?\s*\S/.test(c) && c.replace(/^Project Designer\s*:?\s*/, '').trim());
    E.meta.designer = cand[0] || (inline ? inline.replace(/^Project Designer\s*:?\s*/, '') : null); }
  if (!E.meta.designer && pmY != null) { const l = p.lines.find(x => Math.abs(x.y - pmY) < 3); if (l && !/^Project/.test(l.cells[0])) E.meta.designer = l.cells[0]; }
  const dept = lines.find(c => c.some(x => /^DPF\d+|^[A-Z]{3}\d{2}$/.test(x))); if (dept) E.meta.dept = dept.find(x => /^DPF\d+|^[A-Z]{3}\d{2}$/.test(x));
  return E;
}

/* ================= JHA ================= */
function parseJHA(pages) {
  const J = {}; const p = pages[0]; if (!p) return J;
  const A = (p.annots || []).filter(a => a.text && a.text.trim());
  const labelish = /:\s*$|^(Date|Rev|Place|for|Completion|Distribution Job Hazard Analysis|Who is|Is this|Has the|including|Substation|Circuit|ARC|DOC|DLOC|Nearest|Work Location|Management|Crew|Job Scope|Designated|Contact|Non Auto|Hot Line|Scouting|Traffic|Environmental|What steps|Emergency|AED|Device)/i;
  p.lines.forEach(l => l.cells.forEach((c, i) => { if (!labelish.test(c) && !/^_+$/.test(c) && c.length < 80) A.push({ text: c, x: l.xs[i], y: l.y, fromText: true }); }));
  const labels = [['Date:', 'date'], ['Nearest Medical Facility :', 'facility'], ['DOC #', 'doc'], ['DLOC #', 'doc'], ['Substation:', 'substation'], ['Circuit :', 'circuit'], ['ARC Rating:', 'arc'], ['Work Location "911" Address/GPS Coordinates/County/Parish :', 'address'], ['Crew Leader for Job:', 'crew'], ['Job Scope:', 'scope'], ['Device :', 'device']];
  const used = new Set();
  labels.forEach(([lab, k]) => {
    let pos = null;
    p.lines.forEach(l => l.cells.forEach((c, i) => { if (!pos && (c === lab || c.startsWith(lab.replace(/\s*:$/, '')) && c.length < lab.length + 25)) pos = { x: l.xs[i], y: l.y }; }));
    if (!pos) return;
    const cand = A.filter(a => !used.has(a) && Math.abs(a.y - pos.y) < 11 && a.x > pos.x - 2).sort((a, b) => (Math.abs(a.y - pos.y) * 4 + (a.x - pos.x) * 0.05) - (Math.abs(b.y - pos.y) * 4 + (b.x - pos.x) * 0.05))[0];
    if (cand) { J[k] = cand.text.trim(); used.add(cand); }
  });
  p.lines.forEach(l => l.cells.forEach(c => labels.forEach(([lab, k]) => { const base = lab.replace(/\s*:$/, '').trim(); if (c.startsWith(base) && c.length > lab.length + 1) { const v = c.slice(base.length).replace(/^\s*:?\s*_*\s*/, '').trim(); if (v && !/:$/.test(v) && !J[k]) J[k] = v; } })));
  if (!J.date) { const d = A.find(a => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(a.text.trim())); if (d) J.date = d.text.trim(); }
  return J;
}


/* ================= DCO (Distribution Change Order) ================= */
function parseDCO(pages) {
  const forms = [];
  pages.forEach((p, pi) => {
    const T = p.lines.map(l => l.text).join('\n');
    if (!/Change Order \(DCO\)/.test(T)) return;
    const F = { page: p.pageNo, types: [], activity: [], rows: [], date: null, office: null, dloc: null, toDloc: null, lat: null, lon: null, feeder: null, wo: null, comments: '' };
    const checked = cells => cells.filter(c => /☒|☑|\[x\]/i.test(c)).map(c => c.replace(/☒|☑|\[x\]/ig, '').replace(/^.*?:\s*/, '').trim());
    p.lines.forEach((L, li) => {
      const c = L.cells, t = L.text; let m;
      const di = c.indexOf('Date:'); if (di >= 0 && c[di + 1]) F.date = c[di + 1];
      if (/^Equipment Type:|^☐Capacitor|^☒Capacitor/.test(t)) F.types.push(...checked(c));
      if (/^Activity:/.test(t)) F.activity = checked(c);
      if (c[0] === 'From:') { c.slice(1).forEach((x, i) => { if (/^\d{8,}$/.test(x)) F.dloc = x; else if (/^\d{1,3}$/.test(x) && !F.office) F.office = x; }); const li2 = c.indexOf('LAT'); if (li2 >= 0) F.latText = c[li2 + 1]; else if ((m = t.match(/LAT\s*(-?\d+\.\d+)/))) F.latText = m[1]; }
      if (c[0] === 'To:') { c.slice(1).forEach(x => { if (/^\d{8,}$/.test(x)) F.toDloc = x; }); const li2 = c.indexOf('LONG'); if (li2 >= 0) F.lonText = c[li2 + 1]; else if ((m = t.match(/LONG\s*(-?\d+\.\d+)/))) F.lonText = m[1]; }
      if (/^(Install|Remove)$/.test(c[0])) {
        const vals = c.slice(1).filter(x => !/^[☐☒☑]/.test(x));
        const ph = c.filter(x => /^[☒☑]\s*[ABC]$/.test(x)).map(x => x.replace(/[☒☑]\s*/, ''));
        if (vals.length || ph.length) F.rows.push({ action: c[0], type: vals[0] || '', size: vals[1] || '', equip: vals[2] || '', serial: vals[3] || '', phase: ph.join(''), extra: vals.slice(4) });
      }
      if (/Feeder\. ?No/i.test(t)) { for (let k = li; k < Math.min(li + 4, p.lines.length); k++) { const x = p.lines[k].cells.find(z => /^[0-9]{1,3}[A-Za-z]{2,4}\d?$/.test(z)); if (x) { F.feeder = x; break; } } }
      if ((m = t.match(/^Field Address\/Comments:\s*(.*)$/))) F.comments = m[1];
      if (c[0] === 'Switch Type:') F.switchType = checked(c);
      const ii = c.indexOf('Installed #:'); if (ii >= 0 && c[ii + 1] && !/:$/.test(c[ii + 1])) F.installedNo = c[ii + 1];
    });
    F.lat = pfNum(F.latText); F.lon = pfNum(F.lonText);
    // the second page of the form carries the signature / work order line
    const nxt = pages[pi + 1];
    if (nxt) nxt.lines.forEach(L => { const i = L.cells.indexOf('Work Order #:'); if (i >= 0) { const v = L.cells[i + 1]; if (v && !/:$/.test(v)) F.wo = v; } const j = L.cells.indexOf('Employee ID:'); if (j >= 0 && L.cells[j + 1]) F.employee = L.cells[j + 1]; });
    forms.push(F);
  });
  return { forms };
}

/* ================= Voltage drop / flicker worksheet ================= */
function parseVD(pages, name) {
  const V = { rows: [], name };
  const p = pages[0]; if (!p) return V;
  p.lines.forEach((L, li) => {
    const c = L.cells;
    if (/^\d{1,2}$/.test(c[0]) && c.length >= 10 && c.some(x => /%$/.test(x))) {
      if (c[1] === '0') return;
      const pi = c.findIndex(x => /%$/.test(x));
      const ti = c.findIndex((x, i) => i >= 2 && /^[POCD]$/.test(x));
      const pfi = c.findIndex((x, i) => i > ti && /^0\.\d{2}$/.test(x));
      const mid = ti >= 0 && pfi > ti ? c.slice(ti + 2, pfi) : [];
      V.rows.push({ point: +c[0], v: c[1], wire: c[2], inst: ti >= 0 ? c[ti] : '', feet: ti >= 0 ? pfNum(c[ti + 1]) : null, load: mid.length >= 2 ? pfNum(mid[0]) : null, phases: mid.length ? pfNum(mid[mid.length - 1]) : null, pf: pfNum(c[pfi]), cls: c[pfi + 1] || '', cum: pfNum(c[pi]), sect: pfNum(c[pi + 1]), kva: pfNum(c[pi + 2]), cap: pfNum(c[pi + 3]), amps: pfNum(c[pi + 5]) });
    }
    const oi = c.indexOf('Transformer Over Ride'); if (oi >= 0) { for (let k = li + 1; k < li + 4 && k < p.lines.length; k++) { const x = p.lines[k].cells.find(z => /^\d+(\.\d+)?$/.test(z) && p.lines[k].cells.length <= 2); if (x) { V.override = pfNum(x); break; } } }
    const mi = c.indexOf('Largest Motor or AC'); if (mi >= 0) V.motor = pfNum(c[mi + 1]);
    const si = c.indexOf('Starting kVA'); if (si >= 0) V.starting = pfNum(c[si + 1]);
    if (/^Revised/.test(L.text)) V.revised = L.text.replace(/^Revised\s*/, '');
  });
  const x = V.rows.find(r => r.v === 'XFMR');
  V.xfmr = x ? pfNum(x.wire) : null;
  V.kind = /flicker/i.test(name || '') ? 'flicker' : /divers|drop|vd/i.test(name || '') ? 'drop' : (x && x.load == null ? 'flicker' : 'drop');
  V.maxCum = V.rows.length ? Math.max(...V.rows.map(r => r.cum || 0)) : null;
  return V;
}

/* ================= estimate CU list (Excel export: Station, Work Set, CU Name, Work Function, Quantity) ================= */
function parseCUSheet(rows) {
  const hi = rows.slice(0, 5).findIndex(r => r.some(c => /^cu name$/i.test(String(c).trim())) && r.some(c => /^station$/i.test(String(c).trim())));
  if (hi < 0) return null;
  const H = rows[hi].map(c => String(c).trim().toLowerCase()), col = n => H.indexOf(n);
  const ix = { st: col('station'), ws: col('work set'), cu: col('cu name'), desc: col('description'), wf: col('work function'), qty: col('quantity'), hc: col('hot / cold') };
  if (ix.wf < 0 || ix.qty < 0) return null;
  const g = (r, k) => ix[k] >= 0 ? String(r[ix[k]] ?? '').trim() : '';
  const out = rows.slice(hi + 1).filter(r => g(r, 'cu') && g(r, 'st')).map(r => ({ station: g(r, 'st'), ws: g(r, 'ws'), cu: g(r, 'cu'), desc: g(r, 'desc'), wf: g(r, 'wf'), qty: pfNum(g(r, 'qty')), hc: g(r, 'hc') }));
  return { rows: out, stations: [...new Set(out.map(r => r.station))] };
}

/* ================= field KMZ / KML (placemarks with a DLOC table in the description) ================= */
function parseKML(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml'), tag = (el, n) => el.getElementsByTagName(n)[0]?.textContent?.trim() || '';
  const marks = [...doc.getElementsByTagName('Placemark')].map(p => {
    const fields = {}, desc = tag(p, 'description');
    if (/<t[dh]/i.test(desc)) new DOMParser().parseFromString(desc, 'text/html').querySelectorAll('tr').forEach(tr => { const c = [...tr.children].map(td => td.textContent.trim()); if (c.length >= 2 && c[0]) fields[c[0]] = c[1]; });
    const [lon, lat] = tag(p, 'coordinates').split(/[\s]+/)[0].split(',').map(Number);
    const dloc = fields['DLOC Number'] || (desc.match(/DLOC[^0-9]{0,20}(\d{9,11})/i) || [])[1] || null;
    return { name: tag(p, 'name'), dloc, lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null, point: !!p.getElementsByTagName('Point')[0], fields };
  });
  return { name: tag(doc, 'name'), marks };
}

/* ================= Job jacket ================= */
// Maximo tables: values are right-aligned under their headers, and the columns differ between job jacket layouts,
// so each value goes to the header column it overlaps most. Rows wrap onto following lines until the next section.
function jacketTable(lines, hi) {
  const H = lines[hi], end = (L, j) => (L.xe || [])[j] ?? L.xs[j] + L.cells[j].length * 5;
  const cols = H.cells.map((name, j) => ({ name, hi: end(H, j) }));
  cols.forEach((c, j) => { c.lo = j ? cols[j - 1].hi : -1e9; }); cols[cols.length - 1].hi += 15;
  const row = {}; let lastY = H.y;
  for (let k = hi + 1; k < lines.length; k++) {
    const L = lines[k]; if (/^[A-Z]{6,}$/.test(L.text) || L.y - lastY > 20) break; lastY = L.y;
    L.cells.forEach((v, j) => { const x0 = L.xs[j], x1 = end(L, j); let best = null, ov = 0;
      cols.forEach(c => { const o = Math.min(x1, c.hi) - Math.max(x0, c.lo); if (o > ov) { ov = o; best = c; } });
      if (best) row[best.name] = row[best.name] ? `${row[best.name]} ${v}` : v; });
  }
  return row;
}
function parseJacket(pages) {
  const J = { wo: null };
  const p = pages[0]; if (!p) return J;
  const date = v => (String(v || '').match(/\d{1,2}\/\d{1,2}\/\d{2,4}/) || [])[0];
  const hi = p.lines.findIndex(L => L.cells.includes('Designer') && L.cells.some(c => /^Work Order/.test(c)));
  if (hi >= 0) { const r = jacketTable(p.lines, hi);
    J.wo = ((r['Work Order'] || r['Work Order #'] || '').match(/\d{7,}/) || [])[0] || null;
    J.workType = r['Work Type']; J.subType = r['Type']; J.designer = r['Designer']; J.targetFinish = date(r['Target Finish']);
    J.office = r['Code'] || r['#']; J.address = r['Street Address']; J.city = r['City']; J.state = r['State'];
    J.kit = r['Kit Materials']; J.kitNotes = r['Kit Notes']; J.description = r['Description']; J.commitCol = date(r['Commit Date']); }
  const oi = p.lines.findIndex(L => L.text === 'ETRLOCALOFFICE');
  if (oi >= 0 && p.lines[oi + 1]) { const r = jacketTable(p.lines, oi + 1);
    J.officeName = r['Local Office Name'] || r['Local Office']; J.network = r['Network Name']; J.networkCode = r['Network Code']; J.region = r['Region']; }
  pages.forEach(pp => pp.lines.forEach(L => { let m = L.text.match(/workorderid\s*=\s*(\d+)/); if (m) J.workorderid = m[1];
    if ((m = L.text.match(/Commit(?: Date)?:\s*([\d\/]+)/i))) J.commit = m[1];
    if ((m = L.text.match(/^JOB JACKET\.?\s+(\S.*)$/i))) J.title = m[1].trim();
    if (L.cells.some(c => /^(OH|UG)$/.test(c))) J.ohug = L.cells.find(c => /^(OH|UG)$/.test(c)); }));
  J.commit = J.commit || J.commitCol;
  return J;
}
function parseJacketOCR(lines) {
  lines = (lines || []).slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const O = {};
  const T = lines.map(l => l.text).join('\n');
  const below = (L, n) => { const out = []; let last = L; for (const l of lines) { if (out.length >= n) break; if (l.y0 <= last.y0 + 2 || Math.abs(l.x0 - L.x0) > 45) continue; if (l.y0 - last.y1 > (L.h || 30) * 2.2) break; out.push(l.text); last = l; } return out; };
  const field = (re, n) => { const L = lines.find(l => re.test(l.text)); if (!L) return null; const after = L.text.replace(re, '').replace(/^\s*[:;]\s*/, '').trim(); return after ? [after, ...below(L, n - 1)] : below(L, n); };
  let v, m;
  if ((m = T.match(/(Onsite\s*)?Man\s*-?\s*Hours\s*[:;]?\s*([\d.,]+)/i))) { O.manHours = pfNum(m[2]); O.manHoursOnsite = !!m[1]; }
  if ((m = T.match(/Line\s*Voltage\s*[:;]?\s*([\d.]+\s*kV)/i))) O.voltage = m[1];
  if ((v = field(/^Upstream\s*Device\s*[:;]?/i, 1)) && v[0]) O.upstream = v[0].trim();
  if ((m = T.match(/\b(\d+(?:\.\d+)?)\s*kV\s*(OH|UG)?\b/i))) O.voltage = m[0].trim();
  if ((v = field(/^Designer\s*Name\s*[:;]?/i, 1)) && v[0]) O.designerName = v[0].trim();
  if ((v = field(/^Designer\s*Company\s*[:;]?/i, 1)) && v[0]) O.designerCompany = v[0].trim();
  if ((v = field(/^(?:Physical\s*)?Location\s*[:;]?/i, 2))) O.location = v.join(' ').replace(/\s+/g, ' ').trim();
  if ((m = T.match(/Commit\s*[:;]\s*([\d\/]+)/i))) O.commit = m[1];
  const cj = lines.find(l => /CONJ?U?N?CTION/i.test(l.text));
  if (cj) O.conjunction = [...new Set(lines.filter(l => l.y0 >= cj.y0 - 5 && l.y0 < cj.y0 + 400 && Math.abs(l.x0 - cj.x0) < 60).map(l => (l.text.match(/\b\d{8}\b/) || [])[0]).filter(Boolean))];
  return O;
}

/* ================= photo labels (field app overlay: Scid / DLOC / Lat / Long) ================= */
function parsePhotoText(pages) {
  return pages.map(p => {
    const lines = [...p.lines.map(l => l.text), ...(p.annots || []).flatMap(a => String(a.text).split(/[\r\n]+/))].map(t => t.trim()).filter(Boolean);
    const T = lines.join('\n'); if (!/DLOC/i.test(T)) return null;
    const g = re => (T.match(re) || [])[1] || null;
    let id = g(/Scid:\s*([A-Za-z0-9\-]+)/i);
    if (!id) { const di = lines.findIndex(l => /DLOC/i.test(l)); for (let k = di - 1; k >= 0 && k >= di - 3; k--) { const m = lines[k].match(/^([A-Z]{0,4}\s?-?\d{1,4}[A-Z]?)$/i); if (m) { id = m[1].replace(/\s|-/g, ''); break; } }
      if (!id) id = g(/^([A-Z]{1,4}\d{1,4})\b/im); }
    return { id, dloc: g(/DLOC(?:\s*(?:Number|#|No\.?))?\s*[:;.]?\s*\n?\s*(\d{6,})/i), lat: g(/LAT(?:itude)?\s*[:;.]?\s*\n?\s*(-?\d+\.\d+)/i), lon: g(/LONG?(?:itude)?\s*[:;.]?\s*\n?\s*(-?\d+\.\d+)/i), src: /Scid:/i.test(T) ? 'scid' : 'text', text: T.slice(0, 300) };
  });
}

/* ================= Maximo device ID generator ================= */
function parseDeviceIDs(pages) {
  const D = { ids: [] };
  pages.forEach(p => {
    const e = { page: p.pageNo }; let next = '';
    p.lines.forEach((L, li) => {
      const c = L.cells, t = L.text;
      if (/Default Site:/.test(t)) { e.user = c[0]; e.site = (t.match(/Default Site:\s*(\S+)/) || [])[1]; }
      if (/^\d{1,2}\/\d{1,2}\/\d{2}, /.test(c[0]) && !e.when) e.when = c[0];
      if (t === 'Work Order') next = 'wo'; else if (t === 'Device Type') next = 'type'; else if (t === 'Device ID') next = 'id';
      else if (next) { if (next === 'wo') { e.wo = c[0]; e.title = c[1] || ''; } else if (next === 'type') e.type = t; else if (next === 'id' && /^[A-Z]{1,3}\d{4,}$/i.test(c[0])) e.id = c[0].toUpperCase(); next = ''; }
    });
    if (e.id) D.ids.push(e);
  });
  D.wo = D.ids[0]?.wo || null;
  return D;
}

/* ================= OCR helpers (tesseract TSV) ================= */
function tsvLines(tsv) {
  const map = new Map();
  String(tsv || '').split('\n').forEach(r => {
    const c = r.split('\t'); if (c.length < 12 || c[0] !== '5') return; const txt = c.slice(11).join('\t').trim(); if (!txt) return;
    const k = c[1] + '|' + c[2] + '|' + c[3] + '|' + c[4]; const L = +c[6], T = +c[7], W = +c[8], H = +c[9], cf = +c[10];
    let o = map.get(k); if (!o) { o = { words: [], x0: L, y0: T, x1: L + W, y1: T + H }; map.set(k, o); }
    o.words.push({ t: txt, x: L, cf }); o.x0 = Math.min(o.x0, L); o.y0 = Math.min(o.y0, T); o.x1 = Math.max(o.x1, L + W); o.y1 = Math.max(o.y1, T + H);
  });
  return [...map.values()].map(o => ({ text: o.words.sort((a, b) => a.x - b.x).map(w => w.t).join(' '), x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1, h: o.y1 - o.y0, conf: o.words.reduce((a, w) => a + w.cf, 0) / o.words.length }));
}
const ocrNormP = s => String(s).replace(/\bP\s?[O0o]\s?([0-9SsIlOo])\b/g, (m, d) => 'P0' + ({ S: '5', s: '5', I: '1', l: '1', O: '0', o: '0' }[d] || d));
const ocrDigits = s => String(s).replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5');
function ocrCallouts(lines) {
  lines = lines.map(l => ({ ...l, text: ocrNormP(String(l.text).replace(/\s+/g, ' ').trim()) })).filter(l => l.text).sort((a, b) => a.y0 - b.y0);
  const out = [], used = new Set();
  const isHead = t => /^[A-Z]{0,3}\s?-?\d{1,4}[A-Z]?\s*[:.]?$/.test(t) && !/^\d+$/.test(t);
  const isField = t => /^(D\s?L\s?O\s?C|Lat|Lon|Address|Notes?|Scope|Transformer|Comms?|Install|Replace|Remove|Transfer|Straighten|Add|Truck|Existing|Relocate|Set|Pole)/i.test(t);
  const collect = (start, lh) => { const blk = [start]; let last = start;
    const cand = lines.filter(l => l !== start && l.y0 > start.y0 + 1 && Math.abs(l.x0 - start.x0) < lh * 2.4).sort((a, b) => a.y0 - b.y0);
    for (const l of cand) { const gap = l.y0 - last.y1; if (gap > lh * 3.4) break; if (gap > lh * 1.8 && !isField(l.text) && !/[a-z]{3}/i.test(l.text)) break; if (/^D\s?L\s?O\s?C/i.test(l.text) && blk.some(b => /^D\s?L\s?O\s?C/i.test(b.text))) break; if (isHead(l.text) && blk.length > 1) break; blk.push(l); last = l; }
    return blk; };
  const finish = (head, blk) => {
    const txt = blk.map(b => b.text);
    const g = re => { const x = txt.find(t => re.test(t)); return x ? x.match(re)[1] : null; };
    const dl = txt.find(t => /^D\s?L\s?O\s?C/i.test(t)); const dlm = dl && dl.match(/([0-9OoIl]{6,})/);
    const ni = txt.findIndex(t => /^Notes?\s*[:;]?/i.test(t)); const ai = txt.findIndex(t => /^Address/i.test(t));
    // a bare "Address:" label has the address on the next line; "ADDRESS: 123 MAIN ST" carries it inline
    const aBare = ai >= 0 && /^Address\s*[:;]?\s*$/i.test(txt[ai]);
    // everything that isn't the pole identity is scope text, whatever the designer labelled it (Notes:, Scope:, none)
    const idLine = (t, i) => /^D\s?L\s?O\s?C|^Lat\w*\s*[:;.]?\s*-?\d|^Lon\w*\s*[:;.]?\s*-?\d|^Address\s*[:;]?$/i.test(t) || (aBare && i === ai + 1 && i !== ni) || (ai >= 0 && i === ai);
    const notes = txt.filter((t, i) => !idLine(t, i)).map(t => t.replace(/^(Notes?|Scope|Work|Description)\s*[:;-]\s*/i, '')).filter(t => t && !/^(Notes?|Scope)\s*[:;]?$/i.test(t));
    blk.forEach(b => used.add(b));
    const all = head ? [head, ...blk] : blk;
    return { id: head ? (head.text.match(/^([A-Z]{0,3})\s?-?(\d{1,4}[A-Z]?)/) || []).slice(1).join('') : null, dloc: dlm ? ocrDigits(dlm[1]) : null, lat: g(/^Lat\w*\s*[:;.]?\s*(-?[\d.]{3,})/i), lon: g(/^Lon\w*\s*[:;.]?\s*(-?[\d.]{3,})/i), addr: ai < 0 ? null : !aBare ? txt[ai].replace(/^Address\s*[:;]?\s*/i, '') : ai + 1 < txt.length && ai + 1 !== ni ? txt[ai + 1] : null, notes, lines: txt, box: { x0: Math.min(...all.map(b => b.x0)), y0: Math.min(...all.map(b => b.y0)), x1: Math.max(...all.map(b => b.x1)), y1: Math.max(...all.map(b => b.y1)) } };
  };
  // pass 1: blocks anchored on a DLOC line
  lines.forEach(d => { if (used.has(d) || !/^D\s?L\s?O\s?C\s*[:;.]?\s*[0-9OoIl]{6,}/i.test(d.text) && !/^D\s?L\s?O\s?C\s*[:;.]?$/i.test(d.text)) return;
    const lh = d.h || 20;
    const head = lines.filter(l => l !== d && !used.has(l) && l.y1 <= d.y0 + 4 && d.y0 - l.y1 < lh * 3 && Math.abs(l.x0 - d.x0) < lh * 2.4 && isHead(l.text)).sort((a, b) => b.y1 - a.y1)[0];
    let blk = collect(d, lh);
    if (/^D\s?L\s?O\s?C\s*[:;.]?$/i.test(d.text)) { const nx = blk[1]; if (nx && /^[0-9OoIl]{6,}$/.test(nx.text)) { d.text = 'DLOC: ' + nx.text; blk.splice(1, 1); } }
    if (head) used.add(head);
    out.push(finish(head, blk));
  });
  // pass 2: blocks that start with a pole label and carry Lat/Long but no readable DLOC
  lines.forEach(h => { if (used.has(h) || !isHead(h.text)) return; const lh = h.h || 20; const blk = collect(h, lh).slice(1); if (!(blk.some(b => /^Lat/i.test(b.text)) && blk.some(b => /^Lon/i.test(b.text)))) return; used.add(h); out.push(finish(h, blk)); });
  return out;
}
function ocrLabelBlock(lines) {
  const txt = lines.map(l => ocrNormP(l.text)).join('\n');
  const g = re => (txt.match(re) || [])[1] || null;
  return { id: g(/^([A-Z]{0,3}\d{2,4})\s*$/m), dloc: (g(/DLOC\s*[:;.]?\s*([0-9OoIl]{6,})/i) || '').replace(/[Oo]/g, '0').replace(/[Il]/g, '1') || null, lat: g(/Lat\w*\s*[:;.]?\s*(-?[\d.]{6,})/i), lon: g(/Lon\w*\s*[:;.]?\s*(-?[\d.]{6,})/i), text: txt };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { parsePhotoText, parseDCO, parseVD, parseJacket, parseJacketOCR, parseDeviceIDs, pfPageLines, pfNum, pfParse, pfSplit, parseGuyRow, docClassify, parseStation, parseWO, parseIFC, parseSketch, parseJobCost, parseCostDist, parseLabor, parseMaterial, parse811, parseNJUNS, parseEnv, parseJHA, tsvLines, ocrCallouts, ocrLabelBlock };

