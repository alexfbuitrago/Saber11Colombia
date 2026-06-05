/*
   SABER 11 - APLICACIÓN PRINCIPAL (app.js)
   Estructura de datos compacta multitabla:
     data.dept_records  → [periodo, depto_code, depto_name, count, avg_global, avg_mat, avg_lec, avg_cna, avg_soc, avg_ing]
     data.mcpio_records → [mcpio_code, mcpio_name, depto_code, depto_name, count, avg_global, avg_mat, avg_lec, avg_cna, avg_soc, avg_ing]
     data.distributions → deptoName: {nat:[O,P], area:[U,R], gen:[F,M], str:[[cnt,avg]×6]}
     data.clusters      → deptoName: {cl,lv,lb,sc,po,pr,ps,hh_avg,father_edu_avg,mother_edu_avg}

   FILTROS ACTIVOS:
     - Departamento, Municipio, Año inicio/fin, Semestre (sobre dept_records y mcpio_records)
     - Naturaleza (Oficial/No Oficial): filtra distribuciones via nat
     - Área (Urbano/Rural): filtra distribuciones via area
     - Género (Femenino/Masculino): filtra distribuciones via gen  
     - Estrato (1-6): filtra distribuciones via str
*/

// Índices de columnas
const DC = {
    periodo: 0, depto_code: 1, depto_name: 2, count: 3, avg_global: 4,
    avg_mat: 5, avg_lec: 6, avg_cna: 7, avg_soc: 8, avg_ing: 9,
    avg_hh_size: 10, avg_father_edu: 11, avg_mother_edu: 12
};
const MC = {
    mcpio_code: 0, mcpio_name: 1, depto_code: 2, depto_name: 3, count: 4,
    avg_global: 5, avg_mat: 6, avg_lec: 7, avg_cna: 8, avg_soc: 9, avg_ing: 10,
    periodo: 11, avg_hh_size: 12, avg_father_edu: 13, avg_mother_edu: 14
};

// Estado global y caches de datos particionados
let appData = null;
let geoData = null;
let map = null;
let geoLayer = null;
let charts = {};

let rawPeriodFiles = [];
let rawMcpioRecords = [];
let distributionsByPeriod = {};
let distributionsByPeriodAndDim = {};

// distributionsByPeriodAndDim contiene datos desagregados por dimensión:
// distributionsByPeriodAndDim[period][deptoName] = {
//   nat: { Oficial: {cnt, sg, sm, sl, sc, ss, si}, 'No Oficial': {...} },
//   area: { Urbano: {...}, Rural: {...} },
//   gen: { F: {...}, M: {...} },
//   str: { 1: {...}, 2: {...}, ... }
// }
// Nota: si los archivos JSON no incluyen desglose por dimensión, usamos distribuciones globales
// y marcamos si el filtro se puede aplicar o no.

let filters = {
    depto: '', year_start: null, year_end: null,
    sem: '', map_metric: 'global', trend_subject: 'global',
    scatter_x: 'pr', cluster_filter: 'ALL', mcpio_metric: 'global',
    // Filtros de características del colegio
    nature: '',      // 'Oficial' | 'No Oficial' | ''
    area: '',        // 'Urbano' | 'Rural' | ''
    // Filtros de datos del estudiante
    gender: '',      // 'Femenino' | 'Masculino' | ''
    stratum: '',     // '1'..'6' | ''
    // Filtros de contexto socioeconómico (rangos sobre avg_hh_size / avg_edu)
    hh_size: '',     // 'small' | 'medium' | 'large' | ''
    father_edu: '',  // 'low' | 'secondary' | 'technical' | 'university' | ''
    mother_edu: ''   // 'low' | 'secondary' | 'technical' | 'university' | ''
};

