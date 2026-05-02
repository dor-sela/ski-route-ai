(function () {
  'use strict';

  const RESORTS = {
    'val-thorens': { bbox: '45.27,6.55,45.32,6.61' },
    bansko: { bbox: '41.79,23.43,41.84,23.48' },
    zermatt: { bbox: '45.98,7.70,46.03,7.77' },
  };

  const RESORT_DATA_FILES = {
    'val-thorens': './data/val_thorens.json',
    bansko: './data/bansko.json',
    zermatt: './data/zermatt.json',
  };

  /** Extra OSM lodging extract for Val Thorens — base ski JSON omits many tourism-tagged hotels on buildings */
  const VAL_THORENS_LODGING_OVERLAY_URL = './data/val_thorens_lodging_overlay.json';

  async function mergeLodgingElementsForMap(mainElements, resortValue) {
    if (resortValue !== 'val-thorens') return mainElements;
    try {
      const r = await fetch(VAL_THORENS_LODGING_OVERLAY_URL);
      if (!r.ok) return mainElements;
      const ov = await r.json();
      const extra = ov.elements || [];
      if (!extra.length) return mainElements;
      return mainElements.concat(extra);
    } catch (err) {
      console.warn('Val Thorens lodging overlay:', err);
      return mainElements;
    }
  }

  const ROUTE_MODE = { SKI_FORWARD: 'ski', LIFT_RETURN: 'lift' };

  /** Lodging tags — nodes & ways from OSM extract (expand to surface every hotel-like POI in JSON). */
  const LODGING_TOURISM_TAGS = [
    'hotel',
    'motel',
    'guest_house',
    'hostel',
    'alpine_hut',
    'chalet',
    'apartments',
    'apartment',
    'camp_site',
    'caravan_site',
    'wilderness_hut',
    'homestay',
    'resort',
  ];

  function normTag(v) {
    return v != null ? String(v).toLowerCase().trim() : '';
  }

  function tagsSuggestLodging(tags) {
    if (!tags) return false;
    const tourism = normTag(tags.tourism);
    if (tourism && LODGING_TOURISM_TAGS.indexOf(tourism) !== -1) return true;
    const amenity = normTag(tags.amenity);
    if (amenity === 'hotel' || amenity === 'motel') return true;
    const building = normTag(tags.building);
    if (building === 'hotel') return true;
    return false;
  }

  /**
   * Graph POIs from JSON (distinct from routable intersection nodes).
   * Includes standalone nodes and lodging ways (centroid of geometry).
   */
  function collectLodgingMarkersFromElements(elements) {
    const out = [];
    const seenPos = new Set();
    function tryAdd(lat, lon, tags) {
      if (lat == null || lon == null) return;
      const dedupeKey =
        lat.toFixed(5) + ',' + lon.toFixed(5) + '|' + normTag(tags && tags.name);
      if (seenPos.has(dedupeKey)) return;
      seenPos.add(dedupeKey);
      const label =
        tags && tags.name != null && String(tags.name).trim() !== ''
          ? String(tags.name)
          : 'Hotel';
      out.push({ lat: lat, lon: lon, tags: tags, label: label });
    }

    if (!elements || !elements.length) return out;

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (!el.tags || !tagsSuggestLodging(el.tags)) continue;

      if (el.type === 'node') {
        tryAdd(el.lat, el.lon, el.tags);
      } else if (el.type === 'way' && tagsSuggestLodging(el.tags)) {
        let lat;
        let lon;
        if (el.geometry && el.geometry.length >= 2) {
          let sumLat = 0;
          let sumLon = 0;
          const g = el.geometry;
          for (let k = 0; k < g.length; k++) {
            sumLat += g[k].lat;
            sumLon += g[k].lon;
          }
          lat = sumLat / g.length;
          lon = sumLon / g.length;
        } else if (el.center && el.center.lat != null && el.center.lon != null) {
          lat = el.center.lat;
          lon = el.center.lon;
        }
        if (lat != null && lon != null) tryAdd(lat, lon, el.tags);
      }
    }
    return out;
  }

  function pisteColor(tag) {
    const t = String(tag).toLowerCase();
    if (t.includes('novice') || t === 'easy' || t.includes('beginner') || t === 'elementary')
      return '#22c55e';
    if (t === 'intermediate') return '#3b82f6';
    if (t === 'advanced') return '#ef4444';
    if (t.includes('expert') || t === 'extreme' || t.includes('freeride')) return '#171717';
    return '#3b82f6';
  }

  function roundKey(lat, lng) {
    return lat.toFixed(6) + ',' + lng.toFixed(6);
  }

  function parseKey(key) {
    const parts = key.split(',');
    return { lat: Number(parts[0]), lng: Number(parts[1]) };
  }

  function haversineM(a, b) {
    const R = 6371000;
    const toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR;
    const dLng = (b.lng - a.lng) * toR;
    const la1 = a.lat * toR;
    const la2 = b.lat * toR;
    const h =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** OSM nodes that carry ele=* — used only for coarse altitude hints in UI messages */
  let cachedEleSamples = [];

  function rebuildEleSamplesFromElements(elements) {
    cachedEleSamples = [];
    if (!elements || !elements.length) return;
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (el.type !== 'node' || !el.tags || el.lat == null || el.lon == null) continue;
      const raw = el.tags.ele;
      if (raw == null || String(raw).trim() === '') continue;
      const z = parseFloat(String(raw).replace(/[^0-9.\-]/g, ''));
      if (!Number.isFinite(z)) continue;
      cachedEleSamples.push({ lat: el.lat, lng: el.lon, z: z });
    }
  }

  function approximateElevationM(lat, lng) {
    if (!cachedEleSamples.length || lat == null || lng == null) return null;
    const pt = { lat: lat, lng: lng };
    let bestZ = null;
    let bestD = Infinity;
    for (let i = 0; i < cachedEleSamples.length; i++) {
      const s = cachedEleSamples[i];
      const d = haversineM(pt, { lat: s.lat, lng: s.lng });
      if (d < bestD && d < 900) {
        bestD = d;
        bestZ = s.z;
      }
    }
    return bestZ;
  }

  function segmentLengthM(coords, fromIdx, toIdx) {
    let d = 0;
    for (let i = fromIdx; i < toIdx; i++) {
      d += haversineM(coords[i], coords[i + 1]);
    }
    return d;
  }

  function pisteTierFromTag(tag) {
    if (!tag) return 'blue';
    const t = String(tag).toLowerCase();
    if (t.includes('novice') || t === 'easy' || t.includes('beginner') || t === 'elementary')
      return 'green';
    if (t === 'intermediate') return 'blue';
    if (t === 'advanced') return 'red';
    if (t.includes('expert') || t === 'extreme' || t.includes('freeride')) return 'black';
    return 'blue';
  }

  function skillOrdinal(skill) {
    switch (skill) {
      case 'never':
      case 'first-week':
        return 0;
      case 'low-intermediate':
        return 1;
      case 'high-intermediate':
        return 2;
      case 'advanced':
      case 'expert':
        return 3;
      default:
        return 1;
    }
  }

  function tierOrdinal(tier) {
    const o = { green: 0, blue: 1, red: 2, black: 3 };
    return o[tier] != null ? o[tier] : 1;
  }

  /**
   * Forward ski routing: base weight = geographic distance (meters).
   * Goal-specific skill gates: pistes above allowed tier → Infinity.
   * Rewards steer Dijkstra toward matching difficulties.
   */
  function skiForwardEdgeWeight(edge, skill, goal) {
    const d = edge.lengthM;
    if (edge.isLift) {
      return d * 2.5;
    }

    const tier = pisteTierFromTag(edge.difficulty);
    const T = tierOrdinal(tier);
    const S = skillOrdinal(skill);
    const G = String(goal);

    if (G === 'Comfort') {
      if (T > S) return Infinity;
      if (T === S) return d * 0.08;
      return d * 1;
    }
    if (G === 'Progression') {
      if (T >= S + 2) return Infinity;
      if (T === S + 1) return d * 0.04;
      if (T === S) return d * 0.35;
      return d * 1.15;
    }
    if (G === 'Relaxed') {
      if (T > S) return Infinity;
      if (tier === 'green' || tier === 'blue') return d * 0.1;
      if (tier === 'red') return d * 8;
      return d * 40;
    }
    if (T > S) return Infinity;
    return d;
  }

  /** Return trip: reward lifts, penalize downhill pistes. */
  function liftReturnEdgeWeight(edge) {
    let w = edge.lengthM;
    if (edge.isLift) w *= 0.01;
    else w *= 1000;
    return w;
  }

  function edgeWeight(edge, mode, skill, goal) {
    if (mode === ROUTE_MODE.LIFT_RETURN) return liftReturnEdgeWeight(edge);
    return skiForwardEdgeWeight(edge, skill, goal);
  }

  function buildAdjacency(ways) {
    const keyToWays = new Map();
    const endpointKeys = new Set();

    function addWayPoint(wayId, key) {
      if (!keyToWays.has(key)) keyToWays.set(key, new Set());
      keyToWays.get(key).add(wayId);
    }

    const prepared = ways.map(function (w) {
      const geom = w.geometry || [];
      const fullLatLng = geom.map(function (g) {
        return [g.lat, g.lon];
      });
      const coords = geom.map(function (g) {
        return { lat: g.lat, lng: g.lon };
      });
      const keys = coords.map(function (c) {
        return roundKey(c.lat, c.lng);
      });
      if (keys.length) {
        endpointKeys.add(keys[0]);
        endpointKeys.add(keys[keys.length - 1]);
      }
      keys.forEach(function (k) {
        addWayPoint(w.id, k);
      });
      const isLift = !!(w.tags && w.tags.aerialway);
      const name =
        (w.tags && (w.tags.name || w.tags['piste:name'] || w.tags.ref)) ||
        (isLift ? 'Lift' : 'Unnamed piste');
      const difficulty = w.tags && w.tags['piste:difficulty'];
      return { coords, fullLatLng, keys, isLift, name, difficulty, w };
    });

    const nodeKeys = new Set();
    keyToWays.forEach(function (set, key) {
      if (set.size > 1 || endpointKeys.has(key)) nodeKeys.add(key);
    });

    const adj = new Map();
    function addUndirected(u, v, edgeObj) {
      if (!adj.has(u)) adj.set(u, []);
      if (!adj.has(v)) adj.set(v, []);
      adj.get(u).push({ node: v, edge: edgeObj });
      adj.get(v).push({ node: u, edge: edgeObj });
    }

    prepared.forEach(function (row) {
      const keys = row.keys;
      const coords = row.coords;
      const fullLatLng = row.fullLatLng;
      let lastNodeIdx = -1;
      for (let i = 0; i < keys.length; i++) {
        if (!nodeKeys.has(keys[i])) continue;
        if (lastNodeIdx >= 0) {
          const seg = segmentLengthM(coords, lastNodeIdx, i);
          if (seg > 0) {
            const u = keys[lastNodeIdx];
            const v = keys[i];
            const segmentCoords = fullLatLng.slice(lastNodeIdx, i + 1);
            addUndirected(u, v, {
              from: u,
              to: v,
              coords: segmentCoords,
              lengthM: seg,
              isLift: row.isLift,
              name: row.name,
              difficulty: row.isLift ? null : row.difficulty,
              wayId: row.w.id,
              downhillFrom: row.isLift ? null : u,
              downhillTo: row.isLift ? null : v,
            });
          }
        }
        lastNodeIdx = i;
      }
    });

    return { adj, nodeKeys };
  }

  /**
   * Dijkstra on adjacency graph.
   * @param enforceDownhillSki When true (ski-forward mode only): pistes traverse only downhillFrom→downhillTo along OSM geometry; lifts bidirectional.
   * @returns {{ pathNodes: string[], pathEdges: object[], totalCost: number } | null}
   */
  function dijkstra(adj, start, end, weightFn, enforceDownhillSki) {
    const nodes = Array.from(adj.keys());
    const dist = new Map();
    const prev = new Map();
    const prevEdge = new Map();
    const visited = new Set();

    nodes.forEach(function (n) {
      dist.set(n, Infinity);
    });
    dist.set(start, 0);

    while (visited.size < nodes.length) {
      let u = null;
      let best = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (visited.has(n)) continue;
        const dn = dist.get(n);
        if (dn < best) {
          best = dn;
          u = n;
        }
      }
      if (u === null || best === Infinity) break;
      visited.add(u);
      if (u === end) break;

      const outs = adj.get(u) || [];
      for (let j = 0; j < outs.length; j++) {
        const v = outs[j].node;
        const edge = outs[j].edge;
        if (visited.has(v)) continue;
        if (enforceDownhillSki && edge.downhillFrom != null && edge.downhillFrom !== u) continue;
        const w = weightFn(edge);
        if (!Number.isFinite(w) || w === Infinity) continue;
        const alt = dist.get(u) + w;
        if (alt < dist.get(v)) {
          dist.set(v, alt);
          prev.set(v, u);
          prevEdge.set(v, edge);
        }
      }
    }

    const totalCost = dist.get(end);
    if (!Number.isFinite(totalCost) || totalCost === Infinity) return null;

    const pathNodes = [];
    const pathEdges = [];
    let cur = end;
    pathNodes.push(cur);
    while (cur !== start) {
      const e = prevEdge.get(cur);
      const p = prev.get(cur);
      if (!e || p === undefined) return null;
      pathEdges.push(e);
      pathNodes.push(p);
      cur = p;
    }
    pathNodes.reverse();
    pathEdges.reverse();
    return { pathNodes: pathNodes, pathEdges: pathEdges, totalCost: totalCost };
  }

  function routeShortest(adj, start, end, mode, skill, goal) {
    const enforceDownhill = mode === ROUTE_MODE.SKI_FORWARD;
    return dijkstra(
      adj,
      start,
      end,
      function (edge) {
        return edgeWeight(edge, mode, skill, goal);
      },
      enforceDownhill
    );
  }

  /** Directed downhill connectivity ignoring skill penalties — detects “blocked by skill” vs “no downhill path”. */
  function skiConnectivityEdgeWeight(edge) {
    return edge.lengthM;
  }

  function routePhysicalSkiConnectivity(adj, start, end) {
    return dijkstra(adj, start, end, skiConnectivityEdgeWeight, true);
  }

  function routePolylineFromPath(pathNodes, pathEdges) {
    const pts = [];
    function samePt(a, b) {
      return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
    }
    for (let j = 0; j < pathEdges.length; j++) {
      const e = pathEdges[j];
      const a = pathNodes[j];
      const b = pathNodes[j + 1];
      let seg = e.coords;
      if (!seg || seg.length < 2) continue;
      if (e.from === b && e.to === a) seg = seg.slice().reverse();
      if (pts.length === 0) {
        for (let k = 0; k < seg.length; k++) pts.push(seg[k]);
      } else {
        const skip = samePt(pts[pts.length - 1], seg[0]) ? 1 : 0;
        for (let k = skip; k < seg.length; k++) pts.push(seg[k]);
      }
    }
    return pts;
  }

  let map;
  let waysLayerGroup;
  let nodesLayerGroup;
  let hotelsLayerGroup;
  let selectionLabelsLayer;
  let forwardPolyline;
  let returnPolyline;
  /** @type {Map<string, L.CircleMarker>} */
  let nodeMarkers = new Map();

  let startNode = null;
  let endNode = null;
  let currentAdj = { adj: new Map(), nodeKeys: new Set() };
  let activeRouteView = 'forward';
  /** @type {{ pathNodes: string[], pathEdges: object[] } | null} */
  let lastForwardPath = null;
  /** @type {{ pathNodes: string[], pathEdges: object[] } | null} */
  let lastReturnPath = null;
  /** null | 'skill' | 'uphill' — primary forward poly uses lifts-only cyan when non-null */
  let lastForwardLiftReason = null;
  /** @type {L.CircleMarker | null} */
  let activeNodeHighlight = null;

  const el = {
    loading: document.getElementById('loading-banner'),
    resort: document.getElementById('resort'),
    skill: document.getElementById('skill'),
    goal: document.getElementById('goal'),
    findBtn: document.getElementById('find-route'),
    resetBtn: document.getElementById('reset-search'),
    forwardHeader: document.getElementById('forward-header'),
    forwardHeaderTitle: document.getElementById('forward-header-title'),
    forwardRouteWarning: document.getElementById('forward-route-warning'),
    returnHeader: document.getElementById('return-header'),
    forwardList: document.getElementById('forward-list'),
    returnList: document.getElementById('return-list'),
  };

  function setLoading(on) {
    el.loading.classList.toggle('hidden', !on);
  }

  function getBboxBoundsLiteral(bboxStr) {
    const p = bboxStr.split(',').map(Number);
    return [
      [p[0], p[1]],
      [p[2], p[3]],
    ];
  }

  function ensureRouteLabelCss() {
    if (document.getElementById('ski-agent-route-css')) return;
    const st = document.createElement('style');
    st.id = 'ski-agent-route-css';
    st.textContent =
      '.leaflet-tooltip.route-label-start{' +
      'font-weight:700;color:#16a34a;background:#fff;padding:0.25rem 0.5rem;' +
      'border-radius:0.25rem;border:1px solid #e2e8f0;}' +
      '.leaflet-tooltip.route-label-end{' +
      'font-weight:700;color:#dc2626;background:#fff;padding:0.25rem 0.5rem;' +
      'border-radius:0.25rem;border:1px solid #e2e8f0;}' +
      '.ski-hotel-star-wrap{background:transparent!important;border:none!important;' +
      'font-size:18px;line-height:18px;text-align:center;text-shadow:0 1px 3px rgba(0,0,0,.7);}' +
      '.leaflet-tooltip.ski-hotel-tip{' +
      'font-size:11px;font-weight:600;background:#fffbeb;color:#7c2d12;padding:2px 6px;' +
      'border:1px solid #f59e0b;border-radius:3px;}' +
      '.forward-route-warning{margin:6px 0 8px;padding:10px 12px;font-size:12px;line-height:1.45;' +
      'border-radius:6px;font-weight:600;}' +
      '.forward-route-warning.forward-route-warning--skill{' +
      'border:2px solid rgba(254,202,202,.95);background:rgba(153,27,27,.96);color:#fff;' +
      'box-shadow:0 0 0 1px rgba(0,0,0,.35);}' +
      '.forward-route-warning.forward-route-warning--uphill{' +
      'border:2px solid rgba(251,191,36,.65);background:rgba(120,53,15,.88);color:#fef3c7;}';
    document.head.appendChild(st);
  }

  /** Node click radius scales with zoom so they stay easy to click when zoomed in. */
  function nodeRadiusForZoom(z) {
    if (!Number.isFinite(z)) return 4;
    if (z >= 17) return 9;
    if (z >= 16) return 8;
    if (z >= 15) return 6;
    if (z >= 14) return 5;
    return 4;
  }

  function applyGraphNodeRadiiFromZoom() {
    if (!map || !nodeMarkers.size) return;
    const r = nodeRadiusForZoom(map.getZoom());
    nodeMarkers.forEach(function (cm) {
      cm.setRadius(r);
    });
  }

  /** Lodging markers from JSON (nodes + lodging ways centroid); ★ + hover tooltip. */
  function drawHotelMarkersFromElements(elements) {
    if (!hotelsLayerGroup) return;
    hotelsLayerGroup.clearLayers();

    const starIcon = L.divIcon({
      className: 'ski-hotel-star-wrap',
      html: '<span style="color:#fbbf24;">★</span>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });

    const markers = collectLodgingMarkersFromElements(elements);
    for (let i = 0; i < markers.length; i++) {
      const row = markers[i];
      const marker = L.marker([row.lat, row.lon], { icon: starIcon, interactive: true });
      marker.bindTooltip(row.label, {
        direction: 'top',
        sticky: false,
        className: 'ski-hotel-tip',
        offset: [0, -6],
      });
      marker.addTo(hotelsLayerGroup);
    }
  }

  function setForwardRouteUi(liftReason, elevationClause) {
    const skill = liftReason === 'skill';
    const uphill = liftReason === 'uphill';

    if (el.forwardHeaderTitle) {
      if (skill) {
        el.forwardHeaderTitle.textContent = '🚠 Lifts Route — Above Your Skill Settings';
      } else if (uphill) {
        el.forwardHeaderTitle.textContent = '🚠 Uphill Lifts Route';
      } else {
        el.forwardHeaderTitle.textContent = 'Forward Route';
      }
    }

    if (el.forwardRouteWarning) {
      el.forwardRouteWarning.classList.remove('forward-route-warning--skill', 'forward-route-warning--uphill');
      if (skill) {
        el.forwardRouteWarning.innerHTML =
          '<strong>No downhill ski route matches your skill level / route goal</strong> between these markers — ' +
          'every reachable ski connection here is rated above what we allow for your choices. ' +
          '<strong>Showing lifts only</strong> so you can still move across the resort.';
        el.forwardRouteWarning.classList.add('forward-route-warning--skill');
        el.forwardRouteWarning.classList.remove('hidden');
      } else if (uphill) {
        let txt =
          '<strong>No downhill ski route</strong> from Start to End along pistes (given slope direction). ' +
          '<strong>This cyan route uses lifts — it is mainly an ascent</strong> toward your destination.';
        if (elevationClause) {
          txt += ' ' + elevationClause;
        }
        el.forwardRouteWarning.innerHTML = txt;
        el.forwardRouteWarning.classList.add('forward-route-warning--uphill');
        el.forwardRouteWarning.classList.remove('hidden');
      } else {
        el.forwardRouteWarning.innerHTML = '';
        el.forwardRouteWarning.textContent = '';
        el.forwardRouteWarning.classList.add('hidden');
      }
    }
  }

  function resortBboxString() {
    return RESORTS[el.resort.value].bbox;
  }

  function fitResortBounds() {
    map.fitBounds(getBboxBoundsLiteral(resortBboxString()), { padding: [24, 24] });
  }

  function initMap() {
    ensureRouteLabelCss();
    map = L.map('map', { zoomControl: true });

    L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
      maxZoom: 22,
      maxNativeZoom: 17,
    }).addTo(map);

    L.tileLayer('https://tile.waymarkedtrails.org/slopes/{z}/{x}/{y}.png', {
      maxZoom: 22,
      maxNativeZoom: 17,
      opacity: 0.65,
    }).addTo(map);

    waysLayerGroup = L.layerGroup().addTo(map);
    nodesLayerGroup = L.layerGroup().addTo(map);
    hotelsLayerGroup = L.layerGroup().addTo(map);
    selectionLabelsLayer = L.layerGroup().addTo(map);

    map.on('zoomend', applyGraphNodeRadiiFromZoom);
    map.whenReady(applyGraphNodeRadiiFromZoom);
  }

  function refreshStartEndLabels() {
    selectionLabelsLayer.clearLayers();
    if (startNode) {
      const p = parseKey(startNode);
      const m = L.circleMarker([p.lat, p.lng], {
        radius: 12,
        fillColor: '#22c55e',
        color: '#ffffff',
        weight: 2,
        fillOpacity: 0.95,
        interactive: false,
      });
      m.bindTooltip('START', {
        permanent: true,
        direction: 'top',
        className: 'route-label-start font-bold text-green-600 bg-white px-2 py-1 rounded',
      });
      m.addTo(selectionLabelsLayer);
    }
    if (endNode) {
      const p = parseKey(endNode);
      const m = L.circleMarker([p.lat, p.lng], {
        radius: 12,
        fillColor: '#ef4444',
        color: '#ffffff',
        weight: 2,
        fillOpacity: 0.95,
        interactive: false,
      });
      m.bindTooltip('END', {
        permanent: true,
        direction: 'top',
        className: 'route-label-end font-bold text-red-600 bg-white px-2 py-1 rounded',
      });
      m.addTo(selectionLabelsLayer);
    }
  }

  function clearRouteLayers() {
    if (forwardPolyline) {
      map.removeLayer(forwardPolyline);
      forwardPolyline = null;
    }
    if (returnPolyline) {
      map.removeLayer(returnPolyline);
      returnPolyline = null;
    }
  }

  function clearActiveNodeHighlight() {
    if (activeNodeHighlight) {
      map.removeLayer(activeNodeHighlight);
      activeNodeHighlight = null;
    }
  }

  function highlightRouteListNode(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    clearActiveNodeHighlight();
    activeNodeHighlight = L.circleMarker([lat, lng], {
      radius: 8,
      color: '#ff7800',
      weight: 3,
      fillColor: '#ffff00',
      fillOpacity: 1,
    }).addTo(map);
    if (typeof activeNodeHighlight.bringToFront === 'function') {
      activeNodeHighlight.bringToFront();
    }
  }

  function redrawNodeMarkers() {
    nodesLayerGroup.clearLayers();
    nodeMarkers = new Map();
    const nodeKeys = currentAdj.nodeKeys || new Set();
    const r = map ? nodeRadiusForZoom(map.getZoom()) : 4;
    nodeKeys.forEach(function (key) {
      const p = parseKey(key);
      const cm = L.circleMarker([p.lat, p.lng], {
        radius: r,
        color: '#334155',
        weight: 1,
        fillColor: '#94a3b8',
        fillOpacity: 0.9,
      });
      cm.on('click', function (ev) {
        L.DomEvent.stopPropagation(ev);
        if (!startNode) {
          startNode = key;
          updateStartEndStyles();
        } else if (!endNode && key !== startNode) {
          endNode = key;
          updateStartEndStyles();
        } else if (key === startNode || key === endNode) {
          if (key === endNode) endNode = null;
          else {
            startNode = key;
            endNode = null;
          }
          updateStartEndStyles();
        } else {
          endNode = key;
          updateStartEndStyles();
        }
      });
      cm.addTo(nodesLayerGroup);
      nodeMarkers.set(key, cm);
    });
    applyGraphNodeRadiiFromZoom();
    updateStartEndStyles();
  }

  function updateStartEndStyles() {
    nodeMarkers.forEach(function (m, key) {
      let fill = '#94a3b8';
      let stroke = '#334155';
      if (key === startNode) {
        fill = '#22c55e';
        stroke = '#14532d';
      } else if (key === endNode) {
        fill = '#ef4444';
        stroke = '#7f1d1d';
      }
      m.setStyle({ fillColor: fill, color: stroke });
    });
    refreshStartEndLabels();
  }

  function drawOriginalWays(ways) {
    waysLayerGroup.clearLayers();
    ways.forEach(function (w) {
      const geom = w.geometry || [];
      if (geom.length < 2) return;
      const latlngs = geom.map(function (g) {
        return [g.lat, g.lon];
      });
      const isLift = !!(w.tags && w.tags.aerialway);
      const diff = w.tags && w.tags['piste:difficulty'];
      const opt = isLift
        ? { color: '#64748b', weight: 2, dashArray: '6 6', opacity: 0.9 }
        : { color: pisteColor(diff), weight: 3, opacity: 0.85 };
      L.polyline(latlngs, opt).addTo(waysLayerGroup);
    });
  }

  async function fetchResortData() {
    const url = RESORT_DATA_FILES[el.resort.value];
    if (!url) throw new Error('Unknown resort data file');
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to load: ' + response.status);
    const data = await response.json();
    return data.elements || [];
  }

  function rebuildGraph(ways) {
    const built = buildAdjacency(ways);
    currentAdj = { adj: built.adj, nodeKeys: built.nodeKeys };
    drawOriginalWays(ways);
    redrawNodeMarkers();
  }

  function polylineLatLngsFromPath(path) {
    if (!path || !path.pathNodes) return [];
    let latlngs = routePolylineFromPath(path.pathNodes, path.pathEdges || []);
    if (latlngs.length < 2 && path.pathNodes.length) {
      latlngs = path.pathNodes.map(function (k) {
        const p = parseKey(k);
        return [p.lat, p.lng];
      });
    }
    return latlngs;
  }

  function showForwardPolyline() {
    if (!lastForwardPath) return;
    activeRouteView = 'forward';
    if (returnPolyline) {
      map.removeLayer(returnPolyline);
      returnPolyline = null;
    }
    const latlngs = polylineLatLngsFromPath(lastForwardPath);
    if (forwardPolyline) map.removeLayer(forwardPolyline);
    forwardPolyline = L.polyline(latlngs, {
      color: lastForwardLiftReason ? 'cyan' : 'yellow',
      weight: 8,
      opacity: 0.6,
    }).addTo(map);
  }

  function showReturnPolyline() {
    if (!lastReturnPath) return;
    activeRouteView = 'return';
    if (forwardPolyline) {
      map.removeLayer(forwardPolyline);
      forwardPolyline = null;
    }
    const latlngs = polylineLatLngsFromPath(lastReturnPath);
    if (returnPolyline) map.removeLayer(returnPolyline);
    returnPolyline = L.polyline(latlngs, {
      color: 'cyan',
      weight: 8,
      opacity: 0.6,
    }).addTo(map);
  }

  function clearLists() {
    el.forwardList.innerHTML = '';
    el.returnList.innerHTML = '';
  }

  function appendFlyLi(ul, text, lat, lng) {
    const li = document.createElement('li');
    li.textContent = text;
    li.dataset.lat = String(lat);
    li.dataset.lng = String(lng);
    ul.appendChild(li);
  }

  function bindForwardListFlyTo() {
    el.forwardList.querySelectorAll('li[data-lat]').forEach(function (li) {
      li.addEventListener('click', function (e) {
        e.stopPropagation();
        showForwardPolyline();
        const lat = parseFloat(li.dataset.lat);
        const lng = parseFloat(li.dataset.lng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          map.flyTo([lat, lng], 17);
          highlightRouteListNode(lat, lng);
        }
      });
    });
  }

  function pathToListItems(pathResult, ul, skipClear) {
    if (!skipClear) ul.innerHTML = '';
    if (!pathResult || !pathResult.pathNodes || !pathResult.pathNodes.length) return;
    const pathNodes = pathResult.pathNodes;
    const pathEdges = pathResult.pathEdges || [];
    const st = parseKey(pathNodes[0]);
    appendFlyLi(ul, '1. Start', st.lat, st.lng);
    for (let j = 0; j < pathEdges.length; j++) {
      const e = pathEdges[j];
      const dest = parseKey(pathNodes[j + 1]);
      const prefix = e.isLift ? 'Lift' : 'Piste';
      appendFlyLi(ul, j + 2 + '. ' + prefix + ': ' + e.name, dest.lat, dest.lng);
    }
    const en = parseKey(pathNodes[pathNodes.length - 1]);
    appendFlyLi(ul, pathEdges.length + 2 + '. End', en.lat, en.lng);
  }

  function runFindRoute() {
    if (!startNode || !endNode) {
      alert('Select a start node and an end node on the map (two clicks).');
      return;
    }
    const adj = currentAdj.adj;
    if (!adj || adj.size === 0) {
      alert('No graph data yet. Wait for loading or pick another resort.');
      return;
    }

    clearActiveNodeHighlight();
    clearRouteLayers();
    clearLists();
    lastForwardLiftReason = null;
    setForwardRouteUi(null);

    const skill = el.skill.value;
    const goal = el.goal.value;

    const skiForward = routeShortest(
      adj,
      startNode,
      endNode,
      ROUTE_MODE.SKI_FORWARD,
      skill,
      goal
    );
    const physicalSki = routePhysicalSkiConnectivity(adj, startNode, endNode);
    const liftForward = routeShortest(
      adj,
      startNode,
      endNode,
      ROUTE_MODE.LIFT_RETURN,
      skill,
      goal
    );
    const ret = routeShortest(adj, endNode, startNode, ROUTE_MODE.LIFT_RETURN, skill, goal);

    let primaryForward = skiForward;
    let elevClauseHtml = '';

    if (skiForward) {
      primaryForward = skiForward;
      lastForwardLiftReason = null;
    } else if (liftForward) {
      primaryForward = liftForward;
      if (physicalSki) {
        lastForwardLiftReason = 'skill';
      } else {
        lastForwardLiftReason = 'uphill';
        const ps = parseKey(startNode);
        const pe = parseKey(endNode);
        const zs = approximateElevationM(ps.lat, ps.lng);
        const ze = approximateElevationM(pe.lat, pe.lng);
        if (zs != null && ze != null && zs + 25 < ze) {
          elevClauseHtml =
            '<strong>Height hint from nearby OSM survey points:</strong> Start ~' +
            Math.round(zs) +
            ' m vs End ~' +
            Math.round(ze) +
            ' m — <strong>your Start is lower than your End</strong>, so this route climbs uphill by lifts.';
        }
      }
    } else {
      primaryForward = null;
      lastForwardLiftReason = null;
    }

    lastForwardPath = primaryForward
      ? { pathNodes: primaryForward.pathNodes, pathEdges: primaryForward.pathEdges }
      : null;
    lastReturnPath = ret ? { pathNodes: ret.pathNodes, pathEdges: ret.pathEdges } : null;

    activeRouteView = 'forward';
    setForwardRouteUi(lastForwardLiftReason, elevClauseHtml);

    if (lastForwardPath) {
      el.forwardList.innerHTML = '';
      if (lastForwardLiftReason === 'skill') {
        const msgLi = document.createElement('li');
        msgLi.textContent =
          'No downhill ski route matches your skill level and route goal — pistes along reachable paths are too difficult for what you selected. Below is a lifts-only route along Start→End.';
        msgLi.style.marginBottom = '0.65rem';
        msgLi.style.padding = '8px 10px';
        msgLi.style.borderRadius = '6px';
        msgLi.style.background = 'rgba(127,29,29,.55)';
        msgLi.style.border = '1px solid rgba(248,113,113,.55)';
        msgLi.style.color = '#fecaca';
        msgLi.style.fontWeight = '700';
        msgLi.style.listStyle = 'none';
        el.forwardList.appendChild(msgLi);
        pathToListItems(lastForwardPath, el.forwardList, true);
      } else if (lastForwardLiftReason === 'uphill') {
        const msgLi = document.createElement('li');
        msgLi.textContent =
          'No downhill ski route along pistes from Start to End (slope directions). Below is lifts-only — mainly uphill toward your destination.';
        msgLi.style.marginBottom = '0.65rem';
        msgLi.style.color = '#fcd34d';
        msgLi.style.fontStyle = 'italic';
        msgLi.style.fontWeight = '600';
        msgLi.style.listStyle = 'none';
        el.forwardList.appendChild(msgLi);
        pathToListItems(lastForwardPath, el.forwardList, true);
      } else {
        pathToListItems(lastForwardPath, el.forwardList, false);
      }
      bindForwardListFlyTo();
      showForwardPolyline();
    } else {
      const li = document.createElement('li');
      if (!physicalSki && !liftForward) {
        li.textContent =
          'No route found between these markers (no downhill ski graph connection and no lifts-only connection). Try different junctions.';
      } else if (physicalSki && !liftForward) {
        li.textContent =
          'Downhill paths exist for routing geometry but no lifts-only route was found between these markers.';
      } else {
        li.textContent = 'No route found between these markers.';
      }
      el.forwardList.appendChild(li);
    }

    el.returnList.innerHTML = '';
    if (lastForwardLiftReason === 'skill') {
      const note = document.createElement('li');
      note.textContent =
        'Return Trip: lifts from End back toward Start (shown below when available). Forward above stays lifts-only because your skill settings block pistes.';
      note.style.marginBottom = '0.5rem';
      note.style.color = '#bae6fd';
      note.style.listStyle = 'none';
      el.returnList.appendChild(note);
      if (lastReturnPath) pathToListItems(lastReturnPath, el.returnList, true);
      else {
        const li = document.createElement('li');
        li.textContent = 'No return route via lifts found.';
        el.returnList.appendChild(li);
      }
    } else if (lastForwardLiftReason === 'uphill') {
      const note = document.createElement('li');
      note.textContent =
        'Return Trip mirrors the usual lifts-back pattern (End→Start). Forward above is lifts-only uphill along your Start→End choice.';
      note.style.marginBottom = '0.5rem';
      note.style.color = '#bae6fd';
      note.style.listStyle = 'none';
      el.returnList.appendChild(note);
      if (lastReturnPath) pathToListItems(lastReturnPath, el.returnList, true);
      else {
        const li = document.createElement('li');
        li.textContent = 'No return route via lifts found.';
        el.returnList.appendChild(li);
      }
    } else if (lastReturnPath) {
      pathToListItems(lastReturnPath, el.returnList, false);
    } else {
      const li = document.createElement('li');
      li.textContent = 'No return route via lifts found.';
      el.returnList.appendChild(li);
    }
  }

  function resetSearch() {
    startNode = null;
    endNode = null;
    selectionLabelsLayer.clearLayers();
    updateStartEndStyles();
    clearActiveNodeHighlight();
    clearRouteLayers();
    clearLists();
    lastForwardPath = null;
    lastReturnPath = null;
    lastForwardLiftReason = null;
    activeRouteView = 'forward';
    setForwardRouteUi(null);
    fitResortBounds();
  }

  async function loadResortData() {
    setLoading(true);
    startNode = null;
    endNode = null;
    selectionLabelsLayer.clearLayers();
    if (hotelsLayerGroup) hotelsLayerGroup.clearLayers();
    clearActiveNodeHighlight();
    clearRouteLayers();
    clearLists();
    lastForwardPath = null;
    lastReturnPath = null;
    lastForwardLiftReason = null;
    activeRouteView = 'forward';
    setForwardRouteUi(null);
    try {
      const elements = await fetchResortData();
      const lodgingMerge = await mergeLodgingElementsForMap(elements, el.resort.value);
      rebuildEleSamplesFromElements(lodgingMerge);
      const ways = elements.filter(function (e) {
        return e.type === 'way' && e.geometry && e.geometry.length >= 2;
      });
      rebuildGraph(ways);
      drawHotelMarkersFromElements(lodgingMerge);
      fitResortBounds();
    } catch (err) {
      console.error(err);
      alert('Failed to load ski data: ' + (err.message || String(err)));
    } finally {
      setLoading(false);
    }
  }

  el.findBtn.addEventListener('click', runFindRoute);
  el.resetBtn.addEventListener('click', resetSearch);

  el.forwardHeader.addEventListener('click', showForwardPolyline);

  el.returnHeader.addEventListener('click', showReturnPolyline);

  el.returnList.addEventListener('click', function (e) {
    const li = e.target.closest('li');
    showReturnPolyline();
    if (li && li.dataset.lat != null && li.dataset.lng != null) {
      const la = parseFloat(li.dataset.lat);
      const ln = parseFloat(li.dataset.lng);
      if (Number.isFinite(la) && Number.isFinite(ln)) {
        map.flyTo([la, ln], 17);
        highlightRouteListNode(la, ln);
      }
    }
  });

  el.resort.addEventListener('change', function () {
    resetSearch();
    loadResortData();
  });

  initMap();
  fitResortBounds();
  requestAnimationFrame(function () {
    map.invalidateSize();
  });
  loadResortData();
})();
