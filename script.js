(function () {
  "use strict";

  const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

  const RESORTS = [
    {
      id: "val-thorens",
      name: "Val Thorens",
      bbox: [45.27, 6.55, 45.32, 6.61],
      center: [45.295, 6.58],
      zoom: 14,
    },
    {
      id: "whistler",
      name: "Whistler",
      bbox: [50.05, -122.98, 50.12, -122.85],
      center: [50.085, -122.915],
      zoom: 12,
    },
    {
      id: "zermatt",
      name: "Zermatt",
      bbox: [45.98, 7.7, 46.03, 7.77],
      center: [46.005, 7.735],
      zoom: 13,
    },
  ];

  /** @typedef {{ id: string, lat: number, lon: number }} GraphNode */
  /**
   * @typedef {{
   *   to: string,
   *   lengthMeters: number,
   *   isLift: boolean,
   *   difficultyTier: number,
   *   wayName: string,
   *   polyline: { lat: number, lon: number }[],
   * }} GraphEdge
   */

  let map = null;
  let graphLayer = null;
  /** @type {L.Polyline[]} */
  let baseTrackLines = [];
  /** @type {Map<string, L.CircleMarker>} */
  let nodeMarkers = new Map();

  let forwardRouteLayer = null;
  let returnRouteLayer = null;

  /** @type {number[][]|null} */
  let lastForwardLine = null;
  /** @type {number[][]|null} */
  let lastReturnLine = null;

  /** @type {Map<string, GraphNode>} */
  let nodeStore = new Map();
  /** @type {Map<string, GraphEdge[]>} */
  let adjacency = new Map();

  /** @type {{ coords: {lat:number,lon:number}[], diffNorm: string|null, isLift: boolean, wayName: string }[]} */
  let parsedWays = [];

  let clickStage = 0;
  /** @type {string|null} */
  let startNodeId = null;
  /** @type {string|null} */
  let endNodeId = null;

  const $resort = document.getElementById("resort-select");
  const $skill = document.getElementById("skill-select");
  const $goal = document.getElementById("goal-select");
  const $find = document.getElementById("find-route");
  const $reset = document.getElementById("reset-search");
  const $hint = document.getElementById("status-hint");
  const $routeOut = document.getElementById("route-output");
  const $fwdHeader = document.getElementById("forward-route-header");
  const $retHeader = document.getElementById("return-trip-header");
  const $fwdList = document.getElementById("forward-route-list");
  const $retList = document.getElementById("return-trip-list");

  function coordKey(lat, lon) {
    return (
      Math.round(lat * 1e5) / 1e5 + "," + Math.round(lon * 1e5) / 1e5
    );
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toR = (d) => (d * Math.PI) / 180;
    const dLat = toR(lat2 - lat1);
    const dLon = toR(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function polylineLengthMeters(coords) {
    let L = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i],
        b = coords[i + 1];
      L += haversineMeters(a.lat, a.lon, b.lat, b.lon);
    }
    return L;
  }

  function normalizeDifficulty(tags) {
    const raw = (
      tags["piste:difficulty"] ||
      tags["snowmobile:difficulty"] ||
      ""
    )
      .toLowerCase()
      .trim();
    if (!raw) return null;
    if (["novice", "easy", "beginner"].includes(raw)) return "easy";
    if (["intermediate", "blue"].includes(raw)) return "intermediate";
    if (["advanced", "difficult", "red"].includes(raw)) return "advanced";
    if (["expert", "extreme", "freeride", "black", "yes"].includes(raw))
      return "expert";
    return "intermediate";
  }

  function tierFromDifficulty(diffNorm) {
    if (diffNorm === "easy") return 1;
    if (diffNorm === "intermediate") return 2;
    if (diffNorm === "advanced") return 3;
    if (diffNorm === "expert") return 4;
    return 2;
  }

  function skillMaxTier() {
    const v = $skill.value;
    if (v === "never" || v === "first-week") return 1;
    if (v === "low-intermediate") return 2;
    if (v === "high-intermediate") return 3;
    if (v === "advanced") return 4;
    if (v === "expert" || v === "extreme") return 4;
    return 2;
  }

  function pisteLineStyle(diffNorm, isLift) {
    if (isLift) {
      return {
        color: "#94a3b8",
        weight: 3,
        opacity: 0.9,
        dashArray: "10 8",
      };
    }
    switch (diffNorm) {
      case "easy":
        return { color: "#22c55e", weight: 3, opacity: 0.92 };
      case "intermediate":
        return { color: "#2563eb", weight: 3, opacity: 0.92 };
      case "advanced":
        return { color: "#dc2626", weight: 3, opacity: 0.92 };
      case "expert":
        return { color: "#0f172a", weight: 4, opacity: 0.95 };
      default:
        return { color: "#64748b", weight: 3, opacity: 0.88 };
    }
  }

  function buildOverpassQuery(bbox) {
    const s = bbox[0],
      w = bbox[1],
      n = bbox[2],
      e = bbox[3];
    return (
      '[out:json][timeout:25];(way["piste:type"="downhill"](' +
      s +
      "," +
      w +
      "," +
      n +
      "," +
      e +
      ');way["aerialway"](' +
      s +
      "," +
      w +
      "," +
      n +
      "," +
      e +
      "););out geom;"
    );
  }

  async function fetchResortOsm(bbox) {
    const q = buildOverpassQuery(bbox);
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      body: "data=" + encodeURIComponent(q),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
    });
    if (!res.ok) throw new Error("Overpass HTTP " + res.status);
    return res.json();
  }

  function addUndirectedEdge(a, b, metaAtoB, metaBtoA) {
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push({ ...metaAtoB, to: b });
    adjacency.get(b).push({ ...metaBtoA, to: a });
  }

  function reverseCoords(coords) {
    return coords.slice().reverse();
  }

  function buildGraph(json) {
    nodeStore = new Map();
    adjacency = new Map();
    parsedWays = [];

    const elements = json.elements || [];
    for (const el of elements) {
      if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
      const tags = el.tags || {};
      const isDownhill = tags["piste:type"] === "downhill";
      const isLift =
        tags["aerialway"] != null && String(tags["aerialway"]) !== "no";
      if (!isDownhill && !isLift) continue;

      const coords = el.geometry.map((g) => ({ lat: g.lat, lon: g.lon }));
      const diffNorm = isDownhill ? normalizeDifficulty(tags) : null;
      const tier = diffNorm != null ? tierFromDifficulty(diffNorm) : 0;
      const wayName = (tags.name || tags["name:en"] || "").trim() || "Unnamed";

      parsedWays.push({
        coords,
        diffNorm,
        isLift,
        wayName,
      });

      const a = coords[0];
      const b = coords[coords.length - 1];
      const ka = coordKey(a.lat, a.lon);
      const kb = coordKey(b.lat, b.lon);
      if (ka === kb) continue;

      const len = polylineLengthMeters(coords);
      if (len < 0.25) continue;

      if (!nodeStore.has(ka))
        nodeStore.set(ka, { id: ka, lat: a.lat, lon: a.lon });
      if (!nodeStore.has(kb))
        nodeStore.set(kb, { id: kb, lat: b.lat, lon: b.lon });

      const base = {
        lengthMeters: len,
        isLift: isLift,
        difficultyTier: tier,
        wayName: wayName,
        polyline: coords,
      };
      addUndirectedEdge(ka, kb, { ...base }, { ...base, polyline: reverseCoords(coords) });
    }

    for (const id of [...nodeStore.keys()]) {
      const edges = adjacency.get(id);
      if (!edges || edges.length === 0) {
        nodeStore.delete(id);
        adjacency.delete(id);
      }
    }
  }

  function edgeWeightForward(edge) {
    let w = edge.lengthMeters;
    const userMax = skillMaxTier();
    const goal = $goal.value;

    if (goal === "direct") {
      if (!edge.isLift && edge.difficultyTier > userMax) w *= 100;
      return w;
    }

    if (!edge.isLift && edge.difficultyTier > userMax) w *= 100;

    if (edge.isLift) {
      if (goal === "relaxed") w *= 0.9;
      return w;
    }

    const P = edge.difficultyTier;

    if (goal === "comfort") {
      if (P === userMax) w *= 0.1;
      return w;
    }

    if (goal === "progression") {
      const stretch = Math.min(userMax + 1, 4);
      if (P === stretch || P === userMax) w *= 0.1;
      return w;
    }

    if (goal === "relaxed") {
      if (P === 1) w *= 0.1;
      else if (P === 2) w *= 8;
      else w *= 50;
      return w;
    }

    if (goal === "training") {
      w *= 0.85;
      return w;
    }

    if (goal === "scenic") {
      if (P === userMax) w *= 0.12;
      return w;
    }

    return w;
  }

  function edgeWeightReturn(edge) {
    let w = edge.lengthMeters;
    if (edge.isLift) return w * 0.01;
    return w * 1000;
  }

  class MinHeap {
    constructor() {
      this.h = [];
    }
    push(d, id) {
      this.h.push({ d, id });
      this._up(this.h.length - 1);
    }
    pop() {
      const a = this.h;
      if (!a.length) return null;
      const top = a[0];
      const last = a.pop();
      if (a.length && last) {
        a[0] = last;
        this._down(0);
      }
      return top;
    }
    _up(i) {
      const a = this.h;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[i].d >= a[p].d) break;
        [a[i], a[p]] = [a[p], a[i]];
        i = p;
      }
    }
    _down(i) {
      const a = this.h;
      const n = a.length;
      for (;;) {
        let m = i;
        const l = i * 2 + 1;
        const r = l + 1;
        if (l < n && a[l].d < a[m].d) m = l;
        if (r < n && a[r].d < a[m].d) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
  }

  /**
   * @param {Map<string, GraphEdge[]>} graph
   * @param {string} start
   * @param {string} end
   * @param {(e: GraphEdge) => number} wf
   */
  function dijkstra(graph, start, end, wf) {
    const dist = new Map();
    const prev = new Map();
    for (const k of graph.keys()) dist.set(k, Infinity);
    if (!graph.has(start) || !graph.has(end))
      return { path: null, edges: null };

    dist.set(start, 0);
    const heap = new MinHeap();
    heap.push(0, start);

    while (true) {
      const cur = heap.pop();
      if (!cur) break;
      if (cur.d > dist.get(cur.id)) continue;
      if (cur.id === end) break;

      const edges = graph.get(cur.id);
      if (!edges) continue;
      for (const e of edges) {
        const alt = cur.d + wf(e);
        const dv = dist.get(e.to);
        if (alt < dv) {
          dist.set(e.to, alt);
          prev.set(e.to, { from: cur.id, edge: e });
          heap.push(alt, e.to);
        }
      }
    }

    if (dist.get(end) === Infinity) return { path: null, edges: null };

    const nodes = [];
    const pathEdges = [];
    let x = end;
    while (x !== start) {
      nodes.push(x);
      const p = prev.get(x);
      if (!p) return { path: null, edges: null };
      pathEdges.push(p.edge);
      x = p.from;
    }
    nodes.push(start);
    nodes.reverse();
    pathEdges.reverse();
    return { path: nodes, edges: pathEdges };
  }

  function mergePathLatLngs(pathEdges) {
    const out = [];
    for (let i = 0; i < pathEdges.length; i++) {
      const pl = pathEdges[i].polyline;
      if (!pl || !pl.length) continue;
      const seg = pl.map((p) => [p.lat, p.lon]);
      if (out.length === 0) out.push(...seg);
      else {
        const la = out[out.length - 1];
        const fb = seg[0];
        const dup =
          Math.abs(la[0] - fb[0]) < 1e-7 && Math.abs(la[1] - fb[1]) < 1e-7;
        if (dup) for (let j = 1; j < seg.length; j++) out.push(seg[j]);
        else out.push(...seg);
      }
    }
    return out;
  }

  function segmentFlyLatLng(edge) {
    const pl = edge.polyline;
    if (!pl || !pl.length) return null;
    const i = Math.floor(pl.length / 2);
    return [pl[i].lat, pl[i].lon];
  }

  function removeForwardGlow() {
    if (forwardRouteLayer && map) {
      map.removeLayer(forwardRouteLayer);
      forwardRouteLayer = null;
    }
  }

  function removeReturnGlow() {
    if (returnRouteLayer && map) {
      map.removeLayer(returnRouteLayer);
      returnRouteLayer = null;
    }
  }

  function drawForwardGlow(latlngs) {
    if (!map || latlngs.length < 2) return;
    removeForwardGlow();
    forwardRouteLayer = L.polyline(latlngs, {
      className: "route-glow-forward",
      color: "yellow",
      weight: 8,
      opacity: 0.6,
      lineCap: "round",
      lineJoin: "round",
    });
    forwardRouteLayer.addTo(map);
    forwardRouteLayer.bringToFront();
    bringMarkersFront();
  }

  function drawReturnGlow(latlngs) {
    if (!map || latlngs.length < 2) return;
    removeReturnGlow();
    returnRouteLayer = L.polyline(latlngs, {
      className: "route-glow-return",
      color: "cyan",
      weight: 8,
      opacity: 0.6,
      lineCap: "round",
      lineJoin: "round",
    });
    returnRouteLayer.addTo(map);
    returnRouteLayer.bringToFront();
    bringMarkersFront();
  }

  function bringMarkersFront() {
    nodeMarkers.forEach((m) => {
      if (m.bringToFront) m.bringToFront();
    });
  }

  function styleNodeMarker(id, marker) {
    if (id === startNodeId) {
      marker.setStyle({
        radius: 5,
        color: "#15803d",
        weight: 2,
        fillColor: "#4ade80",
        fillOpacity: 0.95,
      });
    } else if (id === endNodeId) {
      marker.setStyle({
        radius: 5,
        color: "#b91c1c",
        weight: 2,
        fillColor: "#f87171",
        fillOpacity: 0.95,
      });
    } else {
      marker.setStyle({
        radius: 3,
        color: "#4338ca",
        weight: 1,
        fillColor: "#a5b4fc",
        fillOpacity: 0.85,
      });
    }
  }

  function onNodeClick(nodeId, ev) {
    L.DomEvent.stopPropagation(ev);
    if (clickStage % 2 === 0) startNodeId = nodeId;
    else endNodeId = nodeId;
    clickStage++;
    nodeMarkers.forEach((mk, id) => styleNodeMarker(id, mk));
    if ($hint)
      $hint.textContent =
        startNodeId && endNodeId
          ? "Start and end set — click Find Route."
          : startNodeId
            ? "Click end node."
            : "Click start node.";
  }

  function redrawBaseTracks() {
    if (!graphLayer || !map) return;
    for (const pl of baseTrackLines) {
      if (graphLayer.hasLayer(pl)) graphLayer.removeLayer(pl);
    }
    baseTrackLines = [];
    for (const w of parsedWays) {
      const latlngs = w.coords.map((c) => [c.lat, c.lon]);
      const st = pisteLineStyle(w.diffNorm, w.isLift);
      const line = L.polyline(latlngs, st);
      baseTrackLines.push(line);
      graphLayer.addLayer(line);
    }
    baseTrackLines.forEach((ln) => {
      if (ln.bringToBack) ln.bringToBack();
    });
    bringMarkersFront();
  }

  function renderMapGraph() {
    if (!map) return;
    if (graphLayer) {
      map.removeLayer(graphLayer);
      graphLayer = null;
    }
    nodeMarkers.clear();
    baseTrackLines = [];
    graphLayer = L.layerGroup();
    parsedWays.forEach((w) => {
      const latlngs = w.coords.map((c) => [c.lat, c.lon]);
      const st = pisteLineStyle(w.diffNorm, w.isLift);
      const line = L.polyline(latlngs, st);
      baseTrackLines.push(line);
      graphLayer.addLayer(line);
    });

    nodeStore.forEach((node, id) => {
      const mk = L.circleMarker([node.lat, node.lon], {
        radius: 3,
        color: "#4338ca",
        weight: 1,
        fillColor: "#a5b4fc",
        fillOpacity: 0.85,
      });
      mk.on("click", (e) => onNodeClick(id, e));
      graphLayer.addLayer(mk);
      nodeMarkers.set(id, mk);
    });

    nodeMarkers.forEach((mk, id) => styleNodeMarker(id, mk));
    graphLayer.addTo(map);
    baseTrackLines.forEach((ln) => {
      if (ln.bringToBack) ln.bringToBack();
    });
    bringMarkersFront();
  }

  function clearRouteUi() {
    if ($fwdList) $fwdList.innerHTML = "";
    if ($retList) $retList.innerHTML = "";
    if ($routeOut) $routeOut.classList.add("hidden");
    removeForwardGlow();
    removeReturnGlow();
    lastForwardLine = null;
    lastReturnLine = null;
  }

  function populateForwardList(edges) {
    if (!$fwdList) return;
    $fwdList.innerHTML = "";
    edges.forEach((e, idx) => {
      const label = e.isLift ? "Lift: " + e.wayName : "Piste: " + e.wayName;
      const li = document.createElement("li");
      li.textContent = idx + 1 + ". " + label;
      li.tabIndex = 0;
      const ll = segmentFlyLatLng(e);
      function fly() {
        if (ll && map) map.flyTo(ll, 17, { duration: 0.45 });
      }
      li.addEventListener("click", fly);
      li.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          fly();
        }
      });
      $fwdList.appendChild(li);
    });
  }

  function populateReturnList(edges) {
    if (!$retList) return;
    $retList.innerHTML = "";
    edges.forEach((e, idx) => {
      const label = e.isLift ? "Lift: " + e.wayName : "Piste: " + e.wayName;
      const li = document.createElement("li");
      li.textContent = idx + 1 + ". " + label;
      $retList.appendChild(li);
    });
  }

  function showForwardOnly() {
    if (!lastForwardLine || lastForwardLine.length < 2) return;
    removeReturnGlow();
    drawForwardGlow(lastForwardLine);
    if (map)
      map.fitBounds(L.latLngBounds(lastForwardLine), {
        padding: [40, 40],
        maxZoom: 16,
      });
  }

  function showReturnOnly() {
    if (!lastReturnLine || lastReturnLine.length < 2) return;
    removeForwardGlow();
    drawReturnGlow(lastReturnLine);
    if (map)
      map.fitBounds(L.latLngBounds(lastReturnLine), {
        padding: [40, 40],
        maxZoom: 16,
      });
  }

  function onFindRoute() {
    if (!startNodeId || !endNodeId) {
      if ($hint) $hint.textContent = "Select start and end nodes on the map.";
      return;
    }
    if (startNodeId === endNodeId) {
      if ($hint) $hint.textContent = "Start and end must differ.";
      return;
    }

    const r1 = dijkstra(adjacency, startNodeId, endNodeId, edgeWeightForward);
    if (!r1.path || !r1.edges) {
      if ($hint)
        $hint.textContent = "No route found between these nodes in the loaded graph.";
      clearRouteUi();
      return;
    }

    lastForwardLine = mergePathLatLngs(r1.edges);
    removeReturnGlow();
    drawForwardGlow(lastForwardLine);

    const r2 = dijkstra(adjacency, endNodeId, startNodeId, edgeWeightReturn);
    if (r2.path && r2.edges) {
      lastReturnLine = mergePathLatLngs(r2.edges);
      populateReturnList(r2.edges);
    } else {
      lastReturnLine = null;
      if ($retList) $retList.innerHTML = "";
    }

    populateForwardList(r1.edges);
    if ($routeOut) $routeOut.classList.remove("hidden");
    if ($hint) $hint.textContent = "Route ready. Use headers to toggle yellow / cyan.";

    if (map && lastForwardLine.length >= 2) {
      map.fitBounds(L.latLngBounds(lastForwardLine), {
        padding: [40, 40],
        maxZoom: 16,
      });
    }
    bringMarkersFront();
  }

  function onReset() {
    startNodeId = null;
    endNodeId = null;
    clickStage = 0;
    clearRouteUi();
    nodeMarkers.forEach((mk, id) => styleNodeMarker(id, mk));
    redrawBaseTracks();
    const resort = RESORTS.find((r) => r.id === $resort.value);
    if (map && resort) map.setView(resort.center, resort.zoom);
    if ($hint)
      $hint.textContent = "Selection cleared. Click two endpoint nodes.";
  }

  async function loadResort(resort) {
    if ($hint) $hint.textContent = "Loading " + resort.name + "…";
    try {
      const json = await fetchResortOsm(resort.bbox);
      buildGraph(json);
      if (nodeStore.size === 0) {
        if ($hint)
          $hint.textContent = "No piste or lift data in this area.";
        return;
      }
      if (map) {
        map.setView(resort.center, resort.zoom);
        renderMapGraph();
      }
      startNodeId = endNodeId = null;
      clickStage = 0;
      clearRouteUi();
      nodeMarkers.forEach((mk, id) => styleNodeMarker(id, mk));
      if ($hint)
        $hint.textContent =
          "Loaded " +
          nodeStore.size +
          " nodes. Click start then end (way endpoints).";
    } catch (e) {
      console.error(e);
      if ($hint)
        $hint.textContent =
          "Failed to load data: " + (e.message || String(e));
    }
  }

  function initMap() {
    map = L.map("map", { zoomControl: true, maxZoom: 22 });

    L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 22,
      maxNativeZoom: 17,
      attribution:
        '© <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    }).addTo(map);

    L.tileLayer("https://tile.waymarkedtrails.org/slopes/{z}/{x}/{y}.png", {
      maxZoom: 22,
      maxNativeZoom: 17,
      opacity: 0.55,
      attribution: '© <a href="https://slopes.waymarkedtrails.org/">Waymarked Trails</a>',
    }).addTo(map);
  }

  $resort.addEventListener("change", function () {
    const r = RESORTS.find((x) => x.id === $resort.value);
    if (r) loadResort(r);
  });
  $find.addEventListener("click", onFindRoute);
  $reset.addEventListener("click", onReset);

  if ($fwdHeader) {
    $fwdHeader.addEventListener("click", function (e) {
      e.preventDefault();
      showForwardOnly();
    });
    $fwdHeader.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        showForwardOnly();
      }
    });
  }
  if ($retHeader) {
    $retHeader.addEventListener("click", function (e) {
      e.preventDefault();
      showReturnOnly();
    });
    $retHeader.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        showReturnOnly();
      }
    });
  }

  initMap();
  loadResort(RESORTS[0]);
})();
