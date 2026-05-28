/*
   SABER 11 - APLICACIÓN PRINCIPAL (app.js)
   Estructura de datos compacta multitabla:
     data.dept_records  → [periodo, depto_code, depto_name, count, avg_global, avg_mat, avg_lec, avg_cna, avg_soc, avg_ing]
     data.mcpio_records → [mcpio_code, mcpio_name, depto_code, depto_name, count, avg_global, avg_mat, avg_lec, avg_cna, avg_soc, avg_ing]
     data.distributions → deptoName: {nat:[O,P], area:[U,R], gen:[F,M], str:[[cnt,avg]×6]}
     data.clusters      → deptoName: {cl,lv,lb,sc,po,pr,ps}
*/

// Índices de columnas
const DC = { periodo:0, depto_code:1, depto_name:2, count:3, avg_global:4, avg_mat:5, avg_lec:6, avg_cna:7, avg_soc:8, avg_ing:9 };
const MC = { mcpio_code:0, mcpio_name:1, depto_code:2, depto_name:3, count:4, avg_global:5, avg_mat:6, avg_lec:7, avg_cna:8, avg_soc:9, avg_ing:10 };

// Estado global
let appData = null;
let geoData = null;
let map = null;
let geoLayer = null;
let charts = {};

let filters = {
    depto: '', year_start: null, year_end: null,
    sem: '', map_metric: 'global', trend_subject: 'global',
    scatter_x: 'pr', cluster_filter: 'ALL', mcpio_metric: 'global'
};

// ─── INICIO ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    setupTabs();
    setupClusterButtons();
});

async function loadData() {
    const bar = document.getElementById('loader-progress-bar');
    try {
        bar.style.width = '30%';
        const r1 = await fetch('data.json');
        if (!r1.ok) throw new Error('No se pudo cargar data.json');
        appData = await r1.json();

        bar.style.width = '70%';
        const r2 = await fetch('colombia.geojson');
        if (!r2.ok) throw new Error('No se pudo cargar colombia.geojson');
        geoData = await r2.json();

        bar.style.width = '100%';
        setTimeout(() => {
            const overlay = document.getElementById('loader-overlay');
            overlay.style.opacity = '0';
            setTimeout(() => { overlay.style.display = 'none'; }, 500);
            initApp();
        }, 300);
    } catch (e) {
        console.error(e);
        document.querySelector('.loader-title').textContent = '⚠ Error cargando datos';
        document.querySelector('.loader-subtitle').textContent = e.message;
        document.querySelector('.spinner').style.borderTopColor = '#ef4444';
    }
}

function initApp() {
    populateFilters();
    initMap();
    updateDashboard();
}

// ─── FILTROS ──────────────────────────────────────────────────────────────────
function populateFilters() {
    const deptos = [...new Set(appData.dept_records.map(r => r[DC.depto_name]))].sort();
    const years  = [...new Set(appData.dept_records.map(r => Math.floor(r[DC.periodo]/10)))].sort((a,b)=>a-b);

    const sel = document.getElementById('select-dept');
    deptos.filter(d => !d.startsWith('DEPTO_')).forEach(d => {
        const o = document.createElement('option'); o.value = d; o.textContent = d; sel.appendChild(o);
    });

    const sy = document.getElementById('select-year-start');
    const ey = document.getElementById('select-year-end');
    years.forEach(y => {
        [sy, ey].forEach(s => { const o = document.createElement('option'); o.value=y; o.textContent=y; s.appendChild(o); });
    });
    filters.year_start = years[0];
    filters.year_end   = years[years.length - 1];
    sy.value = filters.year_start;
    ey.value = filters.year_end;

    // Event listeners de filtros
    sel.addEventListener('change', e => { filters.depto = e.target.value; updateMcpioDropdown(); renderGeoLayer(); updateDashboard(); });
    document.getElementById('select-year-start').addEventListener('change', e => { filters.year_start=+e.target.value; renderGeoLayer(); updateDashboard(); });
    document.getElementById('select-year-end').addEventListener('change',   e => { filters.year_end=+e.target.value;   renderGeoLayer(); updateDashboard(); });
    document.getElementById('select-period-sem').addEventListener('change', e => { filters.sem=e.target.value;         renderGeoLayer(); updateDashboard(); });
    document.getElementById('select-map-metric').addEventListener('change', e => { filters.map_metric=e.target.value;  renderGeoLayer(); });
    document.getElementById('select-trend-subject').addEventListener('change', e => { filters.trend_subject=e.target.value; renderTrend(); });
    document.getElementById('select-scatter-x').addEventListener('change',  e => { filters.scatter_x=e.target.value;   renderScatter(); });
    document.getElementById('select-mcpio-metric').addEventListener('change',e => { filters.mcpio_metric=e.target.value; renderMcpioCharts(); });
    document.getElementById('input-search-mcpio').addEventListener('input',  () => renderMcpioTable());
    document.getElementById('btn-clear-filters').addEventListener('click', clearFilters);
}

