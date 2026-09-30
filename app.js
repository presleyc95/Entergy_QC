(function(){
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const natural = (a,b) => String(a).localeCompare(String(b),undefined,{numeric:true});
const f1 = n => n==null||isNaN(n) ? '–' : (Math.round(n*10)/10).toLocaleString('en-US');
const f0 = n => n==null||isNaN(n) ? '–' : Math.round(n).toLocaleString('en-US');
const f2 = n => n==null||isNaN(n) ? '–' : n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const money = n => n==null||isNaN(n) ? '–' : '$'+f2(n);
const near = (a,b,t) => a!=null && b!=null && Math.abs(a-b) <= t;
try { if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; } catch(e){}

/* ---------- settings ---------- */
const DEF = {poleWarn:80, poleFail:85, eqWarn:98, eqFail:100, lead:0.5, commSep:40, spanFt:2, spanPct:1, ang:5, hag250c:60, coordFt:15, leadTol:0.3, degTol:3, attTol:2, ocrAuto:1, repl250c:1, vdMax:5, flkMax:5, dcoMi:0.5, sv:2, qcTech:''};
let S = {...DEF};
try { const saved = JSON.parse(localStorage.getItem('pfqc:settings')||'{}'); if (!saved.sv || saved.sv<2){ delete saved.leadTol; saved.sv=2; } Object.assign(S, saved); } catch(e){}
const saveS = () => { try{ localStorage.setItem('pfqc:settings', JSON.stringify(S)); }catch(e){} };

/* ---------- storage (IndexedDB) ---------- */
let DBP = null;
function db(){ if (DBP) return DBP; DBP = new Promise((res,rej)=>{ try{ const r=indexedDB.open('pfqc',1); r.onupgradeneeded=()=>r.result.createObjectStore('docs',{keyPath:'id'}); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);}catch(e){rej(e);} }); return DBP; }
async function dbAll(){ try{ const d=await db(); return await new Promise((res,rej)=>{ const q=d.transaction('docs').objectStore('docs').getAll(); q.onsuccess=()=>res(q.result||[]); q.onerror=()=>rej(q.error); }); }catch(e){ return []; } }
async function dbPut(rec){ try{ const d=await db(); await new Promise((res,rej)=>{ const t=d.transaction('docs','readwrite'); t.objectStore('docs').put(rec); t.oncomplete=res; t.onerror=()=>rej(t.error); }); }catch(e){ console.warn('save failed', e); } }
async function dbDel(id){ try{ const d=await db(); await new Promise((res)=>{ const t=d.transaction('docs','readwrite'); id==null?t.objectStore('docs').clear():t.objectStore('docs').delete(id); t.oncomplete=res; t.onerror=res; }); }catch(e){} }

/* ---------- state ---------- */
let DOCS = [];    // {id,name,kind,bytes,pages,data,added}
let POLES = [];   // PoleForeman records {id,fileName,docId,pageNos,R,pf,img}
let STN = [];     // one per station / pole, tying every document together
let PKG = {};     // latest document of each kind
let ISS = [], CONN = [];
let TAB = 'overview', CUR = null, SKCUR = null;
const SORT = {};
let FIL = {status:'', rules:'', q:'', review:false, sev:'', cat:''};

const KINDS = {
  pf:{n:'PoleForeman reports', need:true}, station:{n:'Station Details & Job Instructions', need:true}, ifc:{n:'IFC package (not checked)'}, design:{n:'Design summary'}, sketch:{n:'Job sketch', need:true}, permitsketch:{n:'Permit sketch'}, mapreq:{n:'Mapping request'},
  wo:{n:'Work Order Details', need:true}, jobcost:{n:'Job Cost Summary'}, costdist:{n:'Cost Distribution Summary'}, labor:{n:'Labor Summary'}, material:{n:'Material Summary'},
  t811:{n:'811 ticket'}, njuns:{n:'NJUNS ticket'}, dco:{n:'DCO form'}, vd:{n:'Voltage drop / flicker worksheet'}, jacket:{n:'Job jacket'}, deviceid:{n:'Device ID generator'}, inspection:{n:'Inspection sheet'}, scopeimg:{n:'Scope image'}, env:{n:'Environmental Checklist'}, jha:{n:'Job Hazard Analysis'}, photos:{n:'Photos'}, vicinity:{n:'Vicinity map'}, unknown:{n:'Not recognized'}
};

/* ---------- pdf helpers ---------- */
const PDFC = new Map();
async function pdfOf(doc){ if (PDFC.has(doc.id)) return PDFC.get(doc.id); const p = pdfjsLib.getDocument({data:new Uint8Array(doc.bytes.slice(0))}).promise; PDFC.set(doc.id, p); return p; }
async function renderPage(pdf, n, scale){ const p=await pdf.getPage(n), vp=p.getViewport({scale}); const cv=document.createElement('canvas'); cv.width=Math.ceil(vp.width); cv.height=Math.ceil(vp.height); const ctx=cv.getContext('2d',{willReadFrequently:true}); ctx.fillStyle='#fff'; ctx.fillRect(0,0,cv.width,cv.height); await p.render({canvasContext:ctx, viewport:vp}).promise; return cv; }
const cropCanvas = (cv,fx0,fy0,fx1,fy1) => { const W=cv.width,H=cv.height; const c2=document.createElement('canvas'); c2.width=Math.round((fx1-fx0)*W); c2.height=Math.round((fy1-fy0)*H); c2.getContext('2d').drawImage(cv, fx0*W, fy0*H, c2.width, c2.height, 0,0,c2.width,c2.height); return c2; };
async function textPages(pdf, onStep){
  const pages = [];
  for (let i=1;i<=pdf.numPages;i++){
    onStep && onStep(`Reading page ${i} of ${pdf.numPages}`);
    const p=await pdf.getPage(i); const vp=p.getViewport({scale:1});
    const tc=await p.getTextContent();
    let annots=[]; try { annots=(await p.getAnnotations()).filter(a=>(a.contentsObj&&a.contentsObj.str)||(typeof a.fieldValue==='string'&&a.fieldValue)).map(a=>{ const t=pdfjsLib.Util.transform(vp.transform,[1,0,0,1,a.rect[0],a.rect[3]]); return {text:String(a.fieldValue||a.contentsObj.str), x:t[4], y:t[5]+(a.rect[3]-a.rect[1])*0.7, x0:t[4], y0:t[5], x1:t[4]+(a.rect[2]-a.rect[0]), y1:t[5]+(a.rect[3]-a.rect[1])}; }); } catch(e){}
    pages.push({pageNo:i, lines:pfPageLines(tc.items, vp.transform, pdfjsLib.Util.transform), annots, w:vp.width, h:vp.height});
  }
  return pages;
}

/* ---------- PoleForeman status icons ---------- */
function classifyIcon(ctx, x, y, sc){
  const x0=Math.max(0,Math.round((x-17)*sc)), y0=Math.max(0,Math.round((y-13)*sc)), w=Math.round(16*sc), h=Math.round(15*sc);
  let d; try { d = ctx.getImageData(x0,y0,w,h).data; } catch(e){ return ''; }
  let g=0,a=0,r=0;
  for (let i=0;i<d.length;i+=4){ const R=d[i],G=d[i+1],B=d[i+2];
    if (G>120 && G>R+30 && G>B+20) g++; else if (R>200 && G>120 && G<225 && B<110) a++; else if (R>170 && G<110 && B<110) r++; }
  const mx=Math.max(g,a,r); if (mx<6) return '';
  return mx===r?'fail':mx===a?'warn':'pass';
}
async function pfRecords(pdf, pages, docId, fileName, onStep){
  const segs = pfSplit(pages), out = [];
  for (const seg of segs){
    const R = pfParse(seg.pages);
    if (!R.ruleOrder.length) continue;
    const imgPage = R.summaryPage || (R.rules[R.ruleOrder[0]]||{}).firstPage || seg.pages[0].pageNo;
    const need = [...new Set([imgPage, ...R.statusTargets.map(t=>t.page)])];
    const pf = {}, img = {}; const sc = 2;
    for (const pn of need){
      onStep && onStep(`${R.label||'Report'}: checking status icons, page ${pn}`);
      const cv = await renderPage(pdf, pn, sc); const ctx = cv.getContext('2d',{willReadFrequently:true});
      R.statusTargets.filter(t=>t.page===pn).forEach(t=>{ const c=classifyIcon(ctx,t.x,t.y,sc); if (c) pf[t.key]=c; });
      if (pn===imgPage){ img.d3 = cropCanvas(cv,0.422,0.394,0.99,0.744).toDataURL('image/jpeg',0.85); img.polar = cropCanvas(cv,0.055,0.35,0.405,0.86).toDataURL('image/jpeg',0.8); }
    }
    delete R.statusTargets;
    out.push({ id: R.label || (seg.footer&&(seg.footer.match(/^([A-Za-z]*\d+)/)||[])[1]) || seg.footer || fileName, fileName: seg.footer || fileName, docId, pageNos: seg.pages.map(p=>p.pageNo), R, pf, img });
  }
  return out;
}

/* ---------- reading a file ---------- */
async function readImage(file){ const url = await new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(file); }); const req = /mapping.?request|permit.?request/i.test(file.name.replace(/_/g,' ')); return { id:'d'+Date.now().toString(36)+Math.random().toString(36).slice(2,7), name:file.name, kind:req?'mapreq':'scopeimg', pages:1, added:Date.now(), bytes:null, data: req ? { img:url, permit:permitOf(file.name) } : { img:url } }; }
async function readDoc(file, onStep){
  if (!window.pdfjsLib) throw new Error('The PDF reader library did not load. Check your connection and reload.');
  const bytes = await file.arrayBuffer();
  const id = 'd'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
  const rec = { id, name:file.name, bytes, added:Date.now() };
  const pdf = await pdfjsLib.getDocument({data:new Uint8Array(bytes.slice(0))}).promise; PDFC.set(id, Promise.resolve(pdf));
  const pages = await textPages(pdf, onStep);
  rec.pages = pages.length;
  rec.kind = docClassify(pages, file.name);
  const K = rec.kind;
  onStep && onStep(`Reading ${KINDS[K].n.toLowerCase()}`);
  if (K==='pf') { rec.data = { poles: await pfRecords(pdf, pages, id, file.name, onStep) }; if (!rec.data.poles.length) throw new Error('No PoleForeman analyses found in this file.'); }
  else if (K==='station') rec.data = parseStation(pages);
  else if (K==='wo') rec.data = parseWO(pages);
  else if (K==='ifc') { const I = parseIFC(pages); delete I.stationPages; if (I.sketchPage){ I.sketch = parseSketch(pages, I.sketchPages); I.sketchImg = await sketchImage(pdf, I.sketch); } rec.data = I; }
  else if (K==='sketch' || K==='permitsketch') { const K2 = parseSketch(pages); rec.data = { sketch:K2, sketchImg: await sketchImage(pdf, K2) }; if (K==='permitsketch') rec.data.permit = permitOf(file.name); }
  else if (K==='design') { rec.data = parseIFC(pages); delete rec.data.stationPages; }
  else if (K==='mapreq') { const p=pages[0], ls=pages.flatMap((p,i)=>p.lines.flatMap(l=>l.cells.map((c,j)=>({text:c, x0:l.xs[j], x1:(l.xe||[])[j]??l.xs[j]+c.length*5, y0:l.y-9+i*2000, y1:l.y+1+i*2000})))); rec.data = { req: parseMapReq(ls, p.w), permit: permitOf(file.name) }; }
  else if (K==='jobcost') rec.data = parseJobCost(pages);
  else if (K==='costdist') rec.data = parseCostDist(pages);
  else if (K==='labor') rec.data = parseLabor(pages);
  else if (K==='material') rec.data = parseMaterial(pages);
  else if (K==='t811') rec.data = parse811(pages);
  else if (K==='njuns') rec.data = parseNJUNS(pages);
  else if (K==='env') rec.data = parseEnv(pages);
  else if (K==='jha') rec.data = parseJHA(pages);
  else if (K==='inspection') { const ps=[]; for (let i=1;i<=pdf.numPages;i++){ const cv=await renderPage(pdf,i,1.2); const t=pages[i-1].lines.map(l=>l.text).join('\n'); ps.push({page:i, img:cv.toDataURL('image/jpeg',0.75), text:t}); } rec.data = {pages:ps}; }
  else if (K==='dco') rec.data = parseDCO(pages);
  else if (K==='vd') rec.data = parseVD(pages, file.name);
  else if (K==='deviceid') rec.data = parseDeviceIDs(pages);
  else if (K==='jacket') { rec.data = parseJacket(pages); const cv=await renderPage(pdf,1,1.4); rec.data.img = cv.toDataURL('image/jpeg',0.8); }
  else if (K==='photos') { const lbl = parsePhotoText(pages); const ps=[]; for (let i=1;i<=pdf.numPages;i++){ onStep&&onStep(`Photo ${i} of ${pdf.numPages}`); const cv=await renderPage(pdf,i,1.1); const o={page:i, img:cv.toDataURL('image/jpeg',0.72)}; if (lbl[i-1] && lbl[i-1].id) o.ocr = lbl[i-1]; ps.push(o); } rec.data = {pages:ps}; }
  else if (K==='vicinity') { const cv=await renderPage(pdf,1,1.6); rec.data = {img:cv.toDataURL('image/jpeg',0.8)}; }
  else rec.data = {};
  return rec;
}
const SKS = 2.4; // sketch image scale
const skPagesOf = K => K.pages || [{ page: K.page, x0: 0, y0: 0 }];
// every sketch page drawn onto one image, laid out as parseSketch stacked them
async function sketchImage(pdf, K){
  const sc = Math.min(SKS, 16000 / Math.max(K.w, K.h)); // stay inside browser canvas limits on long sketches
  const cv = document.createElement('canvas'); cv.width = Math.ceil(K.w * sc); cv.height = Math.ceil(K.h * sc);
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  for (const pg of skPagesOf(K)) ctx.drawImage(await renderPage(pdf, pg.page, sc), Math.round(pg.x0 * sc), Math.round(pg.y0 * sc));
  return { src: cv.toDataURL('image/jpeg', 0.86), w: cv.width, h: cv.height, scale: sc };
}
// sketches saved before multi-page support: read again from the stored PDF
async function upgradeSketches(docs){
  for (const d of docs){ const K = d.kind==='sketch' ? d.data.sketch : d.kind==='ifc' ? d.data.sketch : null;
    if (!K || K.pages || !d.bytes) continue;
    try { const pdf = await pdfOf(d), pages = await textPages(pdf);
      const nos = d.kind==='sketch' ? sketchPageNos(pages, true) : sketchPageNos(pages);
      if (nos.length < 2) { K.pages = skPagesOf(K); dbPut(d); continue; }
      const K2 = parseSketch(pages, nos), img = await sketchImage(pdf, K2);
      if (d.kind==='sketch') d.data = { sketch:K2, sketchImg:img }; else { d.data.sketch = K2; d.data.sketchImg = img; d.data.sketchPages = nos; delete d.data.ocr; }
      dbPut(d);
    } catch(e){ console.error(e); } } }

