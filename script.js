(function () {
  'use strict';

  const RESORTS = {
    'val-thorens': { bbox: '45.27,6.55,45.32,6.61', label: 'Val Thorens' },
    whistler: { bbox: '50.05,-122.98,50.12,-122.85', label: 'Whistler' },
    zermatt: { bbox: '45.98,7.70,46.03,7.77', label: 'Zermatt' },
  };

  function pisteColor(tag) {
    if (!tag) return '#3b82f6';
    const t = String(tag).toLowerCase();
    if (t.includes('novice') || t === 'easy' || t.includes('beginner') || t === 'elementary') return '#22c55e';
    if (t === 'intermediate') return '#3b82f6';
    if (t === 'advanced') return '#ef4444';
    if (t.includes('expert') || t === 'extreme' || t.includes('freeride')) return '#171717';
    return '#3b82f6';
  }

  function roundKey(lat, lng) {
    return `${lat.toFixed(6)},${lng.toFixed(6)}`;
  }

  function parseKey(key) {
    const [la, ln] = key.split(',').map(Number);
    return { lat: la, lng: ln };
  }

  function haversineM(a, b) {
    const R = 6371000;
    const toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR;
    const dLng = (b.lng - a.lng) * toR;
    const la1 = a.lat * toR;
    const la2 = b.lat * toR;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function segmentLengthM(coords, fromIdx, toIdx) {
    let d = 0;
    for (let i = fromIdx; i < toIdx; i++) {
      d += haversineM(coords[i], coords[i + 1]);
    }
    return d;
  }

  /**
   * Map OSM piste:difficulty to color tier (skill routing baseline).
   */
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

  function tierAboveForProgression(skill) {
    switch (skill) {
      case 'never':
        return 'blue';
      case 'first-week':
        return 'red';
      case 'low-intermediate':
        return 'red';
      case 'high-intermediate':
        return 'black';
      case 'advanced':
      case 'expert':
        return 'black';
      default:
        return 'black';
    }
  }

  function tierBelowForComfort(skill) {
    switch (skill) {
      case 'never':
      case 'first-week':
      case 'low-intermediate':
        return 'green';
      case 'high-intermediate':
        return 'blue';
      case 'advanced':
      case 'expert':
        return 'red';
      default:
        return 'green';
    }
  }

  /** Skill baseline cost multiplier per piste tier (before goal tweak). */
  function skillBaselineMultiplier(skill, tier) {
    switch (skill) {
      case 'never':
        if (tier === 'green') return 0.1;
        return Infinity;
      case 'first-week':
        if (tier === 'green') return 0.1;
        if (tier === 'blue') return 1;
        return Infinity;
      case 'low-intermediate':
        if (tier === 'blue') return 0.1;
        if (tier === 'green') return 0.5;
        if (tier === 'red') return 5;
        return Infinity;
      case 'high-intermediate':
        if (tier === 'red') return 0.1;
        if (tier === 'blue') return 0.5;
        if (tier === 'black') return 5;
        return 1;
      case 'advanced':
      case 'expert':
        if (tier === 'black') return 0.1;
        if (tier === 'red') return 0.5;
        if (tier === 'blue') return 1.5;
        if (tier === 'green') return 2;
        return 1;
      default:
        return 1;
    }
  }

  function applyGoalModifier(skill, goal, tier, mult) {
    if (!Number.isFinite(mult)) return mult;
    let m = mult;
    if (goal === 'progression' && tier === tierAboveForProgression(skill))
      m *= 0.62;
    if (goal === 'comfort' && tier === tierBelowForComfort(skill)) m *= 0.72;
    return m;
  }

  /** Forward routing cost: strict skill tiers + goal; lifts moderated unless Direct. */
  function forwardEdgeWeight(edge, skill, goal) {
    if (edge.isLift) {
      return goal === 'direct' ? edge.lengthM : edge.lengthM * 1.85;
    }
    const tier = pisteTierFromTag(edge.difficulty);
    const base = skillBaselineMultiplier(skill, tier);
    const mult = applyGoalModifier(skill, goal, tier, base);
    return edge.lengthM * mult;
  }

  function returnEdgeWeight(edge) {
    let w = edge.lengthM;
    if (edge.isLift) w *= 0.01;
    else w *= 1000;
    return w;
  }

  function buildAdjacency(ways) {
    const keyToWays = new Map();
    const endpointKeys = new Set();

    function addWayPoint(wayId, key) {
      if (!keyToWays.has(key)) keyToWays.set(key, new Set());
      keyToWays.get(key).add(wayId);
    }

    const prepared = ways.map((w) => {
      const geom = w.geometry || [];
      const fullLatLng = geom.map((g) => [g.lat, g.lon]);
      const coords = geom.map((g) => ({
        lat: g.lat,
        lng: g.lon,
      }));
      const keys = coords.map((c) => roundKey(c.lat, c.lng));
      if (keys.length) {
        endpointKeys.add(keys[0]);
        endpointKeys.add(keys[keys.length - 1]);
      }
      keys.forEach((k) => addWayPoint(w.id, k));
      const isLift = !!(w.tags && w.tags.aerialway);
      const name =
        (w.tags && (w.tags.name || w.tags['piste:name'] || w.tags.ref)) ||
        (isLift ? 'Lift' : 'Unnamed piste');
      const difficulty = w.tags && w.tags['piste:difficulty'];
      return { w, coords, fullLatLng, keys, isLift, name, difficulty };
    });

    const nodeKeys = new Set();
    keyToWays.forEach((set, key) => {
      if (set.size > 1 || endpointKeys.has(key)) nodeKeys.add(key);
    });

    const adj = new Map();
    function addUndirected(u, v, edge) {
      if (!adj.has(u)) adj.set(u, []);
      if (!adj.has(v)) adj.set(v, []);
      adj.get(u).push({ node: v, edge });
      adj.get(v).push({ node: u, edge });
    }

    prepared.forEach(({ coords, fullLatLng, keys, isLift, name, difficulty, w }) => {
      let lastNodeIdx = -1;
      for (let i = 0; i < keys.length; i++) {
        if (!nodeKeys.has(keys[i])) continue;
        if (lastNodeIdx >= 0) {
          const seg = segmentLengthM(coords, lastNodeIdx, i);
          if (seg > 0) {
            const u = keys[lastNodeIdx];
            const v = keys[i];
            const segmentCoords = fullLatLng.slice(lastNodeIdx, i + 1);
            const edge = {
              from: u,
              to: v,
              coords: segmentCoords,
              lengthM: seg,
              isLift,
              name,
              difficulty: isLift ? null : difficulty,
              wayId: w.id,
            };
            addUndirected(u, v, edge);
          }
        }
        lastNodeIdx = i;
      }
    });

    return { adj, nodeKeys };
  }

  function dijkstra(adj, start, end, weightFn) {
    const nodes = Array.from(adj.keys());
    const dist = new Map();
    const prev = new Map();
    const prevEdge = new Map();
    const visited = new Set();

    nodes.forEach((n) => {
      dist.set(n, Infinity);
    });
    dist.set(start, 0);

    while (visited.size < nodes.length) {
      let u = null;
      let best = Infinity;
      nodes.forEach((n) => {
        if (visited.has(n)) return;
        const d = dist.get(n);
        if (d < best) {
          best = d;
          u = n;
        }
      });
      if (u === null || best === Infinity) break;
      visited.add(u);
      if (u === end) break;

      const outs = adj.get(u) || [];
      outs.forEach(({ node: v, edge }) => {
        if (visited.has(v)) return;
        const w = weightFn(edge);
        if (!Number.isFinite(w) || w === Infinity) return;
        const alt = dist.get(u) + w;
        if (alt < dist.get(v)) {
          dist.set(v, alt);
          prev.set(v, u);
          prevEdge.set(v, edge);
        }
      });
    }

    if (dist.get(end) === Infinity) return null;

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
    return { pathNodes, pathEdges };
  }

  /**
   * Build one continuous lat/lng path following stored edge geometries,
   * orienting each segment along the path direction.
   */
  function routePolylineFromPath(pathNodes, pathEdges) {
    const pts = [];
    function samePt(a, b) {
      return (
        Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9
      );
    }
    for (let j = 0; j < pathEdges.length; j++) {
      const e = pathEdges[j];
      const a = pathNodes[j];
      const b = pathNodes[j + 1];
      let seg = e.coords;
      if (!seg || seg.length < 2) continue;
      if (e.from === a && e.to === b) {
        // keep forward
      } else if (e.from === b && e.to === a) {
        seg = seg.slice().reverse();
      }
      if (pts.length === 0) {
        for (let k = 0; k < seg.length; k++) pts.push(seg[k]);
      } else {
        const startIdx = samePt(pts[pts.length - 1], seg[0]) ? 1 : 0;
        for (let k = startIdx; k < seg.length; k++) pts.push(seg[k]);
      }
    }
    return pts;
  }

  // --- Map & state ---
  let map;
  let baseLayer;
  let slopesLayer;
  let waysLayerGroup;
  let nodesLayerGroup;
  let selectionLabelsLayer;
  let forwardPolyline;
  let returnPolyline;
  /** @type {Map<string, L.CircleMarker>} */
  let nodeMarkers = new Map();

  let startNode = null;
  let endNode = null;
  let currentWays = [];
  let currentAdj = { adj: new Map(), nodeKeys: new Set() };
  let activeRouteView = 'forward';
  let lastForwardPath = null;
  let lastReturnPath = null;

  const el = {
    loading: document.getElementById('loading-banner'),
    resort: document.getElementById('resort'),
    skill: document.getElementById('skill'),
    goal: document.getElementById('goal'),
    findBtn: document.getElementById('find-route'),
    resetBtn: document.getElementById('reset-search'),
    forwardHeader: document.getElementById('forward-header'),
    returnHeader: document.getElementById('return-header'),
    forwardList: document.getElementById('forward-list'),
    returnList: document.getElementById('return-list'),
  };

  function setLoading(on) {
    el.loading.classList.toggle('hidden', !on);
  }

  function getBboxBoundsLiteral(bboxStr) {
    const [s, w, n, e] = bboxStr.split(',').map(Number);
    return [
      [s, w],
      [n, e],
    ];
  }

  function ensureRouteLabelTooltipCss() {
    if (document.getElementById('route-label-tooltip-css')) return;
    const st = document.createElement('style');
    st.id = 'route-label-tooltip-css';
    st.textContent =
      '.leaflet-tooltip.route-label-start{' +
      'font-weight:700;color:#16a34a;background:#fff;padding:0.25rem 0.5rem;' +
      'border-radius:0.25rem;border:1px solid #e2e8f0;}' +
      '.leaflet-tooltip.route-label-end{' +
      'font-weight:700;color:#dc2626;background:#fff;padding:0.25rem 0.5rem;' +
      'border-radius:0.25rem;border:1px solid #e2e8f0;}';
    document.head.appendChild(st);
  }

  function initMap() {
    ensureRouteLabelTooltipCss();
    map = L.map('map', { zoomControl: true });

    baseLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
      maxZoom: 22,
      maxNativeZoom: 17,
    });

    slopesLayer = L.tileLayer(
      'https://tile.waymarkedtrails.org/slopes/{z}/{x}/{y}.png',
      {
        maxZoom: 22,
        maxNativeZoom: 17,
        opacity: 0.65,
      }
    );

    baseLayer.addTo(map);
    slopesLayer.addTo(map);

    waysLayerGroup = L.layerGroup().addTo(map);
    nodesLayerGroup = L.layerGroup().addTo(map);
    selectionLabelsLayer = L.layerGroup().addTo(map);
  }

  function refreshStartEndLabels() {
    if (!selectionLabelsLayer) return;
    selectionLabelsLayer.clearLayers();
    if (startNode) {
      const { lat, lng } = parseKey(startNode);
      const m = L.circleMarker([lat, lng], {
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
        className:
          'route-label-start font-bold text-green-600 bg-white px-2 py-1 rounded',
      });
      m.addTo(selectionLabelsLayer);
    }
    if (endNode) {
      const { lat, lng } = parseKey(endNode);
      const m = L.circleMarker([lat, lng], {
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
        className:
          'route-label-end font-bold text-red-600 bg-white px-2 py-1 rounded',
      });
      m.addTo(selectionLabelsLayer);
    }
  }

  function resortBboxString() {
    return RESORTS[el.resort.value].bbox;
  }

  function fitResortBounds() {
    const b = getBboxBoundsLiteral(resortBboxString());
    map.fitBounds(b, { padding: [24, 24] });
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

  function redrawNodeMarkers() {
    nodesLayerGroup.clearLayers();
    nodeMarkers = new Map();
    const nodeKeys = currentAdj.nodeKeys || new Set();

    nodeKeys.forEach((key) => {
      const { lat, lng } = parseKey(key);
      const cm = L.circleMarker([lat, lng], {
        radius: 3,
        color: '#334155',
        weight: 1,
        fillColor: '#94a3b8',
        fillOpacity: 0.9,
      });
      cm.on('click', (ev) => {
        L.DomEvent.stopPropagation(ev);
        if (!startNode) {
          startNode = key;
          updateStartEndStyles();
        } else if (!endNode && key !== startNode) {
          endNode = key;
          updateStartEndStyles();
        } else if (key === startNode || key === endNode) {
          if (key === endNode) {
            endNode = null;
          } else {
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
    updateStartEndStyles();
  }

  function updateStartEndStyles() {
    nodeMarkers.forEach((m, key) => {
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
    ways.forEach((w) => {
      const geom = w.geometry || [];
      if (geom.length < 2) return;
      const latlngs = geom.map((g) => [g.lat, g.lon]);
      const isLift = !!(w.tags && w.tags.aerialway);
      const diff = w.tags && w.tags['piste:difficulty'];
      const opt = isLift
        ? { color: '#64748b', weight: 2, dashArray: '6 6', opacity: 0.9 }
        : {
            color: pisteColor(diff),
            weight: 3,
            opacity: 0.85,
          };
      L.polyline(latlngs, opt).addTo(waysLayerGroup);
    });
  }

  async function fetchOverpass() {
    const bbox = resortBboxString();
    const q = `[out:json][timeout:25];(way["piste:type"="downhill"](${bbox});way["aerialway"](${bbox}););out geom;`;
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!res.ok) throw new Error('Overpass: ' + res.status);
    const data = await res.json();
    return data.elements || [];
  }

  function rebuildGraph(ways) {
    currentWays = ways;
    const { adj, nodeKeys } = buildAdjacency(ways);
    currentAdj = { adj, nodeKeys };
    drawOriginalWays(ways);
    redrawNodeMarkers();
  }

  function polylineLatLngsFromRoute(path) {
    let latlngs = routePolylineFromPath(path.pathNodes, path.pathEdges);
    if (latlngs.length < 2) {
      latlngs = path.pathNodes.map((k) => {
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
    const latlngs = polylineLatLngsFromRoute(lastForwardPath);
    if (forwardPolyline) map.removeLayer(forwardPolyline);
    forwardPolyline = L.polyline(latlngs, {
      color: 'yellow',
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
    const latlngs = polylineLatLngsFromRoute(lastReturnPath);
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
    el.forwardList.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', (e) => {
        e.stopPropagation();
        showForwardPolyline();
        const lat = parseFloat(li.dataset.lat);
        const lng = parseFloat(li.dataset.lng);
        if (Number.isFinite(lat) && Number.isFinite(lng))
          map.flyTo([lat, lng], 17);
      });
    });
  }

  function pathToListItems(pathResult, ul) {
    ul.innerHTML = '';
    if (!pathResult) return;
    const { pathNodes, pathEdges } = pathResult;
    if (pathNodes.length === 0) return;
    const start = parseKey(pathNodes[0]);
    appendFlyLi(ul, '1. Start', start.lat, start.lng);
    for (let j = 0; j < pathEdges.length; j++) {
      const e = pathEdges[j];
      const dest = parseKey(pathNodes[j + 1]);
      const prefix = e.isLift ? 'Lift' : 'Piste';
      appendFlyLi(ul, `${j + 2}. ${prefix}: ${e.name}`, dest.lat, dest.lng);
    }
    const last = parseKey(pathNodes[pathNodes.length - 1]);
    appendFlyLi(ul, `${pathEdges.length + 2}. End`, last.lat, last.lng);
  }

  function runFindRoute() {
    if (!startNode || !endNode) {
      alert('Select a start node and an end node on the map (two clicks).');
      return;
    }
    refreshStartEndLabels();
    const adj = currentAdj.adj;
    if (!adj || adj.size === 0) {
      alert('No graph data yet. Wait for loading or pick another resort.');
      return;
    }
    const skill = el.skill.value;
    const goal = el.goal.value;

    const forward = dijkstra(adj, startNode, endNode, (edge) =>
      forwardEdgeWeight(edge, skill, goal)
    );
    if (!forward) {
      clearLists();
      clearRouteLayers();
      lastForwardPath = null;
      lastReturnPath = null;
      alert('No forward route found between the selected nodes.');
      return;
    }
    lastForwardPath = forward;

    const backward = dijkstra(adj, endNode, startNode, returnEdgeWeight);
    lastReturnPath = backward;

    clearRouteLayers();
    activeRouteView = 'forward';
    showForwardPolyline();

    pathToListItems(forward, el.forwardList);
    bindForwardListFlyTo();

    if (backward) {
      pathToListItems(backward, el.returnList);
    } else {
      el.returnList.innerHTML = '';
      const li = document.createElement('li');
      li.textContent = 'No return route via lifts found.';
      el.returnList.appendChild(li);
    }
  }

  function resetSearch() {
    startNode = null;
    endNode = null;
    if (selectionLabelsLayer) selectionLabelsLayer.clearLayers();
    updateStartEndStyles();
    clearRouteLayers();
    clearLists();
    lastForwardPath = null;
    lastReturnPath = null;
    activeRouteView = 'forward';
    fitResortBounds();
  }

  async function loadResortData() {
    setLoading(true);
    startNode = null;
    endNode = null;
    if (selectionLabelsLayer) selectionLabelsLayer.clearLayers();
    clearRouteLayers();
    clearLists();
    lastForwardPath = null;
    lastReturnPath = null;
    try {
      const elements = await fetchOverpass();
      const ways = elements.filter((e) => e.type === 'way' && e.geometry);
      rebuildGraph(ways);
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
  el.returnList.addEventListener('click', (e) => {
    showReturnPolyline();
    const li = e.target.closest('li');
    if (li && li.dataset.lat != null && li.dataset.lng != null) {
      const la = parseFloat(li.dataset.lat);
      const ln = parseFloat(li.dataset.lng);
      if (Number.isFinite(la) && Number.isFinite(ln))
        map.flyTo([la, ln], 17);
    }
  });

  el.resort.addEventListener('change', () => {
    resetSearch();
    loadResortData();
  });

  initMap();
  fitResortBounds();
  requestAnimationFrame(() => map.invalidateSize());
  loadResortData();
})();