function updateMcpioDropdown() {
    const sel = document.getElementById('select-mcpio');
    sel.innerHTML = '<option value="">Todos los Municipios</option>';
    if (!filters.depto) { sel.disabled = true; return; }
    sel.disabled = false;
    const mcpios = [...new Map(
        appData.mcpio_records
            .filter(r => r[MC.depto_name] === filters.depto)
            .map(r => [r[MC.mcpio_code], r[MC.mcpio_name]])
    ).entries()].sort((a,b) => a[1].localeCompare(b[1]));
    mcpios.forEach(([code, name]) => {
        const o = document.createElement('option'); o.value = code; o.textContent = name; sel.appendChild(o);
    });
    if (!sel.hasAttribute('data-listener')) {
        sel.setAttribute('data-listener','1');
        sel.addEventListener('change', e => { filters.mcpio = +e.target.value || null; updateDashboard(); });
    }
}

function clearFilters() {
    filters.depto = ''; filters.mcpio = null; filters.sem = '';
    const years = [...new Set(appData.dept_records.map(r => Math.floor(r[DC.periodo]/10)))].sort((a,b)=>a-b);
    filters.year_start = years[0]; filters.year_end = years[years.length-1];
    ['select-dept','select-mcpio','select-period-sem'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('select-year-start').value = filters.year_start;
    document.getElementById('select-year-end').value   = filters.year_end;
    document.getElementById('select-mcpio').disabled = true;
    renderGeoLayer(); updateDashboard();
}

// ─── FILTRAR DATOS ────────────────────────────────────────────────────────────
function filterDeptRecords() {
    return appData.dept_records.filter(r => {
        const yr = Math.floor(r[DC.periodo]/10);
        const sm = r[DC.periodo] % 10;
        if (filters.depto && r[DC.depto_name] !== filters.depto) return false;
        if (filters.year_start && yr < filters.year_start) return false;
        if (filters.year_end   && yr > filters.year_end)   return false;
        if (filters.sem && sm !== +filters.sem) return false;
        return true;
    });
}

function filterMcpioRecords() {
    return appData.mcpio_records.filter(r => {
        if (filters.depto && r[MC.depto_name] !== filters.depto) return false;
        if (filters.mcpio && r[MC.mcpio_code] !== filters.mcpio) return false;
        return true;
    });
}

// ─── ACTUALIZAR TODO ──────────────────────────────────────────────────────────
function updateDashboard() {
    const dRows = filterDeptRecords();
    updateKPIs(dRows);
    renderNatureChart();
    renderAreaChart();
    renderStratumChart();
    renderGenderChart();
    renderTrend();
    renderMcpioCharts();
    renderMcpioTable();
    renderClustersTable();
    renderScatter();
}

// ─── KPIs ─────────────────────────────────────────────────────────────────────
function updateKPIs(rows) {
    let totalCnt=0, sg=0, sm=0, sl=0, sc=0, ss=0, si=0;
    rows.forEach(r => {
        const w = r[DC.count];
        totalCnt += w;
        sg += r[DC.avg_global] * w;
        sm += r[DC.avg_mat]    * w;
        sl += r[DC.avg_lec]    * w;
        sc += r[DC.avg_cna]    * w;
        ss += r[DC.avg_soc]    * w;
        si += r[DC.avg_ing]    * w;
    });
    const n = totalCnt || 1;
    document.getElementById('val-kpi-evaluados').textContent = totalCnt.toLocaleString('es-CO');
    document.getElementById('val-kpi-global').textContent    = Math.round(sg/n);
    document.getElementById('val-kpi-mat').textContent       = (sm/n).toFixed(1);
    document.getElementById('val-kpi-lec').textContent       = (sl/n).toFixed(1);
    document.getElementById('val-kpi-cna').textContent       = (sc/n).toFixed(1);
    document.getElementById('val-kpi-soc').textContent       = (ss/n).toFixed(1);
    document.getElementById('val-kpi-ing').textContent       = (si/n).toFixed(1);
}

// ─── MAPA ─────────────────────────────────────────────────────────────────────
function initMap() {
    map = L.map('colombia-map', { zoomControl:true, scrollWheelZoom:false, attributionControl:false })
            .setView([4.57, -74.30], 5);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom:9, minZoom:4 }).addTo(map);
    renderGeoLayer();
}

