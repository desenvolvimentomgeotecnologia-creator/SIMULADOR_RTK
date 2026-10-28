/* MGEO · Simulador de Cobertura RTK UHF 450 MHz */
(() => {
const $ = id => document.getElementById(id);
const PI = Math.PI, log10 = Math.log10;
const COLORS = { 3:[0,170,0], 2:[255,230,0], 1:[230,0,0], 0:[55,55,55], [-1]:[55,55,55] };
const RE = 8494000;            // raio efetivo da Terra (k=4/3)
const BLOCK = -999, OUT = -1e9;
const MOBILE = window.matchMedia('(max-width:760px)').matches || /Android|iPhone|iPad/i.test(navigator.userAgent);
const STORE = 'mgeo-rtk-v2';

if (window.MGEO_LOGO) $('logoImg').src = window.MGEO_LOGO;

/* ---------------- PERSISTÊNCIA DOS CAMPOS ---------------- */
const fields = [...document.querySelectorAll('#panel input[id], #panel select[id]')].filter(e => !['q','lat','lon'].includes(e.id));
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
  fields.forEach(e => { if (saved[e.id] !== undefined){ if (e.type==='checkbox') e.checked = saved[e.id]; else e.value = saved[e.id]; } });
} catch(e){}
function persist(){
  try { const o = {}; fields.forEach(e => o[e.id] = e.type==='checkbox' ? e.checked : e.value); localStorage.setItem(STORE, JSON.stringify(o)); } catch(e){}
}
fields.forEach(e => e.addEventListener('change', persist));

/* ---------------- MAPA ---------------- */
const map = L.map('map', { zoomControl:true, tap:true }).setView([-22.5, -52.2], 7);
const bases = {
  'Google Híbrido': L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&hl=pt-BR&x={x}&y={y}&z={z}', { maxZoom:21, subdomains:['0','1','2','3'], attribution:'Imagens © Google' }),
  'Satélite (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom:19, attribution:'Imagens © Esri' }),
  'Topográfico (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom:17, attribution:'© OpenTopoMap © OpenStreetMap' }),
  'Ruas (OSM)': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, attribution:'© OpenStreetMap' })
};
bases['Google Híbrido'].addTo(map);
const hill = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', { maxZoom:16, opacity:0.4, attribution:'Relevo © Esri' });
L.control.layers(bases, { 'Relevo sombreado': hill }, { position:'topright' }).addTo(map);
L.control.scale({ imperial:false }).addTo(map);

const towerSvg = (col, label) => `<svg width="30" height="42" viewBox="0 0 30 42"><g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round">
   <path d="M15 12 L8 38 M15 12 L22 38 M10 30 L20 30 M11.5 23 L18.5 23"/><circle cx="15" cy="9" r="3" fill="${col}" stroke="#fff"/>
   <path d="M8 4 a10 10 0 0 0 0 10 M22 4 a10 10 0 0 1 0 10" stroke="${col}"/></g>
   ${label ? `<rect x="19" y="27" width="11" height="13" rx="3" fill="${col}"/><text x="24.5" y="37.5" font-size="10" font-weight="700" text-anchor="middle" fill="#000" font-family="sans-serif">${label}</text>` : ''}</svg>`;
const towerIcon = L.divIcon({ className:'tower-ic', iconSize:[30,42], iconAnchor:[15,39], html:towerSvg('#38bdf8') });
const repIcon = i => L.divIcon({ className:'tower-ic', iconSize:[30,42], iconAnchor:[15,39], html:towerSvg('#f97316', i) });

let mode = 'tower', base = null, reps = [], overlay = null, circles = [], demLayer = null, towerMarker = null;
let profLine = null, profMarker = null, lastProfile = null, gpsMarker = null;

/* ---------------- ALTIMETRIA (Terrarium) ---------------- */
const tiles = new Map();
let demZ = 12;
const lonToPx = (lon,z) => (lon+180)/360*256*Math.pow(2,z);
const latToPx = (lat,z) => { const r = lat*PI/180; return (1 - Math.log(Math.tan(r)+1/Math.cos(r))/PI)/2*256*Math.pow(2,z); };
const pxToLat0 = y => Math.atan(Math.sinh(PI*(1 - 2*y/256)))*180/PI;

function loadImg(urls){
  return new Promise(res => {
    const img = new Image(); img.crossOrigin = 'anonymous'; let k = 0;
    img.onload = () => res(img);
    img.onerror = () => { if (++k < urls.length) img.src = urls[k]; else res(null); };
    img.src = urls[0];
  });
}
async function loadTile(z,x,y){
  const key = z+'/'+x+'/'+y;
  if (tiles.has(key)) return;
  const img = await loadImg([
    `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png?r=1`
  ]);
  if (!img){ tiles.set(key,null); return; }
  try{
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const cx = c.getContext('2d', { willReadFrequently:true });
    cx.drawImage(img,0,0);
    const d = cx.getImageData(0,0,256,256).data;
    const a = new Float32Array(65536);
    for (let i=0;i<65536;i++) a[i] = (d[4*i]*256 + d[4*i+1] + d[4*i+2]/256) - 32768;
    tiles.set(key,a);
  }catch(err){ tiles.set(key,null); }
}

async function ensureDEM(bb){
  let z;
  const maxT = MOBILE ? 100 : 150;
  for (z=13; z>=8; z--) {
    const nx = Math.floor(lonToPx(bb.e,z)/256) - Math.floor(lonToPx(bb.w,z)/256) + 1;
    const ny = Math.floor(latToPx(bb.s,z)/256) - Math.floor(latToPx(bb.n,z)/256) + 1;
    if (nx*ny <= maxT) break;
  }
  demZ = z;
  const x0 = Math.floor(lonToPx(bb.w,z)/256), x1 = Math.floor(lonToPx(bb.e,z)/256);
  const y0 = Math.floor(latToPx(bb.n,z)/256), y1 = Math.floor(latToPx(bb.s,z)/256);
  const jobs = [];
  for (let x=x0;x<=x1;x++) for (let y=y0;y<=y1;y++) jobs.push(loadTile(z,x,y));
  let done = 0;
  await Promise.all(jobs.map(p => p.then(()=>{ done++; setStatus(`Baixando altimetria… ${done}/${jobs.length}`); })));
  let ok = 0;
  for (let x=x0;x<=x1;x++) for (let y=y0;y<=y1;y++) if (tiles.get(z+'/'+x+'/'+y)) ok++;
  return { ok, total: jobs.length };
}

function rawPx(ix,iy){
  const a = tiles.get(demZ+'/'+(ix>>8)+'/'+(iy>>8));
  return a ? a[(iy&255)*256 + (ix&255)] : NaN;
}
function elevAt(lat,lon){
  const px = lonToPx(lon,demZ)-0.5, py = latToPx(lat,demZ)-0.5;
  const x0 = Math.floor(px), y0 = Math.floor(py), fx = px-x0, fy = py-y0;
  const a=rawPx(x0,y0), b=rawPx(x0+1,y0), c=rawPx(x0,y0+1), d=rawPx(x0+1,y0+1);
  if (isNaN(a+b+c+d)) { const v=[a,b,c,d].filter(v=>!isNaN(v)); return v.length ? v[0] : 0; }
  return (a*(1-fx)+b*fx)*(1-fy) + (c*(1-fx)+d*fx)*fy;
}
const demPxMeters = lat => 156543.03*Math.cos(lat*PI/180)/Math.pow(2,demZ);

/* ---------------- PARÂMETROS ---------------- */
const num = id => parseFloat($(id).value);
const wToDbm = w => 10*log10(Math.max(0.001,w)*1000);
function P(){
  return {
    f:num('f'), ptx:wToDbm(num('pW')), gTx:num('gTx'), lCable:num('lCable'), gRx:num('gRx'),
    hTx:Math.max(1,num('hTx')), hRx:Math.max(0.3,num('hRx')), sens:num('sens'),
    radius:Math.min(80,Math.max(1,num('radius')))*1000, model:$('model').value, clutter:num('clutter'),
    good:num('thrGood'), med:num('thrMed'),
    cut: $('losMode').value === 'cut', fres: parseFloat($('fresReq').value),
    hRep:Math.max(1,num('hRep')), pRep:wToDbm(num('pRep')), gRep:num('gRep')
  };
}
const repParams  = p => ({ ...p, hTx:p.hRep, ptx:p.pRep, gTx:p.gRep });
const linkParams = p => ({ ...p, hRx:p.hRep, gRx:p.gRep });
function cls(v,p){ if (v<=OUT/2) return -2; if (v<=BLOCK+1) return -1; if (v>=p.good) return 3; if (v>=p.med) return 2; if (v>=p.sens) return 1; return 0; }
const NAMES = {3:'Bom',2:'Médio',1:'Ruim',0:'Sem sinal',[-1]:'Bloqueado pelo terreno'};

