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

  const ROUTE_MODE = { SKI_FORWARD: 'ski', LIFT_RETURN: 'lift' };

  function pisteColor(tag) {
    if (!tag) return '#3b82f6';
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
            });
          }
        }
        lastNodeIdx = i;
      }
    });

    return { adj, nodeKeys };
  }

  /**
   * @returns {{ pathNodes: string[], pathEdges: object[], totalCost: number } | null}
   */
  function dijkstra(adj, start, end, weightFn) {
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
    return dijkstra(adj, start, end, function (edge) {
      return edgeWeight(edge, mode, skill, goal);
    });
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
      'border-radius:0.25rem;border:1px solid #e2e8f0;}';
    document.head.appendChild(st);
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
    selectionLabelsLayer = L.layerGroup().addTo(map);
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
    nodeKeys.forEach(function (key) {
      const p = parseKey(key);
      const cm = L.circleMarker([p.lat, p.lng], {
        radius: 3,
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
    const latlngs = polylineLatLngsFromPath(lastReturnPath);
    if (returnPolyline) map.removeLayer(returnPolyline);
    returnPolyline = L.polyline(latlngs, {
      color: 'cyan',
      weight: 8,
      opacity: 0.6,
    }).addTo(map);
  }

  function hideForwardWarning() {
    if (!el.forwardRouteWarning) return;
    el.forwardRouteWarning.textContent = '';
    el.forwardRouteWarning.classList.add('hidden');
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
    el.forwardList.querySelectorAll('li').forEach(function (li) {
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

  function pathToListItems(pathResult, ul) {
    ul.innerHTML = '';
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
    hideForwardWarning();

    const skill = el.skill.value;
    const goal = el.goal.value;

    const forward = routeShortest(adj, startNode, endNode, ROUTE_MODE.SKI_FORWARD, skill, goal);

    const ret = routeShortest(adj, endNode, startNode, ROUTE_MODE.LIFT_RETURN, skill, goal);

    lastForwardPath = forward
      ? { pathNodes: forward.pathNodes, pathEdges: forward.pathEdges }
      : null;
    lastReturnPath = ret ? { pathNodes: ret.pathNodes, pathEdges: ret.pathEdges } : null;

    activeRouteView = 'forward';

    if (lastForwardPath) {
      pathToListItems(lastForwardPath, el.forwardList);
      bindForwardListFlyTo();
      showForwardPolyline();
    } else {
      const li = document.createElement('li');
      li.textContent = 'No ski route found for this skill/goal between these nodes.';
      el.forwardList.appendChild(li);
    }

    if (lastReturnPath) {
      pathToListItems(lastReturnPath, el.returnList);
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
    activeRouteView = 'forward';
    hideForwardWarning();
    fitResortBounds();
  }

  async function loadResortData() {
    setLoading(true);
    startNode = null;
    endNode = null;
    selectionLabelsLayer.clearLayers();
    clearActiveNodeHighlight();
    clearRouteLayers();
    clearLists();
    lastForwardPath = null;
    lastReturnPath = null;
    activeRouteView = 'forward';
    hideForwardWarning();
    try {
      const elements = await fetchResortData();
      const ways = elements.filter(function (e) {
        return e.type === 'way' && e.geometry && e.geometry.length >= 2;
      });
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