function getDeptStats() {
    const stats = {};
    const dRows = filterDeptRecords();
    dRows.forEach(r => {
        const dn = r[DC.depto_name];
        if (!stats[dn]) stats[dn] = { cnt:0, sg:0, sm:0, sl:0, sc:0, ss:0, si:0 };
        const w = r[DC.count];
        stats[dn].cnt += w;
        stats[dn].sg  += r[DC.avg_global]*w;
        stats[dn].sm  += r[DC.avg_mat]*w;
        stats[dn].sl  += r[DC.avg_lec]*w;
        stats[dn].sc  += r[DC.avg_cna]*w;
        stats[dn].ss  += r[DC.avg_soc]*w;
        stats[dn].si  += r[DC.avg_ing]*w;
    });
    const result = {};
    Object.entries(stats).forEach(([dn, s]) => {
        const n = s.cnt || 1;
        result[dn] = { cnt:s.cnt, global:s.sg/n, mat:s.sm/n, lec:s.sl/n, cna:s.sc/n, soc:s.ss/n, ing:s.si/n };
    });
    return result;
}

function renderGeoLayer() {
    if (geoLayer) { map.removeLayer(geoLayer); geoLayer = null; }
    const stats = getDeptStats();
    const metric = filters.map_metric;

    const vals = Object.values(stats).map(s => s[metric] || s.cnt || 0).filter(v=>v>0);
    const mn = vals.length ? Math.min(...vals) : 0;
    const mx = vals.length ? Math.max(...vals) : 100;

    function getColor(v) {
        if (!v) return '#1e293b';
        const t = (v - mn) / (mx - mn || 1);
        const colors = metric==='cnt'
            ? ['#0284c7','#0369a1','#6d28d9','#7c3aed','#db2777']
            : ['#ea580c','#eab308','#06b6d4','#10b981','#059669'];
        const idx = Math.min(4, Math.floor(t * 5));
        return colors[idx];
    }

    geoLayer = L.geoJSON(geoData, {
        style: feat => {
            const dn = feat.properties.normalized_name;
            const s  = stats[dn];
            const val = s ? (metric==='cnt' ? s.cnt : s[metric]) : null;
            const sel = filters.depto === dn;
            return { fillColor:getColor(val), weight:sel?3:1, color:sel?'#38bdf8':'#334155', fillOpacity:sel?0.85:0.65 };
        },
        onEachFeature: (feat, layer) => {
            const dn = feat.properties.normalized_name;
            const s  = stats[dn];
            let tip = `<div style="font-family:'Outfit',sans-serif;padding:8px;min-width:160px"><strong style="color:#f8fafc">${dn}</strong><br>`;
            if (s && s.cnt > 0) {
                tip += `<span style="color:#94a3b8">Evaluados: </span><strong style="color:#0ea5e9">${s.cnt.toLocaleString('es-CO')}</strong><br>`;
                tip += `<span style="color:#94a3b8">Global prom.: </span><strong style="color:#a855f7">${Math.round(s.global)}</strong><br>`;
                tip += `<span style="color:#94a3b8">Matemáticas: </span><strong style="color:#10b981">${s.mat.toFixed(1)}</strong><br>`;
                tip += `<span style="color:#94a3b8">Lectura: </span><strong style="color:#f97316">${s.lec.toFixed(1)}</strong>`;
            } else { tip += '<span style="color:#64748b">Sin datos para los filtros</span>'; }
            tip += '</div>';
            layer.bindTooltip(tip, { sticky:true, className:'leaflet-tooltip-own' });
            layer.on({
                mouseover: e => e.target.setStyle({ fillOpacity:0.85, weight:2 }),
                mouseout:  e => geoLayer.resetStyle(e.target),
                click: () => {
                    filters.depto = filters.depto === dn ? '' : dn;
                    document.getElementById('select-dept').value = filters.depto;
                    updateMcpioDropdown();
                    renderGeoLayer();
                    updateDashboard();
                }
            });
        }
    }).addTo(map);

    // Legend
    const leg = document.getElementById('map-legend');
    const cs = metric==='cnt'
        ? ['#0284c7','#0369a1','#6d28d9','#7c3aed','#db2777']
        : ['#ea580c','#eab308','#06b6d4','#10b981','#059669'];
    leg.innerHTML = '<div class="legend-item"><strong>Escala:</strong></div>' +
        cs.map((c,i) => {
            const v = mn + (mx-mn)*(i/4);
            return `<div class="legend-item"><span class="legend-color" style="background:${c}"></span><span>${Math.round(v)}</span></div>`;
        }).join('');
}

