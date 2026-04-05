(function () {
  'use strict';

  const RESORTS = {
    'val-thorens': { bbox: '45.27,6.55,45.32,6.61', label: 'Val Thorens' },
    whistler: { bbox: '50.05,-122.98,50.12,-122.85', label: 'Whistler' },
    zermatt: { bbox: '45.98,7.70,46.03,7.77', label: 'Zermatt' },
  };

  const SKILL_VALUES = [
    'never',
    'first-week',
    'low-intermediate',
    'high-intermediate',
    'advanced',
    'expert',
  ];

  function skillRankFromSelect(value) {
    const i = SKILL_VALUES.indexOf(value);
    return i < 0 ? 0 : i;
  }

  /** Numeric trail difficulty for penalty/reward (0 = easiest) */
  function osmDifficultyRank(tag) {
    if (!tag) return 2;
    const t = String(tag).toLowerCase();
    if (t.includes('novice') || t === 'easy' || t.includes('beginner') || t === 'elementary') return 0;
    if (t === 'intermediate') return 2;
    if (t === 'advanced') return 3;
    if (t.includes('expert') || t === 'extreme' || t.includes('freeride')) return 4;
    return 2;
  }

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

  /** Base length → forward-path weight with skill + goal */
  function forwardEdgeWeight(edge, skillRank, goal) {
    let w = edge.lengthM;
    if (!edge.isLift) {
      const dr = osmDifficultyRank(edge.difficulty);
      if (dr > skillRank) w *= 100;
      w *= goalMultiplier(goal, skillRank, dr, false);
    }
    return w;
  }

  function goalMultiplier(goal, skillRank, difficultyRank, isLift) {
    if (isLift) return 1;
    switch (goal) {
      case 'comfort': {
        if (difficultyRank <= 0) return 0.4;
        if (difficultyRank === 2) return 0.85;
        if (difficultyRank >= 3) return 1.6;
        return 1;
      }
      case 'progression': {
        const target = Math.min(4, skillRank + 1);
        if (difficultyRank === target || (skillRank <= 2 && difficultyRank === 2))
          return 0.1;
        if (difficultyRank <= skillRank) return 0.9;
        return 1;
      }
      case 'relaxed': {
        if (difficultyRank <= 0) return 0.1;
        if (difficultyRank === 2) return 0.35;
        return 2;
      }
      case 'training': {
        if (difficultyRank === 2) return 0.45;
        if (difficultyRank === 3) return 0.65;
        if (difficultyRank <= 0) return 0.75;
        return 1;
      }
      case 'direct':
      default:
        return 1;
    }
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
      return { w, coords, keys, isLift, name, difficulty };
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

    prepared.forEach(({ coords, keys, isLift, name, difficulty, w }) => {
      let lastNodeIdx = -1;
      for (let i = 0; i < keys.length; i++) {
        if (!nodeKeys.has(keys[i])) continue;
        if (lastNodeIdx >= 0) {
          const seg = segmentLengthM(coords, lastNodeIdx, i);
          if (seg > 0) {
            const u = keys[lastNodeIdx];
            const v = keys[i];
            const edge = {
              from: u,
              to: v,
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

  function pathToLatLngs(pathNodes) {
    return pathNodes.map((k) => {
      const { lat, lng } = parseKey(k);
      return [lat, lng];
    });
  }

  // --- Map & state ---
  let map;
  let baseLayer;
  let slopesLayer;
  let waysLayerGroup;
  let nodesLayerGroup;
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

  function initMap() {
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

  function showForwardPolyline() {
    if (!lastForwardPath) return;
    activeRouteView = 'forward';
    if (returnPolyline) {
      map.removeLayer(returnPolyline);
      returnPolyline = null;
    }
    const latlngs = pathToLatLngs(lastForwardPath.pathNodes);
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
    const latlngs = pathToLatLngs(lastReturnPath.pathNodes);
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
    const adj = currentAdj.adj;
    if (!adj || adj.size === 0) {
      alert('No graph data yet. Wait for loading or pick another resort.');
      return;
    }
    const skillRank = skillRankFromSelect(el.skill.value);
    const goal = el.goal.value;

    const forward = dijkstra(adj, startNode, endNode, (edge) =>
      forwardEdgeWeight(edge, skillRank, goal)
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