/* ---------------- PROPAGAÇÃO ----------------
   Perfil a partir da torre (índice 0). Perda = max(espaço livre, terra plana)
   + difração de Bullington (horizonte da torre x horizonte do rover)
   + perda de vegetação. */
let EA = new Float64Array(4096);
function computeAlong(elev, n, step, p, out){
  const lam = 299.792458/p.f;
  const txH = elev[0] + p.hTx;
  const eirp = p.ptx + p.gTx - p.lCable + p.gRx;
  const fTerm = 32.45 + 20*log10(p.f);
  const Wn = Math.max(3, Math.round(4000/step));      // janela do horizonte do rover (4 km)
  if (EA.length < n+1) EA = new Float64Array(n+1);
  const ea = EA;
  for (let i=0;i<=n;i++){ const d=i*step; ea[i] = elev[i] - d*d/(2*RE); }
  let maxSlope = -Infinity, dObs = 0;
  out[0] = eirp - 40;
  for (let i=1;i<=n;i++){
    const d = i*step, e = ea[i], rxH = e + p.hRx, sRx = (rxH - txH)/d;
    let J = 0, blocked = false;
    if (maxSlope > -Infinity){
      const d1 = dObs, d2 = d - d1;
      const h = (maxSlope - sRx)*d1;                    // obstáculo dominante acima(+)/abaixo(-) da visada
      let v = h*Math.sqrt(2*d/(lam*d1*d2));
      if (h > 0){                                       // sem visada: Bullington
        let Sr = (txH + maxSlope*d1 - rxH)/d2;          // horizonte do rover (inclui obstáculo dominante)
        for (let j=Math.max(1,i-Wn); j<i; j++){ const s = (ea[j]-rxH)/(d-j*step); if (s > Sr) Sr = s; }
        const den = maxSlope + Sr;
        if (den > 1e-12){
          let db = (rxH - txH + Sr*d)/den;
          if (db < step) db = step; if (db > d-step) db = d-step;
          const hb = txH + maxSlope*db - (txH*(d-db) + rxH*db)/d;
          const vb = hb*Math.sqrt(2*d/(lam*db*(d-db)));
          if (vb > v) v = vb;
        }
      }
      if (p.cut && h > -p.fres*Math.sqrt(lam*d1*d2/d)) blocked = true;
      if (v > -0.78) J = 6.9 + 20*log10(Math.sqrt((v-0.1)*(v-0.1)+1) + v - 0.1);
    }
    let L = fTerm + 20*log10(d/1000);
    if (p.model === '2ray'){
      const ht = Math.max(p.hTx, txH - e);
      const pe = 40*log10(d) - 20*log10(ht*p.hRx);
      if (pe > L) L = pe;
    }
    out[i] = blocked ? BLOCK : eirp - L - J - p.clutter;
    const sT = (e - txH)/d;
    if (sT > maxSlope){ maxSlope = sT; dObs = d; }
  }
  return out;
}

function newSite(lat0, lon0, pp, opt){
  const R = opt.R, mLat = 111320, mLon = 111320*Math.cos(lat0*PI/180);
  const nSteps = Math.ceil(R/opt.step);
  return { lat0, lon0, mLat, mLon, R, step:opt.step, nSteps, nAz:opt.nAz, pp,
    result:new Float32Array(opt.nAz*(nSteps+1)),
    s:lat0-R/mLat, n:lat0+R/mLat, w:lon0-R/mLon, e:lon0+R/mLon };
}
function computeRadials(S, a0, a1, elev){
  for (let a=a0;a<a1;a++){
    const az = a*2*PI/S.nAz, sa = Math.sin(az), ca = Math.cos(az);
    for (let i=0;i<=S.nSteps;i++){ const d=i*S.step; elev[i] = elevAt(S.lat0 + d*ca/S.mLat, S.lon0 + d*sa/S.mLon); }
    computeAlong(elev, S.nSteps, S.step, S.pp, S.result.subarray(a*(S.nSteps+1),(a+1)*(S.nSteps+1)));
  }
}
async function computeSiteAsync(S, label, my){
  const elev = new Float32Array(S.nSteps+1);
  for (let a=0;a<S.nAz;a+=40){
    computeRadials(S, a, Math.min(S.nAz,a+40), elev);
    setStatus(`${label} ${Math.round(a/S.nAz*100)}%`);
    await frame(); if (my !== runId) return false;
  }
  return true;
}
const computeSiteSync = S => computeRadials(S, 0, S.nAz, new Float32Array(S.nSteps+1));
function fullOpts(lat, R){
  const step = Math.max(20, demPxMeters(lat)*0.8);
  const mx = MOBILE ? 900 : 1440;
  return { R, step, nAz:Math.min(mx, Math.max(360, Math.ceil(2*PI*R/(step*3)))) };
}
function siteVal(S, lat, lon){
  const dy=(lat-S.lat0)*S.mLat, dx=(lon-S.lon0)*S.mLon, d=Math.hypot(dx,dy);
  if (d > S.R) return OUT;
  let az = Math.atan2(dx,dy); if (az<0) az += 2*PI;
  const ai = Math.round(az/(2*PI)*S.nAz) % S.nAz;
  const si = Math.min(S.nSteps, Math.round(d/S.step));
  return S.result[ai*(S.nSteps+1)+si];
}
function allSites(){ const a=[]; if (base && base.site) a.push(base.site); reps.forEach(r=>r.site && a.push(r.site)); return a; }
function combined(lat, lon){
  let v = OUT, src = -1; const ss = allSites();
  for (let i=0;i<ss.length;i++){ const x = siteVal(ss[i],lat,lon); if (x > v){ v = x; src = i; } }
  return { v, src };
}
function bboxOf(sites){
  const bb = { s:Infinity, n:-Infinity, w:Infinity, e:-Infinity };
  sites.forEach(S => { bb.s=Math.min(bb.s,S.s); bb.n=Math.max(bb.n,S.n); bb.w=Math.min(bb.w,S.w); bb.e=Math.max(bb.e,S.e); });
  return bb;
}
function circleBB(lat, lon, R){
  const mLat=111320, mLon=111320*Math.cos(lat*PI/180);
  return { s:lat-R/mLat, n:lat+R/mLat, w:lon-R/mLon, e:lon+R/mLon };
}
const unionBB = (a, b) => ({ s:Math.min(a.s,b.s), n:Math.max(a.n,b.n), w:Math.min(a.w,b.w), e:Math.max(a.e,b.e) });

function profileLevels(lat0, lon0, lat1, lon1, pp, maxStep){
  const mLat=111320, mLon=111320*Math.cos(lat0*PI/180);
  const D = Math.hypot((lat1-lat0)*mLat, (lon1-lon0)*mLon);
  const n = Math.min(3000, Math.max(20, Math.ceil(D/(maxStep||30))));
  const step = D/n, elev = new Float32Array(n+1), out = new Float32Array(n+1);
  for (let i=0;i<=n;i++){ const t=i/n; elev[i] = elevAt(lat0+(lat1-lat0)*t, lon0+(lon1-lon0)*t); }
  computeAlong(elev, n, step, pp, out);
  return { D, n, step, elev, out };
}
const linkDbm = (a, b, pp) => profileLevels(a.lat, a.lng, b.lat, b.lng, pp, 40).out.at(-1);

const frame = () => new Promise(r => requestAnimationFrame(()=>r()));
let runId = 0;

/* ---------------- SIMULAÇÃO ---------------- */
async function simulate(askSave){
  if (!base) return;
  const my = ++runId;
  const p = P();
  busy(true);
  let bb = circleBB(base.lat, base.lng, p.radius);
  reps.forEach(r => bb = unionBB(bb, circleBB(r.lat, r.lng, p.radius)));
  const dem = await ensureDEM(bb);
  if (my !== runId) return;
  if (dem.ok === 0){
    busy(false);
    setStatus('ERRO: não foi possível baixar a altimetria. Verifique a internet/firewall (s3.amazonaws.com).');
    alert('Não consegui baixar os dados de altimetria (s3.amazonaws.com). Sem eles o terreno não é considerado.\nVerifique sua conexão ou se a rede bloqueia esse endereço.');
    return;
  }
  const t0 = performance.now();
  const elevTx = elevAt(base.lat, base.lng);
  base.elev = elevTx;
  $('elevTx').textContent = elevTx.toFixed(0)+' m (topo da antena: '+(elevTx+p.hTx).toFixed(0)+' m)';
  base.site = newSite(base.lat, base.lng, { ...p }, fullOpts(base.lat, p.radius));
  if (!await computeSiteAsync(base.site, 'Calculando torre base…', my)) return;
  for (let i=0;i<reps.length;i++){
    const r = reps[i];
    r.site = newSite(r.lat, r.lng, repParams(p), fullOpts(r.lat, p.radius));
    if (!await computeSiteAsync(r.site, `Calculando repetidora ${i+1}…`, my)) return;
    r.link = linkDbm(base, r, linkParams(p));
    r.elev = elevAt(r.lat, r.lng);
  }
  buildDemLayer();
  render();
  updateRepList();
  busy(false);
  setStatus(`Pronto em ${((performance.now()-t0)/1000).toFixed(1)} s` + (reps.length ? ` · base + ${reps.length} repetidora(s)` : '') +
    (dem.ok<dem.total ? ` · ATENÇÃO: ${dem.total-dem.ok} de ${dem.total} blocos de altimetria falharam` : ''));
  if (lastProfile) showProfile(lastProfile);
  if (askSave) showSaveBar();
}
function busy(b){
  $('run').disabled = b; $('suggest').disabled = b;
  $('busy').style.display = b ? 'block' : 'none';
}