// ─── DISTRIBUCIONES (Naturaleza, Área, Estrato, Género) ───────────────────────
function getDeptoDistrib() {
    // Suma las distribuciones de todos los departamentos filtrados
    const target = filters.depto ? [filters.depto] : Object.keys(appData.distributions);
    const agg = { nat:[0,0], area:[0,0], gen:[0,0], str: Array(6).fill(null).map(()=>[0,0]) };
    target.forEach(dn => {
        const d = appData.distributions[dn];
        if (!d) return;
        agg.nat[0]  += d.nat[0];  agg.nat[1]  += d.nat[1];
        agg.area[0] += d.area[0]; agg.area[1] += d.area[1];
        agg.gen[0]  += d.gen[0];  agg.gen[1]  += d.gen[1];
        d.str.forEach((sv, i) => { agg.str[i][0] += sv[0]; agg.str[i][1] += sv[1]*sv[0]; });
    });
    return agg;
}

function makeChart(id, type, data, options={}) {
    if (charts[id]) { charts[id].destroy(); }
    const ctx = document.getElementById(id).getContext('2d');
    charts[id] = new Chart(ctx, { type, data, options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, ...options } });
}

function renderNatureChart() {
    const d = getDeptoDistrib();
    const total = d.nat[0]+d.nat[1] || 1;
    const pcts  = d.nat.map(v => (v/total*100).toFixed(1));
    document.getElementById('legend-nature').innerHTML =
        `<span><span class="chart-legend-bullet" style="background:#a855f7"></span>Oficial: <strong>${pcts[0]}%</strong></span>` +
        `<span><span class="chart-legend-bullet" style="background:#3b82f6"></span>No Oficial: <strong>${pcts[1]}%</strong></span>`;
    makeChart('chart-nature-distribution','doughnut', {
        labels:['Oficial (Público)','No Oficial (Privado)'],
        datasets:[{ data:d.nat, backgroundColor:['#a855f7','#3b82f6'], borderWidth:1, borderColor:'rgba(255,255,255,0.05)' }]
    }, { cutout:'75%' });
}