async function handleFiles(files){
  files=[...files].filter(Boolean); if(!files.length) return;
  $('#empty').hidden=false; $('#app').hidden=true; $('#fileList').innerHTML='';
  let ok=0; const bad=[];
  for (const f of files.sort((a,b)=>natural(a.name,b.name))){
    const li=document.createElement('li'); li.innerHTML=`<span>${esc(f.name)}</span><span>Waiting</span>`; $('#fileList').appendChild(li); const st=li.lastChild;
    if (/\.xlsx$/i.test(f.name)){ st.textContent='Checking spreadsheet…'; let ok=false, what=''; const bytes = await f.arrayBuffer(); try { const W = await scOpen(bytes.slice(0)); if (W.sheets['Design Scorecard']) { ok = await saveTemplate(f); what='Scorecard template saved'; } else { ok = await saveCUList(bytes, f.name); what='Compatible unit list saved'; } } catch(e){} st.textContent = ok ? what : 'Not a scorecard template or CU list'; st.className = ok ? 'g' : 'e'; continue; }
    if (/\.(png|jpe?g|webp)$/i.test(f.name)){ const rec = await readImage(f); const dup = DOCS.findIndex(d=>d.name===rec.name); if (dup>=0){ dbDel(DOCS[dup].id); DOCS.splice(dup,1); } DOCS.push(rec); dbPut(rec); st.textContent=KINDS[rec.kind].n; st.className='g'; ok++; continue; }
    if (!/\.pdf$/i.test(f.name)){ st.textContent='Not a PDF'; st.className='e'; bad.push(f.name); continue; }
    try {
      const rec = await readDoc(f, s=>st.textContent=s);
      // a newer copy of the same single-instance document replaces the old one
      const single = !MULTI.includes(rec.kind);
      const dup = DOCS.findIndex(d => d.name===rec.name || (single && d.kind===rec.kind));
      if (dup>=0){ dbDel(DOCS[dup].id); PDFC.delete(DOCS[dup].id); DOCS.splice(dup,1); }
      DOCS.push(rec); dbPut(rec);
      st.textContent = rec.kind==='pf' ? `PoleForeman: ${rec.data.poles.map(p=>p.id).join(', ')}` : KINDS[rec.kind].n;
      st.className = rec.kind==='unknown' ? 'e' : 'g'; ok++;
    } catch(e){ console.error(e); st.textContent=e.message||'Could not read'; st.className='e'; bad.push(f.name); }
  }
  if (DOCS.length && ok){ rebuild(); toast(bad.length?`${ok} read. ${bad.length} skipped: ${bad.join(', ')}`:`Read ${ok} document${ok===1?'':'s'}`); queueOCR(); }
}
const drop=$('#drop');
$('#pick').onclick=()=>$('#file').click(); $('#addMore').onclick=()=>$('#file').click();
$('#file').setAttribute('accept','application/pdf,.pdf,.xlsx,.png,.jpg,.jpeg,.webp'); $('#file').onchange=e=>{ const fs=[...e.target.files]; e.target.value=''; handleFiles(fs); };
['dragenter','dragover'].forEach(ev=>document.addEventListener(ev,e=>{e.preventDefault(); drop.classList.add('over');}));
['dragleave','drop'].forEach(ev=>document.addEventListener(ev,e=>{e.preventDefault(); if(ev==='drop'||e.target===document.documentElement) drop.classList.remove('over');}));
document.addEventListener('drop',e=>{ const fs=e.dataTransfer?.files; if(fs&&fs.length) handleFiles(fs); });
$('#clearAll').onclick=async()=>{ if(!confirm('Remove every loaded document and start a new package?')) return; for (const d of DOCS) await dbDel(d.id); DOCS=[]; POLES=[]; STN=[]; CUR=null; PDFC.clear(); $('#empty').hidden=false; $('#app').hidden=true; $('#addMore').hidden=$('#clearAll').hidden=true; $('#fileList').innerHTML=''; };
dbAll().then(recs=>{ recs = recs.filter(r=>r.id!=='__scoretpl'); if (recs.length){ const b=$('#restore'); b.hidden=false; b.textContent=`Reopen last package (${recs.length} document${recs.length>1?'s':''})`; b.onclick=async()=>{ DOCS=recs.sort((a,b)=>a.added-b.added); await upgradeSketches(DOCS); rebuild(); queueOCR(); }; } });
$('#themeBtn').onclick=()=>{ const cur=document.documentElement.dataset.theme||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'); const n=cur==='dark'?'light':'dark'; document.documentElement.dataset.theme=n; try{localStorage.setItem('pfqc:theme',n);}catch(e){} };
try{ const t=localStorage.getItem('pfqc:theme'); if(t) document.documentElement.dataset.theme=t; }catch(e){}

/* ---------- original PDFs and Excel ---------- */
function openOriginal(docId, page){ const d=DOCS.find(x=>x.id===docId); if(!d) return; const url=URL.createObjectURL(new Blob([d.bytes],{type:'application/pdf'})); const w=window.open(url+(page?`#page=${page}`:''),'_blank'); if(!w){ const a=document.createElement('a'); a.href=url; a.download=d.name; a.click(); } setTimeout(()=>URL.revokeObjectURL(url), 120000); }
let XLSXP=null; function xlsxLib(){ if (window.XLSX) return Promise.resolve(window.XLSX); if (!XLSXP) XLSXP = loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js').then(()=>window.XLSX); return XLSXP; }

/* ---------- text reading (OCR) for the sketch, photos and vicinity map ---------- */
let TESS = null, OCRBUSY = false;
function loadScript(src){ return new Promise((res,rej)=>{ const s=document.createElement('script'); s.src=src; s.onload=res; s.onerror=()=>rej(new Error('Could not load the text reader from '+new URL(src).host)); document.head.appendChild(s); }); }
async function tess(onP){
  if (TESS) return TESS;
  if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  TESS = await Tesseract.createWorker('eng', 1, { logger: m => { if (m.status==='recognizing text' && onP) onP(m.progress); } });
  await TESS.setParameters({ tessedit_pageseg_mode: '11' });
  return TESS;
}
let ocrP = null;
// a form screenshot enlarged and turned to dark text on white (email confirmations are often white-on-dark)
async function formCanvas(src){
  const im = new Image(); im.src = src; await im.decode();
  const sc = Math.max(1, Math.min(3, 1600 / im.width)), cv = document.createElement('canvas'); cv.width = Math.round(im.width*sc); cv.height = Math.round(im.height*sc);
  const ctx = cv.getContext('2d', {willReadFrequently:true}); ctx.drawImage(im, 0, 0, cv.width, cv.height);
  const id = ctx.getImageData(0, 0, cv.width, cv.height), a = id.data; let sum = 0;
  for (let i=0;i<a.length;i+=4){ a[i] = a[i]*.3 + a[i+1]*.59 + a[i+2]*.11; sum += a[i]; }
  const dark = sum/(a.length/4) < 128;
  for (let i=0;i<a.length;i+=4){ const g = dark ? 255-a[i] : a[i]; a[i]=a[i+1]=a[i+2]=g; }
  ctx.putImageData(id, 0, 0); return cv;
}
async function ocrTSV(cv){ const w = await tess(p=>ocrP&&ocrP(p)); const r = await w.recognize(cv, {}, {tsv:true, text:false, blocks:false, hocr:false}); return r.data.tsv || ''; }
function ocrStatus(t){ const el=$('#ocrState'); if(!el) return; el.hidden=!t; el.textContent=t||''; }
function needsOCR(){ return DOCS.filter(d => (d.kind==='mapreq' && d.data.img && !d.data.ocr) || ((d.kind==='sketch' || d.kind==='permitsketch') &&!d.data.ocr && (d.data.sketch.callouts||[]).filter(c=>c.dloc).length < Math.max(1,(d.data.sketch.labels||[]).length)) || (d.kind==='ifc' && d.data.sketchPage && !d.data.ocr && (d.data.sketch?.callouts||[]).filter(c=>c.dloc).length < Math.max(1,(d.data.sketch?.labels||[]).length) && !DOCS.some(x=>x.kind==='sketch')) || (d.kind==='photos' && d.data.pages.some(p=>!p.ocr)) || (d.kind==='vicinity' && !d.data.ocr) || (d.kind==='jacket' && !d.data.ocr)); }
function queueOCR(force){ if (!force && !S.ocrAuto) return; runOCR(); }
async function runOCR(){
  if (OCRBUSY) return; const todo = needsOCR(); if (!todo.length) { toast('All text has been read'); return; }
  OCRBUSY = true;
  try {
    for (const d of todo){
      const pdf = d.bytes ? await pdfOf(d) : null;
      if (d.kind==='mapreq'){
        ocrStatus('Reading mapping request…'); ocrP = p=>ocrStatus(`Reading mapping request ${Math.round(p*100)}%`);
        const cv = await formCanvas(d.data.img); d.data.ocr = parseMapReq(tsvLines(await ocrTSV(cv)), cv.width);
        dbPut(d); rebuild(); continue;
      }
      if (d.kind==='sketch' || d.kind==='ifc' || d.kind==='permitsketch'){
        const pgs = skPagesOf(d.data.sketch); const sc = 3.5; const lines = [];
        for (const [i, pg] of pgs.entries()){
          const of = pgs.length>1 ? ` (page ${i+1} of ${pgs.length})` : '';
          ocrStatus(`Reading sketch text${of}…`); ocrP = p=>ocrStatus(`Reading sketch text${of} ${Math.round(p*100)}%`);
          const cv = await renderPage(pdf, pg.page, sc), dx = pg.x0*sc, dy = pg.y0*sc;
          tsvLines(await ocrTSV(cv)).forEach(l => lines.push({ ...l, x0:l.x0+dx, x1:l.x1+dx, y0:l.y0+dy, y1:l.y1+dy }));
        }
        d.data.ocr = { scale: sc, callouts: ocrCallouts(lines), lines: lines.map(l=>({t:l.text, x0:l.x0, y0:l.y0, x1:l.x1, y1:l.y1})) };
      } else if (d.kind==='photos'){
        for (const pg of d.data.pages){ if (pg.ocr) continue; ocrStatus(`Reading photo label ${pg.page} of ${d.data.pages.length}`); ocrP=null;
          const cv = await renderPage(pdf, pg.page, 3.5); const lines = tsvLines(await ocrTSV(cropCanvas(cv,0,0,0.42,0.15))); pg.ocr = ocrLabelBlock(lines); }
      } else if (d.kind==='jacket'){
        ocrStatus('Reading job jacket…'); ocrP = p=>ocrStatus(`Reading job jacket ${Math.round(p*100)}%`);
        const cv = await renderPage(pdf, 1, 3); const lines = tsvLines(await ocrTSV(cv));
        d.data.ocr = { ...parseJacketOCR(lines), callouts: ocrCallouts(lines) };
      } else if (d.kind==='vicinity'){
        ocrStatus('Reading vicinity map labels…'); ocrP = p=>ocrStatus(`Reading vicinity map ${Math.round(p*100)}%`);
        const cv = await renderPage(pdf, 1, 2.6); const lines = tsvLines(await ocrTSV(cv));
        const ids = [...new Set(lines.map(l=>(l.text.replace(/\bP\s?[O0o]\s?([0-9SsIlOo])\b/g,(m,x)=>'P0'+({S:'5',s:'5',I:'1',l:'1',O:'0',o:'0'}[x]||x)).match(/\bP\d{2,3}\b/g)||[])).flat())];
        d.data.ocr = { ids, callouts: ocrCallouts(lines) };
      }
      dbPut(d); rebuild();
    }
    ocrStatus(''); toast('Finished reading sketch and photo text');
  } catch(e){ console.error(e); ocrStatus(''); toast(e.message || 'Text reading failed'); }
  OCRBUSY = false;
}


/* ---------- derived values ---------- */
const specOf = s => { const m=String(s||'').match(/^(\d+)\s*\/\s*([A-Z]?\d+|H\d+)/i); return m?{len:+m[1], cls:m[2].toUpperCase(), c:m[2].toUpperCase().replace(/^C/,'')}:{len:null,cls:'',c:''}; };
function metrics(r){
  const ph = r.spans.flatMap(s=>s.wires.flatMap(w=>w.phases.map(p=>({...p, span:s.n, kind:w.kind}))));
  const mx = (arr) => arr.filter(x=>x!=null).reduce((a,b)=>Math.max(a,b), -Infinity);
  const fr = mx(ph.flatMap(p=>[p.bracketLoad,p.supportLoad,p.insLoad]));
  const gw = r.anchors.flatMap(a=>a.wires.flatMap(w=>[w.load,w.insLoad])).concat((r.spanGuys||[]).flatMap(g=>g.wires.flatMap(w=>[w.load,w.nearLoad,w.farLoad])));
  const an = r.anchors.flatMap(a=>a.anchor?[a.anchor.load,a.anchor.rodLoad]:[]);
  const g = gw.filter(x=>x!=null);
  return { horz:r.head.horz, vert:r.head.vert, framing: fr===-Infinity?null:fr, guy: g.length?mx(g):null, anchor: an.length?mx(an):null };
}
const TH = k => k==='pole' ? [S.poleWarn, S.poleFail] : [S.eqWarn, S.eqFail];
const lv = (p, k) => { if (p==null) return ''; const [w,f]=TH(k); return p>f ? 'bad' : p>w ? 'warn' : ''; };
const pctHtml = (p, k) => p==null ? '<span class="muted">–</span>' : `<span class="pct ${lv(p,k)}">${f0(p)}%</span>`;
const meter = (p, c, k) => p==null ? '<span class="muted">–</span>' : `<div class="meter"><div class="tr"><i class="${lv(p,k)||c||''}" style="width:${Math.min(p,100)}%"></i></div><span class="pct ${lv(p,k)}">${f0(p)}%</span></div>`;
const baseRule = R => R ? (R.rules['250B']||R.rules[R.ruleOrder[0]]) : null;

/* ---------- geometry ---------- */
const distFt = (a,b,c,d) => (a==null||b==null||c==null||d==null) ? null : Math.hypot((c-a)*364000, (d-b)*364000*Math.cos(a*Math.PI/180));
const offsetLL = (lat,lon,ft,brg) => ({ lat: lat + ft*Math.cos(brg*Math.PI/180)/364000, lon: lon + ft*Math.sin(brg*Math.PI/180)/(364000*Math.cos(lat*Math.PI/180)) });
const compassOf = b => ['N','NE','E','SE','S','SW','W','NW'][Math.round(((b%360)+360)%360/45)%8];
const angd = (a,b) => { const d=Math.abs(((a-b)%360+360)%360); return d>180?360-d:d; };

/* ---------- CU vocabulary ---------- */
const CU = {
  pole: c => /^WP\d/i.test(c.cu) || /^POLE,/i.test(c.desc),
  poleHC: c => { if(!c) return null; let m=c.cu.match(/WP(\d+)-(\d+)/i)||c.desc.match(/(\d+)\s*FT\s*CL(?:ASS)?\s*(\d+)/i); return m?{h:+m[1], c:String(+m[2])}:null; },
  ag: c => /^(AG|GUYDN|GUYSP|DG)\d/i.test(c.cu) || /^AG,|DOWN GUY|SPAN GUY|GUY ASSY/i.test(cuDesc(c)),
  agSize: c => (c.desc.match(/(\d+\/\d+)"/)||[])[1]||null,
  agHelix: c => ({S:'single',D:'double',T:'triple'})[(c.desc.match(/\b([SDT])\s*HELIX/i)||[])[1]]||null,
  gsi: c => /^GSI/i.test(c.cu) || /GUY STRAIN/i.test(c.desc),
  gsiLen: c => pfNum((c.cu.match(/GSI(\d+)/i)||[])[1] || (c.desc.match(/(\d+)"/)||[])[1]),
  hendrix: c => /HENDRIX/i.test(c.cu+' '+c.desc),
  xfmr: c => CUDB && cuRec(c) ? eqClass(c)==='transformer' : (/KVA/i.test(c.desc) && /^T\d|TRANSF|XFMR|INST/i.test(c.cu+' '+c.desc)),
  kva: c => pfNum((c.desc.match(/(\d+(?:\.\d+)?)\s*KVA/i)||[])[1]),
  light: c => CUDB && cuRec(c) ? eqClass(c)==='light' : (/LIGHT|LUMINAIRE/i.test(c.desc) || /^PL/i.test(c.cu)),
  riser: c => CUDB && cuRec(c) ? eqClass(c)==='riser' : /RISER/i.test(c.cu+' '+c.desc),
  straighten: c => /STRAIGHTEN/i.test(c.cu+' '+c.desc),
  primFrame: c => /^P[0-9X][0-9A-Z]*A\d+/i.test(c.cu) && !/^PGW|^PL/i.test(c.cu),
  framePrefix: s => (String(s).match(/^(P[0-9A-Z]*?\d+)A\d+/i)||[])[1] || null,
};
const WFN = {I:'install', R:'remove', T:'transfer'};
const RE = {
  repl: /\b(replace|change\s*out|change)\s+(?:the\s+)?(?:existing\s+)?(?:broken\s+|damaged\s+|rotten\s+)?pole\b(?!\s*(?:ground|guy|tag|top|attach|fram|number|#|riser|step|band|key|line|light))|\bset\s+(?:a\s+)?new\s+pole\b|\bwith\s+WP\d|\bpole\s+to\s+WP\d/i,
  guyNew: /\b(install|replace|add)\b[^.]*?(down\s*guy|\bDG\b|guy\s*wire)/i,
  guyAny: /down\s*guy|\bDG\b|guy\s*wire/i,
  gsi: /\bGSI\b|guy\s*strain/i, hendrix: /hendrix/i, xfmr: /transformer|xfmr|\bkva\b/i, light: /\blight\b|luminaire/i,
  riser: /\briser\b/i, straighten: /straighten|plumb\b/i, truck: /inaccessib/i,
};
const sentencesOf = t => String(t||'').replace(/\s+/g,' ').split(/(?<=\.)\s+/).filter(Boolean);
const pick = (t, re) => sentencesOf(t).filter(s=>re.test(s)).join(' ');
const clauses = t => String(t||'').replace(/\s+/g,' ').split(/[.;]\s*|,\s*(?=(?:and\s+)?(?:install|replace|transfer|add|remove|relocate)\b)/i).filter(Boolean);
const pickClause = (t, re) => clauses(t).filter(s=>re.test(s)).join('. ');
function guyNums(t){
  if (!t) return {};
  const lead = t.match(/\bLL\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*(?:ft|'|feet)?|lead\s*(?:length)?\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*(?:ft|'|feet)|(\d+(?:\.\d+)?)\s*(?:ft|'|feet)\s*(?:LL|lead)/i);
  const deg = t.match(/(\d{1,3}(?:\.\d+)?)\s*(?:°|deg(?:rees?)?\b)/i);
  const att = t.match(/attach(?:ment)?\s*(?:height|ht)?\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*(?:in\b|")|(\d+(?:\.\d+)?)\s*(?:in\b|")\s*attach/i);
  const sizes = [...t.matchAll(/(\d+\/\d+)\s*(?:in\b|"|”)/g)].map(m=>m[1]);
  const comp = t.match(/\b(NE|NW|SE|SW|N|S|E|W)\b(?=\s*,|\s+\d)/);
  return { lead: lead?pfNum(lead[1]||lead[2]||lead[3]):null, deg: deg?pfNum(deg[1]):null, att: att?pfNum(att[1]||att[2]):null, size: sizes.length?sizes[sizes.length-1]:null, compass: comp?comp[1]:null };
}
function poleFromText(t){ if(!t) return null;
  const m = t.match(/\b(\d{2})\s*(?:ft\.?|'|foot|feet)?\s*(?:wood(?:en)?\s+)?(?:pole\s*)?,?\s*(?:class|cl\.?|c)\s*-?\s*(\d)\b/i)
    || t.match(/\b(\d{2})\s*(?:ft|')?\s*[-\/]\s*C?(\d)\b(?!\s*(?:kva|in|"|°|deg))/i) || t.match(/WP(\d+)-(\d+)/i);
  return m && +m[1]>=25 && +m[1]<=120 ? {h:+m[1], c:String(+m[2])} : null; }
const attachIn = t => pfNum((String(t||'').match(/attach\w*\s*(?:height\s*)?(?:of\s*)?(\d+)\s*(?:in\b|")/i)||[])[1]);

/* ---------- sketch source ---------- */
function sketchSrc(){
  if (PKG.sketch) return { K:PKG.sketch.data.sketch, img:PKG.sketch.data.sketchImg, ocr:PKG.sketch.data.ocr, doc:PKG.sketch };
  if (PKG.ifc && PKG.ifc.data.sketch) return { K:PKG.ifc.data.sketch, img:PKG.ifc.data.sketchImg, ocr:PKG.ifc.data.ocr, doc:PKG.ifc };
  return null;
}
let SK = null, ST = null, WO = null, JK = null;
/* sketch callouts: read from the PDF text / text boxes when present, otherwise from the image */
function skCO(){ if (!SK) return null; const t = (SK.K.callouts || []).filter(c=>c.dloc || c.lat); if (SK.ocr && SK.ocr.callouts.length > t.length) return SK.ocr; if (t.length) return { scale:1, callouts:t, lines:SK.K.textLines||[], text:true }; return SK.ocr || null; }
// PL01, P1, P-01, POLE 1 and 01 all mean pole P01
const nkey = s => { const t=String(s||'').toUpperCase().replace(/[\s_\-.#]+/g,''); const m=t.match(/^(?:P|PL|PO|POL|POLE|STA|STN|STATION)?0*(\d{1,4})([A-Z]?)$/); return m ? 'P'+(+m[1])+m[2] : t; };
const canon = s => { const k=nkey(s); const m=k.match(/^P(\d+)([A-Z]?)$/); return m ? 'P'+m[1].padStart(2,'0')+m[2] : String(s); };

/* ---------- tie everything to each pole ---------- */
const MULTI = ['t811','njuns','pf','unknown','dco','vd','deviceid','jacket','permitsketch','mapreq'];
function rebuild(){
  computeWO();
  PKG = {}; DOCS.forEach(d=>{ if (MULTI.includes(d.kind)) (PKG[d.kind]=PKG[d.kind]||[]).push(d); else if (!PKG[d.kind] || PKG[d.kind].foreign || !d.foreign) PKG[d.kind]=d; });
  // a standalone design summary is the same table as the IFC package's: it stands in when there's no IFC, and is compared with it otherwise
  if (PKG.design && !PKG.ifc) PKG.ifc = PKG.design;
  JK = (PKG.jacket||[]).find(d=>!d.foreign) || null;
  POLES=[]; const dupPF=[];
  (PKG.pf||[]).forEach(d=>d.data.poles.forEach(r=>{ const i=POLES.findIndex(p=>p.id===r.id); if(i>=0){ dupPF.push(r.id); POLES[i]=r; } else POLES.push(r); }));
  POLES.sort((a,b)=>natural(a.id,b.id));
  SK = sketchSrc(); ST = PKG.station ? PKG.station.data : (PKG.ifc && PKG.ifc.data.station) || null; WO = PKG.wo ? PKG.wo.data : null;
  buildStations();
  runChecks(dupPF);
  if (!CUR || !STN.find(s=>s.id===CUR)) CUR = STN[0]?.id;
  if (!SKCUR || !STN.find(s=>s.id===SKCUR)) SKCUR = STN[0]?.id;
  $('#empty').hidden=true; $('#app').hidden=false; $('#addMore').hidden=$('#clearAll').hidden=false;
  const title = WO?.meta.title || SK?.K.fields.title || PKG.env?.data.meta.name || '';
  const wo = DOMWO || WO?.meta.wo || SK?.K.fields.wo || PKG.ifc?.data.meta.maximo || ST?.meta.wo || '';
  $('#hTitle').textContent = wo ? `WO ${wo}` : `${STN.length} poles`;
  $('#hSub').textContent = [title, `${STN.length} pole${STN.length===1?'':'s'}`, `${DOCS.length} document${DOCS.length===1?'':'s'}`].filter(Boolean).join(' · ');
  renderKpis(); render();
}
function buildStations(){
  const map = new Map(), order = [];
  const get = id => { const k=nkey(id); if (!map.has(k)) { map.set(k, {id:canon(id), key:k, src:{}}); order.push(k); } return map.get(k); };
  (ST?.order||[]).forEach(get); (WO?.noteOrder||[]).forEach(get); (PKG.ifc?.data.order||[]).forEach(get);
  const ifcSt = PKG.station && PKG.ifc?.data.station;
  STN = [];
  const byKey = (obj) => { const o={}; Object.keys(obj||{}).forEach(k=>{ o[nkey(k)]=obj[k]; }); return o; };
  const stK=byKey(ST?.stations), siK=byKey(ifcSt?.stations), woK=byKey(WO?.notes), ifK=byKey(PKG.ifc?.data.rows);
  map.forEach(s=>{ s.st = stK[s.key] || null; s.stIfc = ifcSt ? siK[s.key]||null : null; s.wo = woK[s.key]||null; s.ifc = ifK[s.key]||null; });
  // PoleForeman: matched by label only (PoleForeman coordinates aren't reliable)
  POLES.forEach(P=>{ const s=map.get(nkey(P.id)); if (s && !s.pf) s.pf=P; else { const n=get(P.id); if (!n.pf) n.pf=P; } });
  (SK?.K.labels||[]).forEach(l=>{ const s=map.get(nkey(l.id)) || get(l.id); s.skLabel=l; });
  map.forEach(s=>{ s.names=[]; if (ST) Object.keys(ST.stations).forEach(k=>{ if(nkey(k)===s.key) s.names.push(['station details',k]); }); if (WO?.notes) Object.keys(WO.notes).forEach(k=>{ if(nkey(k)===s.key && !WO.notes[k].heading) s.names.push(['WO notes',k]); }); if (PKG.ifc) Object.keys(PKG.ifc.data.rows).forEach(k=>{ if(nkey(k)===s.key) s.names.push(['IFC design table',k]); }); if (s.pf) s.names.push(['PoleForeman report',s.pf.id]); if (s.skLabel) s.names.push(['job sketch',s.skLabel.id]); });
  (skCO()?.callouts||[]).forEach(c=>{ let s = c.id && map.get(nkey(c.id)); if (!s) s=[...map.values()].find(x=>(x.wo?.dloc||x.ifc?.dloc)===c.dloc); if (s) s.sk=c; });
  map.forEach(s=>{ const L=s.skLabel; if (!L?.alts || !s.sk) return; const k=1/skCO().scale, b=s.sk.box, cx=(b.x0+b.x1)/2*k, cy=(b.y0+b.y1)/2*k;
    const n=L.alts.reduce((a,p)=>Math.hypot(p.x-cx,p.y-cy)<Math.hypot(a.x-cx,a.y-cy)?p:a); s.skLabel={...L, x:n.x, y:n.y}; });
  const all = order.map(k=>map.get(k));
  // photos
  const ph = PKG.photos?.data.pages||[];
  ph.forEach(p=>{ const o=p.ocr; let s = o && o.id && map.get(nkey(o.id)); if (!s && o && o.dloc) s=all.find(x=>(x.wo?.dloc||x.ifc?.dloc)===o.dloc); if (s){ (s.phs=s.phs||[]).push(p); if (!s.ph) s.ph=p; } });
  if (ph.length && !ph.some(p=>p.ocr && p.ocr.id)) { const main = all.filter(s=>s.st||s.wo||s.ifc); if (ph.length===main.length) main.forEach((s,i)=>{ if(!s.ph){ s.ph=ph[i]; s.phByOrder=true; } }); }
  // NJUNS assets
  (PKG.njuns||[]).forEach(d=>d.data.assets.forEach(a=>{ let s=all.find(x=>(x.wo?.dloc||x.ifc?.dloc)===a.pole); if(!s) s=all.find(x=>{ const dd=distFt(x.wo?.lat??x.ifc?.lat, x.wo?.lon??x.ifc?.lon, a.lat, a.lon); return dd!=null && dd<30; }); if (s) (s.nj=s.nj||[]).push({a, doc:d}); }));
  all.forEach(s=>{
    const cus = s.st?.cus || [];
    const R = s.pf?.R, b = baseRule(R);
    s.d = {
      cus, poleInst: cus.find(c=>c.wf==='I'&&CU.pole(c)), poleRem: cus.find(c=>c.wf==='R'&&CU.pole(c)),
      agI: cus.filter(c=>c.wf==='I'&&CU.ag(c)), agR: cus.filter(c=>c.wf==='R'&&CU.ag(c)),
      has250C: !!R?.rules['250C'], anchors: b?.anchors||[], spanGuys: b?.spanGuys||[], equip: b?.equipment||[], comms: b ? b.spans.flatMap(x=>x.comms) : [],
      pfSpec: specOf(R?.poleSpec), setting: b?.head.setting ?? null,
      lat: s.wo?.lat ?? s.ifc?.lat ?? null, lon: s.wo?.lon ?? s.ifc?.lon ?? null,
      dloc: s.wo?.dloc || s.ifc?.dloc || s.sk?.dloc || null,
    };
    s.d.repl = !!s.d.poleInst;
    s.d.instHC = CU.poleHC(s.d.poleInst);
    STN.push(s);
  });
}

/* ---------- scope trace: each piece of work, across every document ---------- */
const COLS = [['cu','Station details'],['wo','WO notes'],['sk','Job sketch'],['pf','PoleForeman']];
const COLN = {cu:'station details', wo:'WO notes', ifc:'IFC design table', sk:'job sketch', pf:'PoleForeman report'};
const C = { ok:(t)=>({s:'ok',t}), bad:(t)=>({s:'bad',t}), warn:(t)=>({s:'warn',t}), miss:(t)=>({s:'miss',t:t||'not called out'}), na:(t)=>({s:'',t:t||''}), none:(t)=>({s:'none',t}) };
function scopeOf(s){
  if (s._scope) return s._scope;
  const d = s.d, rows = [];
  const src = {
    wo: s.wo ? s.wo.notes.join(' ') : null,
    ifc: null,
    sk: s.sk ? s.sk.notes.join(' ') : null,
  };
  const noSrc = { wo: WO ? 'no note for this pole' : 'no WO document', ifc: PKG.ifc ? 'no row for this pole' : 'no IFC package', sk: !SK ? 'no sketch' : !skCO() ? 'sketch text not read' : 'callout not found' };
  const NEG = /\bno need\b|\bnot (?:needed|required)\b|\bleave\b[^.]*\bas[- ]is\b|\bdo not\b|\bdon'?t\b/i;
  const has = (k,re,noun) => { if (src[k]==null) return false; const all = sentencesOf(src[k]); if (!all.some(x=>re.test(x))) return false; const nr = noun || re; return !all.some(x=>nr.test(x) && NEG.test(x)); };
  const T = (k, found, okText) => src[k]==null ? C.none(noSrc[k]) : found ? C.ok(okText||'called out') : C.miss();
  const skGlobal = skCO() ? (skCO().lines||[]).map(l=>l.t).join('\n') : '';
  const row = (o) => { rows.push(o); return o; };

  /* pole replacement */
  const pI=d.poleInst, pR=d.poleRem, anyRepl = ['wo','ifc','sk'].some(k=>has(k,RE.repl));
  if (pI || pR || d.has250C || anyRepl){
    row({ key:'repl', label:'Pole replacement', cat:'Pole',
      cu: pI&&pR ? C.ok(`remove ${pR.cu}, install ${pI.cu}`) : pI ? C.warn(`installs ${pI.cu}, no pole removal CU`) : pR ? C.bad(`removes ${pR.cu}, no new pole`) : C.miss('no pole CUs'),
      wo: T('wo', has('wo',RE.repl)), ifc: T('ifc', has('ifc',RE.repl)), sk: T('sk', has('sk',RE.repl)),
      pf: !s.pf ? C.none('no report') : d.has250C ? C.ok('250B + 250C') : C.warn('250B only'),
      req: { wo:!!pI, ifc:!!pI, sk:!!pI } });
    // PoleForeman sets the pole size; every other document is checked against it (station CU only when there's no report)
    const pfHC = s.pf && d.pfSpec.len ? {h:d.pfSpec.len, c:d.pfSpec.c} : null;
    const exp = pfHC || d.instHC;
    const off = v => exp && (v.h!==exp.h || v.c!==exp.c);
    const cmpP = (k, v, raw) => { if (src[k]==null && k!=='ifc') return C.none(noSrc[k]); if (!v) return C.miss(raw!=null?'height/class not stated':'not called out'); return off(v) ? C.bad(`${v.h}' class ${v.c}`) : C.ok(`${v.h}' class ${v.c}`); };
    const ifcP = s.ifc ? poleFromText(s.ifc.poleMacro) || poleFromText(s.ifc.comments) : null;
    row({ key:'newpole', label: exp ? `New pole ${exp.h}' class ${exp.c}${pfHC?' (per PoleForeman)':''}` : 'New pole size', cat:'Pole', expect: exp ? `${exp.h}' class ${exp.c}` : '',
      cu: d.instHC ? (pfHC && off(d.instHC) ? C.bad : C.ok)(`${pI.cu}: ${d.instHC.h}' class ${d.instHC.c}`) : C.miss('no new pole CU'),
      wo: cmpP('wo', poleFromText(src.wo), src.wo), ifc: s.ifc ? cmpP('ifc', ifcP, '') : C.none(noSrc.ifc), sk: cmpP('sk', poleFromText(src.sk), src.sk),
      pf: !s.pf ? C.none('no report') : pfHC ? C.ok(s.pf.R.poleSpec) : C.warn(s.pf.R.poleSpec ? `height/class not read from ${s.pf.R.poleSpec}` : 'no pole spec in report'),
      req: { cu:true, wo:false, ifc:false, sk:!!pI } });
  }

  /* guying */
  const guyNewIn = t => sentencesOf(t).some(x=>RE.guyNew.test(x) && !/\b(?:on|to)\s+(?:the\s+)?existing\b[^.]*?(?:down\s*guy|\bDG\b|guy)/i.test(x) && !(/\b(?:install|add)\b[^.]*?(?:\bGSI\b|guy\s*strain)[^.]*?\b(?:on|to)\b/i.test(x) && !/\breplace\b[^.]*?guy/i.test(x)));
  const hasNew = k => src[k]!=null && guyNewIn(src[k]);
  const newGuyTxt = ['wo','ifc','sk'].some(hasNew);
  const anyGuyTxt = ['wo','ifc','sk'].some(k=>has(k,RE.guyAny));
  if (d.agI.length || newGuyTxt || (d.anchors.length && anyGuyTxt)){
    const isNew = d.agI.length>0 || newGuyTxt;
    const gt = { wo: pick(src.wo, RE.guyAny), ifc: pick(src.ifc, RE.guyAny), sk: pick(src.sk, RE.guyAny) };
    if (s.ifc?.anchor) gt.ifc += ' ' + s.ifc.anchor;
    const gn = { wo: guyNums(gt.wo), ifc: guyNums(gt.ifc), sk: guyNums(gt.sk) };
    const degHint = gn.wo.deg ?? gn.ifc.deg ?? gn.sk.deg;
    const A = d.anchors.slice().sort((a,b)=> degHint!=null ? angd(a.bearing,degHint)-angd(b.bearing,degHint) : a.n-b.n)[0];
    const pfSize = A ? (A.wires[0]?.size.match(/(\d+\/\d+)/)||[])[1] : null;
    row({ key:'guy', label: isNew ? `New down guy${d.agI.length>1?'s':''} and anchor` : 'Existing down guy', cat:'Guying',
      cu: d.agI.length ? C.ok(d.agI.map(c=>`${c.cu} (${c.desc.replace(/^AG,\s*/,'')})`).join('; ') + (d.agR.length?`; removes ${d.agR.map(c=>c.cu).join(', ')}`:'')) : isNew ? C.miss('no AG install CU') : C.na('existing'),
      wo: T('wo', isNew ? hasNew('wo') : has('wo',RE.guyAny)), ifc: T('ifc', isNew ? hasNew('ifc') : has('ifc',RE.guyAny)), sk: T('sk', isNew ? hasNew('sk') : has('sk',RE.guyAny)),
      pf: !s.pf ? C.none('no report') : d.anchors.length ? ((d.repl && d.agI.length && d.anchors.length!==d.agI.length) ? C.bad(`${d.anchors.length} anchors modeled, ${d.agI.length} AG install CUs`) : C.ok(`${d.anchors.length} anchor${d.anchors.length>1?'s':''} modeled`)) : isNew ? C.bad('no anchor modeled') : C.none('no anchors'),
      req: { cu:isNew, wo:d.agI.length>0, ifc:d.agI.length>0&&!!s.ifc, sk:d.agI.length>0 } });
    if (A){
      if (d.agI.length){
        const cuSize = CU.agSize(d.agI[0]), cuHelix = CU.agHelix(d.agI[0]);
        const pfHelix = A.anchor ? ((A.anchor.type.match(/(single|double|triple)/i)||[])[1]||'').toLowerCase() : '';
        const cS = (k) => src[k]==null ? C.none(noSrc[k]) : !gn[k].size ? C.miss('size not stated') : pfSize && gn[k].size!==pfSize ? C.bad(gn[k].size+'"') : C.ok(gn[k].size+'"');
        row({ key:'guysize', label:`Guy size ${pfSize||cuSize||''}"`, cat:'Guying', expect: pfSize?pfSize+'"':'',
          cu: cuSize ? (pfSize && cuSize!==pfSize ? C.bad(`${cuSize}" guy`) : C.ok(`${cuSize}" guy${cuHelix?`, ${cuHelix} helix`:''}`)) : C.miss('size not in CU'),
          wo: cS('wo'), ifc: s.ifc?cS('ifc'):C.none(noSrc.ifc), sk: cS('sk'),
          pf: C.ok(`${A.wires.map(w=>w.size).join(', ')}${A.anchor?`, ${A.anchor.type}`:''}`) , req:{ wo:!!gt.wo },
          extra: cuHelix && pfHelix && cuHelix!==pfHelix ? `CU anchor is ${cuHelix} helix, PoleForeman models ${A.anchor.type}` : '' });
      }
      const numRow = (key, label, pv, fmt, tol, pickN) => {
        const cell = k => { if (src[k]==null) return C.none(noSrc[k]); const v=gn[k][pickN]; if (v==null) {
            if (k==='sk' && key==='lead' && skGlobal && new RegExp(`\\b${Math.round(pv)}\\s*(?:ft|')\\s*LL\\b`,'i').test(skGlobal)) return C.ok(`${Math.round(pv)} ft LL label`);
            return C.miss('not stated'); }
          return (key==='dir' ? angd(v,pv)>tol : Math.abs(v-pv)>tol) ? C.bad(fmt(v)) : C.ok(fmt(v)); };
        row({ key, label:`${label} ${fmt(pv)}`, cat:'Guying', expect: fmt(pv), cu:C.na(), wo:cell('wo'), ifc: s.ifc?cell('ifc'):C.none(noSrc.ifc), sk:cell('sk'), pf:C.ok(fmt(pv)), req:{ wo:d.agI.length>0 && !!gt.wo, sk:d.agI.length>0 && !!gt.sk } });
      };
      numRow('lead','Lead length', A.lead, v=>`${f1(v)}'`, S.leadTol, 'lead');
      const r = numRow('dir','Direction', A.bearing, v=>`${f0(v)}°`, S.degTol, 'deg');
      if (gn.ifc.compass && compassOf(A.bearing)!==gn.ifc.compass) rows[rows.length-1].ifc = C.bad(`${gn.ifc.compass} (bearing ${f0(A.bearing)}° is ${compassOf(A.bearing)})`);
      const topAtt = A.wires.length ? A.wires.map(w=>w.attach) : [];
      if (topAtt.length){ const pv = topAtt[0];
        const cell = k => { if (src[k]==null) return C.none(noSrc[k]); const v=gn[k].att; if (v==null) return C.miss('not stated'); return topAtt.some(a=>Math.abs(a-v)<=S.attTol) ? C.ok(`${v}"`) : C.bad(`${v}"`); };
        row({ key:'att', label:`Guy attach ${topAtt.join(' / ')}" from top`, cat:'Guying', expect:`${pv}"`, cu:C.na(), wo:cell('wo'), ifc:s.ifc?cell('ifc'):C.none(noSrc.ifc), sk:cell('sk'), pf:C.ok(topAtt.map(a=>a+'"').join(', ')), req:{ wo:d.agI.length>0 && !!gt.wo, sk:d.agI.length>0 && !!gt.sk } });
      }
    }
  }

  /* guy strain insulators */
  const cuG = d.cus.filter(c=>c.wf==='I'&&CU.gsi(c));
  const pfIns = [...d.anchors.flatMap(a=>a.wires.map(w=>w.insulator)), ...d.spanGuys.flatMap(g=>g.wires.flatMap(w=>[w.nearIns,w.farIns]))].filter(x=>x && !/^(none|na)$/i.test(x));
  const gsiTxt = ['wo','ifc','sk'].some(k=>has(k,RE.gsi));
  if (cuG.length || gsiTxt){
    const cl = cuG.length ? CU.gsiLen(cuG[0]) : null, pl = pfIns.length ? pfNum((pfIns[0].match(/(\d+)"/)||[])[1]) : null;
    row({ key:'gsi', label:`Guy strain insulator${cl?` ${cl}"`:''}`, cat:'Guying',
      cu: cuG.length ? C.ok(cuG.map(c=>c.cu+(c.qty>1?` ×${c.qty}`:'')).join(', ')) : C.miss('no GSI CU'),
      wo: T('wo', has('wo',RE.gsi)), ifc: T('ifc', has('ifc',RE.gsi)), sk: T('sk', has('sk',RE.gsi)),
      pf: !s.pf ? C.none('no report') : pfIns.length ? (cl && pl && cl!==pl ? C.bad(pfIns[0]) : C.ok(pfIns[0])) : C.bad('no guy insulator modeled'),
      req: { cu:true, wo:cuG.length>0, ifc:cuG.length>0&&!!s.ifc, sk:cuG.length>0 } });
  }

  /* hendrix */
  const cuH = d.cus.filter(c=>CU.hendrix(c));
  if (cuH.length || ['wo','ifc','sk'].some(k=>has(k,RE.hendrix))){
    row({ key:'hendrix', label:'Hendrix', cat:'Framing', cu: cuH.length ? C.ok(cuH.map(c=>c.cu).join(', ')) : C.miss('no Hendrix CU'),
      wo: T('wo', has('wo',RE.hendrix)), ifc: T('ifc', has('ifc',RE.hendrix)), sk: T('sk', has('sk',RE.hendrix)), pf: C.na(), req:{ cu:true, wo:cuH.length>0, ifc:cuH.length>0&&!!s.ifc, sk:cuH.length>0 } });
  }

  /* equipment: transformer, light, riser/cutout */
  const vo = noun => { const r = new RegExp(`\\b(?:install|replace|transfer|remove|upgrade|add|relocate|set|mount|move|change|swap)\\w*\\s+(?:(?:a|an|the|new|existing|unused|old|primary|private|street|security|pole|\\d+\\s*kva|\\d+)\\s+){0,3}(?:${noun})\\b`, 'i'); r._noun = new RegExp(`\\b(?:${noun})\\b`, 'i'); return r; };
  const eqRow = (key, label, isCU, re, pfCat, sizeOf, pfTrig=true) => {
    const cu = d.cus.filter(isCU), pfE = d.equip.filter(e=>pfCat.test(e.cat));
    const nounRe = re._noun || re;
    const txt = ['wo','ifc','sk'].some(k=>has(k,re,nounRe));
    if (!cu.length && !txt && !(pfTrig && d.repl && pfE.length)) return;
    const wfs = new Set(cu.map(c=>c.wf)); const wf = !cu.length ? '' : wfs.has('I')&&wfs.has('R') ? 'replace' : (WFN[cu[0].wf]||cu[0].wf);
    const cI = cu.find(c=>c.wf==='I') || cu[0]; const cSize = cI && sizeOf ? CU.kva(cI) : null;
    const pSize = pfE[0] && sizeOf ? pfNum(pfE[0].name) : null;
    const tcell = k => { if (src[k]==null) return C.none(noSrc[k]); const sent = pickClause(src[k], re); if (!sent) return C.miss(); const kv = sizeOf ? pfNum((sent.match(/(\d+(?:\.\d+)?)\s*kva/i)||[])[1]) : null; const at = attachIn(sent);
      const bits = [kv!=null?`${kv} kVA`:'', at!=null?`at ${at}"`:''].filter(Boolean).join(' ');
      if (kv!=null && (cSize??pSize)!=null && kv!==(cSize??pSize)) return C.bad(bits);
      if (at!=null && pfE[0] && Math.abs(at-pfE[0].attach)>S.attTol) return C.bad(bits);
      return C.ok(bits||'called out'); };
    row({ key, label: `${label}${wf?` (${wf})`:''}${cSize?` ${cSize} kVA`:''}`, cat:'Equipment',
      cu: cu.length ? (sizeOf && cSize!=null && pSize!=null && cSize!==pSize ? C.bad(`${cI.cu} is ${cSize} kVA; PoleForeman models ${pSize} kVA`) : C.ok(cu.map(c=>`${WFN[c.wf]||c.wf} ${c.cu}`).join(', '))) : C.miss(`no ${label.toLowerCase()} CU`),
      wo: tcell('wo'), ifc: s.ifc?tcell('ifc'):C.none(noSrc.ifc), sk: tcell('sk'),
      pf: !s.pf ? C.none('no report') : pfE.length ? C.ok(pfE.map(e=>`${e.name} at ${e.attach}"`).join(', ')) : cu.length ? C.warn('not modeled') : C.none('none'),
      req: { cu:true, wo:cu.length>0 && cu.some(c=>c.wf!=='T'), ifc:false, sk:cu.length>0 && (key==='xfmr' || cu.some(c=>c.wf!=='T')) } });
  };
  eqRow('xfmr','Transformer', CU.xfmr, vo('transformers?|xfmrs?'), /Transformer/i, true);
  eqRow('light','Light', CU.light, vo('lights?|luminaires?|street\\s*lights?|security\\s*lights?'), /Light/i, false);
  eqRow('riser','Primary riser', CU.riser, vo('(?:primary\\s+)?risers?'), /Switch/i, false, false);
  eqRow('fuse','Fuse / switch', c=>['fuse','switch'].includes(eqClass(c)) && !CU.riser(c), vo('fuses?|cutouts?|fuse\\s*cutouts?|switch(?:es)?|LFUS|fuse\\s*switch'), /Switch/i, false, false);
  eqRow('recloser','Recloser', c=>eqClass(c)==='recloser', vo('reclosers?'), /Reclos/i, false, false);
  eqRow('capacitor','Capacitor', c=>eqClass(c)==='capacitor', vo('capacitors?(?:\\s*banks?)?|cap\\s*banks?'), /Capac/i, false, false);
  eqRow('regulator','Regulator', c=>eqClass(c)==='regulator', vo('regulators?'), /Regul/i, false, false);

  /* straighten */
  const cuS = d.cus.filter(CU.straighten);
  if (cuS.length || ['wo','ifc','sk'].some(k=>has(k,RE.straighten)))
    row({ key:'straighten', label:'Straighten pole', cat:'Pole', cu: cuS.length?C.ok(cuS[0].cu):C.miss('no straighten CU'), wo:T('wo',has('wo',RE.straighten)), ifc:T('ifc',has('ifc',RE.straighten)), sk:T('sk',has('sk',RE.straighten)), pf:C.na(), req:{cu:true, wo:cuS.length>0, ifc:cuS.length>0&&!!s.ifc, sk:cuS.length>0} });

  /* access */
  if (s.st?.inacc)
    row({ key:'truck', label:`${s.st.inacc[0]+s.st.inacc.slice(1).toLowerCase()} inaccessible`, cat:'Access', cu:C.ok(`Inaccessible: ${s.st.inacc}`), wo:C.na(), ifc:C.na(), sk:T('sk',has('sk',RE.truck)), pf:C.na(), req:{sk:true} });

  /* primary framing */
  const cuF = d.cus.filter(c=>c.wf==='I'&&CU.primFrame(c));
  const ifcF = [];
  const b = baseRule(s.pf?.R);
  const pfF = b ? [...new Set(b.spans.flatMap(sp=>sp.wires.filter(w=>/primary/i.test(w.kind) && w.framing && !/^\(L\)/.test(w.framing)).map(w=>(w.framing.match(/\b(P[0-9A-Z]{0,3}\d{1,2})\b/)||[])[1]).filter(Boolean)))] : [];
  if (cuF.length || ifcF.length){
    const cp = cuF.map(c=>CU.framePrefix(c.cu)).filter(Boolean);
    row({ key:'frame', label:`Primary framing ${cuF.map(c=>c.cu).join(', ')||ifcF.join(', ')}`, cat:'Framing',
      cu: cuF.length ? C.ok(cuF.map(c=>c.cu).join(', ')) : C.miss('no framing install CU'), wo:C.na(), sk:C.na(),
      ifc: !s.ifc ? C.none(noSrc.ifc) : !ifcF.length ? C.miss('no framing macro') : ifcF.some(x=>cuF.some(c=>c.cu.toUpperCase()===x.toUpperCase())) ? C.ok(ifcF.join(', ')) : C.bad(ifcF.join(', ')),
      pf: !s.pf ? C.none('no report') : !pfF.length ? C.none('no new framing named') : pfF.some(p=>cp.includes(p.toUpperCase())) ? C.ok(pfF.join(', ')) : C.warn(pfF.join(', ')),
      req: { cu: ifcF.length>0 } });
  }
  s._scope = rows;
  return rows;
}

/* ---------- design features (what the design actually does at each pole) ---------- */
const FEAT = [
  { key:'pole', label:'Replace pole', re:/replac\w*\s+(?:\w+\s+){0,3}poles?|pole replacement|new poles?|set\w*\s+(?:a\s+)?(?:new\s+)?poles?/i, big:true },
  { key:'straighten', label:'Straighten pole', re:/straighten|plumb/i },
  { key:'hendrix', label:'Hendrix', re:/hendrix/i },
  { key:'guy', label:'New down guy / anchor', re:/\bguy|anchor/i },
  { key:'reconductor', label:'Reconductor', re:/reconductor|re-conductor|replace\w*\s+(?:the\s+)?(?:conductor|wire|neutral)/i, big:true },
  { key:'xfmr', label:'New / replaced transformer', re:/transformer|xfmr/i, big:true },
  { key:'fuse', label:'Fuse / switch', re:/\bfuse|cutout|switch/i },
  { key:'recloser', label:'Recloser', re:/recloser/i, big:true },
  { key:'capacitor', label:'Capacitor', re:/capacitor/i, big:true },
  { key:'regulator', label:'Regulator', re:/regulator/i, big:true },
  { key:'arrester', label:'Arrester', re:/arrest[eo]r/i },
  { key:'riser', label:'Riser', re:/riser/i },
  { key:'frame', label:'Reframe', re:/fram(e|ing)|crossarm/i },
];
function designFeatures(s){
  const d = s.d, cus = d.cus, out = {};
  const put = (k, c) => { (out[k] = out[k] || []).push(c); };
  cus.forEach(c=>{ const e = eqClass(c), wt = cuRec(c)?.wt || '';
    if (c.wf==='I' && CU.pole(c)) put('pole', c);
    if (CU.straighten(c)) put('straighten', c);
    if (CU.hendrix(c)) put('hendrix', c);
    if (c.wf==='I' && CU.ag(c)) put('guy', c);
    if (e==='transformer' && c.wf!=='T') put('xfmr', c);
    if (['fuse','switch'].includes(e) && c.wf!=='T') put('fuse', c);
    ['recloser','capacitor','regulator','arrester','riser'].forEach(k=>{ if (e===k && c.wf!=='T') put(k, c); });
    if (c.wf==='I' && wt==='STRN' && /CONDUCTOR|AAAC|ACSR|\bAAC\b|COPPER/i.test(cuDesc(c)) && !/HANDLING|HANDLE/i.test(cuDesc(c)) && (c.qty||0) >= 20) put('reconductor', c);
    if (c.wf==='I' && CU.primFrame(c)) put('frame', c);
  });
  return out;
}
function scopeText(){ return [WO?.meta.scope, WO?.meta.pn].filter(Boolean).join(' '); }


/* ---------- checks ---------- */
let FACTS = [], EST = [], MATCHK = [], EXC = [], PF2ST = {};
const isoDate = s => { if (!s) return null; let m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m){ const y = m[3].length===2 ? '20'+m[3] : m[3]; return `${y}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`; } const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0,10); };
const digits = s => (String(s||'').match(/\d{6,}/)||[])[0] || null;
function runChecks(dupPF){
  ISS = []; STN.forEach(s=>{ delete s._scope; });
  const add = (pole, sev, cat, title, detail, rule, src, loc) => ISS.push({pole:pole||'Project', sev, cat, title, detail:detail||'', rule:rule||'', src:src||'', loc:loc||null});
  PF2ST = {}; STN.forEach(s=>{ if (s.pf) PF2ST[s.pf.id] = s.id; });
  const addP = (P, sev, cat, title, detail, rule) => add(P ? (PF2ST[P.id]||P.id) : null, sev, cat, title, detail, rule, 'PoleForeman');
  if (POLES.length) pfChecks(addP); else CONN = [];
  (dupPF||[]).forEach(id=>add(PF2ST[id]||id,'warn','Report',`More than one PoleForeman report for ${id}`,'The last one read is used.','', 'PoleForeman'));
  crossChecks(add);
  ISS.forEach(i=>{ if (!i.loc) i.loc = locFor(i); });
  /* guy details: one finding per pole and document instead of lead / direction / attach separately */
  { const gk = new Map(); ISS = ISS.filter(i=>{ const m = i.cat==='Guying' && i.title.match(/^(Lead length|Direction|Guy attach) (.+?) isn't called out on the (.+)$/); if (!m) return true; const k=i.pole+'|'+m[3]; const g=gk.get(k); if (g){ g.parts.push(m[1].toLowerCase()); return false; } i.parts=[m[1].toLowerCase()]; i.docN=m[3]; gk.set(k,i); return true; });
    gk.forEach(i=>{ if (i.parts.length>1) i.title = `Down guy details (${i.parts.join(', ')}) aren't called out on the ${i.docN}`; }); }
  /* less noise: one entry per finding (250B and 250C merged), and CU-list notes grouped across poles */
  const merged = new Map(); ISS.forEach(i=>{ const k=`${i.pole}|${i.sev}|${i.cat}|${i.title}`; const m=merged.get(k); if (m){ if (i.rule && !m.rule.split(', ').includes(i.rule)) m.rule = m.rule ? m.rule+', '+i.rule : i.rule; } else merged.set(k, i); });
  let list = [...merged.values()];
  const grp = new Map(); list = list.filter(i=>{ const m = i.cat==='CU' && i.title.match(/^(\S+?):? (isn't in the compatible unit list|description differs from the CU list|is an underground CU.*)$/); if (!m) return true; const k=i.sev+'|'+i.title; const g=grp.get(k); if (g){ g.poles.push(i.pole); return false; } i.poles=[i.pole]; grp.set(k,i); return true; });
  grp.forEach(i=>{ if (i.poles.length>1){ i.detail = `${i.poles.join(', ')}. ${i.detail||''}`.trim(); i.pole='Project'; } });
  /* naming: one finding per document instead of one per pole */
  const nameG = new Map(); list = list.filter(i=>{ const m = i.cat==='Naming' && i.title.match(/^The (.+?) calls this pole "(.+?)" instead of "(.+?)"$/); if (!m) return true; const g = nameG.get(m[1]); if (g){ g.pairs.push([m[2],m[3]]); return false; } i.pairs=[[m[2],m[3]]]; i.docName=m[1]; nameG.set(m[1], i); return true; });
  nameG.forEach(i=>{ if (i.pairs.length>1){ const ex = i.pairs.slice(0,4).map(p=>`${p[0]} → ${p[1]}`).join(', '); i.title = `The ${i.docName} names ${i.pairs.length} poles differently from the station details`; i.detail = `${ex}${i.pairs.length>4?', …':''}. Matched as the same poles.`; i.pole='Project'; } });
  ISS = list;
  const stat = id => { const is=ISS.filter(x=>x.pole===id); return { s: is.some(x=>x.sev==='bad')?'bad':is.some(x=>x.sev==='warn')?'warn':'ok', c:{bad:is.filter(x=>x.sev==='bad').length,warn:is.filter(x=>x.sev==='warn').length,info:is.filter(x=>x.sev==='info').length} }; };
  STN.forEach(s=>{ const r=stat(s.id); s._status=r.s; s._counts=r.c; });
  POLES.forEach(P=>{ const r=stat(PF2ST[P.id]||P.id); P._status=r.s; P._counts=r.c; });
}


/* ---------- helpers for package-level checks ---------- */
let DOMWO = null;
function docWO(d){ const x=d.data||{}; let v=null;
  switch(d.kind){ case 'wo': v=x.meta?.wo; break; case 'station': v=x.meta?.wo; break; case 'ifc': case 'design': v=x.meta?.maximo; break; case 'sketch': case 'permitsketch': v=x.sketch?.fields.wo; break; case 'mapreq': v=(x.req||x.ocr)?.fields.wo; break; case 'jobcost': v=x.wo; break; case 'env': v=x.meta?.code; break; case 'njuns': v=x.misc; break; case 't811': v=x.job; break; case 'jacket': v=x.wo; break; case 'deviceid': v=x.wo; break; case 'dco': v=(x.forms||[]).find(f=>f.wo)?.wo; break; }
  return { content: digits(v), file: (d.name.match(/WO[_\s-]?(\d{7,9})/i)||[])[1] || null }; }
function computeWO(){
  const cnt = {}; DOCS.forEach(d=>{ d._wo = docWO(d); const w = d._wo.content || d._wo.file; if (w) cnt[w] = (cnt[w]||0) + (d.kind==='wo'?5:d._wo.content?2:1); });
  DOMWO = Object.keys(cnt).sort((a,b)=>cnt[b]-cnt[a])[0] || null;
  DOCS.forEach(d=>{ const w=d._wo.content||d._wo.file; d.foreign = !!(DOMWO && w && w!==DOMWO); });
}
function sameDesigner(a,b){
  const toks = v => String(v||'').toLowerCase().replace(/techserv|:|-|\(|\)/g,' ').split(/\s+/).filter(Boolean);
  const A=toks(a), B=toks(b); if (!A.length||!B.length) return true;
  const users = t => t.filter(x=>/^[a-z]+\d*$/.test(x)).map(x=>x.replace(/\d+$/,''));
  const names = t => { const w=t.filter(x=>/^[a-z]{2,}$/.test(x)); return w.length>=2 ? [{f:w[0], l:w[w.length-1]}] : []; };
  const match = (P,Q) => { for (const n of names(P)) { if (names(Q).some(m=>m.l===n.l)) return true; for (const u of users(Q)) if (u.length>=4 && u[0]===n.f[0] && (n.l.startsWith(u.slice(1)) || u.slice(1).startsWith(n.l.slice(0,5)))) return true; } for (const u of users(P)) for (const w of users(Q)) if (u===w && u.length>=4) return true; return false; };
  return match(A,B) || match(B,A);
}
function docLoc(d, extra){ if (!d) return null; if (!d.bytes) return {tab: extra?.tab || 'docs'};if (SK && d===SK.doc && !extra?.page) return {doc:d.id, page:SK.K.page, find:extra?.find}; return {doc:d.id, page:extra?.page||1, find:extra?.find||null}; }
function locFor(i){
  const s = STN.find(x=>x.id===i.pole); const src=String(i.src||'').toLowerCase();
  const stDoc = PKG.station || (PKG.ifc?.data.station ? PKG.ifc : null);
  const latest811 = (PKG.t811||[]).slice().sort((a,b)=>String(a.data.dateObj).localeCompare(String(b.data.dateObj))).pop();
  const pfFind = i.cat==='Guying' ? 'Anchor' : i.cat==='Line' ? 'Span' : i.cat==='Equipment' ? 'Equipment' : i.cat==='Loading' ? 'Pole Strength' : null;
  if (s){
    if (/station/.test(src) && s.st && stDoc) return {doc:stDoc.id, page:s.st.pages[0], find:(s.names.find(n=>n[0]==='station details')||[])[1]||s.id};
    if (/wo notes/.test(src) && s.wo && PKG.wo) return {doc:PKG.wo.id, page:s.wo.page, find:s.wo.dloc||s.id};
    if (/ifc/.test(src) && PKG.ifc) return {doc:PKG.ifc.id, page:PKG.ifc.data.tablePage||3, find:s.ifc?.dloc||s.id};
    if (/sketch/.test(src) && SK) return {sketch:s.id};
    if (/poleforeman/.test(src) && s.pf){ const r=s.pf.R.rules[i.rule]; return {doc:s.pf.docId, page:(r?r.firstPage:s.pf.pageNos[0]), find:pfFind}; }
    if (/photo/.test(src) && s.ph && PKG.photos) return {doc:PKG.photos.id, page:s.ph.page};
    if (/njuns/.test(src) && PKG.njuns) return {doc:PKG.njuns[0].id, page:1, find:s.d.dloc};
    if (/811/.test(src) && latest811) return {doc:latest811.id, page:1};
    if (s.pf && i.cat!=='Location') return {doc:s.pf.docId, page:(s.pf.R.rules[i.rule]||{}).firstPage||s.pf.pageNos[0], find:pfFind};
    if (s.st && stDoc) return {doc:stDoc.id, page:s.st.pages[0], find:s.id};
  }
  const c = i.cat;
  const d = c==='Estimate' ? (PKG.jobcost||PKG.costdist||PKG.labor||PKG.wo) : c==='Materials' ? (PKG.material||PKG.wo) : c==='Environmental' ? PKG.env : c==='JHA' ? PKG.jha : c==='811' ? latest811 : c==='NJUNS' ? (PKG.njuns||[])[0] : c==='IFC' ? PKG.ifc : c==='Vicinity map' ? PKG.vicinity : c==='Photos' ? PKG.photos : ['Line','Project','Report','Loading'].includes(c) && /poleforeman/.test(src) ? (PKG.pf||[])[0] : null;
  if (d) return {doc:d.id, page: c==='IFC' ? (d.data.specPages?.[0]||1) : 1, find: c==='Environmental' ? (i.title.match(/question (\d+)/)||[])[1]+'.' : null};
  return null;
}

/* ---------- permit requests and permit sketches ---------- */
let PERMIT = { reqs: [], sketches: [] };
const fileKey = n => String(n||'').toLowerCase().replace(/\.[a-z0-9]{2,4}$/,'').replace(/[^a-z0-9]/g,'');
const stOf = (id, dloc) => (id && STN.find(s=>s.key===nkey(id))) || (dloc && STN.find(s=>s.d.dloc===dloc)) || null;
// the pole size everything is held to: PoleForeman first, the station's new-pole CU when there's no report
const poleExp = s => s.pf && s.d.pfSpec.len ? {h:s.d.pfSpec.len, c:s.d.pfSpec.c, src:'PoleForeman'} : s.d.instHC ? {...s.d.instHC, src:'station details'} : null;
const hcT = v => `${v.h}' class ${v.c}`;
function sketchCallouts(d){ const t=(d.data.sketch.callouts||[]).filter(c=>c.dloc||c.lat), o=d.data.ocr; return o && o.callouts.length>t.length ? o.callouts : t; }
// one pole as shown on a permit document, against the design
function permitPole(add, where, loc, p){
  const s = stOf(p.id, p.dloc), out = { p, s, dloc:null, loc:null, size:null };
  if (!s){ if (STN.length) add(null,'bad','Permit',`The ${where} shows ${p.id||p.dloc}, which isn't in the design`, p.dloc?`DLOC ${p.dloc}`:'', '', where, loc); return out; }
  if (p.dloc && s.d.dloc){ out.dloc = p.dloc===s.d.dloc; if (!out.dloc) add(s.id,'bad','Permit',`DLOC on the ${where} (${p.dloc}) doesn't match the design (${s.d.dloc})`,'','',where,loc); }
  if (p.lat!=null && p.lon!=null && s.d.lat!=null && s.d.lon!=null){ const dd=distFt(s.d.lat,s.d.lon,p.lat,p.lon); out.loc = dd<=S.coordFt; out.dist = dd;
    if (!out.loc) add(s.id,'bad','Permit',`Location on the ${where} is ${dd>5280?f1(dd/5280)+' miles':f0(dd)+' ft'} from the design`,`Design: ${s.d.lat}, ${s.d.lon} · ${where}: ${p.lat}, ${p.lon}`,'',where,loc); }
  const e = poleExp(s);
  if (p.size && e){ out.size = p.size.h===e.h && p.size.c===e.c; if (!out.size) add(s.id,'bad','Permit',`New pole on the ${where} is ${hcT(p.size)}, but ${e.src} has ${hcT(e)}`,'','',where,loc); }
  else if (!p.size && s.d.repl && p.text!=null) add(s.id,'warn','Permit',`The ${where} doesn't state the new pole height/class for ${s.id}`, e?`Should be ${hcT(e)}.`:'', '', where, loc);
  if (p.repl && !s.d.repl && ST) add(s.id,'bad','Permit',`The ${where} replaces ${s.id}, but the station details don't`,'','',where,loc);
  else if (p.repl===false && s.d.repl && p.text) add(s.id,'warn','Permit',`${s.id} is replaced, but the ${where} scope doesn't say so`, p.text,'',where,loc);
  return out;
}
function permitChecks(add, wordNorm){
  PERMIT = { reqs: [], sketches: [] };
  const sketchName = d => `${d.data.permit||'permit'} sketch`;
  (PKG.permitsketch||[]).filter(d=>!d.foreign).forEach(d=>{
    const where = sketchName(d), cos = sketchCallouts(d);
    const poles = cos.map(c=>{ const t=(c.notes||[]).join(' '); return permitPole(add, where, {doc:d.id, page:1, find:c.dloc||c.id}, { id:c.id, dloc:c.dloc, lat:pfNum(c.lat), lon:pfNum(c.lon), size:poleFromText(t), repl:RE.repl.test(t), text:t }); });
    if (!cos.length) add(null,'info','Permit',`No pole callouts read from the ${where}`, d.data.ocr?'Check it by eye.':'Use “Read text now” in Settings to read it from the drawing.', '', where, {doc:d.id, page:1});
    PERMIT.sketches.push({ d, where, poles });
  });
  (PKG.mapreq||[]).filter(d=>!d.foreign).forEach(d=>{
    const R = d.data.req || d.data.ocr, loc = {tab:'permits'};
    const type = (R && permitOf(R.fields.type)) || d.data.permit || null, where = `${type?type+' ':''}mapping request`;
    const rec = { d, R, type, where, poles:[], sketch:null, att:[] }; PERMIT.reqs.push(rec);
    if (!R){ add(null,'info','Permit',`The ${where} hasn't been read yet`,'Use “Read text now” in Settings, or turn on automatic text reading.','',where,loc); return; }
    const F = R.fields, ocr = !d.data.req;
    rec.poles = R.poles.map(p=>permitPole(add, where, loc, { ...p, size:poleFromText(p.text), repl:RE.repl.test(p.text) }));
    if (F.scope && !R.poles.length) add(null,'warn','Permit',`No poles found in the ${where} scope of work`, F.scope, '', where, loc);
    if (R.stations!=null && R.poles.length && R.stations!==R.poles.length) add(null,'bad','Permit',`The ${where} says ${R.stations} work station${R.stations===1?'':'s'}, but its scope lists ${R.poles.length}`, R.poles.map(p=>p.id).join(', '), '', where, loc);
    if (!F.type) add(null,'warn','Permit',`Request type isn't filled in on the ${where}`,'','',where,loc);
    // dates must be real dates, in order
    if (F.needDate && !formDate(F.needDate)) add(null,'bad','Permit',`Need date "${F.needDate}" on the ${where} isn't a valid date`,'','',where,loc);
    const dt = String(F.dates||'').match(/\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}/g) || [];
    dt.forEach((t,i)=>{ if (!formDate(t)) add(null,'bad','Permit',`Estimated construction ${dt.length>1?(i?'finish':'start'):''} date "${t}" on the ${where} isn't a valid date`.replace('  ',' '), `Entered as ${F.dates}.`, '', where, loc); });
    const [d0, d1] = dt.map(formDate), nd = formDate(F.needDate);
    if (d0 && d1 && d0>d1) add(null,'bad','Permit',`Estimated construction start is after the finish on the ${where}`, F.dates, '', where, loc);
    if (nd && d0 && nd>d0) add(null,'warn','Permit',`Need date ${F.needDate} is after the estimated construction start on the ${where}`, F.dates, '', where, loc);
    if (F.dates && !dt.length) add(null,'warn','Permit',`Estimated construction dates on the ${where} weren't recognized`, F.dates, '', where, loc);
    // attachments: each should be in the package; the sketch attached (or the permit sketch of the same type) should show the same poles
    const loadable = /\.(pdf|png|jpe?g|webp)$/i;
    rec.att = R.attachments.map(a=>({ name:a, doc: DOCS.find(x=>fileKey(x.name)===fileKey(a)) || null, loadable: loadable.test(a) }));
    rec.att.filter(a=>a.loadable && !a.doc).forEach(a=>add(null,'warn','Permit',`${a.name} is attached to the ${where} but isn't in this package`,'Add it so it can be checked.','',where,loc));
    rec.sketch = rec.att.map(a=>a.doc).find(x=>x && ['sketch','permitsketch'].includes(x.kind)) || (PKG.permitsketch||[]).find(x=>!x.foreign && x.data.permit===type) || null;
    if (!rec.sketch && type && !R.attachments.some(a=>/sketch/i.test(a))) add(null,'warn','Permit',`No sketch attached to the ${where}`,'','',where,loc);
    if (rec.sketch){ const ids = new Set(sketchCallouts(rec.sketch).map(c=>nkey(c.id)).filter(Boolean)), want = new Set(R.poles.map(p=>nkey(p.id)).filter(Boolean)), sn = rec.sketch.kind==='permitsketch' ? sketchName(rec.sketch) : 'job sketch';
      if (ids.size){ [...want].filter(k=>!ids.has(k)).forEach(k=>add(null,'warn','Permit',`${canon(k)} is in the ${where} but not on the ${sn}`,rec.sketch.name,'',where,loc));
        if (rec.sketch.kind==='permitsketch') [...ids].filter(k=>!want.has(k)).forEach(k=>add(null,'warn','Permit',`The ${sn} shows ${canon(k)}, which isn't in the ${where}`,rec.sketch.name,'',sn,{doc:rec.sketch.id,page:1})); } }
    if (ocr) ISS.filter(i=>i.src===where && i.sev==='bad' && /DLOC|Location|pole on|valid date|work station/.test(i.title) && !/confirm it by eye/.test(i.detail)).forEach(i=>{ i.detail = `${i.detail?i.detail+' ':''}Read from the form image, so confirm it by eye.`; });
  });
}
function designSummaryChecks(add, wordNorm){
  const A = PKG.design, B = PKG.ifc; if (!A || !B || A===B || A.foreign || B.foreign || !B.data.order.length) return;
  const loc = id => ({doc:A.id, page:A.data.tablePage||1, find:id});
  [['Maximo WO','maximo'],['PowerPlan WO','powerplan'],['Designer','designer'],['Substation','substation'],['System voltage','voltage'],['Title','title']].forEach(([n,k])=>{ const a=A.data.meta[k], b=B.data.meta[k]; if (a && b && wordNorm(a)!==wordNorm(b)) add(null,'bad','Design',`${n} on the design summary (${a}) doesn't match the IFC package (${b})`,'','','design summary',loc(a)); });
  const ra = {}, rb = {}; A.data.order.forEach(id=>ra[nkey(id)]=A.data.rows[id]); B.data.order.forEach(id=>rb[nkey(id)]=B.data.rows[id]);
  const nm = k => (STN.find(s=>s.key===k)||{}).id || canon(k);
  Object.keys(rb).filter(k=>!ra[k]).forEach(k=>add(nm(k),'bad','Design',`${nm(k)} is in the IFC design table but not the design summary`,'','','design summary',{doc:A.id,page:1}));
  Object.keys(ra).filter(k=>!rb[k]).forEach(k=>add(nm(k),'bad','Design',`${nm(k)} is in the design summary but not the IFC design table`,'','','design summary',loc(ra[k].id)));
  const sq = v => String(v||'').toUpperCase().replace(/\s+/g,''), set = v => String(v||'').toUpperCase().split(/[\s,;]+/).filter(Boolean).sort().join(', ');
  Object.keys(ra).filter(k=>rb[k]).forEach(k=>{ const a=ra[k], b=rb[k], diff=[], soft=[];
    if (sq(a.dloc)!==sq(b.dloc)) diff.push(`DLOC ${a.dloc||'–'} vs ${b.dloc||'–'}`);
    const dd = distFt(a.lat,a.lon,b.lat,b.lon); if (dd!=null && dd>S.coordFt) diff.push(`location ${f0(dd)} ft apart`);
    if (sq(a.poleMacro)!==sq(b.poleMacro)) diff.push(`pole ${a.poleMacro||'–'} vs ${b.poleMacro||'–'}`);
    if (a.setting!==b.setting) diff.push(`setting depth ${a.setting??'–'} vs ${b.setting??'–'}`);
    if (set(a.framing)!==set(b.framing)) diff.push(`framing ${a.framing||'–'} vs ${b.framing||'–'}`);
    [['equipment','equipment'],['anchor','anchor'],['comments','comments']].forEach(([f,n])=>{ if (wordNorm(a[f])!==wordNorm(b[f])) soft.push(`${n}: "${a[f]||'–'}" vs "${b[f]||'–'}"`); });
    if (diff.length) add(nm(k),'bad','Design',`Design summary and IFC design table differ for ${nm(k)}`, `Design summary vs IFC: ${diff.join(' · ')}`,'','design summary',loc(a.id));
    if (soft.length) add(nm(k),'warn','Design',`Design summary and IFC design table wording differs for ${nm(k)}`, soft.join(' · '),'','design summary',loc(a.id));
  });
}
function crossChecks(add){
  const woNo = WO?.meta.wo || ST?.meta.wo || PKG.ifc?.data.meta.maximo || SK?.K.fields.wo || null;
  /* package */
  Object.entries(KINDS).forEach(([k,v])=>{ if (v.need && !PKG[k] && !(k==='sketch' && SK) && !(k==='station' && ST)) add(null,'warn','Package',`No ${v.n} in this package`,'Checks that depend on it are skipped.'); });
  (PKG.unknown||[]).forEach(d=>add(null,'info','Package',`${d.name} wasn't recognized`,'It is listed under Documents but not checked.'));

  /* per pole */
  const dlocs = new Set(STN.map(s=>s.d.dloc).filter(Boolean));
  STN.forEach(s=>{
    const d = s.d, id = s.id;
    scopeOf(s).forEach(row=>{
      COLS.forEach(([col])=>{
        const cell = row[col]; if (!cell) return;
        if (row.key==='repl' && col==='pf') return;
        const src = COLN[col];
        const ocrSk = col==='sk' && !skCO()?.text; if (cell.s==='bad') add(id, ocrSk?'warn':'bad', row.cat, `${row.label}: ${src} shows ${cell.t}${row.expect?`, expected ${row.expect}`:''}`, ocrSk?'Read from the sketch image. Confirm on the Sketch review tab.':'', '', src);
        else if (cell.s==='warn') add(id, col==='pf' && /not modeled/.test(cell.t) ? 'info' : 'warn', row.cat, `${row.label}: ${src} ${cell.t}`, '', '', src);
        else if (cell.s==='miss' && (row.req||{})[col]) add(id, col==='cu'?'bad':'warn', row.cat, col==='cu' ? `${row.label}: no CU in the station details, but ${COLS.filter(([k])=>k!=='cu' && row[k] && row[k].s==='ok').map(([k,n])=>n).join(' and ')||'another document'} shows it` : `${row.label} isn't called out on the ${src}`, cell.t!=='not called out'?cell.t:(ocrSk?'Read from the sketch image. Confirm on the Sketch review tab.':''), '', src);
      });
      if (row.extra) add(id,'warn',row.cat,row.extra,'','', 'station details');
    });
    /* the 250C rule */
    if (s.pf){
      if (d.has250C && !d.poleInst && ST) add(id,'bad','Pole','PoleForeman has a 250C analysis, but the station details don\u2019t replace this pole', `Any report with a 250C should be a pole replacement: remove the existing pole and install a new ${s.pf.R.poleSpec}.`, '', 'station details');
      if (d.poleInst && !d.has250C && S.repl250c) add(id,'warn','Pole','Pole is replaced but the PoleForeman report has no 250C analysis', `Station details install ${d.poleInst.cu}.`, '', 'PoleForeman');
      if (s.pfByLoc) add(id,'warn','Report',`PoleForeman label ${s.pf.id} doesn't match station ${id}`,'Matched by location.','','PoleForeman');
      if (s.pf.R.notes) add(id,'info','Pole',`PoleForeman design note: ${s.pf.R.notes}`,'','','PoleForeman');
    } else if (POLES.length && (s.st||s.wo)) add(id, d.poleInst?'bad':'warn','Report','No PoleForeman report for this pole', d.poleInst?'This pole is being replaced.':'','','PoleForeman');
    if (s.st){
      const sum = s.st.cus.reduce((a,c)=>a+(c.hours||0),0);
      if (s.st.hours!=null && Math.abs(sum-s.st.hours)>0.02) add(id,'bad','Estimate',`Station labor hours ${f2(s.st.hours)} don't add up`,`CU hours total ${f2(sum)}.`,'','station details');
    } else if (ST && (s.wo||s.pf)) add(id,'bad','Station',`${id} isn't in the station details`,'','','station details');
    if (!s.wo && WO && (s.st||s.pf)) add(id,'warn','Scope',`${id} has no note in the WO log`,'','','WO notes');
    /* locations */
    const pfh = baseRule(s.pf?.R)?.head;
    const locs = [['WO notes',s.wo?.lat,s.wo?.lon,'bad'],['sketch callout',pfNum(s.sk?.lat),pfNum(s.sk?.lon),skCO()?.text?'bad':'warn'],['photo label',pfNum(s.ph?.ocr?.lat),pfNum(s.ph?.ocr?.lon),'warn'],['NJUNS asset',s.nj?.[0]?.a.lat,s.nj?.[0]?.a.lon,'bad']].filter(x=>x[1]!=null&&x[2]!=null);
    s._locs = locs;
    if (locs.length>1){ const [rn,rla,rlo]=locs[0]; locs.slice(1).forEach(([n,la,lo,sev])=>{ const dd=distFt(rla,rlo,la,lo); if (dd>S.coordFt) add(id, sev, 'Location', `${n[0].toUpperCase()+n.slice(1)} location is ${dd>5280?f1(dd/5280)+' miles':f0(dd)+' ft'} from the ${rn}`, `${rn}: ${rla}, ${rlo} · ${n}: ${la}, ${lo}`, '', n); }); }
    const dl = [['WO notes',s.wo?.dloc,'bad'],['sketch callout',s.sk?.dloc,skCO()?.text?'bad':'warn'],['photo label',s.ph?.ocr?.dloc,'warn'],['NJUNS asset',s.nj?.[0]?.a.pole,'bad']].filter(x=>x[1]);
    s._dlocs = dl;
    if (dl.length>1) dl.slice(1).forEach(([n,v,sev])=>{ if (v!==dl[0][1]) add(id, sev, 'Location', `DLOC on the ${n} (${v}) doesn't match the ${dl[0][0]} (${dl[0][1]})`, '', '', n); });
    const nm = [...(s.names||[])]; if (s.sk?.id) nm.push(['sketch callout', s.sk.id]); if (s.ph?.ocr?.id && s.ph.ocr.src!=='text') nm.push(['photo label', s.ph.ocr.id]);
    nm.forEach(([src,raw])=>{ if (raw && raw!==s.id) add(id,'warn','Naming',`The ${src} calls this pole "${raw}" instead of "${s.id}"`,'Matched as the same pole. Use one naming convention across the package.','',src); });
    if (SK && SK.K.labels.length && !s.skLabel && (s.st||s.wo)) add(id,'warn','Sketch',`${id} label not found on the job sketch`,'','','job sketch');
    if (skCO() && !s.sk && (s.st||s.wo)) add(id,'info','Sketch',`No callout box found for ${id} on the sketch`,'Text reading looks for a box starting with the pole label and DLOC. Check the Sketch review tab.','','job sketch');
    if (PKG.photos && !s.ph && (s.st||s.wo)) add(id,'info','Photos',`No photo matched to ${id}`,'','','photos');
  });

  /* CU list suggestions (duplicates, GSI in a down guy macro, transformer voltage) */
  STN.forEach(s=>{ const fx = cuFixes(s); Object.entries(fx).forEach(([i,f])=>{ if (/^PoleForeman models|^Guy size/.test(f.fix)) return; const c=s.st.cus[+i]; add(s.id, f.cls==='Incorrect CU' && !/ kV system/.test(f.fix)?'bad':'warn', 'CU', `${c.cu} (${WFN[c.wf]||c.wf}): ${f.cls}`, f.fix, '', 'station details', (PKG.station||PKG.ifc) ? {doc:(PKG.station||PKG.ifc).id, page:c.page||s.st.pages[0], find:c.cu} : null); }); });
  /* CU list: unknown codes and description mismatches */
  if (CUDB && CUDB.n){ const sd = PKG.station||PKG.ifc; STN.forEach(s=>(s.st?.cus||[]).forEach(c=>{ const r=cuRec(c); const loc = sd ? {doc:sd.id, page:c.page||s.st.pages[0], find:c.cu} : null;
    if (!r) add(s.id,'warn','CU',`${c.cu} isn't in the compatible unit list`,`Check the spelling. If it's a new CU, update the CU list in Settings (${CUDB.name}).`,'','station details',loc);
    else { const a=String(c.desc||'').toUpperCase().replace(/[^A-Z0-9]/g,''), b=r.d.toUpperCase().replace(/[^A-Z0-9]/g,''); if (a && b && !a.startsWith(b.slice(0,14)) && !b.startsWith(a.slice(0,14))) add(s.id,'info','CU',`${c.cu}: description differs from the CU list`,`Station details: ${c.desc} · CU list: ${r.d}`,'','station details',loc); }
  })); }
  /* project facts */
  const wordNorm = v => String(v||'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  const addrNorm = v => wordNorm(v).split(' ').slice(0,3).join(' ');
  
  const t811 = (PKG.t811||[]).map(d=>d.data), nj = (PKG.njuns||[]).map(d=>d.data);
  const gl = WO?.meta.gl ? (WO.meta.gl.split('~').find(x=>/^C\w{6,}$/.test(x))||null) : null;
  const J0 = JK?.data, JO = JK?.data.ocr || {};
  const V = (label, v, doc, extra) => [label, v, doc, extra];
  const DS = PKG.design || null, PS = PKG.permitsketch || [], MR = (PKG.mapreq || []).map(d => ({ d, R: d.data.req || d.data.ocr })).filter(x => x.R);
  const psN = d => `${d.data.permit || 'Permit'} sketch`, mrN = x => `${permitOf(x.R.fields.type) || x.d.data.permit || ''} mapping request`.trim();
  const psV = k => PS.map(d => V(psN(d), d.data.sketch.fields[k], d)), mrV = k => MR.map(x => V(mrN(x), x.R.fields[k], x.d, {tab:'permits'}));
  FACTS = [
    ['Maximo WO', digits, [V('Design summary',DS?.data.meta.maximo,DS),...psV('wo'),...mrV('wo'),V('WO details',WO?.meta.wo,PKG.wo),V('Station details',ST?.meta.wo,PKG.station||PKG.ifc),V('IFC',PKG.ifc?.data.meta.maximo,PKG.ifc),V('Sketch',SK?.K.fields.wo,SK?.doc),V('Job cost',PKG.jobcost?.data.wo,PKG.jobcost),V('Environmental',PKG.env?.data.meta.code,PKG.env),V('Job jacket',J0?.wo,JK),...(PKG.njuns||[]).map(d=>V(`NJUNS ${d.data.ticket||''}`,d.data.misc,d)),...(PKG.t811||[]).map(d=>V(`811 ${d.data.ticket}`,d.data.job,d)),...(PKG.deviceid||[]).filter(d=>!d.foreign).map(d=>V('Device IDs',d.data.wo,d))]],
    ['PowerPlan WO', wordNorm, [V('IFC',PKG.ifc?.data.meta.powerplan,PKG.ifc),V('Design summary',DS?.data.meta.powerplan,DS),V('Sketch',SK?.K.fields.powerplan,SK?.doc),...psV('powerplan'),V('WO GL account',gl,PKG.wo)]],
    ['Title', wordNorm, [V('WO details',WO?.meta.title,PKG.wo),V('Sketch',SK?.K.fields.title,SK?.doc),V('Design summary',DS?.data.meta.title,DS),...psV('title'),...mrV('woName'),V('Environmental',PKG.env?.data.meta.name,PKG.env)]],
    ['Address', addrNorm, [V('WO details',WO?.meta.address&&(WO.meta.address+(WO.meta.city?', '+WO.meta.city:'')),PKG.wo),V('Sketch',SK?.K.fields.address,SK?.doc),...psV('address'),V('JHA',PKG.jha?.data.address,PKG.jha),V('Job jacket',J0?.address&&`${J0.address}, ${J0.city||''} ${J0.state||''}`,JK),V('Job jacket location',JO.location,JK),...(PKG.njuns||[]).map(d=>V('NJUNS',d.data.assets[0]?`${d.data.assets[0].house} ${d.data.assets[0].street}`:null,d))]],
    ['Substation', wordNorm, [V('Sketch',SK?.K.fields.sub,SK?.doc),V('Design summary',DS?.data.meta.substation,DS),...psV('sub'),V('IFC',PKG.ifc?.data.meta.substation,PKG.ifc),V('JHA',PKG.jha?.data.substation,PKG.jha)]],
    ['Circuit / feeder', wordNorm, [V('Sketch',SK?.K.fields.circuit,SK?.doc),V('Sketch feeder note',SK?.K.fields.feeder,SK?.doc),...psV('circuit'),V('JHA',PKG.jha?.data.circuit,PKG.jha),...(PKG.dco||[]).flatMap(d=>d.data.forms.map((f,i)=>V(`DCO ${i+1}`,f.feeder,d,{page:f.page,find:f.feeder}))),V('Job jacket upstream device',JO.upstream&&/^\d+[A-Z]{2,4}$/i.test(JO.upstream)?JO.upstream:null,JK)]],
    ['ARC flash', v=>pfNum(v), [V('Sketch',SK?.K.fields.arc,SK?.doc),...psV('arc'),V('JHA',PKG.jha?.data.arc,PKG.jha)]],
    ['Voltage', v=>pfNum(v), [V('Sketch',SK?.K.fields.voltage,SK?.doc),V('Job jacket',JO.voltage,JK)]],
    ['Designer', null, [V('IFC',PKG.ifc?.data.meta.designer,PKG.ifc),V('Design summary',DS?.data.meta.designer,DS),V('Sketch',SK?.K.fields.designer,SK?.doc),...psV('designer'),...mrV('createdBy'),V('Environmental',PKG.env?.data.meta.designer,PKG.env),V('Job jacket',J0?.designer,JK),V('Job jacket name',JO.designerName,JK),...(PKG.njuns||[]).map(d=>V('NJUNS',d.data.contact,d)),...(PKG.t811||[]).slice(-1).map(d=>V('811',d.data.contact,d))]],
    ['Pole count', v=>v, [V('WO details',WO?.meta.poleCount,PKG.wo),V('WO scope statement',WO?.meta.scopePoints,PKG.wo),V('WO work description',WO?.meta.wdPoints,PKG.wo),V('Station details',ST?.order.length,PKG.station||PKG.ifc),V('IFC design table',PKG.ifc?.data.order.length,PKG.ifc),V('Design summary',DS?.data.order.length,DS),V('PoleForeman',POLES.length||null,(PKG.pf||[])[0]),V('Sketch labels',SK?.K.labels.length,SK?.doc)]],
    ['Target finish', isoDate, [V('WO details',WO?.meta.targetFinish,PKG.wo),V('Job jacket',J0?.targetFinish,JK),...(PKG.njuns||[]).map(d=>V('NJUNS requested',d.data.requested,d))]],
    ['Commit date', isoDate, [V('Job jacket',J0?.commit||JO.commit,JK),V('Job cost summary',PKG.jobcost?.data.commit,PKG.jobcost)]],
  ].map(([name, norm, vals])=>{
    const v = vals.filter(x=>x[1]!=null && x[1]!=='' && !(x[2]&&x[2].foreign) && !/^IFC/.test(x[0]));
    let odd = [];
    if (name==='Designer'){ odd = v.filter(x=>!v.some(y=>y!==x && sameDesigner(x[1],y[1])) && v.length>1); }
    else { const ns=v.map(x=>String(norm(x[1]))); const cnt={}; ns.forEach(n=>cnt[n]=(cnt[n]||0)+1); const mode=Object.keys(cnt).sort((a,b)=>cnt[b]-cnt[a])[0]; odd = v.filter((x,i)=>ns[i]!==mode); }
    return {name, vals:v, odd, ok: !odd.length};
  });
  FACTS.forEach(f=>{ if (!f.ok){ const o=f.odd[0]; add(null, ['Designer','Target finish','Voltage'].includes(f.name)?'warn':'bad', 'Project', `${f.name} doesn't match across documents`, f.vals.map(v=>`${v[0]}: ${v[1]}`).join(' · '), '', o[0], docLoc(o[2], o[3])); } });
  permitChecks(add, wordNorm);
  designSummaryChecks(add, wordNorm);
  // ZIP codes in addresses
  const zips = FACTS.find(f=>f.name==='Address')?.vals.map(v=>[v, (String(v[1]).match(/\b(\d{3,6})\s*$/)||[])[1]]).filter(x=>x[1]) || [];
  zips.forEach(([v,z])=>{ if (z.length!==5) add(null,'warn','Project',`${v[0]} address ZIP "${z}" isn't 5 digits`, v[1], '', v[0], docLoc(v[2], {find:z})); });
  const z5 = [...new Set(zips.map(x=>x[1]).filter(z=>z.length===5))]; if (z5.length>1) add(null,'warn','Project',`Address ZIP codes differ: ${z5.join(', ')}`, zips.map(([v,z])=>`${v[0]}: ${z}`).join(' · '));
  // package: documents from another work order and file naming
  DOCS.forEach(d=>{ const w=d._wo||{}; const loc={doc:d.id, page:1, find:w.content||w.file};
    if (d.foreign) add(null,'bad','Package',`${d.name} is for WO ${w.content||w.file}, not WO ${DOMWO}`,'This document looks like it belongs to a different job. It is excluded from the comparisons.','', KINDS[d.kind].n, loc);
    else if (w.content && w.file && w.content!==w.file) add(null,'warn','Naming',`${d.name}: file name says WO ${w.file}, the document says WO ${w.content}`,'','',KINDS[d.kind].n, loc);
    if (/enviromental/i.test(d.name)) add(null,'info','Naming',`File name "${d.name}" misspells Environmental`,'','',KINDS[d.kind].n,{doc:d.id,page:1});
  });
  if (JK){ if (JO.conjunction?.length) add(null,'info','Project',`Job jacket: works in conjunction with WO ${JO.conjunction.join(', ')}`,'Confirm coordination with those work orders.','', 'Job jacket', {doc:JK.id,page:1,find:'CONJUCTION'});
    const tl = WO?.meta.title || SK?.K.fields.title || PKG.env?.data.meta.name; if (JO.upstream && tl){ const tok=(JO.upstream.match(/\d{3,}|[0-9]+[A-Z]{2,4}/i)||[])[0]; if (tok && !tl.toUpperCase().includes(tok.toUpperCase())) add(null,'warn','Project',`Job jacket upstream device ${JO.upstream} isn't in the project title`, tl,'','Job jacket',{doc:JK.id,page:1}); }
    const hOn = PKG.jobcost?.data.onsite ?? ST?.meta.onsite ?? PKG.labor?.data.hours, hTot = PKG.jobcost?.data.hours ?? ST?.meta.total;
    if (JO.manHours!=null && (hOn!=null || hTot!=null) && ![hOn,hTot].some(h=>h!=null && Math.abs(h-JO.manHours)<=0.05)) add(null,'bad','Job jacket',`Job jacket ${JO.manHoursOnsite?'onsite ':''}man hours (${f2(JO.manHours)}) don't match the estimate`, [hOn!=null?`on-site ${f2(hOn)}`:'', hTot!=null?`total ${f2(hTot)}`:''].filter(Boolean).join(' · '),'','Job jacket',{doc:JK.id,page:1,find:'Man Hours'});
    if (!JO.manHours && JK.data.ocr) add(null,'info','Job jacket','Man hours not read from the job jacket','Check them by eye.','','Job jacket',{doc:JK.id,page:1});
  }
  if (WO?.meta.startDloc && dlocs.size && !dlocs.has(WO.meta.startDloc)) add(null,'warn','Project',`WO start DLOC ${WO.meta.startDloc} isn't one of the poles`,'');
  if (WO?.meta.endDloc && dlocs.size && !dlocs.has(WO.meta.endDloc)) add(null,'warn','Project',`WO end DLOC ${WO.meta.endDloc} isn't one of the poles`,'');
  if (PKG.jha){ const J=PKG.jha.data; if (J.doc && dlocs.size && !dlocs.has(J.doc)) add(null,'warn','JHA',`JHA DOC # ${J.doc} isn't one of the pole DLOCs`,''); if (!J.date) add(null,'info','JHA','JHA has no date',''); if (!J.facility) add(null,'warn','JHA','JHA nearest medical facility is blank',''); }

  /* estimate reconciliation */
  const J = PKG.jobcost?.data, D = PKG.costdist?.data, Lb = PKG.labor?.data, M = PKG.material?.data;
  const pnVal = WO?.meta.pnCostText ? pfNum(WO.meta.pnCostText.replace(/[.,](?=.*[.,])/g,'')) : null;
  if (WO?.meta.pnCostText && /\d\.\d{3}\./.test(WO.meta.pnCostText)) add(null,'info','Estimate',`Purpose & Necessity writes the total as $${WO.meta.pnCostText}`,'Should use a comma for thousands.');
  const stSum = ST ? Object.values(ST.stations).reduce((a,s)=>a+(s.hours||0),0) : null;
  EST = [
    ['Total estimate', money, 0.02, [['Job cost total',J?.total],['Cost distribution total',D?.total],['WO approval amount',WO?.meta.approvals?.[0]],['Purpose & Necessity',pnVal]]],
    ['On-site labor hours', f2, 0.02, [['Station details header',ST?.meta.onsite],['Sum of stations',stSum],['Job cost',J?.onsite],['Labor summary',Lb?.hours],['WO planned labor',WO?.labor[0]?.hours]]],
    ['Labor cost', money, 0.02, [['Job cost',J?.labor],['Labor summary',Lb?.cost],['Cost distribution',D?.labor]]],
    ['New material', money, 0.02, [['WO planned materials',WO?.meta.matTotal],['Sum of WO material lines',WO?.materials.length?WO.materials.reduce((a,m)=>a+(m.cost||0),0):null],['Material summary',M?.total],['Sum of material lines',M?.items.length?M.items.reduce((a,m)=>a+(m.cost||0),0):null],['Job cost new material',J?.newMat]]],
    ['Services', money, 0.02, [['WO planned services',WO?.meta.svcTotal],['Job cost services',J?.services],['Station detail services',ST?.services.length?ST.services.reduce((a,x)=>a+(x.cost||0),0):null]]],
  ].map(([name,fmt,tol,vals])=>{ const v=vals.filter(x=>x[1]!=null); const ref=v[0]?.[1]; return {name,fmt,vals:v.map(x=>[x[0],x[1],ref==null||Math.abs(x[1]-ref)<=tol]), ok:v.every(x=>ref==null||Math.abs(x[1]-ref)<=tol)}; });
  EST.forEach(e=>{ if (!e.ok) add(null,'bad','Estimate',`${e.name} doesn't match across the estimate`, e.vals.map(v=>`${v[0]}: ${e.fmt(v[1])}`).join(' · ')); });
  if (WO?.meta.laborTotal!=null && J?.labor!=null && Math.abs(WO.meta.laborTotal-J.labor)>1) add(null,'info','Estimate',`WO planned labor (${money(WO.meta.laborTotal)}) differs from the estimate labor cost (${money(J.labor)})`, J.stationParams?.some(p=>p.rates==='OT') ? `The estimate uses OT labor rates on ${[...new Set(J.stationParams.filter(p=>p.rates==='OT').map(p=>p.id))].join(', ')}.` : '');
  /* materials vs design */
  MATCHK = [];
  const mats = (M?.items||WO?.materials||[]);
  if (mats.length && ST){
    const newPoles = {}; STN.forEach(s=>{ if (s.d.instHC){ const k=`${s.d.instHC.h}' class ${s.d.instHC.c}`; newPoles[k]=(newPoles[k]||0)+(s.d.poleInst.qty||1); } });
    const matPoles = {}; mats.forEach(m=>{ const x=m.desc.match(/^POLE,\s*WOOD,\s*(\d+)\s*LG,\s*C(\d)/i); if (x){ const k=`${+x[1]}' class ${+x[2]}`; matPoles[k]=(matPoles[k]||0)+(m.qty||0); } });
    [...new Set([...Object.keys(newPoles),...Object.keys(matPoles)])].forEach(k=>MATCHK.push({item:`Pole ${k}`, design:newPoles[k]||0, mat:matPoles[k]||0, sev:'bad'}));
    const nPoles = Object.values(newPoles).reduce((a,b)=>a+b,0);
    const sumQ = re => mats.filter(m=>re.test(m.desc)).reduce((a,m)=>a+(m.qty||0),0);
    const ag = STN.reduce((a,s)=>a+s.d.agI.reduce((x,c)=>x+(c.qty||1),0),0);
    MATCHK.push({item:'Power-installed anchors', design:ag, mat:sumQ(/^ANCHOR,\s*POWER/i), sev:'warn'});
    MATCHK.push({item:'Pole tags', design:nPoles, mat:sumQ(/^TAG,\s*POLE/i), sev:'warn'});
    MATCHK.push({item:'Ground rods (at least one per new pole)', design:nPoles, mat:sumQ(/^ROD,\s*GROUND/i), sev:'warn', atLeast:true});
    const ris = STN.reduce((a,s)=>a+s.d.cus.filter(c=>c.wf==='I'&&CU.riser(c)).length,0);
    if (ris) MATCHK.push({item:'Cutouts for riser installs', design:ris, mat:sumQ(/^CUTOUT/i), sev:'warn', atLeast:true});
    MATCHK.forEach(m=>{ m.ok = m.atLeast ? m.mat>=m.design : m.mat===m.design; if (!m.ok) add(null,m.sev,'Materials',`${m.item}: design calls for ${m.design}, materials list has ${m.mat}`,''); });
  }

  /* 811 */
  EXC = [];
  const scanned811 = (PKG.t811||[]).filter(d=>!d.data.ticket && !(d.data.gps||[]).length);
  if (scanned811.length) add(null,'info','811',`${scanned811.map(d=>d.name).join(', ')} has no readable text (scanned), so ticket checks were skipped`,'Review the 811 tickets by eye.','','811',{doc:scanned811[0].id,page:1});
  const tickets = (PKG.t811||[]).filter(d=>d.data.ticket || (d.data.gps||[]).length).map(d=>d.data).sort((a,b)=>String(a.dateObj).localeCompare(String(b.dateObj)));
  const pts = tickets.flatMap(t=>t.gps.map(g=>({...g, t})));
  STN.forEach(s=>{ const d=s.d; if (d.lat==null) return;
    if (d.poleInst) EXC.push({s, what:'New pole', lat:d.lat, lon:d.lon, depth: s.ifc?.setting ?? d.setting});
    if (d.agI.length) d.anchors.forEach(a=>{ const p=offsetLL(d.lat,d.lon,a.lead,a.bearing); EXC.push({s, what:`Anchor ${a.n} (${f1(a.lead)}' at ${f0(a.bearing)}°)`, lat:p.lat, lon:p.lon}); });
  });
  EXC.forEach(e=>{ let best=null; pts.forEach(p=>{ const dd=distFt(e.lat,e.lon,p.lat,p.lon); if (best==null||dd<best.d) best={d:dd,p}; }); e.best=best; const rad=best?.p.t.radius||25; e.rad=rad; e.ok=best && best.d<=rad;
    if (tickets.length && !e.ok) add(e.s.id,'bad','811',`${e.what} is ${best?f0(best.d)+' ft':'far'} from the nearest 811 locate point`,`Locate radius is ${rad} ft.`,'','811'); });
  if (EXC.length && !tickets.length) add(null,'warn','811','Excavation is planned but no 811 ticket is loaded',`${EXC.length} new pole or anchor locations.`);
  if (tickets.length){
    const latest = tickets[tickets.length-1];
    tickets.forEach(t=>{ if (woNo && t.job && digits(t.job)!==digits(woNo)) add(null,'bad','811',`811 ticket ${t.ticket} job number ${t.job} isn't WO ${woNo}`,''); });
    const deep = Math.max(0,...EXC.map(e=>e.depth||0));
    if (latest.depth!=null && deep && latest.depth<deep) add(null,'bad','811',`811 excavation depth ${latest.depth} ft is less than the ${deep} ft setting depth`,`Ticket ${latest.ticket}.`);
    const ts = isoDate(WO?.meta.targetStart), tf = isoDate(WO?.meta.targetFinish);
    if (latest.endDate && ts && latest.endDate < ts) add(null,'warn','811',`Latest 811 ticket (${latest.ticket}) runs out ${latest.endDate}, before the WO target start ${ts}`,'Update the ticket before construction.');
    else if (latest.endDate && tf && latest.endDate < tf) add(null,'info','811',`Latest 811 ticket (${latest.ticket}) runs out ${latest.endDate}, before the WO target finish ${tf}`,`Work date ${latest.workDateObj} plus ${latest.duration}.`);
  }
  /* NJUNS */
  const repl = STN.filter(s=>s.d.poleInst);
  if (PKG.njuns){
    PKG.njuns.forEach(dd=>{ const n=dd.data;
      const pts2 = n.steps.flatMap(x=>x.points);
      repl.forEach(s=>{ if (!(s.nj||[]).some(x=>x.doc===dd)) add(s.id,'bad','NJUNS',`Replaced pole ${s.id} isn't an asset on NJUNS ${n.ticket||n.number}`,s.d.dloc?`DLOC ${s.d.dloc}`:'','','NJUNS asset'); else if (pts2.length && !pts2.map(nkey).includes(s.key)) add(s.id,'info','NJUNS',`NJUNS step remarks don't list ${s.id} as a work point`,'','','NJUNS asset'); });
      n.assets.forEach(a=>{ const s=STN.find(x=>(x.nj||[]).some(y=>y.a===a)); if (!s) add(null,'warn','NJUNS',`NJUNS asset ${a.pole} doesn't match any pole in the package`,''); else if (!s.d.poleInst) add(s.id,'warn','NJUNS',`${s.id} is on the NJUNS ticket but isn't being replaced`,'','','NJUNS asset'); });
      const comm = repl.filter(s=>s.d.comms.length);
      if (comm.length && !n.steps.some(x=>/TRANSFER/i.test(x.type))) add(null,'warn','NJUNS',`Comm is attached on ${comm.map(s=>s.id).join(', ')} but NJUNS has no transfer step`,'');
      if (n.requested && WO?.meta.targetFinish && isoDate(n.requested)!==isoDate(WO.meta.targetFinish)) add(null,'info','NJUNS',`NJUNS work requested date ${n.requested} differs from the WO target finish ${WO.meta.targetFinish}`,'');
    });
  } else if (repl.some(s=>s.d.comms.length)) add(null,'warn','NJUNS','Replaced poles carry comm but no NJUNS ticket is loaded', repl.filter(s=>s.d.comms.length).map(s=>s.id).join(', '));
  /* environmental */
  if (PKG.env){ const E=PKG.env.data; E.q.forEach(q=>{ if (q.ans==='YES') add(null,'warn','Environmental',`Environmental checklist question ${q.n} is YES, so an environmental review is required`, q.text); else if (!q.ans) add(null,'warn','Environmental',`Environmental checklist question ${q.n} isn't answered`, q.text); }); }
  if (PKG.vicinity?.data.ocr){ const ids=PKG.vicinity.data.ocr.ids.map(nkey); const miss=STN.filter(s=>(s.st||s.wo)&&!ids.includes(s.key)).map(s=>s.id); if (miss.length) add(null,'info','Vicinity map',`Labels not read on the vicinity map: ${miss.join(', ')}`,'Only called-out poles may be labeled.'); }
  if (PKG.photos){ const n=PKG.photos.data.pages.length, m=STN.filter(s=>s.st||s.wo).length; if (m && n!==m) add(null,'info','Photos',`${n} photo pages for ${m} poles`,''); }

  /* DCO forms */
  const devDocs = (PKG.deviceid||[]).filter(d=>!d.foreign), devIds = new Set(devDocs.flatMap(d=>d.data.ids.map(x=>x.id)));
  const area = [...STN.filter(x=>x.d.lat!=null).map(x=>[x.d.lat,x.d.lon]), ...[JK?.data.ocr?.callouts, PKG.vicinity?.data.ocr?.callouts, skCO()?.callouts].flatMap(cs=>(cs||[]).map(c=>[pfNum(c.lat),pfNum(c.lon)])).filter(x=>x[0]!=null&&x[1]!=null)];
  const knownDlocs = new Set([...STN.map(x=>x.d.dloc).filter(Boolean), ...[JK?.data.ocr?.callouts, PKG.vicinity?.data.ocr?.callouts].flatMap(cs=>(cs||[]).map(c=>c.dloc))]);
  const dcoEquip = new Set();
  (PKG.dco||[]).forEach(d=>d.data.forms.forEach((F,fi)=>{
    const tag = `DCO ${fi+1}${F.dloc?` (DLOC ${F.dloc})`:''}`, loc={doc:d.id, page:F.page, find:F.dloc};
    const s = F.dloc ? STN.find(x=>x.d.dloc===F.dloc) : null;
    if (!F.dloc) add(null,'bad','DCO',`${tag} has no DLOC`,'','','DCO',loc);
    else if (STN.some(x=>x.d.dloc) && !s) add(null,'bad','DCO',`${tag}: DLOC isn't one of the poles in this package`, [...knownDlocs].slice(0,12).join(', '),'','DCO',loc);
    if (F.lat==null || F.lon==null) add(s?.id,'bad','DCO',`${tag} is missing GPS coordinates`,'','','DCO',loc);
    else {
      if (F.lat<25 || F.lat>37 || F.lon>-86 || F.lon<-107) add(s?.id,'bad','DCO',`${tag} coordinates ${F.lat}, ${F.lon} aren't in the service area`,'','','DCO',{...loc,find:F.latText});
      if (s && s.d.lat!=null){ const dd=distFt(s.d.lat,s.d.lon,F.lat,F.lon); if (dd>S.coordFt) add(s.id,'bad','DCO',`${tag} location is ${dd>5280?f1(dd/5280)+' miles':f0(dd)+' ft'} from ${s.id}`,`DCO ${F.lat}, ${F.lon} · WO/IFC ${s.d.lat}, ${s.d.lon}`,'','DCO',{...loc,find:F.latText}); }
      else if (area.length){ const dd=Math.min(...area.map(a=>distFt(a[0],a[1],F.lat,F.lon))); if (dd>S.dcoMi*5280) add(null,'bad','DCO',`${tag} location is ${f1(dd/5280)} miles from the project poles`,`DCO ${F.lat}, ${F.lon}. Check for a typo in the latitude or longitude.`,'','DCO',{...loc,find:F.latText}); }
    }
    if (!F.date) add(null,'warn','DCO',`${tag} has no date`,'','','DCO',loc);
    if (!F.wo) add(null,'info','DCO',`${tag}: work order # is blank`,'','','DCO',{doc:d.id,page:F.page+1,find:'Work Order #'});
    if (!F.types.length) add(null,'warn','DCO',`${tag}: no equipment type is checked`,'','','DCO',{...loc,find:'Equipment Type'});
    if (!F.rows.length) add(null,'bad','DCO',`${tag} has no install or remove line filled in`,'','','DCO',loc);
    F.rows.forEach(r=>{
      const eq = (r.equip||'').toUpperCase(); if (eq) dcoEquip.add(eq);
      if (!eq) add(s?.id,'warn','DCO',`${tag}: ${r.action.toLowerCase()} ${r.type} has no company equipment number`,'','','DCO',loc);
      else if (!/^[A-Z]\d{6}$/.test(eq)) add(s?.id,'warn','DCO',`${tag}: equipment number ${r.equip} isn't a letter plus 6 digits`,'Device IDs from the Maximo generator look like F512669.','','DCO',{...loc,find:r.equip});
      if (eq && devIds.size && !devIds.has(eq)) add(s?.id,'bad','DCO',`${tag}: equipment number ${r.equip} isn't one of the generated device IDs`,`Generated: ${[...devIds].join(', ')}`,'','DCO',{...loc,find:r.equip});
      if (!r.phase) add(s?.id,'warn','DCO',`${tag}: no phase checked for ${r.type}`,'','','DCO',loc);
      if (/fus|lfus|cutout/i.test(r.type) && !(F.switchType||[]).length) add(s?.id,'info','DCO',`${tag}: fuse install but the switch section (switch type, installed #) is blank`,'','','DCO',{...loc,find:'Switch Type'});
      if (s && /fus|lfus/i.test(r.type) && !s.d.cus.some(c=>c.wf==='I' && (eqClass(c)==='fuse' || /FUSE|FSW|CUTOUT/i.test(c.cu+' '+c.desc)))) add(s.id,'warn','DCO',`${tag} installs a fuse but ${s.id} has no fuse/cutout install CU`,'','','DCO',loc);
    });
  }));
  if (PKG.dco) devDocs.forEach(d=>d.data.ids.forEach(x=>{ if (!dcoEquip.has(x.id)) add(null,'warn','DCO',`Generated device ID ${x.id} isn't on any DCO`,`${x.type||''}, generated ${x.when||''}`,'','Device IDs',{doc:d.id,page:x.page,find:x.id}); }));
  if (PKG.dco) STN.forEach(s=>{ if (s.d.cus.some(c=>c.wf==='I' && /FUSE|FSW/i.test(c.cu+' '+c.desc)) && !(PKG.dco||[]).some(d=>d.data.forms.some(f=>f.dloc===s.d.dloc))) add(s.id,'warn','DCO',`${s.id} installs a fuse but has no DCO`,'','','station details'); });

  /* voltage drop / flicker */
  const vds = (PKG.vd||[]).filter(d=>!d.foreign);
  const xfDesign = [...new Set(STN.flatMap(s=>s.d.cus.filter(c=>CU.xfmr(c)&&c.wf!=='R').map(c=>CU.kva(c))).filter(Boolean))];
  vds.forEach(d=>{ const Vd=d.data, nm = Vd.kind==='flicker'?'Flicker':'Voltage drop', lim = Vd.kind==='flicker'?S.flkMax:S.vdMax, loc={doc:d.id,page:1};
    if (Vd.maxCum!=null && Vd.maxCum>lim) add(null,'warn','Calcs',`${nm} worksheet: ${Vd.maxCum}% at the end of the run is over ${lim}%`, Vd.rows.map(r=>`point ${r.point}: ${r.cum}%`).join(' · '),'',nm+' worksheet',{...loc,find:Vd.maxCum+'%'});
    const x = Vd.rows.find(r=>r.v==='XFMR');
    if (x && x.cap && x.kva>x.cap) add(null,'warn','Calcs',`${nm} worksheet: ${x.kva} kVA through the ${Vd.xfmr} kVA transformer is over its ${x.cap} kVA capacity`,'','',nm+' worksheet',{...loc,find:String(x.kva)});
    if (Vd.override && Vd.xfmr && Vd.override!==Vd.xfmr) add(null,'warn','Calcs',`${nm} worksheet: transformer override ${Vd.override} kVA differs from the ${Vd.xfmr} kVA transformer row`,'','',nm+' worksheet',loc);
    if (Vd.kind==='flicker'){ if (x && x.load) add(null,'warn','Calcs','Flicker worksheet still has load on the transformer row','Flicker runs should remove all load other than the motor starting kVA.','','Flicker worksheet',loc);
      Vd.rows.filter(r=>r.v!=='XFMR').forEach(r=>{ if (Vd.starting && r.load!=null && r.load!==Vd.starting) add(null,'warn','Calcs',`Flicker worksheet point ${r.point}: ${r.load} kVA isn't the ${Vd.starting} kVA motor starting load`,'','','Flicker worksheet',loc); }); }
    if (xfDesign.length && Vd.xfmr && !xfDesign.includes(Vd.xfmr)) add(null,'warn','Calcs',`${nm} worksheet uses a ${Vd.xfmr} kVA transformer; station details install ${xfDesign.join(', ')} kVA`,'','',nm+' worksheet',loc);
  });
  const dr = vds.find(d=>d.data.kind==='drop'), fl = vds.find(d=>d.data.kind==='flicker');
  if (dr && fl){
    if (dr.data.xfmr!==fl.data.xfmr) add(null,'bad','Calcs',`Voltage drop sheet uses a ${dr.data.xfmr} kVA transformer, flicker sheet uses ${fl.data.xfmr} kVA`,'','','Flicker worksheet',{doc:fl.id,page:1});
    dr.data.rows.forEach(r=>{ const o=fl.data.rows.find(z=>z.point===r.point); if (!o){ add(null,'warn','Calcs',`Point ${r.point} is on the voltage drop sheet but not the flicker sheet`,'','','Flicker worksheet',{doc:fl.id,page:1}); return; }
      if (r.feet!==o.feet) add(null,'warn','Calcs',`Point ${r.point}: voltage drop sheet uses ${r.feet} ft, flicker sheet uses ${o.feet} ft`,'The two runs should model the same service.','','Flicker worksheet',{doc:fl.id,page:1,find:String(o.feet)});
      if (r.v!=='XFMR' && r.wire!==o.wire) add(null,'warn','Calcs',`Point ${r.point}: wire is ${r.wire} on the voltage drop sheet, ${o.wire} on the flicker sheet`,'','','Flicker worksheet',{doc:fl.id,page:1,find:o.wire}); });
  }

  /* work order: scope statement, P&N and notes against the design */
  if (WO){
    const st = scopeText(), feats = {}; STN.forEach(s=>{ const f=designFeatures(s); Object.keys(f).forEach(k=>(feats[k]=feats[k]||[]).push(s.id)); });
    const woLoc = { doc:PKG.wo.id, page:1, find:'scope' };
    if (st) FEAT.forEach(F=>{ const said = F.re.test(st), has = !!feats[F.key];
      if (said && !has && ['pole','straighten','hendrix','reconductor','recloser','capacitor','regulator','xfmr'].includes(F.key)) add(null,'warn','Scope',`Scope says "${(st.match(F.re)||[''])[0]}" but no pole in the design has it`, `No ${F.label.toLowerCase()} CUs in the station details.`,'','WO details',woLoc);
      if (!said && has && F.big) add(null,'info','Scope',`Design includes ${F.label.toLowerCase()} (${feats[F.key].join(', ')}) that the scope statement doesn't mention`,'Confirm this is within scope.','','WO details',woLoc); });
    if (!WO.meta.scope) add(null,'warn','WO','No scope statement found at the top of the Work Order Details','','','WO details',woLoc);
    if (!WO.meta.pn) add(null,'warn','WO','No Purpose & Necessity entry in the WO log','','','WO details',woLoc);
    const woText = [WO.meta.scope, WO.meta.pn, ...WO.log.filter(e=>e.kind!=='notification').map(e=>e.desc+' '+e.text)].join(' ');
    const latest = (PKG.t811||[]).map(d=>d.data).sort((a,b)=>String(a.dateObj).localeCompare(String(b.dateObj))).pop();
    if (latest && latest.ticket && !woText.includes(latest.ticket)) add(null,'warn','WO',`Work order notes don't list the 811 ticket (${latest.ticket})`,'Add permit and locate information to the Work Order Notes.','','WO details',woLoc);
    (PKG.njuns||[]).forEach(d=>{ const n=(d.data.number||String(d.data.ticket||'').replace(/^PR/i,'')); if (n && !woText.includes(n)) add(null,'warn','WO',`Work order notes don't list NJUNS ticket ${d.data.ticket||n}`,'','','WO details',woLoc); });
    (JK?.data.ocr?.conjunction||[]).forEach(w=>{ if (!woText.includes(w)) add(null,'warn','WO',`Related WO ${w} (from the job jacket) isn't listed in the work order notes`,'List related / split WO numbers in the Long Description and Work Order Notes.','','WO details',woLoc); });
  }

  /* underground CUs on an overhead job */
  if (CUDB && CUDB.n){ const all = STN.flatMap(s=>(s.st?.cus||[]).map(c=>({s,c,wt:cuRec(c)?.wt||''})));
    const ug = x => ['EQUG','WPUG','TRCU'].includes(x.wt); const oh = JK?.data.ohug==='OH' || (all.length && all.filter(ug).length/all.length < 0.1);
    if (oh) all.filter(ug).forEach(x=>add(x.s.id,'warn','CU',`${x.c.cu} is an underground CU (${x.wt}) on an overhead job`, cuRec(x.c)?.d||'', '', 'station details', (PKG.station||PKG.ifc)?{doc:(PKG.station||PKG.ifc).id,page:x.c.page||x.s.st.pages[0],find:x.c.cu}:null)); }

  /* photos: every pole should have one when labels can be read */
  if (PKG.photos && PKG.photos.data.pages.some(p=>p.ocr && p.ocr.id)) STN.forEach(s=>{ if ((s.st||s.wo) && !s.ph) add(s.id,'warn','Photos',`No photo found for ${s.id}`,'','','photos',{doc:PKG.photos.id,page:1}); });
}

/* ---------- PoleForeman checks ---------- */
function pfChecks(add){
  const sorted = POLES.slice().sort((a,b)=>natural(a.id,b.id));
  // majority values
  const maj = (fn) => { const m={}; sorted.forEach(P=>{ const v=fn(P); if(v) m[v]=(m[v]||0)+1; }); return Object.entries(m).sort((a,b)=>b[1]-a[1])[0]?.[0]; };
  const majSw = maj(P=>P.R.sw&&`${P.R.sw} / DB ${P.R.db}`), majEd = maj(P=>P.R.edition), majGr = maj(P=>P.R.grade), majDi = maj(P=>P.R.district);
  const primVolt = P => { const r=P.R.rules['250B']||P.R.rules[P.R.ruleOrder[0]]; const v=r.spans.flatMap(s=>s.wires.filter(w=>/primary/i.test(w.kind)).flatMap(w=>w.phases.map(p=>(p.insulator.match(/(\d+)\s*KV/i)||[])[1]))).filter(Boolean); return v; };
  const voltCount = {}; sorted.forEach(P=>primVolt(P).forEach(v=>voltCount[v]=(voltCount[v]||0)+1));
  const majVolt = Object.entries(voltCount).sort((a,b)=>b[1]-a[1])[0]?.[0];
  sorted.forEach(P=>{
    const R = P.R;
    // file name vs label vs rules
    const fnLabel = (P.fileName.match(/^([A-Za-z]*\d+[A-Za-z]?)_/)||[])[1];
    if (fnLabel && R.label && fnLabel.toUpperCase()!==R.label.toUpperCase()) { if (nkey(fnLabel)===nkey(R.label)) add(P,'warn','Naming',`Report file name uses ${fnLabel} but the report is labeled ${R.label}`,`${P.fileName}. Same pole, different naming.`); else add(P,'bad','Report','File name and pole label are different poles',`File ${P.fileName} but the report is labeled ${R.label}.`); }
    const fnRules = (P.fileName.match(/250[A-Z]/g)||[]);
    fnRules.forEach(r=>{ if (!R.rules[r]) add(P,'bad','Report',`File name says ${r} but the report has no ${r} analysis`,P.fileName); });
    if (!R.rules['250B']) add(P,'bad','Report','No 250B analysis in this report','');
    if (!R.rules['250C']) add(P,'info','Report','250B only','No 250C extreme-wind analysis in this report.');
    // PoleForeman icon status
    Object.entries(P.pf||{}).forEach(([k,v])=>{ if (v==='pass') return; const [a,b,c]=k.split('|'); const what = a==='summary'?`summary ${b} ${c}`:b==='comp'?`${c}${c==='Overall'?' pole':''}`:`${b} ${c}`; add(P, v==='fail'?'bad':'warn','PoleForeman',`PoleForeman marks ${what} ${v==='fail'?'failing':'as a warning'}`, a==='summary'?'':`${a} analysis`, a==='summary'?b:a); });
    // HAG
    const sp = specOf(R.poleSpec);
    R.ruleOrder.forEach(rn=>{
      const r = R.rules[rn], h = r.head, m = metrics(r);
      const L = (v, what, detail, k) => { if (v==null) return; const [w,f]=TH(k); if (v>f) add(P,'bad','Loading',`${what} at ${f0(v)}%, over the ${f}% ${k==='pole'?'pole':'equipment'} limit`,detail,rn); else if (v>w) add(P,'warn','Loading',`${what} at ${f0(v)}%, above the preferred ${w}%`,detail,rn); };
      L(h.horz,'Pole horizontal loading','', 'pole'); L(h.vert,'Pole vertical loading','', 'pole');
      r.spans.forEach(s=>s.wires.forEach(w=>w.phases.forEach(p=>{ const d=`Span ${s.n}, ${w.kind} ${p.phase}`; L(p.bracketLoad,`Bracket (${p.bracket})`,d); L(p.supportLoad,`Insulator support (${p.support})`,d); L(p.insLoad,`Insulator (${p.insulator})`,d); })));
      r.anchors.forEach(a=>{
        a.wires.forEach((w,i)=>{ const d=`Anchor ${a.n}, guy ${i+1} (${w.size} at ${w.attach} in)`; L(w.load,'Guy wire',d); L(w.insLoad,`Guy insulator (${w.insulator})`,d);
          if (w.strength && w.tension!=null && w.load!=null && Math.abs(w.tension/w.strength*100-w.load)>1.5) add(P,'bad','Math',`Guy wire %loading doesn't match tension ÷ strength`,`${d}: ${f0(w.tension)} ÷ ${f0(w.strength)} = ${f1(w.tension/w.strength*100)}%, report shows ${w.load}%`,rn);
          if (w.insStrength && w.tension!=null && w.insLoad!=null && Math.abs(w.tension/w.insStrength*100-w.insLoad)>1.5) add(P,'bad','Math',`Guy insulator %loading doesn't match`,`${d}: ${f0(w.tension)} ÷ ${f0(w.insStrength)} = ${f1(w.tension/w.insStrength*100)}%, report shows ${w.insLoad}%`,rn);
        });
        if (a.anchor){ const an=a.anchor, d=`Anchor ${a.n} (${an.type}, ${an.rod})`; L(an.load,'Anchor holding',d); L(an.rodLoad,'Anchor rod',d);
          const sum = a.wires.reduce((x,w)=>x+(w.tension||0),0);
          if (a.wires.length && Math.abs(sum-an.tension)>Math.max(25, an.tension*0.01)) add(P,'bad','Math','Anchor tension ≠ sum of its guy wires',`${d}: guys total ${f0(sum)} lbs, anchor shows ${f0(an.tension)} lbs`,rn);
          if (an.holding && Math.abs(an.tension/an.holding*100-an.load)>1.5) add(P,'bad','Math','Anchor %loading doesn\u2019t match tension ÷ holding strength',`${d}: ${f1(an.tension/an.holding*100)}% vs ${an.load}%`,rn);
          if (an.rodStrength && an.rodLoad!=null && Math.abs(an.tension/an.rodStrength*100-an.rodLoad)>1.5) add(P,'bad','Math','Rod %loading doesn\u2019t match tension ÷ rod strength',`${d}: ${f1(an.tension/an.rodStrength*100)}% vs ${an.rodLoad}%`,rn);
        } else add(P,'warn','Guying',`Anchor ${a.n} has guy wires but no anchor data`,'',rn);
        // lead ratio
        if (sp.len && h.setting && a.wires.length){ const hag=sp.len-h.setting; const top=Math.min(...a.wires.map(w=>w.attach||0)); const ht=hag-top/12; const ratio=a.lead/ht; a._ratio=ratio; a._ht=ht; if (ratio<S.lead) add(P,'warn','Guying',`Short guy lead on anchor ${a.n} (lead:height ${ratio.toFixed(2)})`,`${f1(a.lead)} ft lead to a guy about ${f1(ht)} ft above ground (limit ${S.lead}).`,rn); }
      });
      (r.spanGuys||[]).forEach(g=>g.wires.forEach((w,i)=>{ const d=`Span guy ${g.n} (${g.length}' at ${g.bearing}°), guy ${i+1} (${w.size} at ${w.attach} in)`; L(w.load,'Span guy wire',d);
        if (w.nearIns && !/^none$/i.test(w.nearIns)) L(w.nearLoad,`Span guy near insulator (${w.nearIns})`,d);
        if (w.farIns && !/^none$/i.test(w.farIns)) L(w.farLoad,`Span guy far insulator (${w.farIns})`,d);
        if (w.strength && w.tension!=null && w.load!=null && Math.abs(w.tension/w.strength*100-w.load)>1.5) add(P,'bad','Math',`Span guy %loading doesn't match tension ÷ strength`,`${d}: ${f0(w.tension)} ÷ ${f0(w.strength)} = ${f1(w.tension/w.strength*100)}%, report shows ${w.load}%`,rn);
        [['near',w.nearStr,w.nearLoad],['far',w.farStr,w.farLoad]].forEach(([k,st,ld])=>{ if (st && ld!=null && w.tension!=null && Math.abs(w.tension/st*100-ld)>1.5) add(P,'bad','Math',`Span guy ${k} insulator %loading doesn't match`,`${d}: ${f1(w.tension/st*100)}% vs ${ld}%`,rn); }); }));
      // spans
      r.spans.forEach(s=>{ if (!s.wires.length && !s.comms.length) add(P,'warn','Spans',`Span ${s.n} has no conductors or cables`,`${s.length}' at ${s.bearing}°. Leftover span, or wires not assigned?`,rn); });
      // NESC factors
      const ex = rn==='250B' && /Grade C/i.test(h.grade||R.grade) ? {Pole:[1.3,1.75,1.9,0.85], Guy:[1.3,1.75,1.5,0.9]} : rn==='250C' ? {Pole:[1,1,1,0.75], Guy:[1,1,1,0.9]} : null;
      if (ex) Object.entries(ex).forEach(([o,v])=>{ const n=r.nesc[o]; if(!n){ add(P,'warn','NESC',`${o} load factors missing`,'',rn); return; } const got=[n.tension,n.wind,n.vertical,n.sf]; const labels=['tension','wind','vertical','strength factor']; got.forEach((g,i)=>{ if (g!==v[i]) add(P,'bad','NESC',`${o} ${labels[i]} factor is ${g}, expected ${v[i]}`,`${rn}, ${h.grade||R.grade}`,rn); }); });
      // district conditions
      if (rn==='250B'){ const D={Light:{temp:30,wind:9,ice:0},Medium:{temp:15,wind:4,ice:0.25},Heavy:{temp:0,wind:4,ice:0.5}}[(h.district||'').trim()];
        if (D){ if (h.temp!==D.temp) add(P,'bad','NESC',`${h.district} district temperature is ${h.temp}°, expected ${D.temp}°`,'',rn); if (h.wind!==D.wind) add(P,'bad','NESC',`${h.district} district wind is ${h.wind} psf, expected ${D.wind} psf`,'',rn); if ((h.ice||0)!==D.ice) add(P,'bad','NESC',`${h.district} district ice is ${h.ice}", expected ${D.ice}"`,'',rn); } }
      if (h.strength!=null && h.strength<100) add(P,'info','Pole',`Pole strength remaining ${h.strength}%`,'Deterioration was applied in this analysis.',rn);
      // setting depth
      if (sp.len && h.setting!=null && h.setting < sp.len*0.1+2-0.01) add(P,'warn','Pole',`Setting depth ${h.setting}' is shallower than 10% + 2' (${f1(sp.len*0.1+2)}')`,R.poleSpec,rn);
      // dead ends with no guys
      const de = r.spans.some(s=>s.wires.some(w=>!/secondary|service/i.test(w.kind) && w.phases.some(p=>/dead\s*end|\bDE\b/i.test(p.insulator+' '+p.bracket))));
      if (de && !r.anchors.length && !(r.spanGuys||[]).length) add(P,'warn','Guying','Dead-end hardware with no guying modeled','Confirm the dead-end tension is balanced.',rn);
      // comm separation
      const powerAtt = r.spans.flatMap(s=>s.wires.filter(w=>!/neutral/i.test(w.kind)&&!/secondary|service/i.test(w.kind)).flatMap(w=>w.phases.map(p=>p.attach)));
      const commAtt = r.spans.flatMap(s=>s.comms.map(c=>c.attach));
      if (powerAtt.length && commAtt.length){ const sep=Math.min(...commAtt)-Math.max(...powerAtt); if (sep<S.commSep) add(P,'warn','Clearance',`Comm is ${f0(sep)} in below the lowest primary at the pole`,`Limit set to ${S.commSep} in.`,rn); }
      // summary vs detail
      const sr = R.summary.find(x=>x.rule===rn);
      if (sr){ [['poleH',h.horz,'Pole H'],['poleV',h.vert,'Pole V'],['framings',m.framing,'Framings'],['guying',m.guy,'Guying']].forEach(([k,v,lab])=>{ if (sr[k]!=null && v!=null && Math.abs(sr[k]-v)>1) add(P,'bad','Report',`Summary page ${lab} (${sr[k]}%) doesn't match the ${rn} detail (${f0(v)}%)`,'',rn); });
        if (sr.temp!=null && h.temp!=null && sr.temp!==h.temp) add(P,'bad','Report',`Summary temperature ${sr.temp}° vs detail ${h.temp}°`,'',rn); }
    });
    // HAG / 250C applicability
    const b = R.rules['250B'];
    if (sp.len && b && b.head.setting!=null){ const hag=sp.len-b.head.setting; P._hag=hag; if (hag>S.hag250c && !R.rules['250C']) add(P,'warn','NESC',`Pole is ${f1(hag)} ft above ground with no 250C analysis`,`NESC 250C extreme wind applies to structures over ${S.hag250c} ft.`); }
    // 250B vs 250C consistency
    const c = R.rules['250C'];
    if (b && c){
      const diff = (what, x, y) => { if (String(x)!==String(y)) add(P,'bad','250B vs 250C',`${what} differs between 250B and 250C`,`250B: ${x} · 250C: ${y}`); };
      diff('Pole', b.head.poleSpec, c.head.poleSpec); diff('Setting depth', b.head.setting, c.head.setting); diff('Soil', b.head.soil, c.head.soil);
      diff('Location', `${b.head.lat}, ${b.head.lon}`, `${c.head.lat}, ${c.head.lon}`);
      diff('Number of spans', b.spans.length, c.spans.length); diff('Number of anchors', b.anchors.length, c.anchors.length); diff('Number of span guys', (b.spanGuys||[]).length, (c.spanGuys||[]).length); diff('Equipment count', b.equipment.length, c.equipment.length);
      b.spans.forEach(s=>{ const t=c.spans.find(x=>x.n===s.n); if(!t) return; diff(`Span ${s.n} length/bearing`, `${s.length}' @ ${s.bearing}°`, `${t.length}' @ ${t.bearing}°`);
        s.wires.forEach((w,i)=>{ const u=t.wires[i]; if(!u){ add(P,'bad','250B vs 250C',`Span ${s.n} ${w.kind} missing from 250C`,''); return; } diff(`Span ${s.n} ${w.kind} conductor`, w.conductor, u.conductor);
          w.phases.forEach((p,j)=>{ const q=u.phases[j]; if(!q) return; if (p.attach!==q.attach||p.offset!==q.offset) diff(`Span ${s.n} ${w.kind} ${p.phase} attachment`, `${p.attach}/${p.offset} in`, `${q.attach}/${q.offset} in`); if (p.bracket!==q.bracket) diff(`Span ${s.n} ${w.kind} ${p.phase} bracket`, p.bracket, q.bracket); if (p.insulator!==q.insulator) diff(`Span ${s.n} ${w.kind} ${p.phase} insulator`, p.insulator, q.insulator); });
          if (u.tension!=null && w.tension!=null && u.tension<w.tension) add(P,'warn','250B vs 250C',`Span ${s.n} ${w.kind} design tension is lower under 250C`,`250B ${f0(w.tension)} lbs · 250C ${f0(u.tension)} lbs`);
        });
        s.comms.forEach((m,i)=>{ const n=t.comms[i]; if(n && m.attach!==n.attach) diff(`Span ${s.n} comm attachment`, m.attach, n.attach); });
      });
      b.anchors.forEach(a=>{ const d=c.anchors.find(x=>x.n===a.n); if(!d) return; diff(`Anchor ${a.n} lead/bearing`, `${a.lead}' @ ${a.bearing}°`, `${d.lead}' @ ${d.bearing}°`); diff(`Anchor ${a.n} guy sizes`, a.wires.map(w=>w.size+'@'+w.attach).join(', '), d.wires.map(w=>w.size+'@'+w.attach).join(', ')); if (a.anchor&&d.anchor) diff(`Anchor ${a.n} type`, a.anchor.type+' / '+a.anchor.rod, d.anchor.type+' / '+d.anchor.rod); });
      const mb=metrics(b), mc=metrics(c);
      if (mb.horz!=null && mc.horz!=null && mc.horz < mb.horz) add(P,'info','250B vs 250C','250C horizontal loading is lower than 250B',`250B ${mb.horz}% · 250C ${mc.horz}%`);
    }
    // project consistency
    if (majEd && R.edition && R.edition!==majEd) add(P,'warn','Project',`NESC edition ${R.edition} differs from the project (${majEd})`,'');
    if (majGr && R.grade && R.grade!==majGr) add(P,'warn','Project',`Grade differs from the project`,`${R.grade} vs ${majGr}`);
    if (majDi && R.district && R.district!==majDi) add(P,'warn','Project',`Loading district differs from the project`,`${R.district} vs ${majDi}`);
    const pv = [...new Set(primVolt(P))];
    if (majVolt && pv.length && pv.some(v=>+v < +majVolt)) add(P,'warn','Framing',`Primary insulators rated ${pv.filter(v=>+v<+majVolt).join('/')} kV on a line that is mostly ${majVolt} kV`,'Confirm the insulator selection.');
  });
  // span connections from coordinates
  const base = P => P.R.rules['250B']||P.R.rules[P.R.ruleOrder[0]];
  const xy = P => { const h=base(P).head; return (h.lat==null||h.lon==null)?null:{y:h.lat*364000, x:h.lon*364000*Math.cos(h.lat*Math.PI/180)}; };
  const normC = s => String(s||'').replace(/\.\.\.$/,'').trim();
  const sameC = (a,b) => { a=normC(a); b=normC(b); return a===b || a.startsWith(b) || b.startsWith(a); };
  const angd = (a,b) => { const d=Math.abs(((a-b)%360+360)%360); return d>180?360-d:d; };
  CONN = [];
  sorted.forEach(A=>{ const pa=xy(A); base(A).spans.forEach(s=>{
    let best=null;
    if (pa) sorted.forEach(B=>{ if (B===A) return; const pb=xy(B); if(!pb) return; const dx=pb.x-pa.x, dy=pb.y-pa.y, dist=Math.hypot(dx,dy), brg=(Math.atan2(dx,dy)*180/Math.PI+360)%360; const ad=angd(brg,s.bearing); if (ad<=S.ang && dist<=s.length*1.35 && (!best||Math.abs(dist-s.length)<Math.abs(best.dist-s.length))) best={B,dist,brg,ad}; });
    CONN.push({A, s, B:best?best.B:null, dist:best?best.dist:null, ad:best?best.ad:null});
  }); });
  const tolOf = L => Math.max(S.spanFt, L*S.spanPct/100);
  CONN.forEach(c=>{
    if (!c.B) { c.state='open'; return; }
    const back = base(c.B).spans.map(t=>({t, d:angd(t.bearing, c.s.bearing+180)})).filter(x=>x.d<=S.ang).sort((x,y)=>x.d-y.d)[0];
    c.t = back ? back.t : null;
    if (Math.abs(c.dist-c.s.length) > tolOf(c.s.length)) { c.state='gps'; add(c.A,'warn','Line',`Span ${c.s.n} toward ${c.B.id} is ${f1(c.s.length)}' but the poles are ${f1(c.dist)}' apart`,'Distance from the report coordinates.'); }
    if (!c.t) { c.state='noback'; add(c.A,'warn','Line',`${c.B.id} has no span pointing back at ${c.A.id}`,`${c.A.id} span ${c.s.n} runs ${c.s.bearing}° toward ${c.B.id}; none of ${c.B.id}'s spans run near ${f0((c.s.bearing+180)%360)}°.`); return; }
    c.state = c.state || 'ok';
    if (natural(c.A.id,c.B.id)>0) return; // report each pair once
    const dl=Math.abs(c.s.length-c.t.length);
    if (dl>tolOf(Math.max(c.s.length,c.t.length))) { c.state='len'; add(c.A,'warn','Line',`Span to ${c.B.id} is ${f1(c.s.length)}' here but ${f1(c.t.length)}' on ${c.B.id}`,`${c.A.id} span ${c.s.n} / ${c.B.id} span ${c.t.n}, ${f1(dl)} ft apart.`); }
    const miss = c.s.wires.filter(w=>!c.t.wires.some(u=>u.kind===w.kind&&sameC(u.conductor,w.conductor))).concat(c.t.wires.filter(u=>!c.s.wires.some(w=>w.kind===u.kind&&sameC(u.conductor,w.conductor))));
    if (miss.length) { c.state='cond'; add(c.A,'warn','Line',`Conductors on the span to ${c.B.id} don't match ${c.B.id}'s side`,`${c.A.id}: ${c.s.wires.map(w=>w.kind+' '+w.conductor).join(', ')||'none'} · ${c.B.id}: ${c.t.wires.map(w=>w.kind+' '+w.conductor).join(', ')||'none'}`); }
    else c.s.wires.forEach(w=>{ const u=c.t.wires.find(x=>x.kind===w.kind&&sameC(x.conductor,w.conductor)); if (u && (u.tension!==w.tension||u.ruling!==w.ruling)) add(c.A,'info','Line',`${w.kind} ruling span / design tension differs from ${c.B.id}`,`${c.A.id}: ${w.ruling}' / ${f0(w.tension)} lbs · ${c.B.id}: ${u.ruling}' / ${f0(u.tension)} lbs`); });
    if (c.s.comms.length!==c.t.comms.length) add(c.A,'warn','Line',`Comm cable count on the span to ${c.B.id} doesn't match`,`${c.A.id}: ${c.s.comms.length} · ${c.B.id}: ${c.t.comms.length}`);
  });
  const opens = CONN.filter(c=>c.state==='open');
  if (opens.length) add(null,'info','Line',`${opens.length} spans end at poles that aren't in this set`,opens.map(c=>`${c.A.id} span ${c.s.n} (${c.s.length}' at ${c.s.bearing}°)`).join(', '));
  // label gaps / duplicates
  const nums = sorted.map(P=>({P, m:String(P.id).match(/^(.*?)(\d+)$/)})).filter(x=>x.m);
  for (let i=0;i<nums.length-1;i++){ const a=nums[i], b=nums[i+1]; if (a.m[1]===b.m[1] && +b.m[2]-+a.m[2]>1) add(null,'info','Project',`Pole labels skip from ${a.P.id} to ${b.P.id}`,'Missing report, or intentionally skipped?'); }
  const noOwner = sorted.filter(P=>P.R.ruleOrder.some(r=>P.R.rules[r].spans.some(s=>s.comms.some(c=>!c.owner)))).length;
  if (noOwner) add(null,'info','Project',`Communication cables have no owner on ${noOwner} pole${noOwner>1?'s':''}`,'The Owner column is blank.');
}

const CLS = {primary:{c:'var(--blue)',n:'Primary'}, neutral:{c:'var(--muted)',n:'Neutral'}, secondary:{c:'var(--ok)',n:'Secondary'}, other:{c:'var(--blue)',n:'Wire'}, comm:{c:'var(--c)',n:'Comm'}, guy:{c:'var(--amber-bar)',n:'Guy'}, equip:{c:'var(--ink)',n:'Equipment'}};
const ftin = inch => { if (inch==null) return '–'; const neg=inch<0; inch=Math.abs(Math.round(inch)); const f=Math.floor(inch/12), i=inch%12; return (neg?'-':'')+(f?`${f}' `:'')+`${i}"`; };
function spacingLevels(P){
  const r = P.R.rules['250B']||P.R.rules[P.R.ruleOrder[0]];
  const items = [];
  const push = (cls, attach, offset, desc, sub, extra) => { if (attach==null) return; let it = items.find(x=>x.cls===cls && x.attach===attach && x.desc===desc); if (!it){ it={cls, attach, desc, subs:new Set(), offsets:new Set(), spans:new Set(), ...extra}; items.push(it); } if (sub) it.subs.add(sub); if (offset!=null) it.offsets.add(offset); if (extra&&extra.span) it.spans.add(extra.span); };
  r.spans.forEach(s=>{
    s.wires.forEach(w=>{ const k=/primary/i.test(w.kind)?'primary':/neutral/i.test(w.kind)?'neutral':/secondary|service/i.test(w.kind)?'secondary':'other';
      w.phases.forEach(p=>push(k, p.attach, p.offset, `${CLS[k].n==='Wire'?w.kind:CLS[k].n} on ${p.bracket}`, p.phase, {span:s.n})); });
    s.comms.forEach(c=>push('comm', c.attach, c.offset, `Comm ${c.cable}${c.owner?` (${c.owner})`:''}`, '', {span:s.n}));
  });
  r.anchors.forEach(a=>a.wires.forEach(w=>push('guy', w.attach, null, `Guy ${w.size}${w.insulator&&w.insulator!=='None'?` + ${w.insulator}`:''}`, `anchor ${a.n}`, {bearing:a.bearing})));
  (r.spanGuys||[]).forEach(g=>g.wires.forEach(w=>push('guy', w.attach, null, `Span guy ${w.size}${w.nearIns&&!/^none$/i.test(w.nearIns)?` + ${w.nearIns}`:''}`, `span guy ${g.n}`, {bearing:g.bearing})));
  r.equipment.forEach(e=>push('equip', e.attach, null, `${e.name}`, e.cat, {weight:e.weight}));
  const lv = {}; items.forEach(it=>{ (lv[it.attach]=lv[it.attach]||{attach:it.attach, items:[]}).items.push(it); });
  const levels = Object.values(lv).sort((a,b)=>a.attach-b.attach);
  levels.forEach((L,i)=>{ L.gap = i<levels.length-1 ? Math.round((levels[i+1].attach - L.attach)*10)/10 : null; });
  return {r, levels, items};
}
const itemText = it => `${it.desc}${it.subs.size?` · ${[...it.subs].sort().join(', ')}`:''}`;
function spacingSection(P){
  const {r, levels} = spacingLevels(P);
  if (!levels.length) return '';
  const sp = specOf(P.R.poleSpec), hagIn = (P._hag||((sp.len&&r.head.setting!=null)?sp.len-r.head.setting:null)); const HAG = hagIn!=null ? hagIn*12 : null;
  const maxAtt = levels[levels.length-1].attach;
  const spanIn = HAG!=null ? HAG : maxAtt+48;
  const k = Math.min(1.6, 600/spanIn);            // px per inch, same both axes
  const y0 = 34, cx = 250, labX = 360, dimX = 150;
  const Y = a => y0 + a*k;
  const yG = y0 + spanIn*k;
  const spread = (ys, m) => { const out=[]; ys.forEach((y,i)=>out.push(i?Math.max(y,out[i-1]+m):y)); return out; };
  // labels: one per item, grouped by level order
  const labs = []; levels.forEach(L=>L.items.forEach(it=>labs.push({it, y:Y(L.attach), L})));
  const ly = spread(labs.map(l=>l.y), 17);
  const gaps = levels.filter(L=>L.gap!=null).map(L=>({L, y1:Y(L.attach), y2:Y(L.attach+L.gap)}));
  const gy = spread(gaps.map(g=>(g.y1+g.y2)/2), 14);
  const H = Math.max(yG, ly[ly.length-1]||0, gy[gy.length-1]||0) + 34;
  let g = '';
  // pole
  g += `<rect x="${cx-7}" y="${y0}" width="14" height="${yG-y0}" rx="3" style="fill:#8a6a45;opacity:.85"/>`;
  g += `<text x="${cx}" y="${y0-10}" text-anchor="middle" style="fill:var(--muted);font-size:12px">Pole top</text>`;
  if (HAG!=null){ g += `<line x1="${cx-120}" x2="${cx+120}" y1="${yG}" y2="${yG}" style="stroke:var(--ok);stroke-width:2"/><text x="${cx+124}" y="${yG+4}" style="fill:var(--ok);font-size:12px;font-weight:600">Ground · ${ftin(HAG)} to top</text>`; }
  // crossarms & items
  levels.forEach(L=>{ const y=Y(L.attach);
    const pw = L.items.filter(it=>['primary','neutral','secondary','other'].includes(it.cls));
    const offs = pw.flatMap(it=>[...it.offsets]);
    if (offs.length && (Math.max(...offs)-Math.min(...offs))>12){ const x1=cx+Math.min(0,...offs)*k-6, x2=cx+Math.max(0,...offs)*k+6; g += `<rect x="${x1}" y="${y-3}" width="${x2-x1}" height="6" rx="2" style="fill:var(--rule-strong)"/>`; }
    L.items.forEach(it=>{ const col=CLS[it.cls].c;
      if (it.cls==='guy'){ g += `<line x1="${cx-7}" y1="${y}" x2="${cx-52}" y2="${y+34}" style="stroke:${col};stroke-width:2"/>`; }
      else if (it.cls==='equip'){ g += `<rect x="${cx+9}" y="${y-7}" width="22" height="14" rx="2" style="fill:var(--surface);stroke:${col};stroke-width:1.5"/>`; }
      else { (it.offsets.size?[...it.offsets]:[0]).forEach(o=>{ g += `<circle cx="${cx+o*k}" cy="${y}" r="5" style="fill:${col};stroke:var(--surface);stroke-width:1.5"/>`; }); }
    });
  });
  // right labels with leaders
  labs.forEach((l,i)=>{ const col=CLS[l.it.cls].c; const xs = l.it.offsets.size?Math.max(...l.it.offsets)*k:0; const x0 = cx + Math.max(xs, l.it.cls==='equip'?31:8) + 6;
    g += `<path d="M${x0} ${l.y} L${labX-40} ${l.y} L${labX-8} ${ly[i]}" style="fill:none;stroke:var(--rule-strong);stroke-width:1"/>`;
    g += `<text x="${labX}" y="${ly[i]+4}" style="font-size:12px"><tspan style="fill:${col};font-weight:700">${esc(CLS[l.it.cls].n)}</tspan><tspan style="fill:var(--ink)"> ${esc(l.L.attach)}"${HAG!=null?` · ${ftin(HAG-l.L.attach)} AGL`:''}</tspan><tspan style="fill:var(--muted)"> ${esc(itemText(l.it).replace(/^(Primary|Neutral|Secondary|Comm|Guy) ?/,'').slice(0,52))}</tspan></text>`; });
  // left gap dimensions
  gaps.forEach((d,i)=>{ const x=dimX; g += `<line x1="${x}" x2="${x}" y1="${d.y1}" y2="${d.y2}" style="stroke:var(--muted);stroke-width:1"/><line x1="${x-4}" x2="${x+4}" y1="${d.y1}" y2="${d.y1}" style="stroke:var(--muted)"/><line x1="${x-4}" x2="${x+4}" y1="${d.y2}" y2="${d.y2}" style="stroke:var(--muted)"/>`;
    const mid=(d.y1+d.y2)/2; if (Math.abs(gy[i]-mid)>1) g += `<line x1="${x-6}" y1="${gy[i]}" x2="${x}" y2="${mid}" style="stroke:var(--rule-strong)"/>`;
    g += `<text x="${x-8}" y="${gy[i]+4}" text-anchor="end" style="fill:var(--ink);font-size:12px;font-weight:600">${d.L.gap}" <tspan style="fill:var(--muted);font-weight:400">${d.L.gap>=12?`(${ftin(d.L.gap)})`:''}</tspan></text>`; });
  g += `<text x="${dimX}" y="${y0-10}" text-anchor="middle" style="fill:var(--muted);font-size:12px">Gap</text>`;
  const svg = `<svg viewBox="0 0 800 ${Math.ceil(H)}" role="img" aria-label="Attachment diagram for pole ${esc(P.id)}"><title>Attachment heights and spacing on ${esc(P.id)}</title>${g}</svg>`;
  // separation summary
  const supply = levels.filter(L=>L.items.some(it=>['primary','other'].includes(it.cls))), comm = levels.filter(L=>L.items.some(it=>it.cls==='comm'));
  const neut = levels.filter(L=>L.items.some(it=>it.cls==='neutral'));
  const notes = [];
  if (supply.length && comm.length){ const sep = Math.min(...comm.map(L=>L.attach)) - Math.max(...supply.map(L=>L.attach)); notes.push(`Lowest primary to highest comm: <b>${sep}" (${ftin(sep)})</b>${sep<S.commSep?` <span class="pill warn">under ${S.commSep}"</span>`:''}`); }
  if (neut.length && comm.length){ const lowN=Math.max(...neut.map(L=>L.attach)); const sep = Math.min(...comm.map(L=>L.attach)) - lowN; if (sep>0) notes.push(`Lowest neutral to highest comm: <b>${sep}" (${ftin(sep)})</b>`); }
  if (supply.length && neut.length){ const sep = Math.min(...neut.map(L=>L.attach)) - Math.max(...supply.map(L=>L.attach)); notes.push(sep>0?`Lowest primary to neutral: <b>${sep}" (${ftin(sep)})</b>`:`Neutral is mounted above the lowest primary (${ftin(-sep)} higher)`); }
  const rows = levels.map((L,i)=>`<tr><td>${L.items.map(it=>`<div><span class="dot" style="background:${CLS[it.cls].c}"></span> <b style="font-weight:600">${esc(CLS[it.cls].n)}</b> <span class="muted">${esc(itemText(it).replace(/^(Primary|Neutral|Secondary|Comm|Guy) ?/,''))}</span></div>`).join('')}</td><td class="num">${L.attach}"</td><td class="num">${HAG!=null?ftin(HAG-L.attach):'–'}</td><td class="num">${L.gap!=null?`<b style="font-weight:600">${L.gap}"</b> <span class="muted">${ftin(L.gap)}</span>`:'<span class="muted">lowest</span>'}</td></tr>`).join('');
  TABLES['spacing'] = {cols:[{l:'Attachment',v:L=>L.items.map(it=>`${CLS[it.cls].n} ${itemText(it)}`).join(' / ')},{l:'From top (in)',v:L=>L.attach},{l:'Above ground (ft)',v:L=>HAG!=null?Math.round((HAG-L.attach)/12*100)/100:''},{l:'Gap to next below (in)',v:L=>L.gap}], rows:levels};
  return `<div class="sec"><h3>Attachment spacing <span class="muted" style="font-family:var(--sans);font-size:13px;font-weight:500">${esc(r.rule)} geometry, drawn to scale</span><span class="spacer"></span><button class="btn sm" data-copy="spacing">Copy table</button></h3>
  <div class="spacing"><div>${svg}<div class="legend" style="margin-top:8px">${Object.entries(CLS).filter(([k])=>levels.some(L=>L.items.some(it=>it.cls===k))).map(([k,v])=>`<span><i style="background:${v.c}"></i>${v.n}</span>`).join('')}</div></div>
  <div><div class="tscroll"><table><thead><tr><th>Attachment</th><th class="num">From top</th><th class="num">Above ground</th><th class="num">Gap to next</th></tr></thead><tbody>${rows}</tbody></table></div>
  ${notes.length?`<div class="gapnote">${notes.join('<br>')}</div>`:''}
  <p class="muted" style="font-size:12px;margin:8px 0 0">Heights come from each attachment's "Attach (in)" in the report, measured down from the pole top. Above ground uses pole length minus setting depth${HAG!=null?` (${ftin(HAG)})`:''}. Horizontal positions use the report offsets.</p></div></div></div>`;
}

/* generic sortable table */
const TABLES = {};
function table(id, cols, rows, opts={}){
  const s = SORT[id] || {k:opts.sort||cols[0].k, asc:opts.asc!==undefined?opts.asc:true};
  const col = cols.find(c=>c.k===s.k)||cols[0];
  rows = rows.slice().sort((a,b)=>{ const x=col.sv?col.sv(a):col.v(a), y=col.sv?col.sv(b):col.v(b); const c=(typeof x==='number'&&typeof y==='number')?x-y:natural(x??'',y??''); return s.asc?c:-c; });
  TABLES[id] = {cols, rows};
  return `<div class="tscroll"><table><thead><tr>${cols.map(c=>`<th class="s ${c.num?'num':''} ${s.k===c.k?'sorted':''}" data-sort="${c.k}" data-t="${id}">${esc(c.l)}${s.k===c.k?(s.asc?' ▲':' ▼'):''}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr class="${opts.click||opts.attr?'click':''}" ${opts.click?`data-pole="${esc(opts.click(r))}"`:''} ${opts.attr?opts.attr(r):''}>${cols.map(c=>`<td class="${c.num?'num':''}">${c.h?c.h(r):esc(c.v(r)??'–')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
async function copyTable(id){
  const t=TABLES[id]; if(!t) return;
  const txt=[t.cols.map(c=>c.l).join('\t'), ...t.rows.map(r=>t.cols.map(c=>{ const v=c.v(r); return v==null?'':String(v).replace(/[\t\n]/g,' '); }).join('\t'))].join('\n');
  let ok=false; try{ await navigator.clipboard.writeText(txt); ok=true; }catch(e){}
  if(!ok){ const ta=document.createElement('textarea'); ta.value=txt; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); try{ok=document.execCommand('copy');}catch(e){} ta.remove(); }
  toast(ok?`Copied ${t.rows.length} rows`:'Copy was blocked by the browser');
}


function renderCompare(){
  let rows = POLES.map(p=>{ const b=p.R.rules['250B'], c=p.R.rules['250C']; return {p, id:p.id, spec:p.R.poleSpec, rules:p.R.ruleOrder.join('+'), mb:b?metrics(b):{}, mc:c?metrics(c):null, setting:(b||{}).head?.setting, hag:p._hag, spans:(b||p.R.rules[p.R.ruleOrder[0]]).spans.length, anchors:(b||p.R.rules[p.R.ruleOrder[0]]).anchors.length, status:p._status, bad:p._counts.bad, warn:p._counts.warn}; });
  if (FIL.review) rows=rows.filter(r=>r.status!=='ok');
  if (FIL.status) rows=rows.filter(r=>r.status===FIL.status);
  if (FIL.rules) rows=rows.filter(r=>r.rules===FIL.rules);
  const govOf = r => { const items=[['pole',r.mb.horz,'250B pole horiz'],['pole',r.mb.vert,'250B pole vert'],['eq',r.mb.framing,'250B framing'],['eq',r.mb.guy,'250B guy'],['eq',r.mb.anchor,'250B anchor']];
    if (r.mc) items.push(['pole',r.mc.horz,'250C pole horiz'],['pole',r.mc.vert,'250C pole vert'],['eq',r.mc.framing,'250C framing'],['eq',r.mc.guy,'250C guy'],['eq',r.mc.anchor,'250C anchor']);
    let best={v:null,cls:'',what:''}; items.forEach(([k,v,w])=>{ if(v==null) return; const pct=v/TH(k)[1]*100; if(best.v==null||pct>best.v) best={v:pct,cls:lv(v,k),what:`${w} ${f0(v)}%`}; }); return best; };
  const maxOf = r => Math.max(...[r.mb.horz,r.mb.vert,r.mb.framing,r.mb.guy,r.mb.anchor,r.mc&&r.mc.horz,r.mc&&r.mc.vert,r.mc&&r.mc.framing,r.mc&&r.mc.guy,r.mc&&r.mc.anchor].filter(x=>x!=null));
  const cols=[
    {k:'id',l:'Pole',v:r=>r.id,h:r=>`<span class="dot ${r.status}"></span> <b>${esc(r.id)}</b>`},
    {k:'spec',l:'Height / class',v:r=>r.spec},
    {k:'rules',l:'Analyses',v:r=>r.rules},
    {k:'bh',l:'250B horiz',num:true,v:r=>r.mb.horz,h:r=>pctHtml(r.mb.horz,'pole')},
    {k:'ch',l:'250C horiz',num:true,v:r=>r.mc?r.mc.horz:null,h:r=>r.mc?pctHtml(r.mc.horz,'pole'):'<span class="muted">–</span>'},
    {k:'bv',l:'250B vert',num:true,v:r=>r.mb.vert,h:r=>pctHtml(r.mb.vert,'pole')},
    {k:'cv',l:'250C vert',num:true,v:r=>r.mc?r.mc.vert:null,h:r=>r.mc?pctHtml(r.mc.vert,'pole'):'<span class="muted">–</span>'},
    {k:'bf',l:'Framing B / C',num:true,v:r=>r.mb.framing,h:r=>`${pctHtml(r.mb.framing)}${r.mc?` / ${pctHtml(r.mc.framing)}`:''}`},
    {k:'bg',l:'Guy B / C',num:true,v:r=>r.mb.guy,h:r=>`${pctHtml(r.mb.guy)}${r.mc?` / ${pctHtml(r.mc.guy)}`:''}`},
    {k:'ba',l:'Anchor B / C',num:true,v:r=>r.mb.anchor,h:r=>`${pctHtml(r.mb.anchor)}${r.mc?` / ${pctHtml(r.mc.anchor)}`:''}`},
    {k:'max',l:'Governing (% of limit)',num:true,v:r=>govOf(r).v,h:r=>{ const g=govOf(r); return g.v==null?'–':`<div class="meter"><div class="tr"><i class="${g.cls}" style="width:${Math.min(g.v,100)}%"></i></div><span class="pct ${g.cls}">${f0(g.v)}%</span></div><div class="muted" style="font-size:11px;text-align:right">${esc(g.what)}</div>`; }},
    {k:'setting',l:'Setting',num:true,v:r=>r.setting,h:r=>r.setting!=null?r.setting+"'":'–'},
    {k:'spans',l:'Spans',num:true,v:r=>r.spans},
    {k:'anchors',l:'Anchors',num:true,v:r=>r.anchors},
    {k:'bad',l:'Errors',num:true,v:r=>r.bad,h:r=>r.bad?`<span class="pct bad">${r.bad}</span>`:'0'},
    {k:'warn',l:'Warnings',num:true,v:r=>r.warn,h:r=>r.warn?`<span class="pct warn">${r.warn}</span>`:'0'},
  ];
  const chart = POLES.map(p=>{ const b=p.R.rules['250B'], c=p.R.rules['250C']; const bh=b?.head.horz, ch=c?.head.horz; const mx=Math.max(110, ...POLES.flatMap(q=>q.R.ruleOrder.map(r=>q.R.rules[r].head.horz||0)));
    return `<div class="crow"><button class="link" data-pole="${esc(p.id)}" style="border:0;background:none;color:var(--blue);font-weight:600;text-align:left;padding:0">${esc(p.id)}</button><div class="cbars">${bh!=null?`<div class="cbar ${lv(bh,'pole')?'':''}" style="width:${bh/mx*100}%;${lv(bh,'pole')?`background:var(--${lv(bh,'pole')==='bad'?'bad':'amber-bar'})`:''}" title="250B ${bh}%"></div>`:''}${ch!=null?`<div class="cbar c" style="width:${ch/mx*100}%;${lv(ch,'pole')?`background:var(--${lv(ch,'pole')==='bad'?'bad':'amber-bar'})`:''}" title="250C ${ch}%"></div>`:''}<span class="wl" style="left:${S.poleWarn/mx*100}%"></span><span class="lim" style="left:${S.poleFail/mx*100}%"></span></div></div>`; }).join('');
  return `<div class="viewbar"><h2>Compare poles</h2><button class="btn sm" data-copy="compare">Copy table</button><div class="hint">Click a row to open the pole. Governing is the highest percentage anywhere on the pole under either rule.</div></div>
  <div class="filters">${reviewToggle()}<select data-fil="status" aria-label="Status"><option value="">All statuses</option><option value="bad" ${FIL.status==='bad'?'selected':''}>Needs attention</option><option value="warn" ${FIL.status==='warn'?'selected':''}>Review</option><option value="ok" ${FIL.status==='ok'?'selected':''}>Clean</option></select><select data-fil="rules" aria-label="Analyses"><option value="">250B and 250B + 250C</option><option value="250B+250C" ${FIL.rules==='250B+250C'?'selected':''}>250B + 250C only</option><option value="250B" ${FIL.rules==='250B'?'selected':''}>250B only</option></select></div>
  ${table('compare', cols, rows, {click:r=>r.id})}
  <div class="sec"><h3>Horizontal pole loading along the line</h3><div class="legend"><span><i style="background:var(--blue)"></i>250B</span><span><i style="background:var(--c)"></i>250C</span><span><i style="border-top:2px dotted var(--amber-bar);height:0"></i>Preferred max ${S.poleWarn}%</span><span><i style="border-top:2px dashed var(--bad);height:0"></i>Limit ${S.poleFail}%</span></div><div class="chart">${chart}</div></div>`;
}

function renderSpans(){
  const rowsC = CONN.filter(c=>!c.B || natural(c.A.id,c.B.id)<0 || !c.t);
  const stH = c => ({ok:'<span class="pill ok">Match</span>',open:'<span class="pill none">Pole not loaded</span>',gps:'<span class="pill warn">Length vs GPS</span>',noback:'<span class="pill warn">No span back</span>',len:'<span class="pill warn">Length mismatch</span>',cond:'<span class="pill warn">Conductor mismatch</span>'}[c.state]||'');
  const pcols=[
    {k:'from',l:'From',v:r=>r.A.id},{k:'sn',l:'Span',num:true,v:r=>r.s.n},
    {k:'to',l:'To',v:r=>r.B?r.B.id:'not loaded',h:r=>r.B?`<b>${esc(r.B.id)}</b>`:'<span class="muted">not in this set</span>'},
    {k:'la',l:'Length here',num:true,v:r=>r.s.length,h:r=>`${r.s.length}' <span class="muted">${r.s.bearing}°</span>`},
    {k:'lb',l:'Length on other pole',num:true,v:r=>r.t?r.t.length:null,h:r=>r.t?`${r.t.length}' <span class="muted">span ${r.t.n}, ${r.t.bearing}°</span>`:'–'},
    {k:'gps',l:'Distance from coordinates',num:true,v:r=>r.dist!=null?Math.round(r.dist*10)/10:null,h:r=>r.dist!=null?f1(r.dist)+"'":'–'},
    {k:'st',l:'Check',v:r=>r.state,h:stH},
    {k:'cond',l:'Conductors',v:r=>r.s.wires.map(w=>`${w.kind}: ${w.conductor}`).join('; ')},
  ];
  const all = POLES.flatMap(P=>{ const r=P.R.rules['250B']||P.R.rules[P.R.ruleOrder[0]]; const c=P.R.rules['250C']; return r.spans.map(s=>({P, s, sc:c&&c.spans.find(x=>x.n===s.n)})); });
  const acols=[
    {k:'pole',l:'Pole',v:r=>r.P.id},{k:'n',l:'Span',num:true,v:r=>r.s.n},{k:'len',l:'Length (ft)',num:true,v:r=>r.s.length},{k:'brg',l:'Bearing',num:true,v:r=>r.s.bearing,h:r=>r.s.bearing+'°'},
    {k:'wires',l:'Wires',v:r=>r.s.wires.map(w=>`${w.kind} ${w.conductor}`).join('; ')||'none'},
    {k:'tb',l:'Primary tension B',num:true,v:r=>(r.s.wires.find(w=>/primary/i.test(w.kind))||{}).tension??null,h:r=>f0((r.s.wires.find(w=>/primary/i.test(w.kind))||{}).tension)},
    {k:'tc',l:'Primary tension C',num:true,v:r=>r.sc?((r.sc.wires.find(w=>/primary/i.test(w.kind))||{}).tension??null):null,h:r=>r.sc?f0((r.sc.wires.find(w=>/primary/i.test(w.kind))||{}).tension):'–'},
    {k:'ang',l:'Max line angle',num:true,v:r=>Math.max(0,...r.s.wires.flatMap(w=>w.phases.map(p=>p.angle||0))),h:r=>f1(Math.max(0,...r.s.wires.flatMap(w=>w.phases.map(p=>p.angle||0))))+'°'},
    {k:'comm',l:'Comm cables',num:true,v:r=>r.s.comms.length},
    {k:'sag',l:'Comm sag (in)',num:true,v:r=>r.s.comms[0]?.sag??null},
  ];
  return `<div class="viewbar"><h2>Span connections</h2><button class="btn sm" data-copy="pairs">Copy table</button><div class="hint">Each span is followed along its bearing using the pole coordinates in the reports. When it lands on another loaded pole, that pole's span back is compared. Tolerance: ${S.spanFt} ft or ${S.spanPct}%, ${S.ang}° bearing, adjustable in Settings.</div></div>
  ${table('pairs', pcols, rowsC, {sort:'from', click:r=>r.A.id})}
  <div class="viewbar" style="margin-top:22px"><h2>Every span</h2><button class="btn sm" data-copy="allspans">Copy table</button></div>
  ${table('allspans', acols, all, {sort:'pole', click:r=>r.P.id})}`;
}

function renderGuying(){
  const rows = POLES.flatMap(P=>{ const r=P.R.rules['250B']||P.R.rules[P.R.ruleOrder[0]]; const c=P.R.rules['250C']; return r.anchors.flatMap(a=>{ const ac=c&&c.anchors.find(x=>x.n===a.n); return a.wires.map((w,i)=>({P,a,w,i,wc:ac&&ac.wires[i],ac})); }); });
  const cols=[
    {k:'pole',l:'Pole',v:r=>r.P.id},{k:'an',l:'Anchor',num:true,v:r=>r.a.n},{k:'lead',l:'Lead (ft)',num:true,v:r=>r.a.lead},{k:'brg',l:'Bearing',num:true,v:r=>r.a.bearing,h:r=>r.a.bearing+'°'},
    {k:'ratio',l:'Lead : height',num:true,v:r=>r.a._ratio!=null?Math.round(r.a._ratio*100)/100:null,h:r=>r.a._ratio!=null?(r.a._ratio<S.lead?`<span class="pct warn">${r.a._ratio.toFixed(2)}</span>`:r.a._ratio.toFixed(2)):'–'},
    {k:'size',l:'Guy',v:r=>r.w.size},{k:'att',l:'Attach (in)',num:true,v:r=>r.w.attach},
    {k:'ten',l:'Tension B',num:true,v:r=>r.w.tension,h:r=>f0(r.w.tension)},{k:'wl',l:'Wire % B',num:true,v:r=>r.w.load,h:r=>meter(r.w.load)},
    {k:'wlc',l:'Wire % C',num:true,v:r=>r.wc?r.wc.load:null,h:r=>r.wc?meter(r.wc.load,'c'):'<span class="muted">–</span>'},
    {k:'ins',l:'Insulator',v:r=>r.w.insulator},
    {k:'atype',l:'Anchor',v:r=>r.a.anchor?`${r.a.anchor.type} / ${r.a.anchor.rod}`:''},
    {k:'al',l:'Anchor % B',num:true,v:r=>r.a.anchor?.load??null,h:r=>pctHtml(r.a.anchor?.load)},
    {k:'rl',l:'Rod % B',num:true,v:r=>r.a.anchor?.rodLoad??null,h:r=>pctHtml(r.a.anchor?.rodLoad)},
    {k:'alc',l:'Anchor % C',num:true,v:r=>r.ac&&r.ac.anchor?r.ac.anchor.load:null,h:r=>r.ac&&r.ac.anchor?pctHtml(r.ac.anchor.load):'<span class="muted">–</span>'},
  ];
  const sg = POLES.flatMap(P=>{ const r=P.R.rules['250B']||P.R.rules[P.R.ruleOrder[0]]; const c=P.R.rules['250C']; return (r.spanGuys||[]).flatMap(g=>{ const gc=c&&(c.spanGuys||[]).find(x=>x.n===g.n); return g.wires.map((w,i)=>({P,g,w,wc:gc&&gc.wires[i]})); }); });
  const sgcols=[{k:'pole',l:'Pole',v:r=>r.P.id},{k:'n',l:'Span',num:true,v:r=>r.g.n},{k:'len',l:'Length (ft)',num:true,v:r=>r.g.length},{k:'brg',l:'Bearing',num:true,v:r=>r.g.bearing,h:r=>r.g.bearing+'°'},{k:'size',l:'Guy',v:r=>r.w.size},{k:'att',l:'Attach (in)',num:true,v:r=>r.w.attach},{k:'ten',l:'Tension B',num:true,v:r=>r.w.tension,h:r=>f0(r.w.tension)},{k:'wl',l:'Wire % B',num:true,v:r=>r.w.load,h:r=>meter(r.w.load)},{k:'wlc',l:'Wire % C',num:true,v:r=>r.wc?r.wc.load:null,h:r=>r.wc?meter(r.wc.load,'c'):'<span class="muted">–</span>'},{k:'ni',l:'Near insulator',v:r=>r.w.nearIns},{k:'nl',l:'Near %',num:true,v:r=>r.w.nearLoad,h:r=>pctHtml(r.w.nearLoad)},{k:'fi',l:'Far insulator',v:r=>r.w.farIns},{k:'fl',l:'Far %',num:true,v:r=>r.w.farLoad,h:r=>pctHtml(r.w.farLoad)}];
  const sgHtml = sg.length ? `<div class="viewbar" style="margin-top:22px"><h2>Span guys</h2><button class="btn sm" data-copy="spanguys">Copy table</button></div>${table('spanguys', sgcols, sg, {sort:'pole', click:r=>r.P.id})}` : '';
  if (!rows.length) return sg.length ? sgHtml : `<p class="muted">No guying in these reports.</p>`;
  return `<div class="viewbar"><h2>All guys and anchors</h2><button class="btn sm" data-copy="guys">Copy table</button><div class="hint">One row per guy wire. Lead : height uses pole length minus setting depth, less the highest guy's attachment (measured down from the pole top).</div></div>${table('guys', cols, rows, {sort:'pole', click:r=>r.P.id})}${sgHtml}`;
}

function renderEquip(){
  const eq = POLES.flatMap(P=>{ const r=P.R.rules['250B']||P.R.rules[P.R.ruleOrder[0]]; return r.equipment.map(e=>({P,e})); });
  const newItems = [];
  POLES.forEach(P=>{ const r=P.R.rules['250B']||P.R.rules[P.R.ruleOrder[0]]; const seen=new Set();
    const addN=(what,item,where)=>{ const k=what+'|'+item; if(seen.has(k)) return; seen.add(k); newItems.push({P,what,item,where}); };
    r.spans.forEach(s=>s.wires.forEach(w=>{ if (!/^\(L\)/.test(w.conductor)) addN('Conductor', `${w.kind}: ${w.conductor}`, `span ${s.n}`); w.phases.forEach(p=>{ if (p.bracket && !/^\(L\)/.test(p.bracket) && !/^(None|Eye Bolt|Machine Bolt|Spool Rack)$/i.test(p.bracket)) addN('Bracket', p.bracket, `span ${s.n} ${p.phase}`); if (p.insulator && !/^\(L\)/.test(p.insulator) && !/^(None|Neutral Dead End|3" Spool)$/i.test(p.insulator)) addN('Insulator', p.insulator, `span ${s.n} ${p.phase}`); }); }));
    (r.spanGuys||[]).forEach(g=>g.wires.forEach(w=>addN('Span guy', `${w.size}${w.nearIns&&!/^none$/i.test(w.nearIns)?` with ${w.nearIns}`:''}`, `span guy ${g.n}`)));
    r.anchors.forEach(a=>{ addN('Anchor', a.anchor?`${a.anchor.type}, ${a.anchor.rod}`:'(no anchor data)', `anchor ${a.n}`); a.wires.forEach(w=>addN('Guy', `${w.size}${w.insulator&&w.insulator!=='None'?` with ${w.insulator}`:''}`, `anchor ${a.n}`)); });
    if (/non-s/i.test(P.R.poleSpec)) addN('Pole', P.R.poleSpec, 'pole');
  });
  const ecols=[{k:'pole',l:'Pole',v:r=>r.P.id},{k:'cat',l:'Type',v:r=>r.e.cat},{k:'name',l:'Item',v:r=>r.e.name},{k:'att',l:'Attach (in)',num:true,v:r=>r.e.attach},{k:'wt',l:'Weight (lb)',num:true,v:r=>r.e.weight},{k:'dir',l:'Direction',num:true,v:r=>r.e.dir,h:r=>f1(r.e.dir)+'°'}];
  const ncols=[{k:'pole',l:'Pole',v:r=>r.P.id},{k:'what',l:'Type',v:r=>r.what},{k:'item',l:'Item',v:r=>r.item},{k:'where',l:'Where',v:r=>r.where}];
  const tally={}; newItems.forEach(n=>{ const k=n.what+': '+n.item; tally[k]=(tally[k]||0)+1; });
  return `<div class="viewbar"><h2>Equipment</h2>${eq.length?'<button class="btn sm" data-copy="equip">Copy table</button>':''}</div>${eq.length?table('equip', ecols, eq, {sort:'pole', click:r=>r.P.id}):'<p class="muted">No equipment modeled.</p>'}
  <div class="viewbar" style="margin-top:22px"><h2>New work</h2><button class="btn sm" data-copy="newwork">Copy table</button><div class="hint">Items without the (L) existing prefix, plus all guys and anchors (PoleForeman doesn't mark those). Confirm against the design before building a material list.</div></div>
  <div class="tscroll" style="margin-bottom:12px"><table><thead><tr><th>Item</th><th class="num">Poles</th></tr></thead><tbody>${Object.entries(tally).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`).join('')}</tbody></table></div>
  ${table('newwork', ncols, newItems, {sort:'pole', click:r=>r.P.id})}`;
}

function pfBody(P){
  const R=P.R, rules=R.ruleOrder, b=R.rules['250B'], c=R.rules['250C'];
  let h='';
  h += spacingSection(P);
  // rule comparison
  const cols = rules.map(r=>({r, o:R.rules[r], m:metrics(R.rules[r])}));
  const row = (lab, fn, fmt) => `<tr><th>${lab}</th>${cols.map(x=>`<td class="${x.r==='250C'?'c':''}">${fmt?fmt(fn(x)):esc(fn(x)??'–')}</td>`).join('')}</tr>`;
  const pfk = (x,k) => pfPill(P.pf[`${x.r}|comp|${k}`] || P.pf[`summary|${x.r}|${k==='Pole'?'poleH':k.toLowerCase()}`]);
  h += `<div class="sec"><h3>Analysis summary</h3><div class="tscroll"><table class="cmp"><thead><tr><th></th>${cols.map(x=>`<th class="${x.r==='250C'?'c':''}">${x.r}</th>`).join('')}</tr></thead><tbody>
    ${row('Pole horizontal', x=>x.m.horz, v=>meter(v,'','pole'))}${row('Pole vertical', x=>x.m.vert, v=>meter(v,'','pole'))}${row('Max framing', x=>x.m.framing, meter)}${row('Max guy wire / insulator', x=>x.m.guy, meter)}${row('Max anchor / rod', x=>x.m.anchor, meter)}
    <tr><th>PoleForeman status</th>${cols.map(x=>`<td class="${x.r==='250C'?'c':''}"><div class="chips">${['Pole','Framings','Guying'].map(k=>`<span title="${k}">${k}: ${pfk(x,k)}</span>`).join('')}</div></td>`).join('')}</tr>
    ${row('Conditions', x=>`${x.o.head.temp}° · ${x.o.head.wind} ${x.o.head.windUnit||''} · ${x.o.head.ice??0}" ice · ${x.o.head.state||''}`)}
    ${row('Grade / district', x=>`${x.o.head.grade||''} · ${x.o.head.district||''}`)}
    ${row('Pole factors T / W / V / SF', x=>{const n=x.o.nesc.Pole; return n?`${n.tension} / ${n.wind} / ${n.vertical} / ${n.sf}`:'–';})}
    ${row('Guy factors T / W / V / SF', x=>{const n=x.o.nesc.Guy; return n?`${n.tension} / ${n.wind} / ${n.vertical} / ${n.sf}`:'–';})}
    ${row('Setting depth / soil', x=>`${x.o.head.setting}' · ${x.o.head.soil||''}`)}
    ${row('Strength remaining', x=>x.o.head.strength!=null?x.o.head.strength+'%':'–')}
    ${row('Location', x=>`${x.o.head.lat}, ${x.o.head.lon}`)}
  </tbody></table></div></div>`;
  // spans
  const base = b || R.rules[rules[0]];
  h += `<div class="sec"><h3>Spans</h3>`;
  base.spans.forEach(s=>{
    const sc = c && c.spans.find(x=>x.n===s.n);
    const st = P.pf[`${base.rule}|span|${s.n}`];
    h += `<h4 style="margin:12px 0 6px;font-size:16px">Span ${s.n}: ${s.length}' at ${s.bearing}° ${st&&st!=='pass'?pfPill(st):''}</h4>`;
    if (!s.wires.length && !s.comms.length){ h+=`<p class="muted">No conductors or cables on this span.</p>`; return; }
    h += `<div class="tscroll"><table><thead><tr><th>Wire</th><th>Phase</th><th class="num">Attach (in)</th><th class="num">Offset</th><th>Bracket</th><th>Bracket %</th><th>Insulator</th><th>Insulator %</th><th class="num">Line angle</th><th class="num">Design tension</th></tr></thead><tbody>`;
    s.wires.forEach((w,i)=>{ const wc = sc && sc.wires[i];
      w.phases.forEach((p,j)=>{ const pc = wc && wc.phases[j];
        const two = (a,b2,mode,modeC) => `${pctHtml(a)}${mode?` <span class="muted">${esc(mode)}</span>`:''}${c?` <span style="color:var(--c)">/ C ${b2==null?'–':f0(b2)+'%'}</span>`:''}`;
        h += `<tr><td>${j===0?`<b>${esc(w.kind)}</b><br><span class="muted" style="font-size:12px">${esc(w.conductor)}</span>`:''}</td><td>${esc(p.phase)}</td><td class="num">${p.attach}</td><td class="num">${p.offset}</td><td>${esc(p.bracket)}</td><td>${two(p.bracketLoad, pc&&pc.bracketLoad, p.bracketMode)}</td><td>${esc(p.insulator)}</td><td>${two(p.insLoad, pc&&pc.insLoad, p.insMode)}</td><td class="num">${f1(p.angle)}°</td><td class="num">${j===0?`${f0(w.tension)}${wc?` <span style="color:var(--c)">/ ${f0(wc.tension)}</span>`:''}`:''}</td></tr>`;
      });
    });
    s.comms.forEach((m,i)=>{ const mc = sc && sc.comms[i]; h += `<tr><td><b>Comm</b><br><span class="muted" style="font-size:12px">${esc(m.cable)}${m.owner?`, ${esc(m.owner)}`:''}</span></td><td></td><td class="num">${m.attach}</td><td class="num">${m.offset}</td><td colspan="4" class="muted">Sag ${m.sag} in${mc?` / C ${mc.sag} in`:''}, ruling span ${m.ruling}'</td><td></td><td class="num">${f0(m.tension)}${mc?` <span style="color:var(--c)">/ ${f0(mc.tension)}</span>`:''}</td></tr>`; });
    h += `</tbody></table></div>`;
  });
  if (c) h += `<p class="muted" style="font-size:13px">Where two values appear, the second (purple) is the 250C result.</p>`;
  h += `</div>`;
  if (base.anchors.length){
    h += `<div class="sec"><h3>Guying</h3>`;
    base.anchors.forEach(a=>{ const ac = c && c.anchors.find(x=>x.n===a.n); const st=P.pf[`${base.rule}|anchor|${a.n}`];
      h += `<h4 style="margin:12px 0 6px;font-size:16px">Anchor ${a.n}: ${a.lead}' lead at ${a.bearing}° ${a._ratio?`<span class="muted" style="font-family:var(--sans);font-size:13px;font-weight:500">lead:height ${a._ratio.toFixed(2)}</span>`:''} ${st&&st!=='pass'?pfPill(st):''}</h4>
      <div class="tscroll"><table><thead><tr><th>Guy</th><th class="num">Attach (in)</th><th class="num">Tension (lbs)</th><th class="num">Strength</th><th>Wire %</th><th>Insulator</th><th>Insulator %</th></tr></thead><tbody>
      ${a.wires.map((w,i)=>{ const wc=ac&&ac.wires[i]; return `<tr><td>${esc(w.size)}</td><td class="num">${w.attach}</td><td class="num">${f0(w.tension)}${wc?` <span style="color:var(--c)">/ ${f0(wc.tension)}</span>`:''}</td><td class="num">${f0(w.strength)}</td><td>${pctHtml(w.load)}${wc?` <span style="color:var(--c)">/ C ${f0(wc.load)}%</span>`:''}</td><td>${esc(w.insulator)}</td><td>${pctHtml(w.insLoad)}</td></tr>`; }).join('')}
      ${a.anchor?`<tr><td colspan="2"><b>${esc(a.anchor.type)}</b> <span class="muted">${esc(a.anchor.soil)} soil, ${esc(a.anchor.rod)}</span></td><td class="num">${f0(a.anchor.tension)}${ac&&ac.anchor?` <span style="color:var(--c)">/ ${f0(ac.anchor.tension)}</span>`:''}</td><td class="num">${f0(a.anchor.holding)}</td><td>Anchor ${pctHtml(a.anchor.load)}${ac&&ac.anchor?` <span style="color:var(--c)">/ C ${f0(ac.anchor.load)}%</span>`:''}</td><td>Rod ${f0(a.anchor.rodStrength)} lbs</td><td>${pctHtml(a.anchor.rodLoad)}</td></tr>`:''}
      </tbody></table></div>`; });
    h += `</div>`;
  }
  if ((base.spanGuys||[]).length){
    h += `<div class="sec"><h3>Span guys</h3>`;
    base.spanGuys.forEach(g=>{ const gc = c && (c.spanGuys||[]).find(x=>x.n===g.n); const st=P.pf[`${base.rule}|spanguy|${g.n}`];
      h += `<h4 style="margin:12px 0 6px;font-size:16px">Span ${g.n}: ${g.length}' at ${g.bearing}° ${st&&st!=='pass'?pfPill(st):''}</h4><div class="tscroll"><table><thead><tr><th>Guy</th><th class="num">Attach (in)</th><th class="num">Tension (lbs)</th><th class="num">Strength</th><th>Wire %</th><th>Near insulator</th><th>Near %</th><th>Far insulator</th><th>Far %</th></tr></thead><tbody>
      ${g.wires.map((w,i)=>{ const wc=gc&&gc.wires[i]; return `<tr><td>${esc(w.size)}</td><td class="num">${w.attach}</td><td class="num">${f0(w.tension)}${wc?` <span style="color:var(--c)">/ ${f0(wc.tension)}</span>`:''}</td><td class="num">${f0(w.strength)}</td><td>${pctHtml(w.load)}${wc?` <span style="color:var(--c)">/ C ${f0(wc.load)}%</span>`:''}</td><td>${esc(w.nearIns)}</td><td>${pctHtml(w.nearLoad)}${wc&&wc.nearLoad!=null?` <span style="color:var(--c)">/ C ${f0(wc.nearLoad)}%</span>`:''}</td><td>${esc(w.farIns)}</td><td>${pctHtml(w.farLoad)}</td></tr>`; }).join('')}</tbody></table></div>`; });
    h += `</div>`;
  }
  if (base.equipment.length) h += `<div class="sec"><h3>Equipment</h3><div class="tscroll"><table><thead><tr><th>Type</th><th>Item</th><th class="num">Attach (in)</th><th class="num">Weight (lb)</th><th class="num">Direction</th></tr></thead><tbody>${base.equipment.map(e=>`<tr><td>${esc(e.cat)}</td><td>${esc(e.name)}</td><td class="num">${e.attach}</td><td class="num">${f0(e.weight)}</td><td class="num">${f1(e.dir)}°</td></tr>`).join('')}</tbody></table></div></div>`;
  h += `<p class="muted" style="font-size:12px">${esc(P.fileName)} · pages ${P.pageNos[0]}–${P.pageNos[P.pageNos.length-1]} of the file · ${esc(R.sw)} / DB ${esc(R.db)} · run by ${esc(R.user)} on ${esc(R.date)}</p>`;
  return h;
}

function locText(l){ if (!l) return ''; if (l.sketch) return 'Job sketch'; const d=DOCS.find(x=>x.id===l.doc); return d ? `${d.name}${l.page?`, p. ${l.page}`:''}` : ''; }
function renderIssues(){
  let rows = ISS.slice();
  if (FIL.sev) rows = rows.filter(i=>i.sev===FIL.sev);
  if (FIL.cat) rows = rows.filter(i=>i.cat===FIL.cat);
  const q=FIL.q.trim().toLowerCase(); if (q) rows=rows.filter(i=>(i.pole+' '+i.title+' '+i.detail+' '+i.cat+' '+i.src).toLowerCase().includes(q));
  const cats=[...new Set(ISS.map(i=>i.cat))].sort();
  const cols=[
    {k:'sev',l:'Severity',v:r=>SEVN[r.sev],sv:r=>({bad:0,warn:1,info:2}[r.sev]),h:r=>`<span class="pill ${r.sev}">${SEVN[r.sev]}</span>`},
    {k:'pole',l:'Pole',v:r=>r.pole,h:r=>r.pole==='Project'?'<span class="muted">Package</span>':`<button class="link" data-pole="${esc(r.pole)}">${esc(r.pole)}</button>`},{k:'cat',l:'Area',v:r=>r.cat},
    {k:'title',l:'Finding',v:r=>r.title,h:r=>`<b style="font-weight:600;white-space:normal">${esc(r.title)}</b>${r.detail?`<span class="muted" style="white-space:normal;display:block;min-width:240px;font-size:13px">${esc(r.detail)}</span>`:''}`},
    {k:'where',l:'Where',v:r=>locText(r.loc),h:r=>r.loc?`<span class="where">${esc(locText(r.loc))} →</span>`:'<span class="muted">–</span>'},
  ];
  const c=s=>ISS.filter(i=>i.sev===s).length;
  return `<div class="viewbar"><h2>Issues</h2><button class="btn sm primary" data-xlsx="1">Download for designer (Excel)</button><button class="btn sm" data-sc="1">Download QAQC scorecard</button><button class="btn sm" data-copy="issues">Copy table</button><div class="hint">${c('bad')} errors, ${c('warn')} warnings, ${c('info')} notes. Click a finding to open the document where it is.</div></div>
  <div class="filters"><input type="search" data-fil="q" value="${esc(FIL.q)}" placeholder="Search findings" aria-label="Search findings"><select data-fil="sev" aria-label="Severity"><option value="">All severities</option><option value="bad" ${FIL.sev==='bad'?'selected':''}>Errors</option><option value="warn" ${FIL.sev==='warn'?'selected':''}>Warnings</option><option value="info" ${FIL.sev==='info'?'selected':''}>Notes</option></select><select data-fil="cat" aria-label="Area"><option value="">All areas</option>${cats.map(x=>`<option ${FIL.cat===x?'selected':''}>${esc(x)}</option>`).join('')}</select></div>
  ${rows.length?table('issues', cols, rows, {sort:'sev', attr:r=>`data-iss="${ISS.indexOf(r)}"`}):'<p class="muted">Nothing matches.</p>'}`;
}



/* ---------- QAQC scorecard ---------- */
const XNS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const colNum = c => { let n=0; for (const ch of c) n = n*26 + ch.charCodeAt(0) - 64; return n; };
const colName = n => { let s=''; while (n>0){ const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=Math.floor((n-1)/26); } return s; };
const b64buf = b64 => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u.buffer; };
let JSZIPP = null; function zipLib(){ if (window.JSZip) return Promise.resolve(window.JSZip); if (!JSZIPP) JSZIPP = loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js').then(()=>window.JSZip); return JSZIPP; }
class XSheet {
  constructor(xml){ this.doc = new DOMParser().parseFromString(xml, 'application/xml'); this.sd = this.doc.getElementsByTagNameNS(XNS,'sheetData')[0]; this.rows = new Map(); for (const r of [...this.sd.getElementsByTagNameNS(XNS,'row')]) this.rows.set(+r.getAttribute('r'), r); }
  row(n){ let r = this.rows.get(n); if (r){ r.removeAttribute('spans'); return r; } r = this.doc.createElementNS(XNS,'row'); r.setAttribute('r', n); const after = [...this.rows.keys()].filter(k=>k>n).sort((a,b)=>a-b)[0]; this.sd.insertBefore(r, after!=null ? this.rows.get(after) : null); this.rows.set(n, r); return r; }
  find(ref){ const m = ref.match(/^([A-Z]+)(\d+)$/); const r = this.rows.get(+m[2]); if (!r) return null; for (const c of r.getElementsByTagNameNS(XNS,'c')) if (c.getAttribute('r')===ref) return c; return null; }
  cell(ref){ const m = ref.match(/^([A-Z]+)(\d+)$/); const cn = colNum(m[1]); const r = this.row(+m[2]); let before = null; for (const c of [...r.getElementsByTagNameNS(XNS,'c')]){ const cc = colNum(c.getAttribute('r').replace(/\d+/,'')); if (cc===cn) return c; if (cc>cn){ before=c; break; } } const c = this.doc.createElementNS(XNS,'c'); c.setAttribute('r', ref); r.insertBefore(c, before); return c; }
  set(ref, v, style){
    const c = this.cell(ref);
    while (c.firstChild) c.removeChild(c.firstChild);
    ['t','cm','vm'].forEach(a=>c.removeAttribute(a));
    if (style!=null && !c.getAttribute('s')) c.setAttribute('s', style);
    if (v==null || v==='') return;
    if (typeof v==='number'){ const e=this.doc.createElementNS(XNS,'v'); e.textContent=String(v); c.appendChild(e); return; }
    c.setAttribute('t','inlineStr'); const is=this.doc.createElementNS(XNS,'is'), t=this.doc.createElementNS(XNS,'t');
    t.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve'); t.textContent=String(v); is.appendChild(t); c.appendChild(is);
  }
  text(ref, sst){ const c=this.find(ref); if (!c) return null; const t=c.getAttribute('t'); if (t==='inlineStr') return [...c.getElementsByTagNameNS(XNS,'t')].map(x=>x.textContent).join(''); const v=c.getElementsByTagNameNS(XNS,'v')[0]; if (!v) return null; return t==='s' ? sst[+v.textContent] : v.textContent; }
  xml(){ return new XMLSerializer().serializeToString(this.doc); }
}
async function scOpen(bytes){
  const JSZip = await zipLib(); const zip = await JSZip.loadAsync(bytes);
  const wbx = await zip.file('xl/workbook.xml').async('string'); const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const sheets = {}; for (const m of wbx.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)){ const t = (rels.match(new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${m[2]}"`))||[]); const target = t[1]||t[2]; if (target) sheets[m[1].replace(/&amp;/g,'&')] = 'xl/' + target.replace(/^\/?xl\//,''); }
  const sstf = zip.file('xl/sharedStrings.xml'); let sst = [];
  if (sstf){ const d = new DOMParser().parseFromString(await sstf.async('string'),'application/xml'); sst = [...d.getElementsByTagNameNS(XNS,'si')].map(si=>[...si.getElementsByTagNameNS(XNS,'t')].map(t=>t.textContent).join('')); }
  return { zip, wbx, sheets, sst };
}
async function scTemplate(){
  try { const d = await db(); const r = await new Promise(res=>{ const q=d.transaction('docs').objectStore('docs').get('__scoretpl'); q.onsuccess=()=>res(q.result); q.onerror=()=>res(null); }); if (r && r.bytes) return { bytes:r.bytes, name:r.name, custom:true }; } catch(e){}
  return { bytes: b64buf(SC_TPL_B64), name:'built-in template (8-21-26)', custom:false };
}
let SCLISTS = null;
async function scLists(){
  if (SCLISTS) return SCLISTS;
  try {
    const T = await scTemplate(); const W = await scOpen(T.bytes.slice(0)); const ref = W.sheets['Ref'];
    const L = { designers:[], qc:[], programs:[], tpl:T.name, custom:T.custom };
    if (ref){ const s = new XSheet(await W.zip.file(ref).async('string'));
      for (let r=6;r<200;r++){ const h=s.text('H'+r, W.sst), l=s.text('L'+r, W.sst), j=s.text('J'+r, W.sst); if (h) L.designers.push(h.trim()); if (l) L.qc.push(l.trim()); if (j) L.programs.push(j.trim()); } }
    SCLISTS = L;
  } catch(e){ console.warn(e); SCLISTS = { designers:[], qc:[], programs:['Revenue','Reliability','Resiliency'], tpl:'unavailable', custom:false }; }
  return SCLISTS;
}
async function saveTemplate(file){
  const bytes = await file.arrayBuffer();
  try { const W = await scOpen(bytes.slice(0)); if (!W.sheets['Design Scorecard'] || !W.sheets['Maximo Upload']) throw new Error('That workbook has no Design Scorecard / Maximo Upload sheets.'); }
  catch(e){ toast(e.message || 'Not a scorecard template'); return false; }
  await dbPut({ id:'__scoretpl', name:file.name, kind:'scoretpl', bytes, added:Date.now() }); SCLISTS = null; await scLists(); toast(`Scorecard template set to ${file.name}`); if (TAB==='settings') render(); return true;
}
async function resetTemplate(){ await dbDel('__scoretpl'); SCLISTS = null; await scLists(); toast('Using the built-in scorecard template'); if (TAB==='settings') render(); }

/* CU-level suggestions for the Maximo Upload sheet */
function sysLN(){ const v = SK?.K.fields.voltage || JK?.data.ocr?.voltage || PKG.ifc?.data.meta.voltage; const kv = pfNum(v); return kv ? { kv, ln: kv*1000/Math.sqrt(3) } : null; }
function cuFixes(s){
  const out = {}; const cus = s.st?.cus || []; if (!cus.length) return out;
  const put = (i, cls, fix) => { if (!out[i]) out[i] = { cls, fix }; else if (out[i].cls!==cls) { out[i].cls = 'Multiple Issues'; out[i].fix += ' ' + fix; } };
  const seen = {}; cus.forEach((c,i)=>{ const k=`${c.cu}|${c.wf}`; if (seen[k]!=null) put(i,'Duplicate CU',`${c.cu} (${WFN[c.wf]||c.wf}) is listed twice.`); else seen[k]=i; });
  if (s.d.agI.length) cus.forEach((c,i)=>{ if (c.wf==='I' && CU.gsi(c)) put(i,'CU Not Needed','GSI included in DG Macro CU.'); });
  const sv = sysLN();
  if (sv) cus.forEach((c,i)=>{ if (!CU.xfmr(c) || c.wf!=='I') return; const pri = pfNum((cuDesc(c).match(/(\d{4,5})\s*-\s*\d+\//)||[])[1]); if (pri && Math.abs(pri-sv.ln)/sv.ln > 0.07){ const rep = xfmrReplacement(c, sv.ln); put(i,'Incorrect CU',`${c.cu} is a ${pri.toLocaleString()} V transformer on a ${sv.kv} kV system (${Math.round(sv.ln).toLocaleString()} V). ${rep?`${WFN[c.wf]==='transfer'?'Transfer':'Use'} ${rep.cu} (${rep.d}).`:'Use the matching-voltage CU.'}`); } });
  const rows = scopeOf(s);
  const np = rows.find(r=>r.key==='newpole'); if (np && s.d.poleInst && s.pf && np.cu && np.cu.s==='bad') put(cus.indexOf(s.d.poleInst),'Incorrect CU',`PoleForeman models ${s.pf.R.poleSpec}; station installs ${s.d.poleInst.cu}.`);
  const gs = rows.find(r=>r.key==='guysize'); if (gs && gs.cu && gs.cu.s==='bad' && s.d.agI[0]) put(cus.indexOf(s.d.agI[0]),'Incorrect CU',`Guy size doesn't match PoleForeman (${gs.expect}).`);
  return out;
}

/* Yes / No / N/A answers */
function scAnswers(s){
  const iss = ISS.filter(i=>i.pole===s.id && i.sev!=='info');
  const pf = s.pf, d = s.d, rawIsSpan = /^S\d/i.test(s.id) || (!d.poleInst && !d.cus.some(c=>CU.pole(c)||CU.primFrame(c)||CU.ag(c)) && /^S/i.test(s.id));
  const pick = f => { const x = iss.filter(f); return x.some(i=>i.sev==='bad') ? 'No' : x.length ? '' : 'Yes'; };
  const isPF = i => /poleforeman/i.test(i.src);
  const A = {};
  if (!pf){ const v = rawIsSpan || !POLES.length ? (rawIsSpan ? 'N/A' : '') : ''; [12,13,14,15,16,17].forEach(r=>A[r]=v); }
  else {
    A[12] = pick(i=>['Pole','Line'].includes(i.cat) || (i.cat==='Loading' && /^Pole/i.test(i.title)) || (i.cat==='NESC' && /250C/.test(i.title)));
    A[13] = pick(i=>i.cat==='Framing' || (i.cat==='Loading' && !/^Pole/i.test(i.title) && !/guy|anchor|rod/i.test(i.title)));
    A[14] = pick(i=>(i.cat==='NESC' && !/250C/.test(i.title)) || (isPF(i) && i.cat==='Project' && /district|grade|edition/i.test(i.title)) || (i.cat==='Report' && /summary/i.test(i.title)));
    const hasEq = d.equip.length || d.cus.some(c=>eqClass(c) && eqClass(c)!=='animal guard');
    A[15] = hasEq ? pick(i=>i.cat==='Equipment') : 'N/A';
    const hasGuy = d.anchors.length || d.spanGuys.length || d.agI.length || d.agR.length;
    A[16] = hasGuy ? pick(i=>i.cat==='Guying' || (i.cat==='Math' && /guy|anchor|rod/i.test(i.title)) || (i.cat==='Loading' && /guy|anchor|rod/i.test(i.title))) : 'N/A';
    A[17] = d.comms.length ? pick(i=>i.cat==='Clearance' || /comm/i.test(i.title)) : 'N/A';
  }
  A[18] = SK ? pick(i=>/sketch/i.test(i.src) || i.cat==='Sketch') : '';
  const fx = cuFixes(s);
  A[19] = s.st ? (Object.keys(fx).length || iss.some(i=>/station details/i.test(i.src) && i.sev==='bad') ? 'No' : 'Yes') : '';
  A[20] = '';
  const seen = new Map(); iss.forEach(i=>{ const k=i.title; if (seen.has(k)){ if (i.rule && !seen.get(k).rules.includes(i.rule)) seen.get(k).rules.push(i.rule); } else seen.set(k, { t:i.title, rules: i.rule?[i.rule]:[] }); });
  const list = [...seen.values()];
  A.comment = list.length ? list.map((x,n)=>`${n+1}. ${x.t}${x.rules.length?` (${x.rules.join(', ')})`:''}`).join('\n') : (Object.values(A).every(v=>v==='Yes'||v==='N/A'||v==='') ? 'Good.' : '');
  return A;
}

/* MaxDel deliverables */
function scDeliverables(){
  const out = {};
  const docIds = k => DOCS.filter(d=>!d.foreign && (Array.isArray(k)?k:[k]).includes(d.kind)).map(d=>d.id);
  const issuesFor = (ids, extra) => ISS.filter(i=>i.sev!=='info' && ((i.loc && ids.includes(i.loc.doc)) || (extra && extra(i))));
  const row = (r, kinds, filt, extra, naFn) => {
    const ids = docIds(kinds);
    if (!ids.length){ out[r] = naFn && naFn() ? { v:'N/A', note:'' } : { v:'', note:'Not in the QC package.' }; return; }
    const is = issuesFor(ids, extra).filter(filt||(()=>true));
    out[r] = is.length ? { v: is.some(i=>i.sev==='bad') ? 'No' : 'No', note: is.map((i,n)=>`${n+1}. ${i.pole!=='Project'?i.pole+': ':''}${i.title}`).join('\n') } : { v:'Yes', note:'Good.' };
  };
  const woProj = i => i.pole==='Project' && /WO (start|end) DLOC/i.test(i.title);
  if (ISS.some(woProj)) out[10] = { v:'', note: ISS.filter(woProj).map((i,n)=>`${n+1}. ${i.title}`).join('\n') };
  row(15, 'jacket');
  row(16, ['sketch'].concat(PKG.sketch?[]:['ifc']), i=>!i.loc || !PKG.ifc || i.loc.doc!==PKG.ifc.id || (PKG.ifc.data.sketchPages||[PKG.ifc.data.sketchPage]).includes(i.loc.page), i=>i.loc && i.loc.sketch);
  row(17, 'vicinity');
  row(18, 'station', i=>['Estimate','Station','Naming'].includes(i.cat));
  const cuIss = ISS.some(i=>i.sev!=='info' && i.pole!=='Project' && (i.cat==='CU' || /station details/i.test(i.src)));
  row(19, 'wo');
  row(20, ['jobcost','costdist'], i=>i.cat==='Estimate');
  row(21, 'material');
  row(22, 'labor');
  if (cuIss) [18,19,20,21,22].forEach(r=>{ if (out[r] && out[r].v==='Yes') out[r].note = 'Update after corrections.'; });
  row(23, 'photos');
  row(24, 't811');
  row(25, 'jha');
  row(26, 'env');
  row(27, 'dco', null, null, ()=>!STN.some(s=>s.d.cus.some(c=>c.wf==='I' && /FUSE|FSW|LSW/i.test(c.cu+' '+c.desc))));
  row(28, 'pf', i=>['Report','Naming','Project'].includes(i.cat));
  row(29, 'njuns', null, null, ()=>!STN.some(s=>s.d.poleInst));
  return out;
}

function scDesigner(names){
  const cands = [PKG.ifc?.data.meta.designer, JK?.data.ocr?.designerName, PKG.env?.data.meta.designer, JK?.data.designer, SK?.K.fields.designer, ...(PKG.njuns||[]).map(d=>d.data.contact), ...(PKG.t811||[]).map(d=>d.data.contact)].filter(Boolean);
  for (const c of cands){ const m = names.find(n=>sameDesigner(n, c)); if (m) return m; }
  const full = cands.find(c=>/^[A-Za-z]+ [A-Za-z]+$/.test(String(c).trim())); return full ? full.trim() : (cands[0]||'');
}
function scProgram(){
  const T = [WO?.meta.subType, JK?.data.subType, WO?.meta.title, SK?.K.fields.woType].filter(Boolean).join(' ').toUpperCase();
  if (/RESIL/.test(T)) return 'Resiliency';
  if (/REV|NEW ?BUS|CUST/.test(T)) return 'Revenue';
  if (/RELIAB|FOCUS|STAR|HEX/.test(T)) return 'Reliability';
  return '';
}

async function exportScorecard(){
  if (!ST){ toast('Add the Station Details & Job Instructions (or IFC package) first; the scorecard is built from the CU list.'); return; }
  toast('Building scorecard…');
  let W; try { const T = await scTemplate(); W = await scOpen(T.bytes.slice(0)); } catch(e){ console.error(e); toast(e.message||'Could not open the scorecard template'); return; }
  const L = await scLists();
  const need = ['Maximo Upload','Design Scorecard','MaxDel Scorecard']; for (const n of need) if (!W.sheets[n]){ toast(`The template has no "${n}" sheet`); return; }
  const mu = new XSheet(await W.zip.file(W.sheets['Maximo Upload']).async('string'));
  const ds = new XSheet(await W.zip.file(W.sheets['Design Scorecard']).async('string'));
  const md = new XSheet(await W.zip.file(W.sheets['MaxDel Scorecard']).async('string'));

  /* header */
  const wo = DOMWO || WO?.meta.wo || ST?.meta.wo || '';
  ds.set('F2', /^\d+$/.test(wo) ? +wo : wo);
  ds.set('H2', WO?.meta.title || SK?.K.fields.title || PKG.env?.data.meta.name || '');
  ds.set('F3', scDesigner(L.designers));
  if (S.qcTech) ds.set('F4', S.qcTech);
  ds.set('H3', 1);
  const now = new Date(); ds.set('H4', Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(1899,11,30)) / 86400000));
  const prog = scProgram(); if (prog) ds.set('H5', prog);

  /* Maximo Upload: station details CUs */
  const sA = mu.find('A2')?.getAttribute('s') || null, sG = mu.find('G2')?.getAttribute('s') || null;
  for (let r=2; r<=999; r++) ['A','B','C','D','E','F','G','H'].forEach(c=>{ if (mu.find(c+r)) mu.set(c+r, null); });
  let r = 2; const order = [];
  ST.order.forEach(id=>{
    const st = ST.stations[id]; if (!st || !st.cus.length) return;
    const s = STN.find(x=>x.key===nkey(id)); const fx = s ? cuFixes(s) : {};
    order.push({ id, s });
    st.cus.forEach((c,i)=>{
      mu.set('A'+r, id, sA); mu.set('B'+r, c.cu, sA); mu.set('C'+r, c.desc, sA); mu.set('D'+r, c.wf, sA);
      mu.set('E'+r, c.qty!=null ? c.qty : '', sA); mu.set('F'+r, c.hc||'', sA);
      if (fx[i]){ mu.set('G'+r, fx[i].cls, sG); mu.set('H'+r, fx[i].fix, sG); }
      r++;
    });
  });

  /* Design Scorecard answers and comments, one column per station in upload order */
  order.forEach((o,k)=>{
    const col = colName(8 + k);
    if (!o.s) return;
    const A = scAnswers(o.s);
    [12,13,14,15,16,17,18,19,20].forEach(rr=>{ if (A[rr]) ds.set(col+rr, A[rr]); });
    if (A.comment) ds.set(col+'23', A.comment);
  });

  /* MaxDel deliverables */
  const D = scDeliverables();
  Object.entries(D).forEach(([rr,x])=>{ if (x.v) md.set('F'+rr, x.v); if (x.note) md.set('E'+rr, x.note); });

  /* recalc on open */
  let wbx = W.wbx; wbx = /<calcPr[^>]*fullCalcOnLoad/.test(wbx) ? wbx : wbx.replace(/<calcPr([^>]*)\/>/, '<calcPr$1 fullCalcOnLoad="1"/>');
  W.zip.file('xl/workbook.xml', wbx);
  W.zip.file(W.sheets['Maximo Upload'], mu.xml()); W.zip.file(W.sheets['Design Scorecard'], ds.xml()); W.zip.file(W.sheets['MaxDel Scorecard'], md.xml());
  const blob = await W.zip.generateAsync({ type:'blob', mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', compression:'DEFLATE' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `WO_${wo||'0000000'}_QAQC_Scorecard.xlsx`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href), 60000);
  const filled = order.length; toast(`Scorecard downloaded: ${r-2} CUs, ${filled} points pre-filled`);
}



/* ---------- compatible unit list ---------- */
let CUDB = null;
async function gunzipText(buf){ const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')); return await new Response(s).text(); }
async function idbGet(id){ try { const d=await db(); return await new Promise(res=>{ const q=d.transaction('docs').objectStore('docs').get(id); q.onsuccess=()=>res(q.result); q.onerror=()=>res(null); }); } catch(e){ return null; } }
async function loadCUs(){
  let txt=null, name='built-in CU list', custom=false;
  const r = await idbGet('__culist'); if (r && r.text){ txt=r.text; name=r.name; custom=true; }
  if (!txt){ try { txt = await gunzipText(b64buf(CU_LIST_B64)); } catch(e){ console.warn('CU list unavailable', e); } }
  const map = new Map(); (txt||'').split('\n').forEach(l=>{ const [cu,d,wt] = l.split('\t'); if (cu) map.set(cu.trim().toUpperCase(), { cu:cu.trim(), d:(d||'').trim(), wt:(wt||'').trim() }); });
  CUDB = { map, name, custom, n: map.size };
  if (DOCS.length){ runChecks(); renderKpis(); render(); }
}
async function saveCUList(bytes, name){
  try {
    const W = await scOpen(bytes.slice(0)); const first = Object.values(W.sheets)[0];
    const s = new XSheet(await W.zip.file(first).async('string'));
    const hdr = {}; let hdrRow = null;
    for (const [n, row] of [...s.rows.entries()].sort((a,b)=>a[0]-b[0]).slice(0,5)) { for (const c of row.getElementsByTagNameNS(XNS,'c')) { const v=(s.text(c.getAttribute('r'), W.sst)||'').trim().toLowerCase(); if (['cu','description','work type','status'].includes(v)) hdr[v]=c.getAttribute('r').replace(/\d+/,''); } if (hdr.cu && hdr.description){ hdrRow=n; break; } }
    if (!hdrRow) return false;
    const out=[]; for (const [n] of [...s.rows.entries()].sort((a,b)=>a[0]-b[0])) { if (n<=hdrRow) continue; const cu=s.text(hdr.cu+n, W.sst); if (!cu) continue; if (hdr.status && /inactive/i.test(s.text(hdr.status+n, W.sst)||'')) continue; out.push(`${cu}\t${(s.text(hdr.description+n, W.sst)||'').replace(/[\t\n]/g,' ')}\t${hdr['work type']?(s.text(hdr['work type']+n, W.sst)||''):''}`); }
    if (!out.length) return false;
    await dbPut({ id:'__culist', name, kind:'culist', text: out.join('\n'), added:Date.now() }); await loadCUs(); toast(`CU list updated: ${out.length.toLocaleString()} units`); return true;
  } catch(e){ console.warn(e); return false; }
}
async function resetCUList(){ await dbDel('__culist'); await loadCUs(); toast('Using the built-in CU list'); if (TAB==='settings') render(); }
const cuRec = c => CUDB ? CUDB.map.get(String(c.cu||'').toUpperCase()) : null;
const cuDesc = c => (cuRec(c)?.d || c.desc || '').toUpperCase();
/* what kind of equipment a CU is, from the CU list description */
function eqClass(c){
  const d = cuDesc(c), code = String(c.cu||'').toUpperCase();
  if (/ANIMAL GUARD/.test(d)) return 'animal guard';
  if (/ARRESTER/.test(d)) return 'arrester';
  if (/RECLOSER/.test(d)) return 'recloser';
  if (/SECTIONALIZER/.test(d)) return 'sectionalizer';
  if (/REGULATOR/.test(d)) return 'regulator';
  if (/CAPACITOR|CAP\.?\s*BANK/.test(d)) return 'capacitor';
  if (/FAULT IND/.test(d)) return 'fault indicator';
  if (/RISER/.test(d)) return 'riser';
  if (/FUSE SWITCH|FUSE CUTOUT|\bCUTOUT\b|FUSE LINK|FUSE BARREL/.test(d) || /^(LSW|FSW|FUSE)/.test(code)) return 'fuse';
  if (/SWITCH/.test(d)) return 'switch';
  if ((cuRec(c)?.wt==='LGHT' || /LIGHT|LUMINAIRE|LGTHEAD|LTHEAD|\bHPS\b/.test(d)) && !/POLE,|\bPOLE\b.*(ALUM|STEEL|FIBERGLASS)/.test(d)) return 'light';
  if (/TRANSFORMER|\d+\s*KVA/.test(d) && !/BUSHING|BRACKET|BKT|MOUNT/.test(d)) return 'transformer';
  return null;
}
/* suggest a same-size transformer CU at the right primary voltage */
function xfmrReplacement(c, ln){
  if (!CUDB) return null;
  const d = cuDesc(c); const kva = pfNum((d.match(/(\d+(?:\.\d+)?)\s*KVA/)||[])[1]); const sec = (d.match(/-(\d+\/\d+)/)||[])[1]; const tap = (d.match(/\b(N?T)\s+(\d)B\b/)||[]).slice(1).join(' ');
  let best=null, bs=-1;
  for (const r of CUDB.map.values()){
    if (r.wt && r.wt!=='EQOH') continue; const rd=r.d.toUpperCase(); if (!/^INST/.test(rd)) continue;
    if (pfNum((rd.match(/(\d+(?:\.\d+)?)\s*KVA/)||[])[1])!==kva) continue;
    const pri = pfNum((rd.match(/(\d{4,5})\s*-/)||[])[1]); if (!pri || Math.abs(pri-ln)/ln>0.03) continue;
    if (sec && (rd.match(/-(\d+\/\d+)/)||[])[1]!==sec) continue;
    let sc = 0; if (tap && rd.includes(tap.replace(' ',' ')+'B')) sc+=5; const a=r.cu.toUpperCase(), b=String(c.cu).toUpperCase(); let i=0; while(i<a.length&&a[i]===b[i]) i++; sc+=i; if (a.slice(-2)===b.slice(-2)) sc+=2;
    if (sc>bs){ bs=sc; best=r; }
  }
  return best;
}


/* ---------- rendering ---------- */
const statusPill = s => s==='bad'?'<span class="pill bad">Attention</span>':s==='warn'?'<span class="pill warn">Review</span>':'<span class="pill ok">Clean</span>';
const pfPill = v => v==='fail'?'<span class="pill bad">✕ PF fail</span>':v==='warn'?'<span class="pill warn">! PF warning</span>':v==='pass'?'<span class="pill ok">✓ PF pass</span>':'<span class="pill none">not shown</span>';
const SEVN = {bad:'Error', warn:'Warning', info:'Note'};
function issHtml(i){ const n=ISS.indexOf(i); return `<div class="iss ${i.sev} ${i.loc?'click':''}" ${i.loc?`data-iss="${n}" title="Open ${esc(locText(i.loc))}"`:''}><b>${esc(i.title)}</b> ${i.rule?`<span class="pill ${i.rule==='250C'?'c':'info'}">${esc(i.rule)}</span>`:''} <span class="pill none">${esc(i.cat)}</span>${i.src?` <span class="muted" style="font-size:12px">${esc(i.src)}</span>`:''}${i.detail?`<div class="w">${esc(i.detail)}</div>`:''}${i.loc?`<div class="where">${esc(locText(i.loc))} →</div>`:''}</div>`; }
const woKey = () => DOMWO || WO?.meta.wo || ST?.meta.wo || SK?.K.fields.wo || 'pkg';
let SKCHK = {}; try { SKCHK = JSON.parse(localStorage.getItem('pfqc:skchk')||'{}'); } catch(e){}
const skKey = (s,k) => `${woKey()}|${s.id}|${k}`;
const skItems = s => scopeOf(s).filter(r=>r.sk && r.sk.s!=='' && !['setting','frame'].includes(r.key) && (s.d.agI.length || !['guy','guysize','lead','dir','att'].includes(r.key)));
function skProgress(){ let n=0, c=0; STN.forEach(s=>skItems(s).forEach(r=>{ n++; if (SKCHK[skKey(s,r.key)] || r.sk.s==='ok') c++; })); return {n,c}; }
const scopeBadges = s => { const d=s.d, b=[]; if (d.poleInst) b.push(`<span class="pill info">Replace ${d.instHC?`${d.instHC.h}-${d.instHC.c}`:''}</span>`); if (d.has250C) b.push('<span class="pill c">250C</span>'); if (d.agI.length) b.push('<span class="pill none">New guy</span>'); if (d.cus.some(CU.xfmr)) b.push('<span class="pill none">Transformer</span>'); if (d.cus.some(CU.straighten)) b.push('<span class="pill none">Straighten</span>'); if (d.cus.some(c=>c.wf==='I'&&CU.gsi(c))) b.push('<span class="pill none">GSI</span>'); if (d.cus.some(CU.hendrix)) b.push('<span class="pill none">Hendrix</span>'); return b.join(' '); };

function renderHeaderTools(){ const sel=$('#origSel'); sel.hidden=!DOCS.length; sel.innerHTML='<option value="">Original PDFs…</option>'+DOCS.filter(d=>d.bytes).sort((a,b)=>natural(a.name,b.name)).map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join(''); $('#xlsxBtn').hidden=!DOCS.length; $('#scBtn').hidden=!DOCS.length; }
$('#scBtn').addEventListener('click', ()=>exportScorecard());
$('#tplFile').addEventListener('change', async e=>{ const f=e.target.files[0]; e.target.value=''; if (f) await saveTemplate(f); });
scLists().then(()=>{ if (TAB==='settings') render(); });
loadCUs();
$('#cuFile').addEventListener('change', async e=>{ const f=e.target.files[0]; e.target.value=''; if (f){ const ok = await saveCUList(await f.arrayBuffer(), f.name); if (!ok) toast('That workbook has no CU / Description columns'); if (TAB==='settings') render(); } });
$('#origSel').addEventListener('change', e=>{ const v=e.target.value; if (v) openOriginal(v); e.target.value=''; });
$('#xlsxBtn').addEventListener('click', ()=>exportExcel());
function renderKpis(){ renderHeaderTools();
  const n=STN.length, c=st=>STN.filter(s=>s._status===st).length;
  const repl=STN.filter(s=>s.d.poleInst).length, c250=POLES.filter(p=>p.R.rules['250C']).length;
  const tot = PKG.jobcost?.data.total ?? PKG.costdist?.data.total ?? null;
  const sp = skProgress();
  const k=[
    [n,'Poles',`${repl} replaced`,''],
    [POLES.length||'–','PoleForeman reports',POLES.length?`${c250} with 250C`:'none loaded',''],
    [c('bad'),'Need attention','errors',c('bad')?'bad':'ok'],
    [c('warn'),'Review','warnings',c('warn')?'warn':''],
    [ISS.filter(i=>i.pole==='Project'&&i.sev!=='info').length,'Package findings','across documents',''],
    [tot!=null?money(tot):'–','Estimate total',PKG.jobcost?'job cost summary':'',''],
    [sp.n?`${sp.c} / ${sp.n}`:'–','Sketch items confirmed',SK?(skCO()?'auto-read + by eye':'confirm by eye'):'no sketch',sp.n&&sp.c===sp.n?'ok':''],
  ];
  $('#kpis').innerHTML=k.map((x,i)=>`<div class="kpi">${(i===2||i===3)&&x[0]?`<button class="kpib" data-gotoreview="1" title="Show poles that need review">`:''}<div class="v ${x[3]}">${x[0]}</div><div class="l">${x[1]}</div><div class="d">${esc(x[2])}</div>${(i===2||i===3)&&x[0]?'</button>':''}</div>`).join('');
  const nr = STN.filter(s=>s._status!=='ok').length;
  $('#reviewBtn').hidden = false; $('#reviewBtn').textContent = nr ? `Review ${nr} pole${nr>1?'s':''}` : 'No poles need review'; $('#reviewBtn').disabled = !nr;
}
const TABS=[['overview','Overview'],['poles','Poles'],['sketch','Sketch review'],['estimate','Estimate'],['wo','Work order'],['scopetab','Scope review'],['permits','Permits'],['devices','DCO & calcs'],['compare','PF compare'],['spans','Spans'],['guying','Guying'],['equipment','Equipment'],['issues','Issues'],['docs','Documents'],['settings','Settings']];
function render(){
  const sp = skProgress();
  const cnt={poles:STN.length, issues:ISS.filter(i=>i.sev!=='info').length, docs:DOCS.length, sketch: sp.n?`${sp.c}/${sp.n}`:null, guying:POLES.reduce((a,p)=>{ const r=baseRule(p.R); return a+r.anchors.length+(r.spanGuys||[]).length; },0)};
  $('#tabs').innerHTML=TABS.map(([k,l])=>`<button class="tab" role="tab" data-tab="${k}" aria-selected="${TAB===k}">${l}${cnt[k]!=null?`<span class="n">${cnt[k]}</span>`:''}</button>`).join('');
  const v=$('#view');
  const pfNeed = ['compare','spans','guying','equipment'].includes(TAB) && !POLES.length;
  v.innerHTML = pfNeed ? `<p class="muted">Add the PoleForeman reports to use this tab.</p>` : ({overview:renderOverview, poles:renderPoles, sketch:renderSketch, estimate:renderEstimate, wo:renderWO, scopetab:renderScope, permits:renderPermits, devices:renderDevices, compare:renderCompare, spans:renderSpans, guying:renderGuying, equipment:renderEquip, issues:renderIssues, docs:renderDocs, settings:renderSettings}[TAB])();
  if (TAB==='sketch') wireSketch();
}
$('#tabs').addEventListener('click',e=>{ const b=e.target.closest('[data-tab]'); if(b){ TAB=b.dataset.tab; render(); } });
const cellHtml = c => { if (!c) return '<td class="sc"></td>'; const ic = {ok:'✓', bad:'✕', warn:'!', miss:'–', none:'', '':''}[c.s]; return `<td class="sc ${c.s||'na'}"><span class="ic">${ic}</span>${esc(c.t)}</td>`; };

/* overview */
function renderOverview(){
  const kinds = Object.entries(KINDS).filter(([k])=>!['unknown','ifc','inspection','scopeimg','design','permitsketch','mapreq'].includes(k) || DOCS.some(d=>d.kind===k));
  const pk = kinds.map(([k,v])=>{ const ds = DOCS.filter(d=>d.kind===k || (k==='sketch' && d.kind==='ifc' && d.data.sketchPage && !PKG.sketch) || (k==='station' && d.kind==='ifc' && d.data.station && !PKG.station));
    const via = ds.length && ds[0].kind!==k ? ' (from IFC)' : '';
    const sum = ds.map(d=>docSummary(d, k)).filter(Boolean).join(' · ');
    return `<tr><td><span class="dot ${ds.length?'ok':v.need?'warn':'none'}"></span> ${esc(v.n)}${via}</td><td style="white-space:normal;word-break:break-word;max-width:260px">${ds.length?ds.map(d=>`<button class="link" data-pages="${d.id}|all">${esc(d.name)}</button>`).join('<br>'):`<span class="muted">${v.need?'missing':'not included'}</span>`}</td><td class="muted" style="white-space:normal">${esc(sum)}</td></tr>`; }).join('');
  const facts = FACTS.filter(f=>f.vals.length).map(f=>`<tr><td><b style="font-weight:600">${esc(f.name)}</b></td><td style="white-space:normal">${f.vals.map(v=>`<span class="kv"><span class="muted">${esc(v[0])}</span> ${esc(v[1])}</span>`).join('')}</td><td>${f.vals.length<2?'<span class="pill none">one source</span>':f.ok?'<span class="pill ok">Match</span>':'<span class="pill bad">Mismatch</span>'}</td></tr>`).join('');
  const proj = ISS.filter(i=>i.pole==='Project').sort((a,b)=>({bad:0,warn:1,info:2}[a.sev]-{bad:0,warn:1,info:2}[b.sev]));
  const cols=[
    {k:'id',l:'Pole',v:s=>s.id,h:s=>`<span class="dot ${s._status}"></span> <b>${esc(s.id)}</b>`},
    {k:'dloc',l:'DLOC',v:s=>s.d.dloc},
    {k:'scope',l:'Scope',v:s=>scopeOf(s).filter(r=>r.cu.s==='ok').map(r=>r.label).join(', '),h:s=>scopeBadges(s)||'<span class="muted">–</span>'},
    {k:'pf',l:'PoleForeman',v:s=>s.pf?s.pf.R.ruleOrder.join('+'):'',h:s=>s.pf?`${esc(s.pf.R.poleSpec)} · ${s.pf.R.ruleOrder.join('+')}`:'<span class="muted">none</span>'},
    {k:'h',l:'Max pole loading',num:true,v:s=>s.pf?Math.max(...s.pf.R.ruleOrder.map(r=>s.pf.R.rules[r].head.horz||0)):null,h:s=>s.pf?pctHtml(Math.max(...s.pf.R.ruleOrder.map(r=>s.pf.R.rules[r].head.horz||0)),'pole'):'–'},
    {k:'hrs',l:'CU hours',num:true,v:s=>s.st?.hours??null,h:s=>s.st?f2(s.st.hours):'–'},
    {k:'bad',l:'Errors',num:true,v:s=>s._counts.bad,h:s=>s._counts.bad?`<span class="pct bad">${s._counts.bad}</span>`:'0'},
    {k:'warn',l:'Warnings',num:true,v:s=>s._counts.warn,h:s=>s._counts.warn?`<span class="pct warn">${s._counts.warn}</span>`:'0'},
  ];
  return `<div class="viewbar"><h2>Poles in this package</h2><button class="btn sm" data-copy="ovpoles">Copy table</button><div class="hint">Click a pole to see every document side by side.</div></div>
  ${table('ovpoles', cols, STN, {sort:'id', click:s=>s.id})}
  <div class="grid2">
  <div class="sec"><h3>Package</h3><div class="tscroll"><table><thead><tr><th>Document</th><th>File</th><th>What was read</th></tr></thead><tbody>${pk}${(PKG.unknown||[]).map(d=>`<tr><td><span class="dot bad"></span> Not recognized</td><td>${esc(d.name)}</td><td></td></tr>`).join('')}</tbody></table></div></div>
  <div class="sec"><h3>Same value everywhere?</h3><div class="tscroll"><table><thead><tr><th>Item</th><th>Values by document</th><th></th></tr></thead><tbody>${facts||'<tr><td colspan="3" class="muted">Add more documents to compare.</td></tr>'}</tbody></table></div></div>
  </div>
  <div class="sec"><h3>Package findings</h3>${proj.length?`<div class="issues">${proj.map(issHtml).join('')}</div>`:'<p class="muted">No package-level findings.</p>'}</div>`;
}
function docSummary(d, as){
  const x=d.data||{}; if (d.foreign) return `Different work order (WO ${d._wo.content||d._wo.file})`;
  switch(d.kind){
    case 'pf': return `${x.poles.length} reports: ${x.poles.map(p=>`${p.id} (${p.R.ruleOrder.join('+')})`).join(', ')}`;
    case 'station': return `${x.order.length} stations, ${f2(x.meta.onsite)} on-site hours`;
    case 'ifc': return as==='sketch' ? `sketch on page${(x.sketchPages||[]).length>1?'s':''} ${(x.sketchPages||[x.sketchPage]).join(', ')}` : as==='station' ? `station details, ${x.station.order.length} stations` : `design summary for ${x.order.length} poles${x.sketchPage?`, sketch p. ${x.sketchPage}`:''}${x.station?', station details':''}`;
    case 'sketch': return `${skPagesOf(x.sketch).length>1?`${skPagesOf(x.sketch).length} pages · `:''}${x.sketch.labels.length?`labels ${x.sketch.labels.map(l=>l.id).join(', ')} · `:''}${x.ocr?`${x.ocr.callouts.length} callouts read`:(x.sketch.callouts||[]).some(c=>c.dloc||c.lat)?`${x.sketch.callouts.filter(c=>c.dloc||c.lat).length} callouts in the PDF text`:'text not read yet'}`;
    case 'wo': return `${x.noteOrder.length} pole notes, ${x.materials.length} materials, targets ${x.meta.targetStart||'?'} to ${x.meta.targetFinish||'?'}`;
    case 'jobcost': return `total ${money(x.total)}`;
    case 'costdist': return `total ${money(x.total)}`;
    case 'labor': return `${f2(x.hours)} hours, ${money(x.cost)}`;
    case 'material': return `${x.items.length} items, ${money(x.total)}`;
    case 't811': return `ticket ${x.ticket} (${x.type}), work ${x.workDateObj||'?'} to ${x.endDate||'?'}, ${x.gps.filter(g=>!g.precise).length} GPS points`;
    case 'njuns': return `${x.ticket}, ${x.assets.length} poles, ${x.steps.length} steps, ${x.status}`;
    case 'env': return `${x.q.filter(q=>q.ans==='YES').length} YES of ${x.q.length}`;
    case 'jha': return [x.date, x.facility].filter(Boolean).join(', ');
    case 'photos': return `${x.pages.length} photos${x.pages.some(p=>p.ocr)?', labels read':''}`;
    case 'vicinity': return x.ocr ? `labels read: ${x.ocr.ids.join(', ')||'none'}` : 'map';
    case 'dco': return `${x.forms.length} form${x.forms.length===1?'':'s'}: ${x.forms.map(f=>`${f.rows.map(r=>`${r.action} ${r.type} ${r.equip}`).join(', ')} at ${f.dloc||'?'}`).join('; ')}`;
    case 'vd': return `${x.kind==='flicker'?'Flicker':'Voltage drop'}: ${x.xfmr||'?'} kVA transformer, ${x.rows.length} points, ${x.maxCum}% at the end`;
    case 'jacket': return `WO ${x.wo}, ${x.subType||''}, designer ${x.designer||'?'}${x.ocr?`, ${x.ocr.manHours||'?'} man hours, upstream ${x.ocr.upstream||'?'}`:', text not read yet'}`;
    case 'inspection': return `${x.pages.length} page${x.pages.length===1?'':'s'}`;
    case 'scopeimg': return 'image';
    case 'design': return `design table for ${x.order.length} pole${x.order.length===1?'':'s'}${PKG.ifc===d?' (used as the design table)':PKG.ifc?' · compared with the IFC package':''}`;
    case 'permitsketch': { const n=sketchCallouts(d).length; return `${x.permit||'Permit'} sketch · ${n?`${n} callout${n===1?'':'s'}: ${sketchCallouts(d).map(c=>c.id).filter(Boolean).join(', ')}`:x.ocr?'no callouts read':'text not read yet'}`; }
    case 'mapreq': { const R=x.req||x.ocr; if (!R) return `${x.permit||''} request · text not read yet`.trim(); return `${R.fields.type||x.permit||'request'} · ${R.poles.length} pole${R.poles.length===1?'':'s'}${R.poles.length?`: ${R.poles.map(p=>p.id).join(', ')}`:''}${x.ocr?' · read from image':''}`; }
    case 'deviceid': return `${x.ids.map(i=>i.id).join(', ')} for WO ${x.wo}`;
  }
  return '';
}

/* poles */
function reviewToggle(){ const n=STN.filter(s=>s._status!=='ok').length; return `<div class="seg" role="group" aria-label="Which poles"><button data-review="0" aria-pressed="${!FIL.review}">All poles (${STN.length})</button><button data-review="1" aria-pressed="${FIL.review}">Needs review (${n})</button></div>`; }
const shownSt = () => FIL.review ? STN.filter(s=>s._status!=='ok') : STN;
function renderPoles(){
  const L = shownSt(); if (!L.find(s=>s.id===CUR)) CUR = L[0]?.id;
  const s = STN.find(x=>x.id===CUR);
  const list = L.map(x=>{ const hb=x.pf?.R.rules['250B']?.head.horz, hc=x.pf?.R.rules['250C']?.head.horz;
    return `<button class="pcard" data-stn="${esc(x.id)}" aria-current="${x.id===CUR}"><span class="dot ${x._status}"></span><b>${esc(x.id)}</b><span class="h">${hb!=null?`<span class="pct ${lv(hb,'pole')}">B ${hb}%</span>`:''}${hc!=null?` · <span class="pct ${lv(hc,'pole')}" style="color:var(--c)">C ${hc}%</span>`:''}</span><span class="spec">${x.d.poleInst?`Replace, ${x.d.instHC?`${x.d.instHC.h}' class ${x.d.instHC.c}`:''}`:esc(x.pf?.R.poleSpec||'Existing pole')}${x._counts.bad?` · ${x._counts.bad} error${x._counts.bad>1?'s':''}`:''}${x._counts.warn?` · ${x._counts.warn} warning${x._counts.warn>1?'s':''}`:''}</span></button>`; }).join('');
  return `<div class="md"><div><div style="margin-bottom:8px">${reviewToggle()}</div><nav class="plist" aria-label="Poles">${list}${FIL.review&&!L.length?'<p class="muted">No poles need review.</p>':''}</nav></div><div class="detail">${s&&L.length?poleView(s):''}</div></div>`;
}
function poleView(s){
  const L=shownSt(), idx=L.findIndex(x=>x.id===s.id), d=s.d;
  const iss=ISS.filter(i=>i.pole===s.id).sort((a,b)=>({bad:0,warn:1,info:2}[a.sev]-{bad:0,warn:1,info:2}[b.sev]));
  let h = `<div class="dhead"><h2>${esc(s.id)}</h2>${statusPill(s._status)} ${scopeBadges(s)} <span class="muted">${d.dloc?`DLOC ${esc(d.dloc)}`:''}</span><span class="spacer"></span>
    <button class="btn sm" data-nav="${idx>0?esc(L[idx-1].id):''}" ${idx<=0?'disabled':''}>← ${idx>0?esc(L[idx-1].id):''}</button><button class="btn sm" data-nav="${idx<L.length-1?esc(L[idx+1].id):''}" ${idx>=L.length-1?'disabled':''}>${idx<L.length-1?esc(L[idx+1].id):''} →</button></div>
    <div class="chips" style="margin-bottom:12px">${s.st&&(PKG.station||PKG.ifc)?`<button class="btn sm" data-pages="${(PKG.station||PKG.ifc).id}|${(PKG.station?s.st.pages:s.st.pages).join(',')}">Station details page</button>`:''}${s.pf?`<button class="btn sm" data-pages="${s.pf.docId}|${s.pf.pageNos.join(',')}">PoleForeman pages</button>`:''}${SK?`<button class="btn sm" data-gosk="${esc(s.id)}">Open on sketch</button>`:''}${s.ph?`<button class="btn sm" data-pages="${PKG.photos.id}|${(s.phs||[s.ph]).map(p=>p.page).join(',')}">Photo${(s.phs||[]).length>1?`s (${s.phs.length})`:''}</button>`:''}</div>`;
  const imgs = [s.ph?`<figure class="light"><img src="${s.ph.img}" alt="Field photo of ${esc(s.id)}"><figcaption>Photo${s.phByOrder?' (by page order)':''}</figcaption></figure>`:'', s.pf?.img?.d3?`<figure><img src="${s.pf.img.d3}" alt="PoleForeman 3D view of ${esc(s.id)}"><figcaption>3D view</figcaption></figure>`:'', s.pf?.img?.polar?`<figure class="light"><img src="${s.pf.img.polar}" alt="PoleForeman plan view of ${esc(s.id)}"><figcaption>Plan view</figcaption></figure>`:''].filter(Boolean);
  if (imgs.length) h += `<div class="imgs3">${imgs.join('')}</div>`;
  h += `<div class="sec"><h3>Findings <span class="muted sm">${iss.length?`${s._counts.bad} errors, ${s._counts.warn} warnings, ${s._counts.info} notes`:''}</span></h3>${iss.length?`<div class="issues">${iss.map(issHtml).join('')}</div>`:'<p class="muted">No findings.</p>'}</div>`;
  const rows = scopeOf(s);
  h += `<div class="sec"><h3>Scope across documents</h3>${rows.length?`<div class="tscroll"><table class="trace"><thead><tr><th>Work</th>${COLS.map(c=>`<th>${c[1]}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr><th>${esc(r.label)}</th>${COLS.map(([k])=>cellHtml(r[k])).join('')}</tr>`).join('')}</tbody></table></div><p class="muted sm" style="margin-top:6px">✓ agrees · ✕ disagrees with the PoleForeman or station values · – not called out. Sketch values are read from the drawing image.</p>`:'<p class="muted">No scope items found for this pole.</p>'}</div>`;
  if ((s._locs||[]).length || (s._dlocs||[]).length){
    const ref = s._locs?.[0];
    const srcs = [...new Set([...(s._dlocs||[]).map(x=>x[0]), ...(s._locs||[]).map(x=>x[0])])];
    h += `<div class="sec"><h3>Location</h3><div class="tscroll"><table><thead><tr><th>Source</th><th>DLOC</th><th class="num">Latitude</th><th class="num">Longitude</th><th class="num">From ${esc(ref?.[0]||'reference')}</th></tr></thead><tbody>${srcs.map(n=>{ const dl=(s._dlocs||[]).find(x=>x[0]===n), lc=(s._locs||[]).find(x=>x[0]===n); const dd = lc && ref && lc!==ref ? distFt(ref[1],ref[2],lc[1],lc[2]) : null;
      return `<tr><td>${esc(n)}</td><td>${dl?`<span class="${dl[1]!==s._dlocs[0][1]?'pct bad':''}">${esc(dl[1])}</span>`:'–'}</td><td class="num">${lc?lc[1]:'–'}</td><td class="num">${lc?lc[2]:'–'}</td><td class="num">${dd==null?'–':`<span class="${dd>S.coordFt?'pct bad':''}">${dd>5280?f1(dd/5280)+' mi':f1(dd)+' ft'}</span>`}</td></tr>`; }).join('')}</tbody></table></div></div>`;
  }
  if (s.st){
    const sum = s.st.cus.reduce((a,c)=>a+(c.hours||0),0);
    const grp = c => c.wf==='I'?0:c.wf==='R'?1:c.wf==='T'?2:3;
    h += `<div class="sec"><h3>Station details <span class="muted sm">${f2(s.st.hours)} labor hours${s.st.inacc?` · inaccessible: ${esc(s.st.inacc)}`:''}</span></h3><div class="tscroll"><table><thead><tr><th>CU</th><th>Work</th><th>Description</th><th class="num">Qty</th><th>H/C</th><th class="num">Hours</th></tr></thead><tbody>${s.st.cus.slice().sort((a,b)=>grp(a)-grp(b)).map(c=>`<tr><td><b style="font-weight:600">${esc(c.cu)}</b></td><td><span class="pill ${c.wf==='I'?'info':c.wf==='R'?'bad':'none'}">${esc(WFN[c.wf]||c.wf)}</span></td><td style="white-space:normal">${esc(c.desc)}</td><td class="num">${f0(c.qty)}</td><td>${esc(c.hc)}</td><td class="num">${f2(c.hours)}</td></tr>`).join('')}<tr><th colspan="5">Total</th><td class="num"><b class="${Math.abs(sum-(s.st.hours||0))>0.02?'pct bad':''}">${f2(sum)}</b></td></tr></tbody></table></div></div>`;
  }
  if (s.wo || s.sk) h += `<div class="sec"><h3>Written scope</h3><div class="grid3">${s.wo?`<div class="note"><b>WO notes</b>${s.wo.notes.map(n=>`<p>${esc(n)}</p>`).join('')}</div>`:''}${s.sk?`<div class="note"><b>Sketch callout (read from image)</b>${s.sk.lines.map(n=>`<p>${esc(n)}</p>`).join('')}</div>`:''}</div></div>`;
  if (s.pf) h += `<div class="sec"><h3 style="font-size:22px;margin-top:10px">PoleForeman ${esc(s.pf.id)} <span class="muted sm">${esc(s.pf.R.poleSpec)} · ${s.pf.R.ruleOrder.join(' + ')}${s.pf._hag?` · ${f1(s.pf._hag)} ft above ground`:''}</span></h3></div>` + pfBody(s.pf);
  return h;
}

/* sketch review */
let SKZ = null;
function renderSketch(){
  if (!SK) return `<p class="muted">Add the job sketch (or an IFC package that includes it) to review it against the station details.</p>`;
  const s = STN.find(x=>x.id===SKCUR) || STN[0];
  const chips = STN.filter(x=>x.skLabel||x.st||x.wo).map(x=>{ const it=skItems(x); const done=it.filter(r=>SKCHK[skKey(x,r.key)]||r.sk.s==='ok').length; const bad=it.some(r=>r.sk.s==='bad');
    return `<button class="chipb ${x.id===s?.id?'on':''}" data-sk="${esc(x.id)}"><span class="dot ${bad?'bad':done===it.length?'ok':'warn'}"></span>${esc(x.id)} <span class="muted">${done}/${it.length}</span></button>`; }).join('');
  const ocrBtn = skCO() ? `<span class="muted sm">${skCO().callouts.length} callouts ${skCO().text?'read from the sketch PDF':'read from the drawing'}</span>` : `<button class="btn sm primary" data-ocr="1">Read sketch text</button>`;
  return `<div class="viewbar"><h2>Sketch vs station details</h2>${ocrBtn}<div class="hint">Pick a pole to zoom to it. Each CU-driven item is checked against the callout text; tick Seen once you've seen it on the drawing. Drag to pan, scroll to zoom.</div></div>
  <div class="skwrap"><div class="skview"><div class="sktools"><button class="btn sm" data-skz="out" aria-label="Zoom out">−</button><button class="btn sm" data-skz="fit">Fit</button><button class="btn sm" data-skz="in" aria-label="Zoom in">+</button><button class="btn sm" data-skz="pole">Zoom to ${esc(s?.id||'')}</button><span class="spacer"></span><button class="btn sm" data-pages="${SK.doc.id}|${skPagesOf(SK.K).map(p=>p.page).join(',')}">Open page${skPagesOf(SK.K).length>1?'s':''}</button></div>
    <div class="skvp" id="skvp"><div class="skin" id="skin"><img src="${SK.img.src}" width="${SK.img.w}" height="${SK.img.h}" alt="Job sketch" draggable="false">${skOverlay(s)}</div></div></div>
  <div class="skside"><div class="chips" style="margin-bottom:10px">${chips}</div>${s?skPanel(s):''}</div></div>`;
}
function skOverlay(cur){
  const W=SK.img.w, H=SK.img.h, k=SK.img.scale, ok = skCO() ? SK.img.scale/skCO().scale : 0;
  let g='';
  STN.forEach(s=>{ const on = s===cur;
    if (s.sk && ok){ const b=s.sk.box; g += `<rect x="${b.x0*ok-8}" y="${b.y0*ok-8}" width="${(b.x1-b.x0)*ok+16}" height="${(b.y1-b.y0)*ok+16}" rx="6" class="skbox ${on?'on':''}"/>`; }
    if (s.skLabel){ const x=s.skLabel.x*k, y=s.skLabel.y*k; g += `<circle cx="${x+18*k/2}" cy="${y-5*k}" r="${on?34:24}" class="skpin ${on?'on':''}"/>`; }
  });
  return `<svg class="skov" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${g}</svg>`;
}
function skPanel(s){
  const idr = [['DLOC', s.wo?.dloc||s.ifc?.dloc, s.sk?.dloc], ['Latitude', s.wo?.latText||s.ifc?.latText, s.sk?.lat], ['Longitude', s.wo?.lonText||s.ifc?.lonText, s.sk?.lon]];
  const idHtml = idr.map(([n,a,b])=>{ const m = a&&b ? (n==='DLOC' ? a===b : Math.abs(pfNum(a)-pfNum(b))<0.00002) : null; return `<tr><td>${n}</td><td>${esc(a||'–')}</td><td class="${m===false?'pct bad':''}">${esc(b|| (skCO()?'not read':'–'))}</td><td>${m==null?'':m?'<span class="pill ok">Match</span>':'<span class="pill bad">Differs</span>'}</td></tr>`; }).join('');
  const items = skItems(s);
  const rows = items.map(r=>{ const k=skKey(s,r.key), on=!!SKCHK[k]; return `<tr><th style="white-space:normal">${esc(r.label)}</th>${cellHtml(r.cu)}${cellHtml(r.sk)}<td><label class="ck"><input type="checkbox" data-skchk="${esc(k)}" ${on?'checked':''}> Seen</label></td></tr>`; }).join('');
  return `<h3 style="font-size:22px;margin-bottom:6px">${esc(s.id)} ${statusPill(s._status)}</h3>
  <div class="tscroll" style="margin-bottom:12px"><table><thead><tr><th></th><th>WO / IFC</th><th>Sketch callout</th><th></th></tr></thead><tbody>${idHtml}</tbody></table></div>
  <div class="tscroll"><table class="trace"><thead><tr><th>Should be on the sketch</th><th>Station details</th><th>Sketch text</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="4" class="muted">No sketch items for this pole.</td></tr>'}</tbody></table></div>
  ${s.st?`<div class="sec" style="margin-top:14px"><h3 style="font-size:17px">Station details <span class="muted sm">${f2(s.st.hours)} hrs${s.st.inacc?` · ${esc(s.st.inacc)} inaccessible`:''}</span> <button class="btn sm" data-pages="${(PKG.station||PKG.ifc).id}|${s.st.pages.join(',')}">Open page</button></h3><div class="tscroll"><table class="cutbl"><thead><tr><th>CU</th><th>Work</th><th>Description</th><th class="num">Qty</th></tr></thead><tbody>${s.st.cus.slice().sort((a,b)=>'IRTX'.indexOf(a.wf)-'IRTX'.indexOf(b.wf)).map(c=>{ const oh=/^(TAILBOARD|VEGM|TRUCK|TRAFFIC|ENGR|SETUP|C6$|CS|CST|CSD|CSA)/i.test(c.cu); return `<tr class="${oh?'dim':''}"><td><b style="font-weight:600">${esc(c.cu)}</b></td><td><span class="pill ${c.wf==='I'?'info':c.wf==='R'?'bad':'none'}">${esc(WFN[c.wf]||c.wf)}</span></td><td style="white-space:normal">${esc(c.desc)}</td><td class="num">${f0(c.qty)}</td></tr>`; }).join('')}</tbody></table></div></div>`:''}
  ${s.wo?`<div class="note" style="margin-top:12px"><b>WO notes</b>${s.wo.notes.map(n=>`<p>${esc(n)}</p>`).join('')}</div>`:''}
  <div class="note" style="margin-top:12px"><b>Callout text</b>${s.sk?s.sk.lines.map(l=>`<p>${esc(l)}</p>`).join(''):`<p class="muted">${skCO()?'No callout box starting with this pole label and a DLOC line was found. Review it by eye.':'Use “Read sketch text” to pull the callouts off the drawing and check them automatically.'}</p>`}</div>`;
}
function skApply(){ const el=$('#skin'); if (el && SKZ) el.style.transform=`translate(${SKZ.x}px,${SKZ.y}px) scale(${SKZ.s})`; }
function skFit(){ const vp=$('#skvp'); if(!vp) return; const s=vp.clientWidth/SK.img.w; SKZ={s, x:0, y:(vp.clientHeight-SK.img.h*s)/2}; skApply(); }
function skFocus(s){ const vp=$('#skvp'); if(!vp||!s) return; let x, y;
  if (s.sk && skCO()){ const k=SK.img.scale/skCO().scale, b=s.sk.box; const pts=[[b.x0*k,b.y0*k],[b.x1*k,b.y1*k]]; if (s.skLabel) pts.push([s.skLabel.x*SK.img.scale, s.skLabel.y*SK.img.scale]); const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]); x=(Math.min(...xs)+Math.max(...xs))/2; y=(Math.min(...ys)+Math.max(...ys))/2; const span=Math.max(Math.max(...xs)-Math.min(...xs)+700, (Math.max(...ys)-Math.min(...ys)+500)*vp.clientWidth/vp.clientHeight); SKZ={s:Math.min(1.2, vp.clientWidth/span), x:0, y:0}; }
  else if (s.skLabel){ x=s.skLabel.x*SK.img.scale; y=s.skLabel.y*SK.img.scale; SKZ={s:Math.min(1, vp.clientWidth/900), x:0,y:0}; }
  else { skFit(); return; }
  SKZ.x = vp.clientWidth/2 - x*SKZ.s; SKZ.y = vp.clientHeight/2 - y*SKZ.s; skApply(); }
function skZoom(f, cx, cy){ const vp=$('#skvp'); if(!vp||!SKZ) return; cx=cx??vp.clientWidth/2; cy=cy??vp.clientHeight/2; const ns=Math.max(0.05, Math.min(3, SKZ.s*f)); SKZ.x = cx-(cx-SKZ.x)*ns/SKZ.s; SKZ.y = cy-(cy-SKZ.y)*ns/SKZ.s; SKZ.s=ns; skApply(); }
function wireSketch(){
  const vp=$('#skvp'); if(!vp) return;
  const s = STN.find(x=>x.id===SKCUR);
  if (!SKZ || SKZ.pole!==SKCUR){ s && (s.skLabel||s.sk) ? skFocus(s) : skFit(); if (SKZ) SKZ.pole=SKCUR; } else skApply();
  vp.addEventListener('wheel', e=>{ e.preventDefault(); const r=vp.getBoundingClientRect(); skZoom(e.deltaY<0?1.15:1/1.15, e.clientX-r.left, e.clientY-r.top); }, {passive:false});
  let drag=null;
  vp.addEventListener('pointerdown', e=>{ drag={x:e.clientX, y:e.clientY, ox:SKZ.x, oy:SKZ.y}; vp.setPointerCapture(e.pointerId); vp.classList.add('drag'); });
  vp.addEventListener('pointermove', e=>{ if(!drag) return; SKZ.x=drag.ox+e.clientX-drag.x; SKZ.y=drag.oy+e.clientY-drag.y; skApply(); });
  const end=()=>{ drag=null; vp.classList.remove('drag'); }; vp.addEventListener('pointerup', end); vp.addEventListener('pointercancel', end);
}

/* estimate */
function renderEstimate(){
  if (!EST.some(e=>e.vals.length) && !ST) return `<p class="muted">Add the Job Cost, Cost Distribution, Labor and Material summaries and the Work Order Details to reconcile the estimate.</p>`;
  const rec = EST.filter(e=>e.vals.length).map(e=>`<tr><td><b style="font-weight:600">${esc(e.name)}</b></td><td style="white-space:normal">${e.vals.map(v=>`<span class="kv ${v[2]?'':'bad'}"><span class="muted">${esc(v[0])}</span> ${esc(e.fmt(v[1]))}</span>`).join('')}</td><td>${e.vals.length<2?'<span class="pill none">one source</span>':e.ok?'<span class="pill ok">Match</span>':'<span class="pill bad">Mismatch</span>'}</td></tr>`).join('');
  const mc = MATCHK.map(m=>`<tr><td>${esc(m.item)}</td><td class="num">${m.design}</td><td class="num">${m.mat}</td><td>${m.ok?'<span class="pill ok">OK</span>':`<span class="pill ${m.sev}">Check</span>`}</td></tr>`).join('');
  const sh = STN.filter(s=>s.st).map(s=>{ const sum=s.st.cus.reduce((a,c)=>a+(c.hours||0),0); return `<tr><td><button class="link" data-pole="${esc(s.id)}">${esc(s.id)}</button></td><td class="num">${f2(s.st.hours)}</td><td class="num">${f2(sum)}</td><td class="num">${s.st.cus.length}</td><td>${Math.abs(sum-s.st.hours)>0.02?'<span class="pill bad">Off</span>':'<span class="pill ok">OK</span>'}</td></tr>`; }).join('');
  const mats = PKG.material?.data.items || WO?.materials || [];
  const mcols=[{k:'item',l:'Item',v:m=>m.item},{k:'desc',l:'Description',v:m=>m.desc,h:m=>`<span style="white-space:normal;display:block;min-width:280px">${esc(m.desc)}</span>`},{k:'qty',l:'Qty',num:true,v:m=>m.qty},{k:'unit',l:'Unit cost',num:true,v:m=>m.unit,h:m=>money(m.unit)},{k:'cost',l:'Line cost',num:true,v:m=>m.cost,h:m=>money(m.cost)}];
  return `<div class="viewbar"><h2>Estimate reconciliation</h2><div class="hint">The first value in each row is the reference; any value that differs by more than a cent (or 0.02 hours) is flagged.</div></div>
  <div class="tscroll"><table><thead><tr><th>Value</th><th>By document</th><th></th></tr></thead><tbody>${rec||'<tr><td colspan="3" class="muted">No estimate summaries loaded.</td></tr>'}</tbody></table></div>
  <div class="grid2"><div class="sec"><h3>Materials vs design</h3>${mc?`<div class="tscroll"><table><thead><tr><th>Item</th><th class="num">Design</th><th class="num">Materials list</th><th></th></tr></thead><tbody>${mc}</tbody></table></div>`:'<p class="muted">Needs station details and a material list.</p>'}</div>
  <div class="sec"><h3>Station hours</h3>${sh?`<div class="tscroll"><table><thead><tr><th>Pole</th><th class="num">Stated</th><th class="num">Sum of CUs</th><th class="num">CUs</th><th></th></tr></thead><tbody>${sh}</tbody></table></div>`:'<p class="muted">No station details.</p>'}</div></div>
  ${mats.length?`<div class="viewbar" style="margin-top:18px"><h2>Materials</h2><button class="btn sm" data-copy="mats">Copy table</button></div>${table('mats', mcols, mats, {sort:'item'})}`:''}`;
}

/* permits */
function renderPermitReqs(){
  const {reqs, sketches} = PERMIT; if (!reqs.length && !sketches.length) return '';
  const yn = (v, t) => v==null ? `<span class="muted">${t||'–'}</span>` : v ? '<span class="pill ok">Match</span>' : '<span class="pill bad">Differs</span>';
  const poleRows = rows => rows.map(r=>{ const {p,s}=r, e=s&&poleExp(s);
    return `<tr><td>${s?`<button class="link" data-pole="${esc(s.id)}">${esc(p.id||s.id)}</button>`:`<span class="pct bad">${esc(p.id||'?')}</span>`}</td><td style="white-space:normal;min-width:240px">${esc(p.text||'')}</td><td>${esc(p.dloc||'–')} ${yn(r.dloc)}</td><td>${r.dist!=null?`${f0(r.dist)} ft `:''}${yn(r.loc)}</td><td>${p.size?esc(hcT(p.size)):'<span class="muted">not stated</span>'} ${yn(r.size)}${e?`<br><span class="muted sm">${esc(e.src)}: ${esc(hcT(e))}</span>`:''}</td></tr>`; }).join('');
  const head = '<thead><tr><th>Pole</th><th>Scope</th><th>DLOC</th><th>Location</th><th>New pole</th></tr></thead>';
  const issFor = where => { const is = ISS.filter(i=>i.src===where || (i.cat==='Permit' && i.title.includes(`the ${where}`))); return is.length ? `<div class="issues" style="margin-bottom:12px">${is.map(issHtml).join('')}</div>` : ''; };
  let h = `<div class="viewbar"><h2>Permit requests</h2><div class="hint">Mapping request forms and permit sketches, checked against the design and the PoleForeman pole size.</div></div>`;
  reqs.forEach(r=>{ const F = r.R?.fields || {};
    const fl = [['WO number',F.wo],['WO name',F.woName],['Request type',F.type],['Created by',F.createdBy],['Need date',F.needDate],['Estimated construction',F.dates],['# of work stations',F.stations],['Revision request',F.revision],['File link',F.link]].filter(x=>x[1]);
    h += `<div class="sec"><h3>${esc(r.where[0].toUpperCase()+r.where.slice(1))} <span class="muted sm">${esc(r.d.name)}${r.R&&!r.d.data.req?' · read from the image, confirm by eye':''}</span></h3>${issFor(r.where)}
    <div class="grid2"><div>${r.R?`<div class="tscroll"><table><tbody>${fl.map(([n,v])=>`<tr><th>${esc(n)}</th><td style="white-space:normal">${esc(v)}</td></tr>`).join('')}</tbody></table></div>
      ${r.att.length?`<div class="tscroll" style="margin-top:10px"><table><thead><tr><th>Attachment</th><th></th></tr></thead><tbody>${r.att.map(a=>`<tr><td>${a.doc?`<button class="link" data-pages="${a.doc.id}|all">${esc(a.name)}</button>`:esc(a.name)}</td><td>${a.doc?'<span class="pill ok">In package</span>':a.loadable?'<span class="pill warn">Not in package</span>':'<span class="pill none">Not checked</span>'}</td></tr>`).join('')}</tbody></table></div>`:''}`:'<p class="muted">Not read yet. Use “Read text now” in Settings.</p>'}</div>
    <div>${r.d.data.img?`<img src="${r.d.data.img}" alt="${esc(r.d.name)}" style="max-width:100%;border-radius:8px;border:1px solid var(--rule)">`:`<button class="btn sm" data-pages="${r.d.id}|all">Open request</button>`}</div></div>
    ${r.poles.length?`<div class="tscroll" style="margin-top:12px"><table>${head}<tbody>${poleRows(r.poles)}</tbody></table></div>`:''}
    ${r.sketch?`<p class="muted sm" style="margin-top:6px">Sketch for this request: <button class="link" data-pages="${r.sketch.id}|all">${esc(r.sketch.name)}</button></p>`:''}</div>`; });
  sketches.forEach(x=>{ const img = x.d.data.sketchImg;
    h += `<div class="sec"><h3>${esc(x.where[0].toUpperCase()+x.where.slice(1))} <span class="muted sm">${esc(x.d.name)}</span> <button class="btn sm" data-pages="${x.d.id}|all">Open</button></h3>${issFor(x.where)}
    <div class="grid2"><div>${x.poles.length?`<div class="tscroll"><table>${head}<tbody>${poleRows(x.poles)}</tbody></table></div>`:'<p class="muted">No pole callouts read.</p>'}</div>
    <div>${img?`<img src="${img.src}" alt="${esc(x.d.name)}" style="max-width:100%;border-radius:8px;border:1px solid var(--rule);background:#fff">`:''}</div></div></div>`; });
  return h;
}
function renderPermits(){
  const T = (PKG.t811||[]).map(d=>({d, x:d.data})).sort((a,b)=>String(a.x.dateObj).localeCompare(String(b.x.dateObj)));
  let h = renderPermitReqs() + `<div class="viewbar"${PERMIT.reqs.length||PERMIT.sketches.length?' style="margin-top:22px"':''}><h2>811</h2></div>`;
  h += T.length ? `<div class="tscroll"><table><thead><tr><th>Ticket</th><th>Type</th><th>Called</th><th>Work window</th><th>Job #</th><th class="num">Depth</th><th>Locate</th><th>GPS points</th><th>Responses</th></tr></thead><tbody>${T.map(({d,x},i)=>`<tr><td><button class="link" data-pages="${d.id}|all">${esc(x.ticket)}</button>${i===T.length-1?' <span class="pill info">latest</span>':''}</td><td>${esc(x.type)}${x.oldTicket?`<br><span class="muted sm">from ${esc(x.oldTicket)}</span>`:''}</td><td>${esc(x.dateObj||x.date)}</td><td>${esc(x.workDateObj||'?')} to ${esc(x.endDate||'?')}</td><td>${esc(x.job)}</td><td class="num">${x.depth!=null?x.depth+' ft':'–'}</td><td style="white-space:normal">${esc(x.locate)}</td><td style="white-space:normal">${x.gps.filter(g=>!g.precise).map(g=>`${esc(g.label)}: ${g.lat}, ${g.lon}`).join('<br>')}</td><td style="white-space:normal">${x.responses.map(r=>`${esc(r.name)}: ${esc(r.status)}`).join('<br>')||`<span class="muted">${x.members.length} members, none shown</span>`}</td></tr>`).join('')}</tbody></table></div>` : `<p class="muted">No 811 tickets loaded.</p>`;
  if (EXC.length) h += `<div class="sec"><h3>Excavation coverage</h3><div class="tscroll"><table><thead><tr><th>Pole</th><th>Dig</th><th class="num">Latitude</th><th class="num">Longitude</th><th>Nearest locate point</th><th class="num">Distance</th><th></th></tr></thead><tbody>${EXC.map(e=>`<tr><td><button class="link" data-pole="${esc(e.s.id)}">${esc(e.s.id)}</button></td><td>${esc(e.what)}</td><td class="num">${e.lat.toFixed(7)}</td><td class="num">${e.lon.toFixed(7)}</td><td>${e.best?`${esc(e.best.p.t.ticket)} ${esc(e.best.p.label)}`:'–'}</td><td class="num">${e.best?f1(e.best.d)+' ft':'–'}</td><td>${!T.length?'<span class="pill none">no ticket</span>':e.ok?`<span class="pill ok">Within ${e.rad} ft</span>`:`<span class="pill bad">Outside ${e.rad} ft</span>`}</td></tr>`).join('')}</tbody></table></div><p class="muted sm" style="margin-top:6px">New anchors are placed from the pole using the PoleForeman lead and bearing.</p></div>`;
  h += `<div class="viewbar" style="margin-top:22px"><h2>NJUNS</h2></div>`;
  (PKG.njuns||[]).forEach(dd=>{ const n=dd.data;
    h += `<p><button class="link" data-pages="${dd.id}|all"><b>${esc(n.ticket)}</b></button> · ${esc(n.type)} · ${esc(n.status)} · ${esc(n.misc||'')} · requested ${esc(n.requested||'?')}</p>
    <div class="grid2"><div class="tscroll"><table><thead><tr><th>Asset</th><th>Pole</th><th>Replaced?</th><th class="num">Latitude</th><th class="num">Longitude</th></tr></thead><tbody>${n.assets.map(a=>{ const s=STN.find(x=>(x.nj||[]).some(y=>y.a===a)); return `<tr><td>${esc(a.pole)}</td><td>${s?`<button class="link" data-pole="${esc(s.id)}">${esc(s.id)}</button>`:'<span class="pct bad">no match</span>'}</td><td>${s?(s.d.poleInst?'<span class="pill ok">Yes</span>':'<span class="pill warn">No</span>'):''}</td><td class="num">${a.lat??'–'}</td><td class="num">${a.lon??'–'}</td></tr>`; }).join('')}</tbody></table></div>
    <div class="tscroll"><table><thead><tr><th>#</th><th>Step</th><th>Member</th><th>Status</th><th>Dates</th><th>Work points</th></tr></thead><tbody>${n.steps.map(x=>`<tr><td>${esc(x.seq)}</td><td>${esc(x.type)}</td><td>${esc(x.member)}</td><td>${esc(x.status)}</td><td>${esc(x.dates.join(' → '))}</td><td>${esc(x.points.join(', '))}</td></tr>`).join('')}</tbody></table></div></div>`; });
  if (!PKG.njuns) h += `<p class="muted">No NJUNS ticket loaded.</p>`;
  h += `<div class="grid2" style="margin-top:22px"><div><div class="viewbar"><h2>Environmental checklist</h2></div>${PKG.env?`<div class="tscroll"><table><tbody>${PKG.env.data.q.map(q=>`<tr><td class="num">${q.n}</td><td style="white-space:normal">${esc(q.text)}</td><td>${q.ans==='YES'?'<span class="pill warn">YES</span>':q.ans==='NO'?'<span class="pill ok">NO</span>':'<span class="pill bad">blank</span>'}</td></tr>`).join('')}</tbody></table></div><p class="muted sm" style="margin-top:6px">${esc(PKG.env.data.meta.code||'')} · designer ${esc(PKG.env.data.meta.designer||'?')} · PM ${esc(PKG.env.data.meta.pm||'?')}</p>`:'<p class="muted">Not loaded.</p>'}</div>
  <div><div class="viewbar"><h2>Job hazard analysis</h2></div>${PKG.jha?`<div class="tscroll"><table><tbody>${[['Date','date'],['Work location','address'],['Nearest medical facility','facility'],['DOC #','doc'],['Substation','substation'],['Circuit','circuit'],['ARC rating','arc'],['Crew leader','crew']].map(([l,k])=>`<tr><th>${l}</th><td>${PKG.jha.data[k]?esc(PKG.jha.data[k]):'<span class="muted">blank</span>'}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">Not loaded.</p>'}</div></div>`;
  return h;
}


/* ---------- work order details ---------- */
function renderWO(){
  if (!WO) return `<p class="muted">Add the Work Order Details PDF to review the scope statement, Purpose &amp; Necessity, work description and notes.</p>`;
  const m = WO.meta, iss = ISS.filter(i=>['WO','Scope'].includes(i.cat) || /WO notes|WO details/i.test(i.src) || (i.loc && i.loc.doc===PKG.wo.id)).filter(i=>i.sev!=='info' || i.cat==='Scope');
  const nSt = STN.filter(s=>s.st||s.wo).length, first = STN.find(s=>s.st)?.d.dloc, last = [...STN].reverse().find(s=>s.st)?.d.dloc;
  const chk = (a,b) => a==null||b==null ? '' : String(a)===String(b) ? '<span class="pill ok">Match</span>' : '<span class="pill bad">Differs</span>';
  const st = scopeText(); const feats = {}; STN.forEach(s=>{ const f=designFeatures(s); Object.keys(f).forEach(k=>(feats[k]=feats[k]||[]).push(s.id)); });
  const chips = FEAT.filter(F=>F.re.test(st) || feats[F.key]).map(F=>{ const said=F.re.test(st), has=!!feats[F.key]; return `<span class="kv ${said&&!has?'bad':''}"><b style="font-weight:600">${esc(F.label)}</b> <span class="muted">${said?'in scope':'not in scope text'} · ${has?'design: '+feats[F.key].join(', '):'not in design'}</span></span>`; }).join('');
  const pnCost = m.pnCostText; const est = PKG.jobcost?.data.total ?? PKG.costdist?.data.total;
  const pnFacts = [['Total cost stated', pnCost?('$'+pnCost):null, est!=null?money(est):null], ['Outages stated', (String(m.pn||'').match(/(\d+)\s*outages?/i)||[])[1], null], ['Two-year CI stated', (String(m.pn||'').match(/CI[^.]*?is\s*(\d[\d,]*)/i)||[])[1], null], ['$/ACI stated', (String(m.pn||'').match(/\$\/ACI of \$?([\d.,]+)/i)||[])[1], null]];
  const notes = WO.log.filter(e=>e.kind==='note'), notif = WO.log.filter(e=>e.kind==='notification');
  const wdRows = STN.filter(s=>s.st||s.wo).map(s=>{ const rows=scopeOf(s).filter(r=>r.wo && r.wo.s!==''); const bad=rows.filter(r=>['miss','bad'].includes(r.wo.s)&&((r.req||{}).wo||r.wo.s==='bad'));
    return `<tr><td><button class="link" data-pole="${esc(s.id)}">${esc(s.id)}</button></td><td style="white-space:normal;min-width:320px">${s.wo?s.wo.notes.map(n=>esc(n)).join('<br>'):'<span class="pct bad">No work description for this pole</span>'}</td><td style="white-space:normal">${bad.length?bad.map(r=>`<span class="pct ${r.wo.s==='bad'?'bad':'warn'}">${esc(r.label)}: ${esc(r.wo.t)}</span>`).join('<br>'):'<span class="pill ok">Matches station details</span>'}</td></tr>`; }).join('');
  return `<div class="viewbar"><h2>Work order details</h2><button class="btn sm" data-pages="${PKG.wo.id}|all">Open pages</button><div class="hint">Scope statement, Purpose &amp; Necessity, work description and notes compared with the design.</div></div>
  ${iss.length?`<div class="issues" style="margin-bottom:14px">${iss.map(issHtml).join('')}</div>`:'<p class="muted">No work order findings.</p>'}
  <div class="grid2"><div class="sec"><h3>Header</h3><div class="tscroll"><table><tbody>
   <tr><th>Work order</th><td>${esc(m.wo)}</td><td></td></tr><tr><th>Title</th><td style="white-space:normal">${esc(m.title)}</td><td></td></tr>
   <tr><th>Pole count</th><td>${esc(m.poleCount??'–')} <span class="muted">· design has ${nSt}</span></td><td>${chk(m.poleCount,nSt)}</td></tr>
   <tr><th>Start DLOC</th><td>${esc(m.startDloc||'–')} <span class="muted">· first pole ${esc(first||'?')}</span></td><td>${chk(m.startDloc,first)}</td></tr>
   <tr><th>End DLOC</th><td>${esc(m.endDloc||'–')} <span class="muted">· last pole ${esc(last||'?')}</span></td><td>${chk(m.endDloc,last)}</td></tr>
   <tr><th>Target start / finish</th><td>${esc(m.targetStart||'–')} / ${esc(m.targetFinish||'–')}</td><td></td></tr>
   <tr><th>Status · work type</th><td>${esc(m.status||'')} · ${esc(m.workType||'')} ${esc(m.subType||'')}</td><td></td></tr>
   <tr><th>GL account</th><td style="white-space:normal">${esc(m.gl||'–')}</td><td></td></tr></tbody></table></div></div>
  <div class="sec"><h3>Scope statement</h3><div class="note"><p>${esc(m.scope||'Not found.')}</p></div><div style="margin-top:8px">${chips||'<span class="muted">No scope items recognized.</span>'}</div></div></div>
  <div class="sec"><h3>Purpose &amp; Necessity</h3><div class="note"><p>${esc(m.pn||'Not found.')}</p></div><div class="tscroll" style="margin-top:8px"><table><tbody>${pnFacts.filter(f=>f[1]).map(f=>`<tr><th>${f[0]}</th><td>${esc(f[1])}</td><td>${f[2]?`<span class="muted">estimate ${esc(f[2])}</span>`:''}</td></tr>`).join('')}</tbody></table></div></div>
  <div class="sec"><h3>Work description by pole</h3><div class="tscroll"><table><thead><tr><th>Pole</th><th>Work description</th><th>Against station details</th></tr></thead><tbody>${wdRows}</tbody></table></div></div>
  <div class="sec"><h3>Work order notes</h3>${notes.length?notes.map(e=>`<div class="note" style="margin-bottom:8px"><b>${esc(e.date)} · ${esc(e.by)} · ${esc(e.desc)}</b><p style="white-space:pre-wrap">${esc(e.text)}</p></div>`).join(''):'<p class="muted">No work order notes besides the work description and P&amp;N.</p>'}<p class="muted sm">${notif.length} automatic Maximo notifications hidden.</p></div>`;
}

/* ---------- scope review ---------- */
let SCOPECHK = {}; try { SCOPECHK = JSON.parse(localStorage.getItem('pfqc:scope')||'{}'); } catch(e){}
function renderScope(){
  const st = scopeText(); const insp = DOCS.filter(d=>d.kind==='inspection'), imgs = DOCS.filter(d=>d.kind==='scopeimg');
  const inspFor = s => insp.flatMap(d=>d.data.pages.filter(p=>{ const t=p.text||''; return (s.d.dloc && t.includes(s.d.dloc)) || new RegExp(`\\b${s.id}\\b|\\bP0*${(s.id.match(/\d+/)||[''])[0]}\\b`).test(t); }).map(p=>({d,p})));
  const rows = STN.filter(s=>s.st).map(s=>{ const f=designFeatures(s); const keys=Object.keys(f); const ins=inspFor(s);
    const items = keys.map(k=>{ const F=FEAT.find(x=>x.key===k); const inScope=F.re.test(st), inWD = s.wo && F.re.test(s.wo.notes.join(' ')), inInsp = ins.some(x=>F.re.test(x.p.text||'')); const ck=`${woKey()}|${s.id}|${k}`;
      return `<tr><th style="white-space:normal">${esc(F.label)}<br><span class="muted sm">${esc(f[k].map(c=>`${WFN[c.wf]||c.wf} ${c.cu}`).join(', '))}</span></th>${cellHtml(st?(inScope?C.ok('mentioned'):C.miss('not mentioned')):C.none('no scope text'))}${cellHtml(s.wo?(inWD?C.ok('mentioned'):C.miss('not mentioned')):C.none('no note'))}${cellHtml(insp.length?(ins.length?(inInsp?C.ok('mentioned'):C.miss('not mentioned')):C.none('pole not found')):C.none('no inspection'))}<td><select data-scope="${esc(ck)}"><option value="">–</option><option ${SCOPECHK[ck]==='In scope'?'selected':''}>In scope</option><option ${SCOPECHK[ck]==='Out of scope'?'selected':''}>Out of scope</option><option ${SCOPECHK[ck]==='Needed for design'?'selected':''}>Needed for design</option></select></td></tr>`; }).join('');
    return `<div class="sec"><h3>${esc(s.id)} <span class="muted sm">${esc(s.d.dloc||'')}</span> ${ins.length?ins.map(x=>`<button class="btn sm" data-pages="${x.d.id}|${x.p.page}">Inspection p. ${x.p.page}</button>`).join(' '):''}</h3>${items?`<div class="tscroll"><table class="trace"><thead><tr><th>Design action</th><th>Scope statement / P&amp;N</th><th>Work description</th><th>Inspection sheet</th><th>Your call</th></tr></thead><tbody>${items}</tbody></table></div>`:'<p class="muted">Only support CUs at this pole (tailboard, traffic control, conductor handling).</p>'}</div>`; }).join('');
  return `<div class="viewbar"><h2>Scope review</h2><div class="hint">Every design action from the station details, checked against the original scope: the WO scope statement and P&amp;N, the pole's work description, and any inspection sheets or scope images you add. Mark each one in scope, out of scope, or needed for the design; your answers are saved in this browser.</div></div>
  ${ISS.filter(i=>i.cat==='Scope').map(issHtml).join('')}
  <div class="note" style="margin:10px 0"><b>Original scope</b><p>${esc(st||'No scope statement or P&N loaded.')}</p></div>
  ${imgs.length?`<div class="sec"><h3>Scope images</h3><div class="imgs3">${imgs.map(d=>`<figure class="light"><img src="${d.data.img}" alt="${esc(d.name)}"><figcaption>${esc(d.name)}</figcaption></figure>`).join('')}</div></div>`:''}
  ${!insp.length&&!imgs.length?'<p class="muted sm">Drop inspection sheets (PDF) or scope images (PNG/JPG) onto the page to compare against them here.</p>':''}
  ${rows||'<p class="muted">Add the station details to review the design scope.</p>'}`;
}

/* documents */
function renderDocs(){
  const rows = DOCS.slice().sort((a,b)=>natural(KINDS[a.kind].n,KINDS[b.kind].n)).map(d=>`<tr><td><span class="dot ${d.kind==='unknown'||d.foreign?'bad':'ok'}"></span> ${esc(KINDS[d.kind].n)}${d.foreign?' <span class="pill bad">other WO</span>':''}</td><td>${esc(d.name)}</td><td class="num">${d.pages}</td><td class="muted" style="white-space:normal">${esc(docSummary(d))}</td><td style="white-space:nowrap">${d.bytes?`<button class="btn sm primary" data-orig="${d.id}">Open PDF</button> <button class="btn sm" data-pages="${d.id}|all">View here</button>`:''} <button class="btn sm" data-rmdoc="${d.id}">Remove</button></td></tr>`).join('');
  return `<div class="viewbar"><h2>Documents</h2><button class="btn sm" data-addmore="1">Add PDFs</button><div class="hint">Open PDF shows the original file in a new browser tab. Each file is identified from its contents. Adding a newer copy of a document replaces the old one. PoleForeman files can hold one pole or the whole package.</div></div><div class="tscroll"><table><thead><tr><th>Type</th><th>File</th><th class="num">Pages</th><th>What was read</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/* settings */
function renderSettings(){
  const f=(k,l,d,step)=>`<div><label for="s_${k}">${l}</label><input id="s_${k}" type="number" step="${step||1}" value="${S[k]}" data-set="${k}"><div class="d">${d}</div></div>`;
  const b=(k,l,d)=>`<div><label for="s_${k}">${l}</label><select id="s_${k}" data-set="${k}"><option value="1" ${S[k]?'selected':''}>On</option><option value="0" ${!S[k]?'selected':''}>Off</option></select><div class="d">${d}</div></div>`;
  return `<div class="viewbar"><h2>Check settings</h2><button class="btn sm" id="resetS">Reset to defaults</button><div class="hint">Changes apply immediately and are remembered in this browser.</div></div>
  <h3 style="margin:6px 0 10px">Package</h3>
  <div class="settings">
    ${f('coordFt','Location tolerance (ft)','Coordinates for the same pole in different documents may differ by this much.')}
    ${f('leadTol','Down guy lead tolerance (ft)','Written lead length vs the PoleForeman anchor.',0.1)}
    ${f('degTol','Guy direction tolerance (°)','Written direction vs the PoleForeman bearing.')}
    ${f('attTol','Attachment height tolerance (in)','Written attach heights vs PoleForeman.')}
    ${f('vdMax','Voltage drop limit (%)','Cumulative drop at the end of the voltage drop worksheet.',0.5)}
    ${f('flkMax','Flicker limit (%)','Cumulative drop at the end of the flicker worksheet.',0.5)}
    ${f('dcoMi','DCO distance from project (miles)','DCO coordinates farther than this from every known pole are flagged.',0.1)}
    ${b('repl250c','Replaced poles need a 250C','Flag a pole replacement whose PoleForeman report is 250B only.')}
    ${b('ocrAuto','Read sketch and photo text automatically','Loads the text reader (tesseract.js) from jsDelivr. Nothing is uploaded.')}
    <div><label for="s_qcTech">QC technician (scorecard)</label>${SCLISTS && SCLISTS.qc.length ? `<select id="s_qcTech" data-sets="qcTech"><option value="">Choose…</option>${SCLISTS.qc.map(n=>`<option ${S.qcTech===n?'selected':''}>${esc(n)}</option>`).join('')}</select>` : `<input id="s_qcTech" value="${esc(S.qcTech||'')}" data-sets="qcTech">`}<div class="d">Filled into the scorecard's QC Technician cell.</div></div>
    <div><label>Scorecard template</label><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm" data-tplup="1">Use a new template…</button>${SCLISTS&&SCLISTS.custom?'<button class="btn sm" data-tplreset="1">Use built-in</button>':''}</div><div class="d">Now using: ${esc(SCLISTS?SCLISTS.tpl:'loading…')}. You can also drop the .xlsx template onto the page.</div></div>
    <div><label>Compatible unit list</label><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm" data-cuup="1">Use a new CU list…</button>${CUDB&&CUDB.custom?'<button class="btn sm" data-cureset="1">Use built-in</button>':''}</div><div class="d">Now using: ${esc(CUDB?`${CUDB.name}, ${CUDB.n.toLocaleString()} units`:'loading…')}. Used to flag unknown CUs and to identify equipment. You can also drop the .xlsx onto the page.</div></div>
    <div><label>Read text now</label><button class="btn" data-ocr="1">Read sketch, photo and map text</button><div class="d">${needsOCR().length?`${needsOCR().length} document${needsOCR().length>1?'s':''} not read yet.`:'Everything has been read.'}</div></div>
  </div>
  <h3 style="margin:20px 0 10px">PoleForeman</h3>
  <div class="settings">
    ${f('poleFail','Pole loading limit (%)','Pole horizontal or vertical loading above this is an error.')}
    ${f('poleWarn','Pole review above (%)','Pole loading above this, but within the limit, is flagged for review.')}
    ${f('eqFail','Equipment limit (%)','Crossarms, brackets, insulators, guys, guy insulators, anchors and rods above this are errors.')}
    ${f('eqWarn','Equipment preferred max (%)','Equipment above this, but within the limit, is flagged for review.')}
    ${f('lead','Minimum guy lead : height','Lead divided by guy attachment height above ground.',0.05)}
    ${f('commSep','Comm below lowest primary (in)','Vertical separation at the pole between the highest comm and the lowest primary conductor.')}
    ${f('spanFt','Span length tolerance (ft)','Allowed difference between two poles\u2019 versions of the same span.',0.5)}
    ${f('spanPct','Span length tolerance (%)','The larger of the two tolerances is used.',0.5)}
    ${f('ang','Bearing tolerance (°)','How far from 180° two spans can be and still count as the same span.',0.5)}
    ${f('hag250c','250C height trigger (ft above ground)','Poles taller than this with no 250C analysis are flagged.')}
  </div>
  <div class="sec"><h3>NESC values checked</h3><p class="muted" style="max-width:80ch">250B Grade C: pole load factors 1.3 tension, 1.75 wind, 1.9 vertical with a 0.85 strength factor; guys 1.3 / 1.75 / 1.5 with 0.9. 250C: all load factors 1.0, pole strength factor 0.75, guys 0.9. Light district: 30°F, 9 psf, no ice (Medium 15°F, 4 psf, ¼"; Heavy 0°F, 4 psf, ½").</p></div>`;
}
document.addEventListener('click', e=>{ if (e.target.id==='resetS'){ S={...DEF}; saveS(); runChecks(); renderKpis(); render(); toast('Settings reset'); } });

/* ---------- interactions ---------- */
$('#view').addEventListener('click', e=>{
  const t = sel => e.target.closest(sel);
  let x;
  if ((x=t('[data-stn]'))){ CUR=x.dataset.stn; render(); return; }
  if ((x=t('[data-pole]'))){ const id=x.dataset.pole; CUR = STN.find(s=>s.id===id) ? id : (PF2ST[id]||id); FIL.review=false; TAB='poles'; render(); window.scrollTo({top:$('.panel').offsetTop-60}); return; }
  if ((x=t('[data-iss]'))){ gotoIssue(ISS[+x.dataset.iss]); return; }
  if ((x=t('[data-orig]'))){ openOriginal(x.dataset.orig); return; }
  if ((x=t('[data-xlsx]'))){ exportExcel(); return; }
  if ((x=t('[data-sc]'))){ exportScorecard(); return; }
  if ((x=t('[data-tplup]'))){ $('#tplFile').click(); return; }
  if ((x=t('[data-tplreset]'))){ resetTemplate(); return; }
  if ((x=t('[data-cuup]'))){ $('#cuFile').click(); return; }
  if ((x=t('[data-cureset]'))){ resetCUList(); return; }
  if ((x=t('[data-nav]'))){ if (x.dataset.nav){ CUR=x.dataset.nav; render(); } return; }
  if ((x=t('[data-review]'))){ FIL.review = x.dataset.review==='1'; render(); return; }
  if ((x=t('[data-pages]'))){ const [id,p]=x.dataset.pages.split('|'); openPages(id, p==='all'?null:p.split(',').map(Number)); return; }
  if ((x=t('[data-gosk]'))){ SKCUR=x.dataset.gosk; TAB='sketch'; render(); return; }
  if ((x=t('[data-sk]'))){ SKCUR=x.dataset.sk; render(); return; }
  if ((x=t('[data-skz]'))){ const c=x.dataset.skz; if(c==='in') skZoom(1.3); else if(c==='out') skZoom(1/1.3); else if(c==='fit') skFit(); else skFocus(STN.find(s=>s.id===SKCUR)); return; }
  if ((x=t('[data-ocr]'))){ runOCR(); return; }
  if ((x=t('[data-addmore]'))){ $('#file').click(); return; }
  if ((x=t('[data-rmdoc]'))){ const i=DOCS.findIndex(d=>d.id===x.dataset.rmdoc); if (i>=0 && confirm(`Remove ${DOCS[i].name}?`)){ dbDel(DOCS[i].id); PDFC.delete(DOCS[i].id); DOCS.splice(i,1); if (DOCS.length) rebuild(); else $('#clearAll').click(); } return; }
  if ((x=t('th[data-sort]'))){ const tb=x.dataset.t, k=x.dataset.sort; const cur=SORT[tb]||{}; SORT[tb]= cur.k===k?{k,asc:!cur.asc}:{k,asc:false}; render(); return; }
  if ((x=t('[data-copy]'))){ copyTable(x.dataset.copy); return; }
});
$('#view').addEventListener('change', e=>{
  const t=e.target;
  if (t.dataset.set){ const v=parseFloat(t.value); if(!isNaN(v)){ S[t.dataset.set]=v; saveS(); runChecks(); renderKpis(); toast('Checks updated'); } }
  if (t.dataset.fil){ FIL[t.dataset.fil]=t.value; render(); }
  if (t.dataset.sets){ S[t.dataset.sets]=t.value; saveS(); toast('Saved'); }
  if (t.dataset.scope){ if (t.value) SCOPECHK[t.dataset.scope]=t.value; else delete SCOPECHK[t.dataset.scope]; try{ localStorage.setItem('pfqc:scope', JSON.stringify(SCOPECHK)); }catch(e){} }
  if (t.dataset.skchk){ if (t.checked) SKCHK[t.dataset.skchk]=true; else delete SKCHK[t.dataset.skchk]; try{ localStorage.setItem('pfqc:skchk', JSON.stringify(SKCHK)); }catch(err){} const y=window.scrollY; renderKpis(); const keep=SKZ; render(); SKZ=keep; skApply(); window.scrollTo(0,y); }
});
$('#view').addEventListener('input', e=>{ const t=e.target; if (t.dataset.fil==='q'){ FIL.q=t.value; const pos=t.selectionStart; render(); const n=$('#view [data-fil="q"]'); if(n){ n.focus(); n.setSelectionRange(pos,pos);} } });
$('#ocrState').addEventListener('click', ()=>{ TAB='sketch'; render(); });

/* ---------- page viewer ---------- */
let LB = {doc:null, pdf:null, list:[], i:0, find:null, findPage:null};
async function openPages(docId, pages, find, startPage){
  const d=DOCS.find(x=>x.id===docId); if(!d) return;
  if (!d.bytes){ if (d.kind==='mapreq'){ TAB='permits'; render(); } return; } // images have no pages to open
  try { LB.pdf = await pdfOf(d); } catch(e){ toast('Could not open the PDF'); return; }
  LB.doc=d; LB.find=find||null;
  if (startPage){ LB.list = Array.from({length:LB.pdf.numPages},(_,i)=>i+1);
    let pg = startPage;
    if (find){ const q=String(find).toLowerCase(); for (let k=startPage; k<=Math.min(LB.pdf.numPages, startPage+8); k++){ try { const tc=await (await LB.pdf.getPage(k)).getTextContent(); if (tc.items.some(it=>it.str&&it.str.toLowerCase().includes(q))){ pg=k; break; } } catch(e){} } }
    LB.i=Math.min(Math.max(pg-1,0), LB.list.length-1); LB.all=true; LB.findPage=pg; }
  else { LB.list = pages && pages.length ? pages : Array.from({length:LB.pdf.numPages},(_,i)=>i+1); LB.i=0; LB.all=!pages; LB.findPage=LB.list[0]; }
  $('#lb').hidden=false; $('#lbTitle').textContent=d.name; showPage();
}
async function showPage(){
  const n=LB.list[LB.i]; $('#lbN').textContent = LB.all ? `${n} of ${LB.pdf.numPages}` : `page ${n} (${LB.i+1} of ${LB.list.length})`;
  $('#lbPrev').disabled=LB.i<=0; $('#lbNext').disabled=LB.i>=LB.list.length-1;
  const sc=2, cv = await renderPage(LB.pdf, n, sc);
  const wrap=document.createElement('div'); wrap.className='pgwrap';
  const im=new Image(); im.src=cv.toDataURL('image/png'); im.alt=`Page ${n} of ${LB.doc.name}`; wrap.appendChild(im);
  $('#lbPg').innerHTML=''; $('#lbPg').appendChild(wrap);
  if (LB.find && n===LB.findPage){
    try {
      const pg=await LB.pdf.getPage(n), vp=pg.getViewport({scale:sc}), tc=await pg.getTextContent();
      const q=String(LB.find).toLowerCase(); let hit=null;
      for (const it of tc.items){ if (it.str && it.str.toLowerCase().includes(q)){ hit=it; break; } }
      if (hit){ const t=pdfjsLib.Util.transform(vp.transform, hit.transform); const h=Math.hypot(t[2],t[3])||12*sc, w=(hit.width||q.length*6)*sc;
        const box=document.createElement('div'); box.className='hl'; Object.assign(box.style,{left:(t[4]-6)/cv.width*100+'%', top:(t[5]-h-4)/cv.height*100+'%', width:(w+12)/cv.width*100+'%', height:(h+10)/cv.height*100+'%'}); wrap.appendChild(box);
        setTimeout(()=>box.scrollIntoView({block:'center', inline:'center', behavior:'smooth'}), 60); }
    } catch(e){}
  }
}
$('#lbOrig').onclick=()=>{ if (LB.doc) openOriginal(LB.doc.id, LB.list[LB.i]); };
function gotoIssue(i){
  if (!i) return;
  const l=i.loc;
  if (l && l.sketch){ SKCUR=l.sketch; TAB='sketch'; SKZ=null; render(); window.scrollTo({top:$('.panel').offsetTop-60}); return; }
  if (l && l.tab){ TAB=l.tab; render(); window.scrollTo({top:$('.panel').offsetTop-60}); return; }
  if (l && l.doc){ openPages(l.doc, null, l.find, l.page||1); return; }
  if (i.pole && i.pole!=='Project'){ CUR=i.pole; TAB='poles'; render(); }
}

/* ---------- Excel list for the designer ---------- */
async function exportExcel(){
  let X; try { X = await xlsxLib(); } catch(e){ toast(e.message||'Could not load the Excel library'); return; }
  const wo = woKey();
  const ord = {bad:0,warn:1,info:2};
  const list = ISS.slice().sort((a,b)=>ord[a.sev]-ord[b.sev] || natural(a.pole,b.pole));
  const head = ['#','Pole','Severity','Area','Finding','Detail','Where to look','Page','Designer response','Fixed (Y/N)'];
  const row = (i,n) => [n+1, i.pole==='Project'?'Package':i.pole, SEVN[i.sev], i.cat, i.title, i.detail, i.loc?(i.loc.sketch?'Job sketch':(DOCS.find(d=>d.id===i.loc.doc)||{}).name||''):(i.src||''), i.loc&&i.loc.page||'', '', ''];
  const fix = list.filter(i=>i.sev!=='info'), notes = list.filter(i=>i.sev==='info');
  const wb = X.utils.book_new();
  const mk = (rows, title) => { const aoa=[[`WO ${wo} QC findings`],[`${title} · generated ${new Date().toLocaleString()} · ${fix.filter(i=>i.sev==='bad').length} errors, ${fix.filter(i=>i.sev==='warn').length} warnings`],[],head,...rows.map(row)]; const ws=X.utils.aoa_to_sheet(aoa); ws['!cols']=[{wch:5},{wch:9},{wch:10},{wch:14},{wch:60},{wch:60},{wch:38},{wch:6},{wch:36},{wch:10}]; ws['!autofilter']={ref:X.utils.encode_range({s:{r:3,c:0},e:{r:3+rows.length,c:head.length-1}})}; ws['!merges']=[{s:{r:0,c:0},e:{r:0,c:5}},{s:{r:1,c:0},e:{r:1,c:5}}]; return ws; };
  X.utils.book_append_sheet(wb, mk(fix,'Errors and warnings to fix before full QC'), 'Fix list');
  if (notes.length) X.utils.book_append_sheet(wb, mk(notes,'Notes to review'), 'Notes');
  const poles = STN.map(s=>[s.id, s.d.dloc||'', s._counts.bad, s._counts.warn, scopeOf(s).filter(r=>r.cu.s==='ok').map(r=>r.label).join('; ')]);
  const ws2 = X.utils.aoa_to_sheet([['Pole','DLOC','Errors','Warnings','Scope (station details)'],...poles]); ws2['!cols']=[{wch:8},{wch:14},{wch:8},{wch:9},{wch:90}]; X.utils.book_append_sheet(wb, ws2, 'Poles');
  const ws3 = X.utils.aoa_to_sheet([['Document type','File','Pages','What was read'],...DOCS.map(d=>[KINDS[d.kind].n, d.name, d.pages, docSummary(d)])]); ws3['!cols']=[{wch:30},{wch:50},{wch:7},{wch:90}]; X.utils.book_append_sheet(wb, ws3, 'Documents');
  X.writeFile(wb, `WO_${wo}_QC_findings.xlsx`);
  toast(`Downloaded ${fix.length} findings${notes.length?` and ${notes.length} notes`:''}`);
}

/* ---------- DCO and calculation worksheets ---------- */
function renderDevices(){
  const dcos=(PKG.dco||[]), vds=(PKG.vd||[]), dev=(PKG.deviceid||[]);
  if (!dcos.length && !vds.length && !dev.length && !(PKG.jacket||[]).length) return `<p class="muted">Add DCO forms, voltage drop / flicker worksheets, device ID screenshots or the job jacket to review them here.</p>`;
  const devIds = new Set(dev.filter(d=>!d.foreign).flatMap(d=>d.data.ids.map(x=>x.id)));
  let h = '';
  if (dcos.length){
    const rows = dcos.flatMap(d=>d.data.forms.map((F,i)=>({d,F,i})));
    h += `<div class="viewbar"><h2>DCO forms</h2></div><div class="tscroll"><table><thead><tr><th>Form</th><th>Date</th><th>DLOC</th><th>Pole</th><th class="num">Latitude</th><th class="num">Longitude</th><th>Activity</th><th>Equipment</th><th>Equip #</th><th>Phase</th><th>Feeder</th><th>WO #</th></tr></thead><tbody>${rows.map(({d,F,i})=>{ const s=STN.find(x=>x.d.dloc===F.dloc); const iss=ISS.filter(z=>z.loc&&z.loc.doc===d.id&&z.loc.page===F.page&&z.sev!=='info');
      return `<tr class="click" data-iss="${iss[0]?ISS.indexOf(iss[0]):''}" ${iss[0]?'':`data-pages="${d.id}|${F.page}"`}><td><span class="dot ${iss.some(z=>z.sev==='bad')?'bad':iss.length?'warn':'ok'}"></span> DCO ${i+1} <span class="muted sm">p. ${F.page}</span></td><td>${esc(F.date||'–')}</td><td>${esc(F.dloc||'–')}</td><td>${s?esc(s.id):'<span class="muted">not matched</span>'}</td><td class="num">${esc(F.latText||'–')}</td><td class="num">${esc(F.lonText||'–')}</td><td>${esc(F.activity.join(', ')||'–')}</td><td>${F.rows.map(r=>esc(`${r.action} ${r.type} ${r.size}`)).join('<br>')}</td><td>${F.rows.map(r=>`<span class="${r.equip&&devIds.size&&!devIds.has(r.equip.toUpperCase())?'pct bad':''}">${esc(r.equip||'–')}</span>`).join('<br>')}</td><td>${F.rows.map(r=>esc(r.phase||'–')).join('<br>')}</td><td>${esc(F.feeder||'–')}</td><td>${esc(F.wo||'blank')}</td></tr>`; }).join('')}</tbody></table></div>`;
  }
  if (dev.length) h += `<div class="sec"><h3>Generated device IDs</h3><div class="tscroll"><table><thead><tr><th>Device ID</th><th>Type</th><th>Work order</th><th>Generated</th><th>By</th><th>On a DCO?</th></tr></thead><tbody>${dev.flatMap(d=>d.data.ids.map(x=>({d,x}))).map(({d,x})=>{ const used=dcos.some(dd=>dd.data.forms.some(f=>f.rows.some(r=>(r.equip||'').toUpperCase()===x.id))); return `<tr><td><button class="link" data-pages="${d.id}|${x.page}">${esc(x.id)}</button></td><td>${esc(x.type||'')}</td><td>${esc(x.wo||'')}${d.foreign?' <span class="pill bad">other WO</span>':''}</td><td>${esc(x.when||'')}</td><td>${esc(x.user||'')}</td><td>${used?'<span class="pill ok">Yes</span>':'<span class="pill warn">No</span>'}</td></tr>`; }).join('')}</tbody></table></div></div>`;
  vds.forEach(d=>{ const V=d.data, lim=V.kind==='flicker'?S.flkMax:S.vdMax;
    h += `<div class="sec"><h3>${V.kind==='flicker'?'Flicker':'Voltage drop'} worksheet <span class="muted sm">${esc(d.name)} · ${V.xfmr||'?'} kVA transformer${V.starting?` · motor starting ${V.starting} kVA`:''}${d.foreign?' · other WO':''}</span> <button class="btn sm" data-orig="${d.id}">Open PDF</button></h3><div class="tscroll"><table><thead><tr><th class="num">Point</th><th>Voltage</th><th>Wire / kVA</th><th>Type</th><th class="num">Feet</th><th class="num">Load kVA</th><th class="num">Cumulative drop</th><th class="num">Section drop</th><th class="num">kVA thru</th><th class="num">Capacity</th><th class="num">Amps</th></tr></thead><tbody>${V.rows.map(r=>`<tr><td class="num">${r.point}</td><td>${esc(r.v)}</td><td>${esc(r.wire)}</td><td>${esc(r.inst)}</td><td class="num">${f1(r.feet)}</td><td class="num">${r.load==null?'–':f1(r.load)}</td><td class="num"><span class="${r.cum>lim?'pct warn':''}">${f1(r.cum)}%</span></td><td class="num">${f2(r.sect)}%</td><td class="num"><span class="${r.cap&&r.kva>r.cap?'pct warn':''}">${f0(r.kva)}</span></td><td class="num">${r.cap?f0(r.cap):'–'}</td><td class="num">${f0(r.amps)}</td></tr>`).join('')}</tbody></table></div></div>`; });
  (PKG.jacket||[]).forEach(d=>{ const J=d.data, O=J.ocr||{};
    h += `<div class="sec"><h3>Job jacket <span class="muted sm">${esc(d.name)}${d.foreign?' · other WO':''}</span> <button class="btn sm" data-orig="${d.id}">Open PDF</button></h3><div class="grid2"><div class="tscroll"><table><tbody>${[['Work order',J.wo],['Type',[J.workType,J.subType].filter(Boolean).join(' / ')],['Designer',[J.designer,O.designerName].filter(Boolean).join(' · ')],['Target finish',J.targetFinish],['Address',[J.address,J.city,J.state].filter(Boolean).join(', ')],['Local office',[J.office,J.officeName].filter(Boolean).join(' ')],['Man hours',O.manHours],['Upstream device',O.upstream],['Voltage',O.voltage],['Location (jacket text)',O.location],['In conjunction with',(O.conjunction||[]).join(', ')]].map(([l,v])=>`<tr><th>${l}</th><td>${v!=null&&v!==''?esc(v):'<span class="muted">'+(J.ocr?'–':'not read yet')+'</span>'}</td></tr>`).join('')}</tbody></table></div>${J.img?`<figure class="light" style="margin:0;border:1px solid var(--rule);border-radius:8px;overflow:hidden"><img src="${J.img}" alt="Job jacket page" style="width:100%;display:block"></figure>`:''}</div></div>`; });
  return h;
}
$('#lbPrev').onclick=()=>{ if(LB.i>0){LB.i--; showPage();} }; $('#lbNext').onclick=()=>{ if(LB.i<LB.list.length-1){LB.i++; showPage();} };
$('#lbClose').onclick=()=>{ $('#lb').hidden=true; };
document.addEventListener('keydown', e=>{ if ($('#lb').hidden) return; if (e.key==='Escape') $('#lbClose').click(); if (e.key==='ArrowRight') $('#lbNext').click(); if (e.key==='ArrowLeft') $('#lbPrev').click(); });
document.addEventListener('click', e=>{ if (e.target.closest('#reviewBtn') || e.target.closest('[data-gotoreview]')){ FIL.review=true; TAB='poles'; CUR=null; render(); const pn=$('.panel'); if(pn) window.scrollTo({top:pn.offsetTop-60}); } });
let tt; function toast(t){ const el=$('#toast'); el.textContent=t; el.classList.add('show'); clearTimeout(tt); tt=setTimeout(()=>el.classList.remove('show'),2800); }
window.addEventListener('resize', ()=>{ if (TAB==='sketch' && SKZ) { SKZ.pole=null; wireSketchResize(); } });
function wireSketchResize(){ const s=STN.find(x=>x.id===SKCUR); if (s) skFocus(s); if (SKZ) SKZ.pole=SKCUR; }
})();