/* ---------------- RENDERIZAÇÃO ---------------- */
function renderCanvas(proj, W, bbOpt, Hopt){
  const p = P(), ss = allSites();
  const bb = bbOpt || bboxOf(ss);
  const latC = (bb.s+bb.n)/2, mLat = 111320, mLon = 111320*Math.cos(latC*PI/180);
  const yN = latToPx(bb.n,0), yS = latToPx(bb.s,0);
  let H = Hopt;
  if (!H) H = proj === 'merc' ? Math.round(W*(yS-yN)/((bb.e-bb.w)/360*256)) : Math.round(W*(bb.n-bb.s)*mLat/((bb.e-bb.w)*mLon));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const cx = c.getContext('2d'), img = cx.createImageData(W,H), D = img.data;
  const showNone = $('showNone').checked;
  const cnt = [0,0,0,0,0]; let tot = 0;
  const lons = new Float64Array(W); for (let px=0;px<W;px++) lons[px] = bb.w + (px+0.5)/W*(bb.e-bb.w);
  for (let py=0;py<H;py++){
    const lat = proj==='merc' ? pxToLat0(yN + (py+0.5)/H*(yS-yN)) : bb.n - (py+0.5)/H*(bb.n-bb.s);
    for (let px=0;px<W;px++){
      let v = OUT;
      for (let i=0;i<ss.length;i++){ const x = siteVal(ss[i], lat, lons[px]); if (x > v) v = x; }
      const k = cls(v,p);
      if (k === -2) continue;
      tot++; cnt[k===-1 ? 4 : k]++;
      if (k <= 0 && !showNone) continue;
      const col = COLORS[k], o = 4*(py*W+px);
      D[o]=col[0]; D[o+1]=col[1]; D[o+2]=col[2]; D[o+3] = k<=0 ? 150 : 255;
    }
  }
  cx.putImageData(img,0,0);
  const pxArea = ((bb.e-bb.w)*mLon/W)*((bb.n-bb.s)*mLat/H)/1e6;
  return { c, W, H, bb, cnt, tot, pxArea };
}

let lastStats = null;
function render(){
  if (!base || !base.site) return;
  const p = P();
  const r = renderCanvas('merc', MOBILE ? 1000 : 1400);
  lastStats = r;
  if (overlay) map.removeLayer(overlay);
  overlay = L.imageOverlay(r.c.toDataURL(), [[r.bb.s,r.bb.w],[r.bb.n,r.bb.e]], { opacity: num('opac'), interactive:false }).addTo(map);
  circles.forEach(c => map.removeLayer(c)); circles = [];
  allSites().forEach((S,i) => circles.push(L.circle([S.lat0,S.lon0], { radius:S.R, color: i===0 ? '#39ff14' : '#f97316', weight: i===0 ? 3 : 2, fill:false, dashArray: i===0 ? null : '8 6', interactive:false }).addTo(map)));
  const fmt = k => r.tot ? `${(r.cnt[k]/r.tot*100).toFixed(0)}% · ${(r.cnt[k]*r.pxArea).toFixed(0)} km²` : '—';
  $('pG').textContent = fmt(3); $('pM').textContent = fmt(2); $('pB').textContent = fmt(1); $('pN').textContent = fmt(0); $('pX').textContent = fmt(4);
  $('lgG').textContent = `Bom (≥ ${p.good} dBm)`;
  $('lgM').textContent = `Médio (${p.med} a ${p.good} dBm)`;
  $('lgB').textContent = `Ruim (${p.sens} a ${p.med} dBm)`;
  $('lgN').textContent = `Sem sinal (< ${p.sens} dBm)`;
}

let demStats = null;
function buildDemLayer(){
  if (demLayer){ map.removeLayer(demLayer); demLayer = null; }
  const ss = allSites(); if (!ss.length) return;
  const bb = bboxOf(ss), W = 500, H = 500;
  const yN = latToPx(bb.n,0), yS = latToPx(bb.s,0);
  const E = new Float32Array(W*H); let lo=Infinity, hi=-Infinity;
  for (let py=0;py<H;py++){
    const lat = pxToLat0(yN + (py+0.5)/H*(yS-yN));
    for (let px=0;px<W;px++){ const v = elevAt(lat, bb.w+(px+0.5)/W*(bb.e-bb.w)); E[py*W+px]=v; if(v<lo)lo=v; if(v>hi)hi=v; }
  }
  demStats = { lo, hi };
  $('demInfo').textContent = `Altimetria carregada: mín ${lo.toFixed(0)} m · máx ${hi.toFixed(0)} m · desnível ${(hi-lo).toFixed(0)} m`;
  if (!$('showDem').checked) return;
  const c = document.createElement('canvas'); c.width=W; c.height=H;
  const cx = c.getContext('2d'), img = cx.createImageData(W,H), D = img.data;
  const ramp = [[0,[13,94,45]],[.25,[90,160,60]],[.5,[230,210,110]],[.75,[170,100,40]],[1,[245,245,245]]];
  for (let i=0;i<W*H;i++){
    const t = (E[i]-lo)/Math.max(1,hi-lo); let j=0; while (j<ramp.length-2 && t>ramp[j+1][0]) j++;
    const [t0,c0]=ramp[j],[t1,c1]=ramp[j+1], f=(t-t0)/(t1-t0);
    const px=i%W, gx = px<W-1 ? E[i+1]-E[i] : 0, gy = i+W<W*H ? E[i+W]-E[i] : 0;
    const sh = Math.max(0.55, Math.min(1.25, 1 - (gx+gy)*0.04));
    D[4*i]=(c0[0]+(c1[0]-c0[0])*f)*sh; D[4*i+1]=(c0[1]+(c1[1]-c0[1])*f)*sh; D[4*i+2]=(c0[2]+(c1[2]-c0[2])*f)*sh; D[4*i+3]=255;
  }
  cx.putImageData(img,0,0);
  demLayer = L.imageOverlay(c.toDataURL(), [[bb.s,bb.w],[bb.n,bb.e]], { opacity:0.85, interactive:false }).addTo(map);
  if (overlay) overlay.bringToFront();
}

/* ---------------- REPETIDORAS ---------------- */
function addRep(ll){
  const r = { lat:ll.lat, lng:ll.lng, site:null, link:null, elev:null, gain:null };
  r.marker = L.marker([r.lat,r.lng], { icon:repIcon(reps.length+1), draggable:true, zIndexOffset:900 }).addTo(map);
  r.marker.on('dragend', () => { const q = r.marker.getLatLng(); r.lat=q.lat; r.lng=q.lng; r.gain=null; simulate(false); });
  r.marker.bindPopup(() => repPopup(r));
  reps.push(r);
  return r;
}
function removeRep(r){
  map.removeLayer(r.marker);
  reps = reps.filter(x => x !== r);
  reps.forEach((x,i) => x.marker.setIcon(repIcon(i+1)));
}
function repPopup(r){
  const p = P(), i = reps.indexOf(r)+1, k = r.link==null ? null : cls(r.link,p);
  const div = document.createElement('div');
  div.innerHTML = `<b>Repetidora ${i}</b><br>${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}<br>`+
    (r.elev!=null ? `Altitude do terreno: ${r.elev.toFixed(0)} m · antena ${p.hRep} m<br>` : '')+
    (k!=null ? `Enlace base → repetidora: <b>${k===-1 ? 'SEM VISADA' : r.link.toFixed(1)+' dBm ('+NAMES[k]+')'}</b><br>` : '')+
    `<button style="margin-top:6px;color:#000;background:#fff">Remover</button>`;
  div.querySelector('button').onclick = () => { map.closePopup(); removeRep(r); simulate(false); };
  return div;
}
function updateRepList(){
  const p = P();
  $('repList').innerHTML = reps.map((r,i) => {
    const k = r.link==null ? null : cls(r.link,p);
    const lk = k==null ? '—' : (k===-1 ? '<span style="color:#f87171">sem visada da base!</span>' : `${r.link.toFixed(1)} dBm (${NAMES[k]})`);
    return `<div class="ri"><b>R${i+1}</b> · ${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}<br>Alt. terreno ${r.elev!=null?r.elev.toFixed(0):'—'} m · antena ${p.hRep} m<br>Enlace da base: ${lk}`+
      (r.gain!=null ? `<br>Recupera ≈ <b>${r.gain.toFixed(0)} km²</b> de área sem sinal/ruim` : '') + `</div>`;
  }).join('');
}