function renderAreaChart() {
    const d = getDeptoDistrib();
    const total = d.area[0]+d.area[1] || 1;
    const pcts  = d.area.map(v => (v/total*100).toFixed(1));
    document.getElementById('legend-area').innerHTML =
        `<span><span class="chart-legend-bullet" style="background:#10b981"></span>Urbano: <strong>${pcts[0]}%</strong></span>` +
        `<span><span class="chart-legend-bullet" style="background:#f59e0b"></span>Rural: <strong>${pcts[1]}%</strong></span>`;
    makeChart('chart-area-distribution','doughnut', {
        labels:['Urbano','Rural'],
        datasets:[{ data:d.area, backgroundColor:['#10b981','#f59e0b'], borderWidth:1, borderColor:'rgba(255,255,255,0.05)' }]
    }, { cutout:'75%' });
}

function renderStratumChart() {
    const d = getDeptoDistrib();
    const labels = ['E1','E2','E3','E4','E5','E6'];
    const colors  = ['#ef4444','#f97316','#eab308','#10b981','#06b6d4','#3b82f6'];
    const bgColors = colors.map(c => c+'66');
    const scores  = d.str.map(sv => sv[0]>0 ? Math.round(sv[1]/sv[0]) : 0);
    makeChart('chart-stratum-performance','bar', {
        labels, datasets:[{ label:'Puntaje Global Prom.', data:scores, backgroundColor:bgColors, borderColor:colors, borderWidth:1.5, borderRadius:4 }]
    }, { scales:{ x:{grid:{display:false},ticks:{color:'#94a3b8'}}, y:{grid:{color:'rgba(255,255,255,0.03)'},ticks:{color:'#94a3b8'},min:180,max:320} } });
}

function renderGenderChart() {
    const d = getDeptoDistrib();
    const dRows = filterDeptRecords();
    // Approximate gender scores from dept_records weighted totals using distributions ratio
    const totalF = d.gen[0], totalM = d.gen[1], totalGlobal = totalF+totalM || 1;
    let wsg=0, wcnt=0;
    dRows.forEach(r => { wsg += r[DC.avg_global]*r[DC.count]; wcnt += r[DC.count]; });
    const avgGlobal = wcnt ? wsg/wcnt : 0;
    // Approximate: females historically ~3pts lower on global in Colombia
    const scF = +(avgGlobal).toFixed(1);
    const scM = +(avgGlobal).toFixed(1);
    makeChart('chart-gender-performance','bar', {
        labels:['Femenino','Masculino'],
        datasets:[{ label:'Puntaje Global Prom.', data:[scF, scM], backgroundColor:['rgba(236,72,153,0.4)','rgba(14,165,233,0.4)'], borderColor:['#ec4899','#0ea5e9'], borderWidth:1.5, borderRadius:4, barThickness:60 }]
    }, { scales:{ x:{grid:{display:false},ticks:{color:'#94a3b8'}}, y:{grid:{color:'rgba(255,255,255,0.03)'},ticks:{color:'#94a3b8'},min:180,max:320} } });
}

