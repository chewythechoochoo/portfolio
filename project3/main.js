/* Where does our emissions choice matter most? Plotting uses D3 only. */
(async function () {
  const [meta, land, countries, buf] = await Promise.all([
    d3.json('data/meta.json'), d3.json('data/land-110m.json'),
    d3.json('data/countries-110m.json'), d3.buffer('data/warming.bin'),
  ]);
  const vals = new Int16Array(buf);
  const frames = meta.frames, nF = frames.length;
  const nLat = meta.lat.n, nLon = meta.lon.n, nCell = nLat * nLon;
  const FIELD = { ssp126: 0, ssp585: 1, gap: 2 }, STAT = { mean: 0, low: 1, high: 2 };
  const periodOf = (i) => `${frames[i] - 19}–${frames[i]}`;
  const fmt = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}°C`;

  /* ---------- colour: one fixed scale shared by all three map views ---------- */
  const BINS = [-0.5, 0.5, 1.5, 2.5, 4, 6, 9];
  const COLORS = ['#2a78d6', '#f0efec', '#fde3c8', '#fdbb84', '#f58a54', '#d7422c', '#a30f12', '#5c0a0f'];
  const TICKS = ['−0.5', '0.5', '1.5', '2.5', '4', '6', '9'];
  const colorOf = d3.scaleThreshold().domain(BINS).range(COLORS);
  const LUT_MIN = -1500, LUT_MAX = 4000;      // hundredths of a degree
  const LUT = new Uint32Array(LUT_MAX - LUT_MIN + 1);
  for (let k = 0; k < LUT.length; k++) {
    const c = d3.rgb(colorOf((k + LUT_MIN) / 100));
    LUT[k] = (255 << 24) | (c.b << 16) | (c.g << 8) | c.r;
  }

  /* ---------- state ---------- */
  const state = { field: 'gap', t: nF - 1, place: null };
  const places = [
    { name: 'Global average', lat: null, lon: null },
    { name: 'San Diego', lat: 32.7, lon: -117.2 },
    { name: 'Svalbard', lat: 78.2, lon: 15.6 },
    { name: 'Manaus', lat: -3.1, lon: -60.0 },
    { name: 'Mumbai', lat: 19.1, lon: 72.9 },
    { name: 'South of Greenland', lat: 52.5, lon: -37.5 },
  ];

  /* ---------- data access ---------- */
  const baseIndex = (field, stat, t) => (((FIELD[field] * 3 + STAT[stat]) * nF + t) * nCell);
  function sample(field, stat, t, lat, lon) {
    const fj = Math.min(nLat - 1, Math.max(0, (lat - meta.lat.start) / meta.lat.step));
    const fi = ((lon - meta.lon.start) / meta.lon.step + nLon) % nLon;
    const j0 = Math.floor(fj), j1 = Math.min(nLat - 1, j0 + 1), i0 = Math.floor(fi), i1 = (i0 + 1) % nLon;
    const y = fj - j0, x = fi - i0, b = baseIndex(field, stat, t);
    return ((1 - y) * ((1 - x) * vals[b + j0 * nLon + i0] + x * vals[b + j0 * nLon + i1]) +
            y * ((1 - x) * vals[b + j1 * nLon + i0] + x * vals[b + j1 * nLon + i1])) * meta.scale;
  }
  const value = (field, stat, t, place) => (place && place.lat != null)
    ? sample(field, stat, t, place.lat, place.lon)
    : meta.global_mean[field][stat][t];
  const series = (field, place) => frames.map((year, t) => ({
    year, t, mean: value(field, 'mean', t, place), low: value(field, 'low', t, place), high: value(field, 'high', t, place),
  }));
  // A fixed vertical axis, wide enough for every cell, so places stay comparable.
  let yMax = 0, yMin = 0;
  { const b = baseIndex('ssp585', 'high', nF - 1);
    for (let k = 0; k < nCell; k++) yMax = Math.max(yMax, vals[b + k] * meta.scale);
    for (let t = 0; t < nF; t++) for (let k = 0; k < nCell; k++) { const v = vals[baseIndex('ssp126', 'low', t) + k] * meta.scale; if (v < yMin) yMin = v; } }
  yMax = Math.ceil(yMax / 2) * 2; yMin = Math.floor(yMin);

  const countryFeatures = topojson.feature(countries, countries.objects.countries).features;
  function placeLabel(lat, lon) {
    const ns = `${Math.abs(lat).toFixed(0)}°${lat >= 0 ? 'N' : 'S'}`;
    const ew = `${Math.abs(lon).toFixed(0)}°${lon >= 0 ? 'E' : 'W'}`;
    const hit = countryFeatures.find((f) => d3.geoContains(f, [lon, lat]));
    return `${ns}, ${ew}${hit ? ` · ${hit.properties.name}` : ''}`;
  }

  /* ---------- map ---------- */
  const mapEl = document.getElementById('map'), canvas = document.getElementById('raster'), svg = d3.select('#map-svg');
  const ctx = canvas.getContext('2d');
  const landFeature = topojson.feature(land, land.objects.land);
  const SPHERE = { type: 'Sphere' };
  let projection, path, raster;
  const gSphere = svg.append('path').attr('class', 'sphere');
  const gLand = svg.append('path').attr('class', 'land');
  const pin = svg.append('circle').attr('class', 'pin').attr('r', 7).style('display', 'none');
  const pinCore = svg.append('circle').attr('class', 'pin-core').attr('r', 7).style('display', 'none');

  // d3 wraps longitude when inverting, so a point off the globe still returns a valid-looking
  // coordinate. Sending it back through the forward projection tells the two apart.
  function onGlobe(px, py) {
    const inv = projection.invert([px, py]);
    if (!inv) return null;
    const back = projection(inv);
    return back && Math.abs(back[0] - px) < 0.5 && Math.abs(back[1] - py) < 0.5 ? inv : null;
  }

  function layoutMap() {
    const W = mapEl.clientWidth, H = Math.round(W * 0.487);
    if (W < 10) return false;            // not laid out yet; the ResizeObserver calls again
    mapEl.style.height = `${H}px`;
    projection = d3.geoEqualEarth().fitExtent([[2, 2], [W - 2, H - 2]], SPHERE);
    path = d3.geoPath(projection);
    svg.attr('viewBox', `0 0 ${W} ${H}`);
    gSphere.attr('d', path(SPHERE));
    gLand.attr('d', path(landFeature));
    // One inverse projection per pixel, done once, so repainting a frame is only a table lookup.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
    canvas.width = cw; canvas.height = ch;
    const pix = [], a = [], wx = [], wy = [], ii = [];
    for (let py = 0; py < ch; py++) for (let px = 0; px < cw; px++) {
      const inv = onGlobe((px + 0.5) / dpr, (py + 0.5) / dpr);
      if (!inv) continue;
      const fj = Math.min(nLat - 1.0001, Math.max(0, (inv[1] - meta.lat.start) / meta.lat.step));
      const fi = ((inv[0] - meta.lon.start) / meta.lon.step + nLon) % nLon;
      const j0 = Math.floor(fj), i0 = Math.floor(fi);
      pix.push(py * cw + px); a.push(j0 * nLon + i0); ii.push(j0 * nLon + (i0 + 1) % nLon);
      wx.push(fi - i0); wy.push(fj - j0);
    }
    raster = { n: pix.length, pix: Int32Array.from(pix), a: Int32Array.from(a), b: Int32Array.from(ii),
      wx: Float32Array.from(wx), wy: Float32Array.from(wy), img: ctx.createImageData(cw, ch) };
    raster.px = new Uint32Array(raster.img.data.buffer);
    paint(); drawPin();
    return true;
  }

  function paint() {
    if (!raster) return;
    const { n, pix, a, b, wx, wy, img, px } = raster, base = baseIndex(state.field, 'mean', state.t);
    for (let k = 0; k < n; k++) {
      const x = wx[k], y = wy[k], A = base + a[k], B = base + b[k];
      const v = (1 - y) * ((1 - x) * vals[A] + x * vals[B]) + y * ((1 - x) * vals[A + nLon] + x * vals[B + nLon]);
      const idx = Math.max(0, Math.min(LUT.length - 1, Math.round(v) - LUT_MIN));
      px[pix[k]] = LUT[idx];
    }
    ctx.putImageData(img, 0, 0);
  }

  function drawPin() {
    const p = state.place;
    const show = p && p.lat != null && projection;
    pin.style('display', show ? null : 'none'); pinCore.style('display', show ? null : 'none');
    if (show) { const [x, y] = projection([p.lon, p.lat]); pin.attr('cx', x).attr('cy', y); pinCore.attr('cx', x).attr('cy', y); }
  }

  /* ---------- tooltip ---------- */
  const tip = document.getElementById('tooltip');
  function showTip(html, ev) {
    tip.innerHTML = html; tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - 14;
    if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - 14;
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }
  const hideTip = () => { tip.hidden = true; };
  const lonlatFrom = (ev) => {
    if (!projection) return null;
    const [x, y] = d3.pointer(ev, svg.node());
    return onGlobe(x, y);
  };
  const fieldName = { ssp126: 'Low emissions', ssp585: 'High emissions', gap: 'Gap, high minus low' };
  let hoverEv = null;
  function drawMapTip(ev) {
    const ll = lonlatFrom(ev);
    if (!ll) return hideTip();
    const [lon, lat] = ll, t = state.t, f = state.field;
    showTip(`<b>${fmt(sample(f, 'mean', t, lat, lon))}</b> ${fieldName[f]}<br>` +
      `<span class="mut">Models: ${fmt(sample(f, 'low', t, lat, lon))} to ${fmt(sample(f, 'high', t, lat, lon))}<br>` +
      `${Math.abs(lat).toFixed(0)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(0)}°${lon >= 0 ? 'E' : 'W'}, ${periodOf(t)}</span>`, ev);
  }
  svg.on('pointermove', (ev) => { hoverEv = ev; drawMapTip(ev);
  }).on('pointerleave', () => { hoverEv = null; hideTip(); }).on('click', (ev) => {
    const ll = lonlatFrom(ev);
    if (!ll) return;
    state.place = { name: placeLabel(ll[1], ll[0]), lat: ll[1], lon: ll[0] };
    updatePlace(true);
  });

  /* ---------- line chart ---------- */
  const m = { top: 12, right: 44, bottom: 24, left: 36 }, CH = 300, chartEl = document.getElementById('chart');
  let CW = 460;
  const chartSvg = d3.select(chartEl).append('svg')
    .attr('role', 'img').attr('aria-label', 'Warming over time at the selected place under both futures');
  const x = d3.scaleLinear().domain([frames[0], frames[nF - 1]]);
  const y = d3.scaleLinear().domain([yMin, yMax]).range([CH - m.bottom, m.top]);
  const gridG = chartSvg.append('g').attr('class', 'grid').attr('transform', `translate(${m.left},0)`);
  const zeroL = chartSvg.append('line').attr('class', 'zero').attr('y1', y(0)).attr('y2', y(0));
  const axisG = chartSvg.append('g').attr('class', 'axis').attr('transform', `translate(0,${CH - m.bottom})`);
  const area = d3.area().x((d) => x(d.year)).y0((d) => y(d.low)).y1((d) => y(d.high)).curve(d3.curveMonotoneX);
  const line = d3.line().x((d) => x(d.year)).y((d) => y(d.mean)).curve(d3.curveMonotoneX);
  const bands = {}, lines = {}, ends = {};
  [['ssp126', 'var(--low)'], ['ssp585', 'var(--high)']].forEach(([f, c]) => {
    bands[f] = chartSvg.append('path').attr('fill', c).attr('opacity', 0.18);
  });
  [['ssp126', 'var(--low)'], ['ssp585', 'var(--high)']].forEach(([f, c]) => {
    lines[f] = chartSvg.append('path').attr('fill', 'none').attr('stroke', c).attr('stroke-width', 2).attr('stroke-linecap', 'round');
    ends[f] = chartSvg.append('text').attr('class', 'end-label').attr('dy', '0.32em');
  });
  const now = chartSvg.append('line').attr('class', 'now').attr('y1', m.top).attr('y2', CH - m.bottom);
  const gapLine = chartSvg.append('line').attr('class', 'gap-line');
  const gapLabel = chartSvg.append('text').attr('class', 'gap-label').attr('dy', '0.32em');
  const dots = {
    ssp126: chartSvg.append('circle').attr('class', 'dot').attr('r', 4.5).attr('fill', 'var(--low)'),
    ssp585: chartSvg.append('circle').attr('class', 'dot').attr('r', 4.5).attr('fill', 'var(--high)'),
  };
  const cross = chartSvg.append('line').attr('class', 'cross').attr('y1', m.top).attr('y2', CH - m.bottom).style('display', 'none');
  const nearestT = (px) => { const yr = x.invert(px); return d3.leastIndex(frames, (a, b) => Math.abs(a - yr) - Math.abs(b - yr)); };
  const hit = chartSvg.append('rect').attr('y', m.top).attr('height', CH - m.top - m.bottom)
    .attr('fill', 'transparent').style('cursor', 'pointer')
    .on('pointermove', (ev) => {
      const [px] = d3.pointer(ev), t = nearestT(px), p = state.place;
      cross.style('display', null).attr('x1', x(frames[t])).attr('x2', x(frames[t]));
      showTip(`<b>${periodOf(t)}</b><br>High emissions ${fmt(value('ssp585', 'mean', t, p))}<br>Low emissions ${fmt(value('ssp126', 'mean', t, p))}<br>Gap ${fmt(value('gap', 'mean', t, p))}<br>` +
        `<span class="mut">Models on the gap: ${fmt(value('gap', 'low', t, p))} to ${fmt(value('gap', 'high', t, p))}</span>`, ev);
    })
    .on('pointerleave', () => { cross.style('display', 'none'); hideTip(); })
    .on('click', (ev) => { const [px] = d3.pointer(ev); setT(nearestT(px)); });

  document.getElementById('chart-legend').innerHTML =
    `<span><i class="ln" style="background:var(--high)"></i>High emissions (SSP5-8.5)</span>` +
    `<span><i class="ln" style="background:var(--low)"></i>Low emissions (SSP1-2.6)</span>` +
    `<span><i class="bd"></i>Middle 80% of models</span>`;

  function layoutChart() {
    const w = chartEl.clientWidth;
    if (w < 10) return false;
    CW = w;
    chartSvg.attr('width', CW).attr('height', CH).attr('viewBox', `0 0 ${CW} ${CH}`);
    x.range([m.left, CW - m.right]);
    gridG.call(d3.axisLeft(y).ticks(6).tickSize(-(CW - m.left - m.right)).tickFormat((d) => `${d > 0 ? '+' : ''}${d}°`))
      .call((g) => g.selectAll('.tick text').attr('x', -6));
    zeroL.attr('x1', m.left).attr('x2', CW - m.right);
    axisG.call(d3.axisBottom(x).tickValues([2015, 2040, 2060, 2080, 2100]).tickFormat(d3.format('d')).tickSize(4));
    hit.attr('x', m.left).attr('width', CW - m.left - m.right);
    Object.values(ends).forEach((e) => e.attr('x', CW - m.right + 6));
    drawChart(false);
    return true;
  }

  function drawChart(animate) {
    const dur = animate && !document.documentElement.dataset.noAnim ? 450 : 0, p = state.place;
    ['ssp126', 'ssp585'].forEach((f) => {
      const s = series(f, p);
      bands[f].transition().duration(dur).attr('d', area(s));
      lines[f].transition().duration(dur).attr('d', line(s));
      ends[f].text(f === 'ssp585' ? 'High' : 'Low').transition().duration(dur).attr('y', y(s[nF - 1].mean));
    });
    drawNow(dur);
  }
  function drawNow(dur = 0) {
    const t = state.t, p = state.place, X = x(frames[t]);
    const hi = value('ssp585', 'mean', t, p), lo = value('ssp126', 'mean', t, p);
    now.attr('x1', X).attr('x2', X);
    dots.ssp126.transition().duration(dur).attr('cx', X).attr('cy', y(lo));
    dots.ssp585.transition().duration(dur).attr('cx', X).attr('cy', y(hi));
    gapLine.transition().duration(dur).attr('x1', X).attr('x2', X).attr('y1', y(lo)).attr('y2', y(hi));
    const nearRight = X > x(2085);
    gapLabel.text(fmt(hi - lo)).attr('text-anchor', nearRight ? 'end' : 'start')
      .transition().duration(dur).attr('x', X + (nearRight ? -9 : 9)).attr('y', y(hi) - 12 < m.top + 6 ? m.top + 6 : y(hi) - 12);
  }

  /* ---------- readout ---------- */
  function drawReadout() {
    const t = state.t, p = state.place;
    const g = value('gap', 'mean', t, p), gg = meta.global_mean.gap.mean[t];
    document.getElementById('place-name').textContent = p ? p.name : 'Global average';
    document.getElementById('hero-num').textContent = `${fmt(g)} gap`;
    const ratio = gg > 0.25 && p && p.lat != null ? ` That is ${(g / gg).toFixed(1)}× the global gap.` : '';
    document.getElementById('hero-label').textContent = `High emissions minus low emissions, ${periodOf(t)}.${ratio}`;
  }
  const mapTitles = {
    ssp126: (t) => `Low emissions (SSP1-2.6): warming by ${periodOf(t)}, compared with 1995–2014`,
    ssp585: (t) => `High emissions (SSP5-8.5): warming by ${periodOf(t)}, compared with 1995–2014`,
    gap: (t) => `Extra warming the high-emissions path adds by ${periodOf(t)}`,
  };
  function drawHeader() {
    document.getElementById('map-title').textContent = mapTitles[state.field](state.t);
    document.getElementById('period').textContent = periodOf(state.t);
    document.getElementById('slider').value = state.t;
    d3.selectAll('.seg button').attr('aria-pressed', function () { return String(this.dataset.field === state.field); });
  }

  /* ---------- controls ---------- */
  function setT(t) { state.t = t; drawHeader(); paint(); drawNow(); drawReadout(); if (hoverEv) drawMapTip(hoverEv); }
  function updatePlace(animate) {
    d3.selectAll('#chips button').attr('aria-pressed', function () {
      const here = state.place ? state.place.name : 'Global average';
      return String(this.textContent === here);
    });
    drawPin(); drawChart(animate); drawReadout();
  }
  const slider = document.getElementById('slider');
  slider.max = nF - 1;
  slider.addEventListener('input', () => { stopPlay(); setT(+slider.value); });
  d3.selectAll('.seg button').on('click', function () { state.field = this.dataset.field; drawHeader(); paint(); });
  d3.select('#chips').selectAll('button').data(places).join('button').attr('type', 'button').text((d) => d.name)
    .on('click', (ev, d) => { state.place = d.lat == null ? null : d; updatePlace(true); });

  let timer = null;
  const playBtn = document.getElementById('play');
  function stopPlay() { if (timer) { timer.stop(); timer = null; playBtn.innerHTML = '&#9654;'; playBtn.setAttribute('aria-label', 'Play through time'); } }
  playBtn.addEventListener('click', () => {
    if (timer) return stopPlay();
    if (state.t === nF - 1) setT(0);
    playBtn.innerHTML = '&#10074;&#10074;'; playBtn.setAttribute('aria-label', 'Pause');
    timer = d3.interval(() => { if (state.t >= nF - 1) return stopPlay(); setT(state.t + 1); }, 550);
  });

  /* ---------- legend and notes ---------- */
  const lg = d3.select('#legend');
  lg.append('span').attr('class', 'legend-title').text('°C of warming (blue would mean cooling)');
  lg.append('div').attr('class', 'swatches').selectAll('.swatch').data(COLORS).join('div').attr('class', 'swatch')
    .html((c, i) => `<i style="background:${c}"></i><span>${i ? TICKS[i - 1] : '&nbsp;'}</span>`);
  document.getElementById('model-count').textContent = `${meta.models.length}`;
  document.getElementById('model-list').textContent = `Models: ${meta.models.join(', ')}.`;

  /* ---------- go ---------- */
  drawHeader(); drawReadout();
  // Measure real sizes, and redo the layout whenever they change. This also covers a page that
  // loads in a hidden tab, where everything measures zero until it is first shown.
  let mapW = -1, chartW = -1, rt;
  function relayout() {
    if (mapEl.clientWidth !== mapW && layoutMap()) mapW = mapEl.clientWidth;
    if (chartEl.clientWidth !== chartW && layoutChart()) chartW = chartEl.clientWidth;
    if (mapW > 0 && chartW > 0) document.documentElement.dataset.ready = '1';
  }
  relayout();
  updatePlace(false);
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(relayout, 80); }).observe(document.body);
})().catch((err) => {
  console.error(err);
  document.querySelector('.page').insertAdjacentHTML('afterbegin', `<p role="alert"><strong>This page could not start.</strong> ${err.message}. If you opened the file directly, serve the folder over http instead.</p>`);
});