async function suggestRepeaters(){
  if (!base || !base.site){ setStatus('Posicione e simule a torre primeiro.'); return; }
  const my = ++runId; busy(true);
  const p = P(), N = parseInt($('nRep').value), R = p.radius;
  reps.slice().forEach(removeRep);
  hideSaveBar();
  const S0 = base.site;
  const dem = await ensureDEM(circleBB(base.lat, base.lng, 2*R));
  if (my !== runId) return;
  if (!dem.ok){ busy(false); setStatus('ERRO ao baixar altimetria.'); return; }

  const G = MOBILE ? 80 : 110, targets = [];
  for (let gy=0;gy<G;gy++) for (let gx=0;gx<G;gx++){
    const lat = S0.s + (gy+0.5)/G*(S0.n-S0.s), lon = S0.w + (gx+0.5)/G*(S0.e-S0.w);
    const v = siteVal(S0, lat, lon);
    if (v > OUT/2 && cls(v,p) < 2) targets.push([lat,lon]);
  }
  const cellKm2 = (2*R/G/1000)**2;
  if (!targets.length){ busy(false); setStatus('A torre já cobre toda a área com sinal médio/bom. Nenhuma repetidora necessária.'); return; }

  const CG = MOBILE ? 24 : 34, sp = 2*R/CG, lp = linkParams(p), cands = [];
  for (let gy=0;gy<CG;gy++){
    for (let gx=0;gx<CG;gx++){
      const lat = S0.s + (gy+0.5)/CG*(S0.n-S0.s), lon = S0.w + (gx+0.5)/CG*(S0.e-S0.w);
      const d = Math.hypot((lat-S0.lat0)*S0.mLat, (lon-S0.lon0)*S0.mLon);
      if (d > R*0.97 || d < 500) continue;
      const lk = linkDbm(base, {lat,lng:lon}, lp);
      if (lk >= p.med) cands.push({ lat, lng:lon, link:lk });
    }
    if (gy%4===0){ setStatus(`Analisando visada para repetidoras… ${Math.round(gy/CG*30)}%`); await frame(); if (my!==runId) return; }
  }
  if (!cands.length){ busy(false); setStatus('Nenhum ponto recebe a base com sinal ≥ MÉDIO. Aumente a altura da repetidora ou da torre.'); return; }

  const rp = repParams(p), coarse = { R, step:Math.max(90, demPxMeters(base.lat)), nAz: MOBILE ? 90 : 120 };
  const T = targets.length;
  const coverBits = c => {
    const S = newSite(c.lat, c.lng, rp, coarse); computeSiteSync(S);
    const b = new Uint8Array(T);
    for (let t=0;t<T;t++) if (cls(siteVal(S, targets[t][0], targets[t][1]), p) >= 2) b[t] = 1;
    return b;
  };
  for (let i=0;i<cands.length;i++){
    cands[i].bits = coverBits(cands[i]);
    if (i%6===0){ setStatus(`Simulando visada dos candidatos… ${30+Math.round(i/cands.length*60)}%`); await frame(); if (my!==runId) return; }
  }

  const covered = new Uint8Array(T), chosen = [];
  const gainOf = (b, cov) => { let g=0; for (let t=0;t<T;t++) if (b[t] && !cov[t]) g++; return g; };
  for (let k=0;k<N;k++){
    let best=null, bg=0;
    for (const c of cands){ if (chosen.includes(c)) continue; const g = gainOf(c.bits, covered); if (g>bg){ bg=g; best=c; } }
    if (!best) break;
    chosen.push(best);
    for (let t=0;t<T;t++) if (best.bits[t]) covered[t]=1;
  }
  if (!chosen.length){ busy(false); setStatus('Nenhum ponto candidato melhora a cobertura.'); return; }

  setStatus('Refinando posição das repetidoras… 92%'); await frame();
  for (let i=0;i<chosen.length;i++){
    const others = new Uint8Array(T);
    chosen.forEach((c,j) => { if (j!==i) for (let t=0;t<T;t++) if (c.bits[t]) others[t]=1; });
    let best = chosen[i], bg = gainOf(best.bits, others);
    for (let oy=-2;oy<=2;oy++) for (let ox=-2;ox<=2;ox++){
      if (!ox && !oy) continue;
      const c = { lat: chosen[i].lat + oy*sp/3/S0.mLat, lng: chosen[i].lng + ox*sp/3/S0.mLon };
      c.link = linkDbm(base, c, lp); if (c.link < p.med) continue;
      c.bits = coverBits(c); const g = gainOf(c.bits, others);
      if (g > bg){ bg = g; best = c; }
    }
    chosen[i] = best;
    await frame(); if (my!==runId) return;
  }
  const cov2 = new Uint8Array(T);
  chosen.forEach(c => { c.gain = gainOf(c.bits, cov2)*cellKm2; for (let t=0;t<T;t++) if (c.bits[t]) cov2[t]=1; });

  chosen.forEach(c => { const r = addRep(c); r.gain = c.gain; });
  busy(false);
  await simulate(true);
  setStatus(`Sugeridas ${chosen.length} repetidora(s) entre ${cands.length} pontos com visada da base. Arraste para ajustar.`);
}

/* ---------------- ZIP / DOWNLOAD ---------------- */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n=0;n<256;n++){ let c=n; for (let k=0;k<8;k++) c = c&1 ? 0xEDB88320^(c>>>1) : c>>>1; t[n]=c>>>0; } return t; })();
function crc32(b){ let c = 0xFFFFFFFF; for (let i=0;i<b.length;i++) c = CRC_T[(c^b[i])&255] ^ (c>>>8); return (c^0xFFFFFFFF)>>>0; }
function makeZip(files, type){
  const enc = new TextEncoder(), parts = [], cent = []; let off = 0;
  for (const f of files){
    const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0,0x04034b50,true); lh.setUint16(4,20,true); lh.setUint16(12,33,true);
    lh.setUint32(14,crc,true); lh.setUint32(18,data.length,true); lh.setUint32(22,data.length,true); lh.setUint16(26,name.length,true);
    parts.push(lh, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0,0x02014b50,true); ch.setUint16(4,20,true); ch.setUint16(6,20,true); ch.setUint16(14,33,true);
    ch.setUint32(16,crc,true); ch.setUint32(20,data.length,true); ch.setUint32(24,data.length,true); ch.setUint16(28,name.length,true);
    ch.setUint32(42,off,true);
    cent.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const cSize = cent.reduce((s,x) => s + x.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0,0x06054b50,true); end.setUint16(8,files.length,true); end.setUint16(10,files.length,true);
  end.setUint32(12,cSize,true); end.setUint32(16,off,true);
  return new Blob([...parts, ...cent, end], { type });
}
function download(blob, name){
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}
const pngBytes = c => new Promise(res => c.toBlob(b => b.arrayBuffer().then(ab => res(new Uint8Array(ab))), 'image/png'));
const stamp = () => { const d = new Date(), z = n => String(n).padStart(2,'0'); return `${d.getFullYear()}${z(d.getMonth()+1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`; };
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
const fname = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^\w-]+/g,'_').replace(/^_|_$/g,'');
const needSim = () => { if (!base || !base.site){ setStatus('Faça uma simulação primeiro.'); alert('Faça uma simulação primeiro.'); return true; } return false; };

async function saveKMZ(){
  if (needSim()) return;
  setStatus('Gerando KMZ…'); await frame();
  const p = P(), r = renderCanvas('geo', MOBILE ? 1600 : 2400), png = await pngBytes(r.c);
  const a = Math.round(num('opac')*255).toString(16).padStart(2,'0');
  const circ = S => { const pts=[]; for (let i=0;i<=180;i++){ const t=i/180*2*PI; pts.push(`${(S.lon0+S.R*Math.sin(t)/S.mLon).toFixed(6)},${(S.lat0+S.R*Math.cos(t)/S.mLat).toFixed(6)},0`); } return pts.join(' '); };
  const fmt = k => r.tot ? `${(r.cnt[k]/r.tot*100).toFixed(0)}% (${(r.cnt[k]*r.pxArea).toFixed(0)} km²)` : '-';
  const bname = $('baseName').value || 'Base RTK';
  const desc = `${bname} · ${p.f} MHz · ${num('pW')} W · antena ${p.hTx} m · rover ${p.hRx} m · raio ${p.radius/1000} km\n`+
    `Bom ≥ ${p.good} dBm: ${fmt(3)}\nMédio ≥ ${p.med} dBm: ${fmt(2)}\nRuim ≥ ${p.sens} dBm: ${fmt(1)}\nSem sinal: ${fmt(0)}\nBloqueado: ${fmt(4)}\nGerado por MGEO - Simulador RTK`;
  let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(bname)} ${p.f}MHz ${stamp()}</name>