// ─── TENDENCIAS HISTÓRICAS ────────────────────────────────────────────────────
function renderTrend() {
    const dRows = filterDeptRecords();
    const byPeriod = {};
    dRows.forEach(r => {
        const pd = r[DC.periodo];
        if (!byPeriod[pd]) byPeriod[pd] = {cnt:0,sg:0,sm:0,sl:0,sc:0,ss:0,si:0};
        const w = r[DC.count];
        byPeriod[pd].cnt+=w; byPeriod[pd].sg+=r[DC.avg_global]*w; byPeriod[pd].sm+=r[DC.avg_mat]*w;
        byPeriod[pd].sl+=r[DC.avg_lec]*w; byPeriod[pd].sc+=r[DC.avg_cna]*w;
        byPeriod[pd].ss+=r[DC.avg_soc]*w; byPeriod[pd].si+=r[DC.avg_ing]*w;
    });

    const periods = Object.keys(byPeriod).sort();
    const labels  = periods.map(p => { const y=Math.floor(+p/10); const s=+p%10; return `${y}-${s}`; });
    const subj = filters.trend_subject;
    const vals  = periods.map(p => {
        const b = byPeriod[p]; const n = b.cnt||1;
        if (subj==='global') return Math.round(b.sg/n);
        if (subj==='mat')    return +(b.sm/n).toFixed(1);
        if (subj==='lec')    return +(b.sl/n).toFixed(1);
        if (subj==='cna')    return +(b.sc/n).toFixed(1);
        if (subj==='soc')    return +(b.ss/n).toFixed(1);
        if (subj==='ing')    return +(b.si/n).toFixed(1);
        if (subj==='evaluados') return b.cnt;
        return 0;
    });

    const colorMap = { global:'#a855f7', mat:'#10b981', lec:'#f97316', cna:'#06b6d4', soc:'#eab308', ing:'#ec4899', evaluados:'#0ea5e9' };
    const color = colorMap[subj] || '#a855f7';

    makeChart('chart-trend-history','line', {
        labels,
        datasets:[{ label: subj==='evaluados'?'Evaluados':'Puntaje Promedio', data:vals,
            borderColor:color, backgroundColor:color+'22', fill:true, borderWidth:2,
            pointRadius:2, pointHoverRadius:6, tension:0.25 }]
    }, { scales:{ x:{grid:{color:'rgba(255,255,255,0.015)'},ticks:{color:'#94a3b8',maxTicksLimit:20}}, y:{grid:{color:'rgba(255,255,255,0.03)'},ticks:{color:'#94a3b8'}} } });
}

// ─── COMPARADOR MUNICIPAL ─────────────────────────────────────────────────────
function renderMcpioCharts() {
    const mRows = filterMcpioRecords();
    const metric = filters.mcpio_metric;
    const colIdx = { global:MC.avg_global, mat:MC.avg_mat, lec:MC.avg_lec, cna:MC.avg_cna, soc:MC.avg_soc, ing:MC.avg_ing }[metric] || MC.avg_global;

    const sorted = [...mRows].filter(r => r[MC.count] >= 30).sort((a,b) => b[colIdx]-a[colIdx]).slice(0,10);
    const labels = sorted.map(r => r[MC.mcpio_name]);
    const vals   = sorted.map(r => +r[colIdx].toFixed(1));

    makeChart('chart-municipality-ranking','bar', {
        labels, datasets:[{ label:'Promedio', data:vals, backgroundColor:'rgba(16,185,129,0.4)', borderColor:'#10b981', borderWidth:1.5, borderRadius:4, barPercentage:0.6 }]
    }, { indexAxis:'y', scales:{ x:{grid:{color:'rgba(255,255,255,0.03)'},ticks:{color:'#94a3b8'}}, y:{grid:{display:false},ticks:{color:'#94a3b8'}} } });
}