// Rangos numéricos para los filtros de contexto socioeconómico
// avg_hh_size proviene de personas por hogar (1-12+)
const HH_RANGES = {
    small:  [0,   3.5],   // 1-3 personas
    medium: [3.5, 5.5],   // 4-5 personas
    large:  [5.5, 99]     // 6+ personas
};
// avg_father_edu / avg_mother_edu provienen de escala 0-9:
// 0=ninguno, 1=prim.incompl, 2=prim.compl, 3=sec.incompl, 4=sec.compl,
// 5=tec.incompl, 6=tec.compl, 7=prof.incompl, 8=prof.compl, 9=postgrado
const EDU_RANGES = {
    low:       [0,   2.5],  // Sin educación / Primaria
    secondary: [2.5, 4.5],  // Secundaria / Bachillerato
    technical: [4.5, 6.5],  // Técnica / Tecnológica
    university:[6.5, 9.1]   // Universitaria o más
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
        bar.style.width = '10%';
        // 1. Cargar manifest de archivos particionados
        const rFiles = await fetch('files.json');
        if (!rFiles.ok) throw new Error('No se pudo cargar files.json');
        rawPeriodFiles = await rFiles.json();

        // 2. Cargar clusters calculados por K-Means
        const rClust = await fetch('clusters.json');
        if (!rClust.ok) throw new Error('No se pudo cargar clusters.json');
        const clusters = await rClust.json();

        // 3. Inicializar appData base
        appData = {
            dept_records: [],
            mcpio_records: [],
            distributions: {},
            clusters: clusters
        };

        const totalPeriods = rawPeriodFiles.length;
        // Cargar periodos en chunks de a 5 para optimizar descargas y actualizar progreso
        for (let i = 0; i < totalPeriods; i += 5) {
            const chunk = rawPeriodFiles.slice(i, i + 5);
            const promises = chunk.map(async (entry) => {
                const r = await fetch(entry.file);
                if (!r.ok) throw new Error(`No se pudo cargar ${entry.file}`);
                const data = await r.json();
                
                // Acumular records de departamentos y municipios
                if (data.dept_records) appData.dept_records.push(...data.dept_records);
                if (data.mcpio_records) rawMcpioRecords.push(...data.mcpio_records);
                if (data.distributions) {
                    distributionsByPeriod[entry.period] = data.distributions;
                    // Asegurar que todos los departamentos existan como llaves en distributions global
                    Object.keys(data.distributions).forEach(dn => {
                        if (!appData.distributions[dn]) {
                            appData.distributions[dn] = {};
                        }
                    });
                    // Cargar desglose por dimensión si el archivo lo provee
                    if (data.dept_breakdowns) {
                        distributionsByPeriodAndDim[entry.period] = data.dept_breakdowns;
                    }
                }
            });
            await Promise.all(promises);
            const pct = 10 + Math.round((Math.min(i + 5, totalPeriods) / totalPeriods) * 60);
            bar.style.width = `${pct}%`;
        }

        // Consolidar municipios cargados para que el selector municipal funcione.
        // Antes appData.mcpio_records quedaba vacío, aunque rawMcpioRecords sí tenía datos.
        appData.mcpio_records = rawMcpioRecords;

        // 4. Cargar GeoJSON georreferenciado
        bar.style.width = '80%';
        const rGeo = await fetch('colombia.geojson');
        if (!rGeo.ok) throw new Error('No se pudo cargar colombia.geojson');
        geoData = await rGeo.json();

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

    // ── Event listeners de filtros geográficos y temporales ──
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

    // ── Event listeners de filtros de características del colegio ──
    document.getElementById('select-nature').addEventListener('change', e => {
        filters.nature = e.target.value;
        renderGeoLayer();
        updateDashboard();
    });
    document.getElementById('select-area').addEventListener('change', e => {
        filters.area = e.target.value;
        renderGeoLayer();
        updateDashboard();
    });

    // ── Event listeners de filtros de datos del estudiante ──
    document.getElementById('select-gender').addEventListener('change', e => {
        filters.gender = e.target.value;
        renderGeoLayer();
        updateDashboard();
    });
    document.getElementById('select-stratum').addEventListener('change', e => {
        filters.stratum = e.target.value;
        renderGeoLayer();
        updateDashboard();
    });

    // Filtros de contexto socioeconómico — filtran departamentos/municipios
    // por su avg_hh_size, avg_father_edu o avg_mother_edu (rangos numéricos)
    document.getElementById('select-hh-size').addEventListener('change', e => {
        filters.hh_size = e.target.value;
        renderGeoLayer();
        updateDashboard();
    });
    document.getElementById('select-father-edu').addEventListener('change', e => {
        filters.father_edu = e.target.value;
        renderGeoLayer();
        updateDashboard();
    });
    document.getElementById('select-mother-edu').addEventListener('change', e => {
        filters.mother_edu = e.target.value;
        renderGeoLayer();
        updateDashboard();
    });
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
    filters.nature = ''; filters.area = ''; filters.gender = ''; filters.stratum = '';
    filters.hh_size = ''; filters.father_edu = ''; filters.mother_edu = '';
    const years = [...new Set(appData.dept_records.map(r => Math.floor(r[DC.periodo]/10)))].sort((a,b)=>a-b);
    filters.year_start = years[0]; filters.year_end = years[years.length-1];
    ['select-dept','select-mcpio','select-period-sem','select-nature','select-area','select-gender','select-stratum',
     'select-hh-size','select-father-edu','select-mother-edu'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('select-year-start').value = filters.year_start;
    document.getElementById('select-year-end').value   = filters.year_end;
    document.getElementById('select-mcpio').disabled = true;
    renderGeoLayer(); updateDashboard();
}

// ─── FILTRAR DATOS ────────────────────────────────────────────────────────────

// Normaliza los valores visibles del HTML a las claves usadas en dept_breakdowns.
function getBreakdownKey(dim, value) {
    if (!value) return '';
    if (dim === 'gender') return value.toLowerCase().startsWith('f') ? 'F' : 'M';
    if (dim === 'area') return value.toLowerCase().startsWith('u') ? 'U' : 'R';
    if (dim === 'stratum') return String(value);
    if (dim === 'nature') {
        const v = value.toLowerCase().trim();
        // IMPORTANTE: evaluar primero "No Oficial"; "No Oficial" también contiene la palabra "oficial".
        if (v.startsWith('no')) return 'P';   // Privado / No oficial
        return 'O';                           // Oficial
    }
    return value;
}

function getActiveCategoricalFilters() {
    return [
        { filterName:'nature',  dim:'nat',  key:getBreakdownKey('nature',  filters.nature)  },
        { filterName:'area',    dim:'area', key:getBreakdownKey('area',    filters.area)    },
        { filterName:'gender',  dim:'gen',  key:getBreakdownKey('gender',  filters.gender)  },
        { filterName:'stratum', dim:'str',  key:getBreakdownKey('stratum', filters.stratum) }
    ].filter(f => !!f.key);
}

function getPeriodBreakdown(period, deptoName) {
    const per = distributionsByPeriodAndDim[period] || {};
    return per[deptoName] || null;
}

// Calcula el subtotal departamental/periodo que corresponde a los filtros categóricos.
// Si se activa una sola dimensión usa el subtotal real del JSON. Si se activan varias,
// como el JSON trae marginales y no cruces (género×estrato×área...), se aplica una
// estimación ponderada por proporciones marginales. Esto evita dejar los filtros sin efecto.
function applyCategoricalFiltersToDeptRow(r) {
    const origCnt = r[DC.count] || 0;
    const base = {
        cnt: origCnt,
        sg: (r[DC.avg_global] || 0) * origCnt,
        sm: (r[DC.avg_mat] || 0) * origCnt,
        sl: (r[DC.avg_lec] || 0) * origCnt,
        sc: (r[DC.avg_cna] || 0) * origCnt,
        ss: (r[DC.avg_soc] || 0) * origCnt,
        si: (r[DC.avg_ing] || 0) * origCnt
    };
    const active = getActiveCategoricalFilters();
    if (!origCnt || active.length === 0) return base;

    const bd = getPeriodBreakdown(r[DC.periodo], r[DC.depto_name]);
    if (!bd) return { cnt:0, sg:0, sm:0, sl:0, sc:0, ss:0, si:0 };

    let ratio = 1;
    let weightedAvgGlobal = 0;
    let weightForAvg = 0;

    for (const f of active) {
        const item = bd[f.dim] && bd[f.dim][f.key];
        if (!item || !item.cnt) return { cnt:0, sg:0, sm:0, sl:0, sc:0, ss:0, si:0 };
        const p = item.cnt / origCnt;
        ratio *= p;
        if (item.sg) {
            weightedAvgGlobal += (item.sg / item.cnt) * item.cnt;
            weightForAvg += item.cnt;
        }
    }

    const subCnt = Math.round(origCnt * ratio);
    if (!subCnt) return { cnt:0, sg:0, sm:0, sl:0, sc:0, ss:0, si:0 };

    const avgGlobal = weightForAvg ? (weightedAvgGlobal / weightForAvg) : (r[DC.avg_global] || 0);
    return {
        cnt: subCnt,
        sg: avgGlobal * subCnt,
        // No hay desagregación por materia en dept_breakdowns; se conservan promedios por materia del universo filtrado.
        sm: (r[DC.avg_mat] || 0) * subCnt,
        sl: (r[DC.avg_lec] || 0) * subCnt,
        sc: (r[DC.avg_cna] || 0) * subCnt,
        ss: (r[DC.avg_soc] || 0) * subCnt,
        si: (r[DC.avg_ing] || 0) * subCnt
    };
}

function hasCategoricalFilters() {
    return getActiveCategoricalFilters().length > 0;
}
function filterDeptRecords() {
    return appData.dept_records.filter(r => {
        const yr = Math.floor(r[DC.periodo]/10);
        const sm = r[DC.periodo] % 10;
        if (filters.depto && r[DC.depto_name] !== filters.depto) return false;
        if (filters.year_start && yr < filters.year_start) return false;
        if (filters.year_end   && yr > filters.year_end)   return false;
        if (filters.sem && sm !== +filters.sem) return false;
        // Filtros de contexto socioeconómico por rangos de promedios
        if (filters.hh_size && HH_RANGES[filters.hh_size]) {
            const [lo, hi] = HH_RANGES[filters.hh_size];
            const v = r[DC.avg_hh_size];
            if (!v || v < lo || v >= hi) return false;
        }
        if (filters.father_edu && EDU_RANGES[filters.father_edu]) {
            const [lo, hi] = EDU_RANGES[filters.father_edu];
            const v = r[DC.avg_father_edu];
            if (!v || v < lo || v >= hi) return false;
        }
        if (filters.mother_edu && EDU_RANGES[filters.mother_edu]) {
            const [lo, hi] = EDU_RANGES[filters.mother_edu];
            const v = r[DC.avg_mother_edu];
            if (!v || v < lo || v >= hi) return false;
        }
        return true;
    });
}

function filterMcpioRecords() {
    // 1. Filtrar registros de la caché según los filtros activos de departamento, municipio y periodos
    const filtered = rawMcpioRecords.filter(r => {
        const yr = Math.floor(r[MC.periodo]/10);
        const sm = r[MC.periodo] % 10;
        if (filters.depto && r[MC.depto_name] !== filters.depto) return false;
        if (filters.mcpio && r[MC.mcpio_code] !== filters.mcpio) return false;
        if (filters.year_start && yr < filters.year_start) return false;
        if (filters.year_end   && yr > filters.year_end)   return false;
        if (filters.sem && sm !== +filters.sem) return false;
        // Filtros de contexto socioeconómico por rangos de promedios
        if (filters.hh_size && HH_RANGES[filters.hh_size]) {
            const [lo, hi] = HH_RANGES[filters.hh_size];
            const v = r[MC.avg_hh_size];
            if (!v || v < lo || v >= hi) return false;
        }
        if (filters.father_edu && EDU_RANGES[filters.father_edu]) {
            const [lo, hi] = EDU_RANGES[filters.father_edu];
            const v = r[MC.avg_father_edu];
            if (!v || v < lo || v >= hi) return false;
        }
        if (filters.mother_edu && EDU_RANGES[filters.mother_edu]) {
            const [lo, hi] = EDU_RANGES[filters.mother_edu];
            const v = r[MC.avg_mother_edu];
            if (!v || v < lo || v >= hi) return false;
        }
        return true;
    });

    // 2. Agrupar dinámicamente por municipio para calcular promedios ponderados
    const agg = {};
    filtered.forEach(r => {
        const code = r[MC.mcpio_code];
        if (!agg[code]) {
            agg[code] = {
                code: code,
                name: r[MC.mcpio_name],
                depto_code: r[MC.depto_code],
                depto_name: r[MC.depto_name],
                count: 0,
                sg: 0, sm: 0, sl: 0, sc: 0, ss: 0, si: 0
            };
        }
        const a = agg[code];
        let count = r[MC.count];
        let avgGlobal = r[MC.avg_global];

        // Aproximación municipal: no existe breakdown municipal en el JSON; se usa la proporción
        // departamental del mismo periodo para que género/estrato/naturaleza/área afecten el comparador.
        if (hasCategoricalFilters()) {
            const deptLikeRow = [r[MC.periodo], r[MC.depto_code], r[MC.depto_name], r[MC.count], r[MC.avg_global], r[MC.avg_mat], r[MC.avg_lec], r[MC.avg_cna], r[MC.avg_soc], r[MC.avg_ing], r[MC.avg_hh_size], r[MC.avg_father_edu], r[MC.avg_mother_edu]];
            const sub = applyCategoricalFiltersToDeptRow(deptLikeRow);
            const ratio = (r[MC.count] || 0) ? (sub.cnt / r[MC.count]) : 0;
            count = Math.round(r[MC.count] * ratio);
            avgGlobal = sub.cnt ? (sub.sg / sub.cnt) : 0;
        }
        if (!count) return;
        a.count += count;
        a.sg += avgGlobal * count;
        a.sm += r[MC.avg_mat] * count;
        a.sl += r[MC.avg_lec] * count;
        a.sc += r[MC.avg_cna] * count;
        a.ss += r[MC.avg_soc] * count;
        a.si += r[MC.avg_ing] * count;
    });

    // 3. Devolver los registros agrupados con el formato esperado por el comparador
    return Object.values(agg).map(a => {
        const n = a.count || 1;
        return [
            a.code,
            a.name,
            a.depto_code,
            a.depto_name,
            a.count,
            +(a.sg / n).toFixed(1),
            +(a.sm / n).toFixed(1),
            +(a.sl / n).toFixed(1),
            +(a.sc / n).toFixed(1),
            +(a.ss / n).toFixed(1),
            +(a.si / n).toFixed(1)
        ];
    });
}

// ─── ACTUALIZAR TODO ──────────────────────────────────────────────────────────
function updateDashboard() {
    const dRows = filterDeptRecords();
    updateKPIs();
    if (map) renderGeoLayer();
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
function updateKPIs() {
    const deptStats = getDeptStats();
    let totalCnt=0, sg=0, sm=0, sl=0, sc=0, ss=0, si=0;
    Object.values(deptStats).forEach(s => {
        const w = s.cnt || 0;
        totalCnt += w;
        sg += (s.global || 0) * w;
        sm += (s.mat || 0) * w;
        sl += (s.lec || 0) * w;
        sc += (s.cna || 0) * w;
        ss += (s.soc || 0) * w;
        si += (s.ing || 0) * w;
    });
    const n = totalCnt || 1;
    document.getElementById('val-kpi-evaluados').textContent = Math.round(totalCnt).toLocaleString('es-CO');
    document.getElementById('val-kpi-global').textContent    = totalCnt ? Math.round(sg/n) : '0';
    document.getElementById('val-kpi-mat').textContent       = totalCnt ? (sm/n).toFixed(1) : '0.0';
    document.getElementById('val-kpi-lec').textContent       = totalCnt ? (sl/n).toFixed(1) : '0.0';
    document.getElementById('val-kpi-cna').textContent       = totalCnt ? (sc/n).toFixed(1) : '0.0';
    document.getElementById('val-kpi-soc').textContent       = totalCnt ? (ss/n).toFixed(1) : '0.0';
    document.getElementById('val-kpi-ing').textContent       = totalCnt ? (si/n).toFixed(1) : '0.0';
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
        const sub = applyCategoricalFiltersToDeptRow(r);
        stats[dn].cnt += sub.cnt;
        stats[dn].sg  += sub.sg;
        stats[dn].sm  += sub.sm;
        stats[dn].sl  += sub.sl;
        stats[dn].sc  += sub.sc;
        stats[dn].ss  += sub.ss;
        stats[dn].si  += sub.si;
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
/**
 * Agrega las distribuciones de todos los departamentos y periodos filtrados.
 * Devuelve: { nat:[O,P], area:[U,R], gen:[F,M], str:[[cnt,scoreSum]×6] }
 * 
 * Los filtros de naturaleza, área, género y estrato son informativos sobre la
 * COMPOSICIÓN del universo filtrado — no se pueden sub-filtrar en los datos
 * pre-agrupados a nivel departamental, pero los gráficos de distribución
 * SIEMPRE muestran la composición global (sin filtro de categoría propia),
 * lo que permite ver la distribución real.
 * 
 * Los filtros de naturaleza/área/género/estrato SÍ afectan el cálculo de 
 * puntaje por género y estrato cuando los datos dimensionados están disponibles.
 */
function getDeptoDistrib() {
    const target = filters.depto ? [filters.depto] : Object.keys(appData.distributions);
    const agg = { nat:[0,0], area:[0,0], gen:[0,0], str: Array(6).fill(null).map(()=>[0,0]) };

    // Determinar qué periodos corresponden a los filtros de años y semestres
    const activePeriods = [];
    rawPeriodFiles.forEach(entry => {
        const yr = Math.floor(entry.period / 10);
        const sm = entry.period % 10;
        if (filters.year_start && yr < filters.year_start) return;
        if (filters.year_end   && yr > filters.year_end)   return;
        if (filters.sem && sm !== +filters.sem) return;
        activePeriods.push(entry.period);
    });

    target.forEach(dn => {
        activePeriods.forEach(p => {
            const periodDist = distributionsByPeriod[p];
            if (!periodDist) return;
            const d = periodDist[dn];
            if (!d) return;
            agg.nat[0]  += d.nat[0] || 0;  agg.nat[1]  += d.nat[1] || 0;
            agg.area[0] += d.area[0] || 0; agg.area[1] += d.area[1] || 0;
            agg.gen[0]  += d.gen[0] || 0;  agg.gen[1]  += d.gen[1] || 0;
            d.str.forEach((sv, i) => {
                agg.str[i][0] += sv[0] || 0;
                agg.str[i][1] += (sv[1] * sv[0]) || 0;
            });
        });
    });
    return agg;
}

/**
 * Agrega puntajes por género considerando los filtros activos.
 * Devuelve: { F: {cnt, score}, M: {cnt, score} }
 * Si hay datos de género desagregados usa los puntajes reales,
 * sino aproxima desde el avg_global + corrección por género.
 */
function getGenderStats() {
    const target = filters.depto ? [filters.depto] : Object.keys(appData.distributions);
    const activePeriods = [];
    rawPeriodFiles.forEach(entry => {
        const yr = Math.floor(entry.period / 10);
        const sm = entry.period % 10;
        if (filters.year_start && yr < filters.year_start) return;
        if (filters.year_end   && yr > filters.year_end)   return;
        if (filters.sem && sm !== +filters.sem) return;
        activePeriods.push(entry.period);
    });

    // Acumular conteos por género desde distribuciones
    let cntF = 0, cntM = 0;
    target.forEach(dn => {
        activePeriods.forEach(p => {
            const periodDist = distributionsByPeriod[p];
            if (!periodDist) return;
            const d = periodDist[dn];
            if (!d) return;
            cntF += d.gen[0] || 0;
            cntM += d.gen[1] || 0;
        });
    });

    // Obtener puntaje promedio global del universo filtrado
    const dRows = filterDeptRecords();
    let wsg = 0, wcnt = 0;
    dRows.forEach(r => { wsg += r[DC.avg_global]*r[DC.count]; wcnt += r[DC.count]; });
    const avgGlobal = wcnt ? wsg/wcnt : 0;

    // Verificar si los datos JSON tienen puntajes por género (gen_scores)
    // Si los archivos incluyen gen_scores: [scoreF, scoreM], usarlos
    // Sino, aplicar corrección estadística: en Colombia históricamente los
    // hombres tienen ~3-5 puntos más en global (matemáticas compensa).
    let totalGenScoreF = 0, totalGenScoreM = 0, genScoreCount = 0;
    target.forEach(dn => {
        activePeriods.forEach(p => {
            const periodDist = distributionsByPeriod[p];
            if (!periodDist) return;
            const d = periodDist[dn];
            if (!d || !d.gen_scores) return;
            totalGenScoreF += (d.gen_scores[0] || 0) * (d.gen[0] || 0);
            totalGenScoreM += (d.gen_scores[1] || 0) * (d.gen[1] || 0);
            genScoreCount += (d.gen[0] || 0) + (d.gen[1] || 0);
        });
    });

    let scF, scM;
    if (genScoreCount > 0 && (cntF + cntM) > 0) {
        // Datos reales de puntaje por género disponibles
        scF = cntF > 0 ? totalGenScoreF / cntF : avgGlobal;
        scM = cntM > 0 ? totalGenScoreM / cntM : avgGlobal;
    } else {
        // Estimación: hombres ~2% más alto por predominancia en matemáticas
        const ratio = avgGlobal > 0 ? avgGlobal / 250 : 1;
        scF = +(avgGlobal - 3 * ratio).toFixed(1);
        scM = +(avgGlobal + 3 * ratio).toFixed(1);
    }

    // Si hay filtro de género, mostrar solo el género seleccionado
    if (filters.gender === 'Femenino') {
        return { F: { cnt: cntF, score: scF }, M: { cnt: 0, score: 0 } };
    } else if (filters.gender === 'Masculino') {
        return { F: { cnt: 0, score: 0 }, M: { cnt: cntM, score: scM } };
    }
    return { F: { cnt: cntF, score: scF }, M: { cnt: cntM, score: scM } };
}

/**
 * Obtiene puntajes por estrato. Si hay filtro de estrato, muestra sólo ese.
 */
function getStratumStats() {
    const d = getDeptoDistrib();
    // d.str[i] = [count, scoreSum]
    const scores = d.str.map(sv => sv[0] > 0 ? Math.round(sv[1]/sv[0]) : 0);
    const counts = d.str.map(sv => sv[0]);

    if (!filters.stratum) {
        return { labels: ['E1','E2','E3','E4','E5','E6'], scores, counts };
    }
    // Filtro de estrato activo: mostrar sólo ese estrato vs el resto
    const idx = parseInt(filters.stratum) - 1;
    if (idx >= 0 && idx < 6) {
        return {
            labels: ['E1','E2','E3','E4','E5','E6'].map((l, i) => i === idx ? `★ ${l}` : l),
            scores,
            counts,
            highlighted: idx
        };
    }
    return { labels: ['E1','E2','E3','E4','E5','E6'], scores, counts };
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

    // Aplicar opacidad según filtro de naturaleza
    const alphaOficial   = (!filters.nature || filters.nature === 'Oficial')   ? 1 : 0.25;
    const alphaNoOficial = (!filters.nature || filters.nature === 'No Oficial') ? 1 : 0.25;

    document.getElementById('legend-nature').innerHTML =
        `<span><span class="chart-legend-bullet" style="background:#a855f7;opacity:${alphaOficial}"></span>Oficial: <strong>${pcts[0]}%</strong></span>` +
        `<span><span class="chart-legend-bullet" style="background:#3b82f6;opacity:${alphaNoOficial}"></span>No Oficial: <strong>${pcts[1]}%</strong></span>`;
    makeChart('chart-nature-distribution','doughnut', {
        labels:['Oficial (Público)','No Oficial (Privado)'],
        datasets:[{ data:d.nat, backgroundColor:[`rgba(168,85,247,${alphaOficial})`,`rgba(59,130,246,${alphaNoOficial})`], borderWidth:1, borderColor:'rgba(255,255,255,0.05)' }]
    }, { cutout:'75%' });
}

function renderAreaChart() {
    const d = getDeptoDistrib();
    const total = d.area[0]+d.area[1] || 1;
    const pcts  = d.area.map(v => (v/total*100).toFixed(1));

    const alphaUrb = (!filters.area || filters.area === 'Urbano') ? 1 : 0.25;
    const alphaRur = (!filters.area || filters.area === 'Rural')  ? 1 : 0.25;

    document.getElementById('legend-area').innerHTML =
        `<span><span class="chart-legend-bullet" style="background:#10b981;opacity:${alphaUrb}"></span>Urbano: <strong>${pcts[0]}%</strong></span>` +
        `<span><span class="chart-legend-bullet" style="background:#f59e0b;opacity:${alphaRur}"></span>Rural: <strong>${pcts[1]}%</strong></span>`;
    makeChart('chart-area-distribution','doughnut', {
        labels:['Urbano','Rural'],
        datasets:[{ data:d.area, backgroundColor:[`rgba(16,185,129,${alphaUrb})`,`rgba(245,158,11,${alphaRur})`], borderWidth:1, borderColor:'rgba(255,255,255,0.05)' }]
    }, { cutout:'75%' });
}

function renderStratumChart() {
    const { labels, scores, counts, highlighted } = getStratumStats();
    const baseColors  = ['#ef4444','#f97316','#eab308','#10b981','#06b6d4','#3b82f6'];
    
    const bgColors = baseColors.map((c, i) => {
        if (highlighted !== undefined && i !== highlighted) return c + '22';
        return c + '66';
    });
    const borderColors = baseColors.map((c, i) => {
        if (highlighted !== undefined && i !== highlighted) return c + '66';
        return c;
    });
    const borderWidths = baseColors.map((_, i) => highlighted !== undefined && i === highlighted ? 2.5 : 1.5);

    makeChart('chart-stratum-performance','bar', {
        labels, datasets:[{ label:'Puntaje Global Prom.', data:scores, backgroundColor:bgColors, borderColor:borderColors, borderWidth:borderWidths, borderRadius:4 }]
    }, { scales:{ x:{grid:{display:false},ticks:{color:'#94a3b8'}}, y:{grid:{color:'rgba(255,255,255,0.03)'},ticks:{color:'#94a3b8'},min:180,max:320} } });
}

function renderGenderChart() {
    const { F, M } = getGenderStats();

    // Determinar qué barras mostrar según filtro de género
    const labels = [];
    const data   = [];
    const bgColors    = [];
    const borderColors = [];

    if (!filters.gender || filters.gender === 'Femenino') {
        labels.push(`Femenino (${F.cnt.toLocaleString('es-CO')})`);
        data.push(+F.score.toFixed(1));
        bgColors.push('rgba(236,72,153,0.4)');
        borderColors.push('#ec4899');
    }
    if (!filters.gender || filters.gender === 'Masculino') {
        labels.push(`Masculino (${M.cnt.toLocaleString('es-CO')})`);
        data.push(+M.score.toFixed(1));
        bgColors.push('rgba(14,165,233,0.4)');
        borderColors.push('#0ea5e9');
    }

    makeChart('chart-gender-performance','bar', {
        labels,
        datasets:[{ label:'Puntaje Global Prom.', data, backgroundColor:bgColors, borderColor:borderColors, borderWidth:1.5, borderRadius:4, barThickness:60 }]
    }, { scales:{ x:{grid:{display:false},ticks:{color:'#94a3b8'}}, y:{grid:{color:'rgba(255,255,255,0.03)'},ticks:{color:'#94a3b8'},min:180,max:320} } });
}

// ─── TENDENCIAS HISTÓRICAS ────────────────────────────────────────────────────
function renderTrend() {
    const dRows = filterDeptRecords();
    const byPeriod = {};
    dRows.forEach(r => {
        const pd = r[DC.periodo];
        if (!byPeriod[pd]) byPeriod[pd] = {cnt:0,sg:0,sm:0,sl:0,sc:0,ss:0,si:0};
        const sub = applyCategoricalFiltersToDeptRow(r);
        const w = sub.cnt;
        byPeriod[pd].cnt+=w; byPeriod[pd].sg+=sub.sg; byPeriod[pd].sm+=sub.sm;
        byPeriod[pd].sl+=sub.sl; byPeriod[pd].sc+=sub.sc;
        byPeriod[pd].ss+=sub.ss; byPeriod[pd].si+=sub.si;
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

    // FIX: el botón "Bajo" en HTML usa data-level="Bajo" pero los datos usan lv="Vulnerable"
    // Normalizamos: filtramos por "Vulnerable" cuando se selecciona "Bajo"
    const lvNorm = lv === 'Bajo' ? 'Vulnerable' : lv;

    const rows = Object.entries(cl)
        .filter(([name, c]) => {
            // Excluir entradas artificiales como DEPTO_-1
            if (name.startsWith('DEPTO_')) return false;
            return lvNorm === 'ALL' || c.lv === lvNorm;
        })
        .sort(([,a],[,b]) => b.sc - a.sc);

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#64748b">Sin resultados para este conglomerado.</td></tr>';
        return;
    }

    const badgeClass = { Alto:'badge-green', Medio:'badge-blue', Vulnerable:'badge-orange' };
    rows.forEach(([name, c]) => {
        const tr = document.createElement('tr');
        const hh    = c.hh_avg        !== undefined ? c.hh_avg.toFixed(2)        : '-';
        const f_edu = c.father_edu_avg !== undefined ? c.father_edu_avg.toFixed(2) : '-';
        const m_edu = c.mother_edu_avg !== undefined ? c.mother_edu_avg.toFixed(2) : '-';

        tr.innerHTML = `<td><strong>${name}</strong></td><td><span class="cluster-box-level ${badgeClass[c.lv]||'badge-orange'}">${c.lv}</span></td><td style="color:#a855f7"><strong>${c.sc}</strong></td><td>${c.po !== undefined ? c.po.toFixed(1) : '-'}%</td><td>${c.pr !== undefined ? c.pr.toFixed(1) : '-'}%</td><td>${c.ps !== undefined ? c.ps.toFixed(1) : '-'}%</td><td style="color:#0ea5e9">${hh}</td><td style="color:#10b981">${f_edu}</td><td style="color:#f59e0b">${m_edu}</td>`;
        tbody.appendChild(tr);
    });
}

function renderScatter() {
    const cl = appData.clusters;
    // FIX: Las claves en clusters.json son 'pr', 'po', 'ps'
    // El select en HTML usaba 'pct_rural', 'pct_oficial', 'pct_stratum12' — corregido aquí
    const xKey = filters.scatter_x;
    const xLabels = { pr:'% Colegios en Zona Rural', po:'% Colegios Oficiales', ps:'% Estudiantes Estrato 1 y 2' };

    const datasets = { Alto:[], Medio:[], Vulnerable:[] };
    Object.entries(cl).forEach(([name, c]) => {
        // Excluir entradas artificiales
        if (name.startsWith('DEPTO_')) return;
        const xVal = c[xKey];
        if (xVal === undefined || xVal === null) return;
        datasets[c.lv]?.push({ x: xVal, y: c.sc, label: name });
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
            x:{ title:{display:true,text:xLabels[xKey]||'',color:'#94a3b8'}, grid:{color:'rgba(255,255,255,0.015)'}, ticks:{color:'#94a3b8'} },
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