<description>${esc(desc)}</description>
<Style id="base"><IconStyle><color>fff8bd38</color><scale>1.3</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/target.png</href></Icon></IconStyle></Style>
<Style id="rep"><IconStyle><color>ff1673f9</color><scale>1.2</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/target.png</href></Icon></IconStyle></Style>
<Style id="c0"><LineStyle><color>ff14ff39</color><width>3</width></LineStyle></Style>
<Style id="c1"><LineStyle><color>ff1673f9</color><width>2</width></LineStyle></Style>
<GroundOverlay><name>Cobertura do sinal</name><description>${esc(desc)}</description><color>${a}ffffff</color><Icon><href>cobertura.png</href></Icon>
<LatLonBox><north>${r.bb.n}</north><south>${r.bb.s}</south><east>${r.bb.e}</east><west>${r.bb.w}</west></LatLonBox></GroundOverlay>
<Placemark><name>${esc(bname)}_${p.f}MHz_${p.hTx}m</name><description>${esc(`Antena ${p.hTx} m · ${num('pW')} W\nAltitude terreno ${base.elev.toFixed(0)} m`)}</description><styleUrl>#base</styleUrl><Point><coordinates>${base.lng.toFixed(7)},${base.lat.toFixed(7)},0</coordinates></Point></Placemark>
<Placemark><name>Raio ${p.radius/1000} km</name><styleUrl>#c0</styleUrl><LineString><tessellate>1</tessellate><coordinates>${circ(base.site)}</coordinates></LineString></Placemark>
`;
  reps.forEach((rp,i) => {
    kml += `<Placemark><name>Repetidora ${i+1}</name><description>${esc(`Antena ${p.hRep} m · ${num('pRep')} W\nEnlace da base: ${rp.link!=null && rp.link>BLOCK+1 ? rp.link.toFixed(1)+' dBm' : 'sem visada'}\nAltitude terreno ${rp.elev!=null?rp.elev.toFixed(0):'-'} m`)}</description><styleUrl>#rep</styleUrl><Point><coordinates>${rp.lng.toFixed(7)},${rp.lat.toFixed(7)},0</coordinates></Point></Placemark>