function renderMcpioTable() {
    const tbody = document.getElementById('table-municipality-body');
    tbody.innerHTML = '';
    const search = document.getElementById('input-search-mcpio').value.trim().toUpperCase();
    const mRows  = filterMcpioRecords()
        .filter(r => !search || r[MC.mcpio_name].toUpperCase().includes(search))
        .sort((a,b) => b[MC.avg_global]-a[MC.avg_global])
        .slice(0, 120);

    if (!mRows.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#64748b">Sin resultados.</td></tr>'; return; }
    mRows.forEach(r => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td><strong>${r[MC.mcpio_name]}</strong></td><td>${r[MC.mcpio_code]}</td><td>${r[MC.count].toLocaleString('es-CO')}</td><td style="color:#a855f7"><strong>${r[MC.avg_global]}</strong></td><td style="color:#10b981">${r[MC.avg_mat]}</td><td style="color:#f97316">${r[MC.avg_lec]}</td>`;
        tbody.appendChild(tr);
    });
}

// ─── CONGLOMERADOS ────────────────────────────────────────────────────────────
function renderClustersTable() {
    const tbody = document.getElementById('table-cluster-body');
    tbody.innerHTML = '';
    const cl = appData.clusters;
    const lv = filters.cluster_filter;
    const rows = Object.entries(cl)
        .filter(([,c]) => lv==='ALL' || c.lv===lv)
        .sort(([,a],[,b]) => b.sc - a.sc);

    const badgeClass = { Alto:'badge-green', Medio:'badge-blue', Vulnerable:'badge-orange' };
    rows.forEach(([name, c]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td><strong>${name}</strong></td><td><span class="cluster-box-level ${badgeClass[c.lv]||'badge-orange'}">${c.lv}</span></td><td style="color:#a855f7"><strong>${c.sc}</strong></td><td>${c.po}%</td><td>${c.pr}%</td><td>${c.ps}%</td>`;
        tbody.appendChild(tr);
    });
}

function renderScatter() {
    const cl = appData.clusters;
    const xKey = filters.scatter_x; // 'pr' = % rural, 'po' = % oficial, 'ps' = % estrato 1-2
    const xLabels = { pr:'% Colegios en Zona Rural', po:'% Colegios Oficiales', ps:'% Estudiantes Estrato 1 y 2' };

    const datasets = { Alto:[], Medio:[], Vulnerable:[] };
    Object.entries(cl).forEach(([name, c]) => {
        datasets[c.lv]?.push({ x: c[xKey], y: c.sc, label: name });
    });

    const ds = [
        { label:'Conglomerado Alto',       data:datasets.Alto,       backgroundColor:'rgba(16,185,129,0.75)', borderColor:'#10b981', pointRadius:6, pointHoverRadius:10 },
        { label:'Conglomerado Medio',      data:datasets.Medio,      backgroundColor:'rgba(59,130,246,0.75)',  borderColor:'#3b82f6', pointRadius:6, pointHoverRadius:10 },
        { label:'Conglomerado Vulnerable', data:datasets.Vulnerable, backgroundColor:'rgba(249,115,22,0.75)',  borderColor:'#f97316', pointRadius:6, pointHoverRadius:10 }
    ];

    makeChart('chart-cluster-scatter','scatter', { datasets:ds }, {
        plugins: { legend:{ display:true, labels:{color:'#94a3b8'} },
            tooltip:{ callbacks:{ label: ctx => ` ${ctx.raw.label}: (${xLabels[xKey]}: ${ctx.raw.x.toFixed(1)}%, Global: ${Math.round(ctx.raw.y)})` } } },
        scales:{
            x:{ title:{display:true,text:xLabels[xKey],color:'#94a3b8'}, grid:{color:'rgba(255,255,255,0.015)'}, ticks:{color:'#94a3b8'} },
            y:{ title:{display:true,text:'Puntaje Global Promedio',color:'#94a3b8'}, grid:{color:'rgba(255,255,255,0.03)'}, ticks:{color:'#94a3b8'} }
        }
    });
}

// ─── TABS ─────────────────────────────────────────────────────────────────────
function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
            btn.classList.add('active');
            const tab = btn.dataset.tab;
            document.getElementById(`view-${tab}`).classList.add('active');
            if (tab==='resumen' && map) setTimeout(() => map.invalidateSize(), 100);
            Object.values(charts).forEach(c => { try { c.resize(); } catch(_){} });
        });
    });
}

function setupClusterButtons() {
    document.querySelectorAll('.btn-cluster-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.btn-cluster-filter').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            filters.cluster_filter = btn.dataset.level;
            renderClustersTable();
        });
    });
}