<Placemark><name>Raio repetidora ${i+1}</name><styleUrl>#c1</styleUrl><LineString><tessellate>1</tessellate><coordinates>${circ(rp.site)}</coordinates></LineString></Placemark>
<Placemark><name>Enlace base - R${i+1}</name><styleUrl>#c1</styleUrl><LineString><tessellate>1</tessellate><coordinates>${base.lng},${base.lat},0 ${rp.lng},${rp.lat},0</coordinates></LineString></Placemark>
`;
  });
  kml += `</Document></kml>`;
  download(makeZip([{ name:'doc.kml', data:kml }, { name:'cobertura.png', data:png }], 'application/vnd.google-earth.kmz'), `cobertura_${fname(bname)}_${stamp()}.kmz`);
  setStatus('KMZ salvo (abra no Google Earth).');
}
async function savePNG(){
  if (needSim()) return;
  setStatus('Gerando PNG…'); await frame();
  const r = renderCanvas('geo', MOBILE ? 1600 : 2400), png = await pngBytes(r.c);
  const dx = (r.bb.e-r.bb.w)/r.W, dy = (r.bb.n-r.bb.s)/r.H;
  const pgw = [dx, 0, 0, -dy, r.bb.w+dx/2, r.bb.n-dy/2].map(v => v.toFixed(12)).join('\n') + '\n';
  const prj = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
  const nm = `cobertura_${fname($('baseName').value||'base')}_${stamp()}`;
  download(makeZip([{ name:nm+'.png', data:png }, { name:nm+'.pgw', data:pgw }, { name:nm+'.prj', data:prj }], 'application/zip'), nm+'_png.zip');
  setStatus('PNG georreferenciado salvo (.png + .pgw + .prj).');
}

/* ---------------- RELATÓRIO PDF ---------------- */
async function reportMapImage(){
  const ss = allSites(), b0 = bboxOf(ss);
  const padLat = (b0.n-b0.s)*0.04, padLon = (b0.e-b0.w)*0.04;
  const bb = { s:b0.s-padLat, n:b0.n+padLat, w:b0.w-padLon, e:b0.e+padLon };
  let z = 16;
  while (z > 6 && lonToPx(bb.e,z)-lonToPx(bb.w,z) > 1700) z--;
  const x0 = lonToPx(bb.w,z), y0 = latToPx(bb.n,z);
  const W = Math.ceil(lonToPx(bb.e,z)-x0), H = Math.ceil(latToPx(bb.s,z)-y0);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.fillStyle = '#cfd5dc'; g.fillRect(0,0,W,H);
  // fundo de satélite (Esri, com CORS)
  const jobs = [];
  for (let tx=Math.floor(x0/256); tx<=Math.floor((x0+W)/256); tx++)
    for (let ty=Math.floor(y0/256); ty<=Math.floor((y0+H)/256); ty++)
      jobs.push(loadImg([`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`]).then(img => { if (img) g.drawImage(img, tx*256-x0, ty*256-y0); }));
  let done = 0;
  await Promise.all(jobs.map(j => j.then(() => { done++; setStatus(`Relatório: baixando imagem de fundo ${done}/${jobs.length}`); })));
  // cobertura
  const cov = renderCanvas('merc', W, bb, H);
  g.globalAlpha = Math.max(0.55, num('opac')); g.drawImage(cov.c, 0, 0); g.globalAlpha = 1;
  const P2 = (lat,lon) => [lonToPx(lon,z)-x0, latToPx(lat,z)-y0];
  const sc = Math.max(1, W/900);
  ss.forEach((S,i) => {
    g.beginPath();
    for (let k=0;k<=180;k++){ const t=k/180*2*PI; const [x,y] = P2(S.lat0+S.R*Math.cos(t)/S.mLat, S.lon0+S.R*Math.sin(t)/S.mLon); k?g.lineTo(x,y):g.moveTo(x,y); }
    g.strokeStyle = i===0 ? '#39ff14' : '#f97316'; g.lineWidth = (i===0 ? 3.5 : 2.5)*sc; g.setLineDash(i===0 ? [] : [10*sc,7*sc]); g.stroke(); g.setLineDash([]);
  });
  reps.forEach(r => { const [x1,y1]=P2(base.lat,base.lng), [x2,y2]=P2(r.lat,r.lng); g.beginPath(); g.moveTo(x1,y1); g.lineTo(x2,y2); g.strokeStyle='rgba(255,255,255,.8)'; g.lineWidth=1.5*sc; g.setLineDash([6*sc,5*sc]); g.stroke(); g.setLineDash([]); });
  const mark = (lat,lon,col,label) => {
    const [x,y] = P2(lat,lon);
    g.beginPath(); g.arc(x,y,9*sc,0,2*PI); g.fillStyle=col; g.fill(); g.lineWidth=2.5*sc; g.strokeStyle='#fff'; g.stroke();
    g.font = `bold ${15*sc}px sans-serif`; g.lineWidth = 4*sc; g.strokeStyle='rgba(0,0,0,.85)'; g.strokeText(label, x+13*sc, y+5*sc); g.fillStyle='#fff'; g.fillText(label, x+13*sc, y+5*sc);
  };
  mark(base.lat, base.lng, '#111', $('baseName').value || 'Base RTK');
  reps.forEach((r,i) => mark(r.lat, r.lng, '#f97316', 'R'+(i+1)));
  // escala
  const mpp = 156543.03*Math.cos((bb.s+bb.n)/2*PI/180)/Math.pow(2,z);
  const target = W*0.22*mpp, pow = Math.pow(10, Math.floor(log10(target)));
  const len = [1,2,5,10].map(k=>k*pow).filter(v=>v<=target).pop();
  const lpx = len/mpp, bx = 20*sc, by = H-24*sc;
  g.fillStyle='rgba(255,255,255,.85)'; g.fillRect(bx-8*sc, by-24*sc, lpx+16*sc, 34*sc);
  g.fillStyle='#000'; g.fillRect(bx, by, lpx, 5*sc); g.fillStyle='#fff'; g.fillRect(bx+lpx/2, by+1*sc, lpx/2, 3*sc);
  g.font=`${13*sc}px sans-serif`; g.fillStyle='#000'; g.fillText(len>=1000 ? (len/1000)+' km' : len+' m', bx, by-6*sc);
  // norte
  const nx = W-34*sc, ny = 46*sc;
  g.fillStyle='rgba(255,255,255,.85)'; g.beginPath(); g.arc(nx, ny-8*sc, 24*sc, 0, 2*PI); g.fill();
  g.fillStyle='#000'; g.beginPath(); g.moveTo(nx, ny-28*sc); g.lineTo(nx-9*sc, ny); g.lineTo(nx, ny-6*sc); g.lineTo(nx+9*sc, ny); g.closePath(); g.fill();
  g.font=`bold ${12*sc}px sans-serif`; g.fillText('N', nx-4*sc, ny+12*sc);
  g.font=`${10*sc}px sans-serif`; g.fillStyle='rgba(255,255,255,.9)'; g.fillText('Imagens © Esri, Maxar, Earthstar Geographics', W-260*sc, H-6*sc);
  let url; try { url = c.toDataURL('image/jpeg', 0.88); } catch(e){ url = cov.c.toDataURL('image/png'); }
  return { url, W, H, stats: cov };
}

const pdfTxt = s => String(s).replace(/≥/g,'>=').replace(/≤/g,'<=').replace(/→/g,'->').replace(/≈/g,'~').replace(/[—–]/g,'-');

async function makeReport(){
  if (needSim()) return;
  if (!window.jspdf){ alert('A biblioteca de PDF não carregou (verifique a internet).'); return; }
  hideSaveBar(); busy(true);
  try{
    setStatus('Gerando relatório…'); await frame();
    const p = P(), m = await reportMapImage(), st = m.stats;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit:'mm', format:'a4', compress:true });
    const now = new Date(), dt = now.toLocaleDateString('pt-BR') + ' ' + now.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    const GOLD = [232,169,59], DARK = [60,60,60];
    const T = (s, x, y, o) => doc.text(pdfTxt(s), x, y, o);
    const header = () => {
      if (window.MGEO_LOGO) doc.addImage(window.MGEO_LOGO, 'PNG', 14, 9, 44, 15);
      doc.setFont('helvetica','bold'); doc.setFontSize(13); doc.setTextColor(...DARK);
      T('RELATÓRIO DE COBERTURA DE SINAL RTK', 196, 15, { align:'right' });
      doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(110);
      T(`Rádio UHF ${p.f} MHz  ·  emitido em ${dt}`, 196, 21, { align:'right' });
      doc.setDrawColor(...GOLD); doc.setLineWidth(0.8); doc.line(14, 27, 196, 27);
    };
    const section = (title, y) => {
      doc.setFillColor(...GOLD); doc.rect(14, y-4.2, 2, 5.5, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(...DARK); T(title, 18.5, y);
      return y + 5;
    };
    const table = (rows, y, widths, opts={}) => {
      doc.setFontSize(9);
      rows.forEach((row, ri) => {
        const head = opts.head && ri===0;
        const h = 6.2;
        if (head){ doc.setFillColor(50,50,50); doc.rect(14, y, 182, h, 'F'); doc.setTextColor(255); doc.setFont('helvetica','bold'); }
        else { if (ri%2===0){ doc.setFillColor(246,246,246); doc.rect(14, y, 182, h, 'F'); } doc.setTextColor(40); doc.setFont('helvetica', opts.boldFirst ? 'bold':'normal'); }
        let x = 14;
        row.forEach((cell, ci) => {
          if (ci===1 && !head && opts.boldFirst) doc.setFont('helvetica','normal');
          if (cell && cell.color){ doc.setFillColor(...cell.color); doc.rect(x+2, y+1.4, 3.4, 3.4, 'F'); T(cell.t, x+7.5, y+4.3); }
          else T(cell, x+2, y+4.3);
          x += widths[ci];
        });
        y += h;
      });
      return y + 3;
    };
    const fmtP = k => st.tot ? `${(st.cnt[k]/st.tot*100).toFixed(1)}%` : '-';
    const fmtA = k => st.tot ? `${(st.cnt[k]*st.pxArea).toFixed(1)} km²` : '-';

    // ---- Página 1
    header();
    let y = 34;
    y = section('Identificação', y);
    const bname = $('baseName').value || 'Base RTK';
    y = table([
      ['Projeto', $('rProj').value || '-', 'Base', bname],
      ['Cliente', $('rCli').value || '-', 'Coordenadas', `${base.lat.toFixed(6)}, ${base.lng.toFixed(6)}`],
      ['Responsável', $('rResp').value || '-', 'Altitude / antena', `${base.elev.toFixed(0)} m / ${p.hTx} m`]
    ], y, [26, 65, 34, 57], { boldFirst:true });
    y = section('Mapa de cobertura', y + 2);
    let mw = 182, mh = mw*m.H/m.W;
    if (mh > 150){ mh = 150; mw = mh*m.W/m.H; }
    doc.addImage(m.url, m.url.startsWith('data:image/png') ? 'PNG' : 'JPEG', 14 + (182-mw)/2, y, mw, mh);
    y += mh + 5;
    y = table([
      ['Classe', 'Faixa de sinal', 'Área (%)', 'Área (km²)'],
      [{t:'Bom', color:COLORS[3]}, `>= ${p.good} dBm`, fmtP(3), fmtA(3)],
      [{t:'Médio', color:COLORS[2]}, `${p.med} a ${p.good} dBm`, fmtP(2), fmtA(2)],
      [{t:'Ruim', color:COLORS[1]}, `${p.sens} a ${p.med} dBm`, fmtP(1), fmtA(1)],
      [{t:'Sem sinal', color:[120,120,120]}, `< ${p.sens} dBm`, fmtP(0), fmtA(0)],
      ...(st.cnt[4] ? [[{t:'Bloqueado pelo terreno', color:[70,70,70]}, 'sem visada (modo rígido)', fmtP(4), fmtA(4)]] : [])
    ], y, [60, 52, 35, 35], { head:true });

    // ---- Página 2
    doc.addPage(); header(); y = 36;
    y = section('Parâmetros da simulação', y);
    y = table([
      ['Frequência', `${p.f} MHz`, 'Raio de análise', `${p.radius/1000} km`],
      ['Potência TX', `${num('pW')} W (${p.ptx.toFixed(1)} dBm)`, 'Altura antena base', `${p.hTx} m`],
      ['Ganho antena TX', `${p.gTx} dBi`, 'Altura antena rover', `${p.hRx} m`],
      ['Perda cabo/conectores', `${p.lCable} dB`, 'Ganho antena rover', `${p.gRx} dBi`],
      ['Sensibilidade RX', `${p.sens} dBm`, 'Perda vegetação', `${p.clutter} dB`],
      ['Modelo', p.model==='2ray' ? 'Terra plana + difração' : 'Espaço livre + difração', 'Relevo', p.cut ? 'Rígido (visada direta)' : 'Realista (difração)'],
      ['EIRP', `${(p.ptx+p.gTx-p.lCable).toFixed(1)} dBm`, 'Altimetria', demStats ? `${demStats.lo.toFixed(0)} a ${demStats.hi.toFixed(0)} m` : '-']
    ], y, [38, 55, 36, 53], { boldFirst:true });

    if (reps.length){
      y = section('Repetidoras', y + 2);
      y = table([
        ['#', 'Latitude', 'Longitude', 'Alt. terreno', 'Enlace da base', 'Área recuperada'],
        ...reps.map((r,i) => [`R${i+1}`, r.lat.toFixed(6), r.lng.toFixed(6), `${r.elev!=null?r.elev.toFixed(0):'-'} m`,
          r.link!=null && r.link>BLOCK+1 ? `${r.link.toFixed(1)} dBm (${NAMES[cls(r.link,p)]})` : 'sem visada',
          r.gain!=null ? `${r.gain.toFixed(0)} km²` : '-'])
      ], y, [12, 30, 30, 26, 46, 38], { head:true });
      doc.setFontSize(8.5); doc.setTextColor(90);
      T(`Repetidoras: antena ${p.hRep} m, ${num('pRep')} W, ${p.gRep} dBi.`, 14, y); y += 6;
    }

    if (lastProfile && $('profile').style.display !== 'none'){
      y = section('Perfil do terreno (base -> ponto analisado)', y + 2);
      const cv = $('profCanvas'), ih = 182*cv.height/cv.width;
      doc.setFillColor(17,24,39); doc.rect(14, y, 182, ih, 'F');
      doc.addImage(cv.toDataURL('image/png'), 'PNG', 14, y, 182, ih);
      y += ih + 4;
      doc.setFontSize(8.5); doc.setTextColor(60);
      const info = doc.splitTextToSize(pdfTxt($('profInfo').innerText), 182);
      doc.text(info, 14, y); y += info.length*4 + 4;
    }

    if (y > 225){ doc.addPage(); header(); y = 36; }
    y = section('Metodologia e observações', y + 2);
    doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(60);
    const met = `A cobertura foi estimada a partir da posição da base, da altimetria do terreno (modelo digital SRTM, resolução aproximada de 30 m) e dos parâmetros do rádio informados. `+
      `Para cada direção ao redor da antena é traçado o perfil do terreno e calculado o nível de sinal recebido pelo rover, considerando a perda de propagação (espaço livre / terra plana), `+
      `a difração sobre os obstáculos do relevo (método de Bullington, ITU-R P.526), a curvatura da Terra (k = 4/3) e uma perda adicional por vegetação de ${p.clutter} dB. `+
      `Os resultados são estimativas: edificações, vegetação densa, interferências e o modelo do rádio podem alterar o alcance real. Recomenda-se validação em campo.`;
    const lines = doc.splitTextToSize(pdfTxt(met + ($('rObs').value ? `\n\nObservações: ${$('rObs').value}` : '')), 182);
    doc.text(lines, 14, y); y += lines.length*4.2 + 6;
    if ($('rResp').value){
      if (y > 262){ doc.addPage(); header(); y = 40; }
      y = Math.max(y, 250);
      doc.setDrawColor(120); doc.setLineWidth(0.3); doc.line(70, y, 140, y);
      doc.setFontSize(9); doc.setTextColor(60); T($('rResp').value, 105, y+5, { align:'center' }); T('Responsável técnico', 105, y+9.5, { align:'center' });
    }

    const n = doc.getNumberOfPages();
    for (let i=1;i<=n;i++){
      doc.setPage(i);
      doc.setDrawColor(...GOLD); doc.setLineWidth(0.4); doc.line(14, 283, 196, 283);
      doc.setFontSize(8); doc.setTextColor(120); doc.setFont('helvetica','normal');
      T('MGEO - Soluções em Agricultura de Precisão e Geotecnologia', 14, 288);
      T(`Página ${i} de ${n}`, 196, 288, { align:'right' });
    }
    doc.save(`Relatorio_Cobertura_RTK_${fname($('rProj').value || bname)}_${stamp()}.pdf`);
    setStatus('Relatório PDF gerado.');
  }catch(err){
    console.error(err); setStatus('Erro ao gerar relatório: ' + err.message);
  }finally{ busy(false); }
}

let sbTimer;
function showSaveBar(){ $('saveBar').style.display='block'; clearTimeout(sbTimer); sbTimer = setTimeout(hideSaveBar, 25000); }
function hideSaveBar(){ $('saveBar').style.display='none'; }

/* ---------------- PERFIL ---------------- */
async function showProfile(ll){
  if (!base){ setStatus('Posicione a torre primeiro.'); return; }
  lastProfile = ll;
  const p = P();
  const lat0 = base.lat, lon0 = base.lng;
  let bb = { s:Math.min(lat0,ll.lat)-0.002, w:Math.min(lon0,ll.lng)-0.002, n:Math.max(lat0,ll.lat)+0.002, e:Math.max(lon0,ll.lng)+0.002 };
  const ss = allSites(); if (ss.length) bb = unionBB(bb, bboxOf(ss));
  await ensureDEM(bb);
  const { D, n, step, elev, out } = profileLevels(lat0, lon0, ll.lat, ll.lng, p, 25);
  if (D < 30) return;

  if (profLine) map.removeLayer(profLine);
  if (profMarker) map.removeLayer(profMarker);
  profLine = L.polyline([[lat0,lon0],[ll.lat,ll.lng]], { color:'#fff', weight:2, dashArray:'4 6' }).addTo(map);
  profMarker = L.circleMarker(ll, { radius:6, color:'#fff', weight:2, fillColor:'#38bdf8', fillOpacity:1 }).addTo(map);

  $('profile').style.display = 'block'; if (!MOBILE) $('hint').style.bottom='244px'; map.invalidateSize();
  const cv = $('profCanvas'), dpr = Math.max(2, window.devicePixelRatio||1);
  const Wc = cv.clientWidth, Hc = cv.clientHeight;
  cv.width = Wc*dpr; cv.height = Hc*dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0);
  g.fillStyle = '#111827'; g.fillRect(0,0,Wc,Hc);

  const lam = 299.792458/p.f;
  const adj = i => elev[i] - (i*step)**2/(2*RE);
  const txH = elev[0]+p.hTx, rxH = adj(n)+p.hRx;
  let lo=Infinity, hi=-Infinity;
  for (let i=0;i<=n;i++){ const e=adj(i); lo=Math.min(lo,e); hi=Math.max(hi,e); }
  hi = Math.max(hi, txH, rxH) + 0.5*Math.sqrt(lam*D); lo -= 10;
  const padL=46, padR=12, padT=12, padB=26;
  const X = d => padL + d/D*(Wc-padL-padR);
  const Y = h => padT + (hi-h)/(hi-lo)*(Hc-padT-padB);

  g.strokeStyle='#263244'; g.fillStyle='#9ca3af'; g.font='11px system-ui'; g.lineWidth=1;
  for (let k=0;k<=4;k++){ const h=lo+(hi-lo)*k/4, y=Y(h); g.beginPath(); g.moveTo(padL,y); g.lineTo(Wc-padR,y); g.stroke(); g.fillText(h.toFixed(0)+' m',2,y+4); }
  for (let k=0;k<=5;k++){ const d=D*k/5; g.fillText((d/1000).toFixed(1)+' km', X(d)-14, Hc-8); }

  g.beginPath(); g.moveTo(X(0),Y(lo));
  for (let i=0;i<=n;i++) g.lineTo(X(i*step),Y(adj(i)));
  g.lineTo(X(D),Y(lo)); g.closePath();
  const grad = g.createLinearGradient(0,padT,0,Hc); grad.addColorStop(0,'#a16207'); grad.addColorStop(1,'#422006');
  g.fillStyle=grad; g.fill();

  let blocked=false, minClear=Infinity;
  g.setLineDash([4,4]); g.strokeStyle='rgba(56,189,248,.7)';
  for (const sgn of [1,-1]){
    g.beginPath();
    for (let i=0;i<=n;i++){ const d=i*step, los=txH+(rxH-txH)*d/D, r=Math.sqrt(lam*d*(D-d)/D); const y=Y(los+sgn*r); i?g.lineTo(X(d),y):g.moveTo(X(d),y); }
    g.stroke();
  }
  g.setLineDash([]);
  for (let i=1;i<n;i++){ const d=i*step, los=txH+(rxH-txH)*d/D, r=Math.sqrt(lam*d*(D-d)/D); const cl=(los-adj(i))/r; if (cl<minClear) minClear=cl; if (los<adj(i)) blocked=true; }
  g.strokeStyle = blocked ? '#ef4444' : '#22c55e'; g.lineWidth=2;
  g.beginPath(); g.moveTo(X(0),Y(txH)); g.lineTo(X(D),Y(rxH)); g.stroke();

  g.strokeStyle='#fff'; g.lineWidth=3;
  g.beginPath(); g.moveTo(X(0),Y(elev[0])); g.lineTo(X(0),Y(txH)); g.stroke();
  g.beginPath(); g.moveTo(X(D),Y(adj(n))); g.lineTo(X(D),Y(rxH)); g.stroke();

  for (let i=1;i<=n;i++){ const k=cls(out[i],p); g.fillStyle = k<=0 ? (k<0 ? '#0b1220' : '#334155') : `rgb(${COLORS[k]})`; g.fillRect(X((i-1)*step), Hc-padB+2, Math.max(1,X(i*step)-X((i-1)*step)+0.5), 5); }

  const v = out[n], k = cls(v,p);
  const cb = combined(ll.lat, ll.lng), kc = cls(cb.v, p);
  const viaRep = reps.length && cb.src > 0 && kc > k ? ` · <b style="color:#f97316">Com repetidora R${cb.src}: ${cb.v.toFixed(1)} dBm (${NAMES[kc]})</b>` : '';
  if (k === -1){
    $('profInfo').innerHTML = `<b>Distância:</b> ${(D/1000).toFixed(2)} km · <b>Altitude no ponto:</b> ${elev[n].toFixed(0)} m · `+
      `<b style="color:#ef4444">SEM VISADA da base — o terreno bloqueia o sinal</b>` + viaRep;
    return;
  }
  const fres = minClear>=0.6 ? 'Fresnel ≥60% livre' : (blocked ? 'visada OBSTRUÍDA (sinal por difração)' : 'Fresnel parcialmente obstruída');
  $('profInfo').innerHTML = `<b>Distância:</b> ${(D/1000).toFixed(2)} km · <b>Altitude:</b> ${elev[n].toFixed(0)} m · `+
    `<b>Sinal da base:</b> <span style="color:rgb(${COLORS[Math.max(0,k)]});font-weight:700">${v.toFixed(1)} dBm (${NAMES[k]})</span> · `+
    `<b>Margem:</b> ${(v-p.sens).toFixed(1)} dB · <b>Visada:</b> ${fres}` + viaRep;
}

/* ---------------- CONSULTA DE PONTO / GPS ---------------- */
function pointInfo(ll){
  if (!base || !base.site) return 'Simule a torre primeiro.';
  const p = P(), cb = combined(ll.lat, ll.lng), k = cls(cb.v,p);
  const d = Math.hypot((ll.lat-base.lat)*111320, (ll.lng-base.lng)*111320*Math.cos(base.lat*PI/180));
  const src = cb.src > 0 ? ` (via R${cb.src})` : '';
  const sig = k===-2 ? 'Fora do raio simulado' : k===-1 ? '<b style="color:#dc2626">Bloqueado pelo terreno</b>'
    : `<b style="color:${k===2?'#a16207':`rgb(${COLORS[k]})`}">${cb.v.toFixed(1)} dBm · ${NAMES[k]}</b>${src}`;
  return `${sig}<br>${(d/1000).toFixed(2)} km da base · alt. ${elevAt(ll.lat,ll.lng).toFixed(0)} m<br>${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`;
}
function locate(cb){
  if (!navigator.geolocation){ alert('GPS não disponível neste navegador.'); return; }
  setStatus('Obtendo posição GPS…');
  navigator.geolocation.getCurrentPosition(pos => cb(L.latLng(pos.coords.latitude, pos.coords.longitude), pos.coords.accuracy),
    err => { setStatus('GPS: ' + err.message); alert('Não foi possível obter o GPS: ' + err.message + (location.protocol!=='https:' ? '\n(O GPS exige o site em HTTPS, ex.: GitHub Pages.)' : '')); },
    { enableHighAccuracy:true, timeout:15000, maximumAge:5000 });
}
function showGps(ll, acc){
  if (gpsMarker) map.removeLayer(gpsMarker);
  gpsMarker = L.circleMarker(ll, { radius:8, color:'#fff', weight:3, fillColor:'#2563eb', fillOpacity:1 }).addTo(map);
  const div = document.createElement('div');
  div.innerHTML = `<b>Minha posição</b> (±${Math.round(acc)} m)<br>${pointInfo(ll)}<br><button style="margin-top:6px;color:#000;background:#fff">Usar como torre</button>`;
  div.querySelector('button').onclick = () => { map.closePopup(); setTower(ll, true); };
  gpsMarker.bindPopup(div).openPopup();
  map.setView(ll, Math.max(map.getZoom(), 13));
  setStatus('Posição GPS obtida.');
}

/* ---------------- INTERAÇÃO ---------------- */
function setStatus(t){ $('status').textContent = t; $('busy').textContent = t; }
function setTower(ll, fly){
  base = { lat:ll.lat, lng:ll.lng, site:null, elev:0 };
  $('lat').value = base.lat.toFixed(6); $('lon').value = base.lng.toFixed(6);
  if (!towerMarker){
    towerMarker = L.marker([base.lat,base.lng], { icon:towerIcon, draggable:true, zIndexOffset:1000 }).addTo(map);
    towerMarker.on('dragend', () => setTower(towerMarker.getLatLng()));
  } else towerMarker.setLatLng([base.lat,base.lng]);
  reps.forEach(r => r.gain = null);
  $('hint').style.display = 'none';
  if (fly) map.setView([base.lat,base.lng], Math.max(map.getZoom(), 11));
  else if (map.getZoom() < 10) map.setView([base.lat,base.lng], 11);
  closePanel();
  simulate(true);
}
const openPanel = () => $('panel').classList.add('open');
const closePanel = () => $('panel').classList.remove('open');

map.on('click', e => {
  if (mode==='tower') setTower(e.latlng);
  else if (mode==='rep'){ if (!base){ setStatus('Posicione a torre primeiro.'); return; } addRep(e.latlng); simulate(true); }
  else if (mode==='query') L.popup().setLatLng(e.latlng).setContent(pointInfo(e.latlng)).openOn(map);
  else showProfile(e.latlng);
});
map.on('mousemove', e => {
  if (MOBILE) return;
  const h = $('hover');
  if (!base || !base.site){ h.style.display='none'; return; }
  const p = P(), cb = combined(e.latlng.lat, e.latlng.lng), k = cls(cb.v,p);
  if (k === -2){ h.style.display='none'; return; }
  const d = Math.hypot((e.latlng.lat-base.lat)*111320, (e.latlng.lng-base.lng)*111320*Math.cos(base.lat*PI/180));
  const src = cb.src > 0 ? ` · via R${cb.src}` : (reps.length ? ' · via base' : '');
  h.style.display='block';
  h.innerHTML = (k===-1 ? `<span style="color:#f87171;font-weight:700">Bloqueado pelo terreno (sem visada)</span><br>`
    : `<span style="color:rgb(${COLORS[k]});font-weight:700">${cb.v.toFixed(1)} dBm · ${NAMES[k]}${src}</span><br>`)+
    `${(d/1000).toFixed(2)} km da base · alt. ${elevAt(e.latlng.lat,e.latlng.lng).toFixed(0)} m`;
});
map.on('mouseout', () => $('hover').style.display='none');

function setMode(m){
  mode = m;
  ['Tower','Rep','Prof','Query'].forEach(k => $('m'+k).classList.toggle('on', m === {Tower:'tower',Rep:'rep',Prof:'profile',Query:'query'}[k]));
  map.getContainer().style.cursor = m==='tower' ? '' : 'crosshair';
  const txt = { tower:'Toque no mapa para posicionar a torre', rep:'Toque no mapa para adicionar uma repetidora', profile:'Toque em um ponto para ver o perfil torre → rover', query:'Toque em um ponto para consultar o sinal' };
  if (m!=='tower' || !base){ $('hint').style.display='block'; $('hint').textContent = txt[m]; } else $('hint').style.display='none';
  closePanel();
}
$('mTower').onclick = () => setMode('tower');
$('mRep').onclick = () => setMode('rep');
$('mProf').onclick = () => setMode('profile');
$('mQuery').onclick = () => setMode('query');
$('panelBtn').onclick = openPanel;
$('closePanel').onclick = closePanel;
$('profClose').onclick = () => {
  $('profile').style.display='none'; $('hint').style.bottom=''; lastProfile=null; map.invalidateSize();
  if (profLine) map.removeLayer(profLine); if (profMarker) map.removeLayer(profMarker);
};
$('goCoord').onclick = () => {
  const la = parseFloat($('lat').value), lo = parseFloat($('lon').value);
  if (isFinite(la) && isFinite(lo)) setTower({lat:la,lng:lo}, true);
};
$('gpsTower').onclick = () => locate(ll => setTower(ll, true));
$('gpsBtn').onclick = () => locate(showGps);
$('run').onclick = () => { closePanel(); simulate(true); };
$('suggest').onclick = () => { closePanel(); suggestRepeaters(); };
$('clearRep').onclick = () => { reps.slice().forEach(removeRep); $('repList').innerHTML=''; simulate(false); };
$('saveKmz').onclick = $('sbKmz').onclick = () => { hideSaveBar(); saveKMZ(); };
$('savePng').onclick = $('sbPng').onclick = () => { hideSaveBar(); savePNG(); };
$('saveReport').onclick = $('sbPdf').onclick = () => { closePanel(); makeReport(); };
$('sbClose').onclick = hideSaveBar;
$('q').addEventListener('keydown', async ev => {
  if (ev.key !== 'Enter') return;
  const q = ev.target.value.trim(); if (!q) return;
  ev.target.blur();
  try{
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q='+encodeURIComponent(q));
    const j = await r.json();
    if (j[0]){ map.setView([+j[0].lat,+j[0].lon], 13); closePanel(); } else setStatus('Local não encontrado.');
  }catch(e){ setStatus('Falha na busca de endereço.'); }
});

let deb;
['hTx','f','pW','gTx','lCable','gRx','hRx','radius','model','clutter','losMode','fresReq','hRep','pRep','gRep'].forEach(id =>
  $(id).addEventListener('change', () => { if (!base) return; clearTimeout(deb); deb = setTimeout(() => simulate(false), 400); }));
['thrGood','thrMed','sens','showNone'].forEach(id => $(id).addEventListener('change', () => { render(); updateRepList(); if (lastProfile) showProfile(lastProfile); }));
$('showDem').addEventListener('change', () => buildDemLayer());
$('opac').addEventListener('input', () => overlay && overlay.setOpacity(num('opac')));
window.addEventListener('resize', () => { if (lastProfile) showProfile(lastProfile); });
if (MOBILE) $('hint').textContent = 'Toque no mapa para posicionar a torre';
})();
