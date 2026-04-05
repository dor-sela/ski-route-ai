(function () {
  "use strict";

  /** @typedef {{ id: string, lat: number, lon: number, label: string }} GraphNode */
  /** @typedef {{ lat: number, lon: number }} LatLon */
  /** @typedef {{ to: string, lengthMeters: number, isLift: boolean, difficulty: string|null, tags: Record<string,string>, polyline: LatLon[], wayName: string|null, wayIdx: number }} GraphEdge */

  /** @typedef {{ goal: string, userMaxPiste: number }} RoutingContext */

  const RESORTS = [
    {
      id: "val-thorens",
      name: "Val Thorens (France)",
      center: [45.295, 6.58],
      zoom: 14,
      bbox: [45.28, 6.56, 45.31, 6.6],
    },
    {
      id: "chamonix",
      name: "Chamonix (France)",
      center: [45.9237, 6.8694],
      zoom: 12,
      bbox: [45.88, 6.84, 45.97, 7.06],
    },
    {
      id: "zermatt",
      name: "Zermatt (Switzerland)",
      center: [45.9763, 7.6586],
      zoom: 12,
      bbox: [45.94, 7.72, 46.02, 7.92],
    },
    {
      id: "whistler",
      name: "Whistler Blackcomb (Canada)",
      center: [50.058, -122.963],
      zoom: 11,
      bbox: [50.02, -123.08, 50.15, -122.85],
    },
    {
      id: "st-anton",
      name: "St. Anton (Austria)",
      center: [47.1278, 10.2636],
      zoom: 13,
      bbox: [47.095, 10.18, 47.16, 10.32],
    },
  ];

  const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

  function coordKey(lat, lon) {
    const rLat = Math.round(lat * 1e5) / 1e5;
    const rLon = Math.round(lon * 1e5) / 1e5;
    return rLat + "," + rLon;
  }

  async function fetchResortData(bbox) {
    const [s, w, n, e] = bbox;
    const q =
      `[out:json][timeout:125];
(
  way["piste:type"="downhill"](${s},${w},${n},${e});
  way["aerialway"](${s},${w},${n},${e});
);
out geom;`;
    const body = "data=" + encodeURIComponent(q);
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    });
    if (!res.ok) throw new Error("Overpass HTTP " + res.status);
    return res.json();
  }

  /** @type {L.Map|null} */
  let map = null;
  /** @type {L.TileLayer|null} */
  let baseLayer = null;

  let graphLayer = null;

  /** @type {L.Polyline[]} */
  let wayPolylines = [];

  /** Glowing overlays (on map, above base graph). */
  /** @type {L.LayerGroup|null} */
  let forwardGlowLayer = null;
  /** @type {L.LayerGroup|null} */
  let returnGlowLayer = null;

  /** @type {number[][]|null} */
  let lastReturnLatLngs = null;
  /** @type {number[][]|null} */
  let lastForwardLatLngs = null;

  /** @type {Map<string, GraphNode>} */
  let nodeStore = new Map();
  /** @type {Map<string, GraphEdge[]>} */
  let adjacency = new Map();

  /** @type {{ coords: LatLon[], tags: Record<string,string>, isLift: boolean, diffNorm: string|null, wayName: string|null }[]} */
  let lastParsedWays = [];

  /** @type {Map<string, L.CircleMarker>} */
  let nodeMarkers = new Map();

  let clickStage = 0;
  /** @type {string|null} */
  let startNodeId = null;
  /** @type {string|null} */
  let endNodeId = null;

  let currentResortId = RESORTS[0].id;

  const $resort = document.getElementById("resort-select");
  const $skill = document.getElementById("skill-select");
  const $goal = document.getElementById("goal-select");
  const $find = document.getElementById("find-route");
  const $reset = document.getElementById("reset-search");
  const $routeList = document.getElementById("route-steps");
  const $returnList = document.getElementById("return-trip-steps");
  const $returnSection = document.getElementById("return-trip-section");
  const $returnPanel = document.getElementById("return-trip-panel");
  const $loadingText = document.getElementById("loading-text");
  const $spinner = document.getElementById("loading-spinner");
  const $startDisp = document.getElementById("start-node-display");
  const $endDisp = document.getElementById("end-node-display");
  const $appHint = document.getElementById("app-hint");
  const $agentSection = document.getElementById("agent-output-section");
  const $routeHeading = document.getElementById("route-heading");

  function setLoading(on, msg) {
    if (on) {
      $loadingText.textContent = msg || "Loading…";
      $loadingText.classList.remove("hidden");
      $spinner.classList.remove("hidden");
      $find.disabled = true;
    } else {
      $loadingText.classList.add("hidden");
      $spinner.classList.add("hidden");
      $find.disabled = false;
    }
  }

  function bringNodeMarkersToFront() {
    nodeMarkers.forEach((m) => {
      if (m && m.bringToFront) m.bringToFront();
    });
  }

  function removeForwardGlow() {
    if (forwardGlowLayer && map) {
      map.removeLayer(forwardGlowLayer);
      forwardGlowLayer = null;
    }
  }

  function removeReturnGlow() {
    if (returnGlowLayer && map) {
      map.removeLayer(returnGlowLayer);
      returnGlowLayer = null;
    }
  }

  function removeAllRouteGlows() {
    removeForwardGlow();
    removeReturnGlow();
    lastReturnLatLngs = null;
    lastForwardLatLngs = null;
  }

  /**
   * @param {number[][]} latlngs
   * @param {'forward'|'return'} kind
   */
  function showRouteGlow(latlngs, kind) {
    if (!map || !latlngs || latlngs.length < 2) return;

    if (kind === "forward") {
      removeForwardGlow();
      forwardGlowLayer = L.layerGroup();
      const line = L.polyline(latlngs, {
        className: "route-glow-forward",
        color: "#facc15",
        weight: 8,
        opacity: 0.6,
        lineCap: "round",
        lineJoin: "round",
      });
      forwardGlowLayer.addLayer(line);
      forwardGlowLayer.addTo(map);
      forwardGlowLayer.bringToFront();
    } else {
      removeReturnGlow();
      returnGlowLayer = L.layerGroup();
      const line = L.polyline(latlngs, {
        className: "route-glow-return",
        color: "#22d3ee",
        weight: 8,
        opacity: 0.6,
        lineCap: "round",
        lineJoin: "round",
      });
      returnGlowLayer.addLayer(line);
      returnGlowLayer.addTo(map);
      returnGlowLayer.bringToFront();
    }
    bringNodeMarkersToFront();
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function polylineLengthMeters(coords) {
    let len = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      len += haversineMeters(a.lat, a.lon, b.lat, b.lon);
    }
    return len;
  }

  function normalizeDifficulty(tags) {
    const raw = (tags["piste:difficulty"] || tags["snowmobile:difficulty"] || "").toLowerCase();
    if (!raw) return null;
    if (["novice", "easy", "beginner"].includes(raw)) return "easy";
    if (["intermediate", "blue"].includes(raw)) return "intermediate";
    if (["advanced", "difficult", "red"].includes(raw)) return "advanced";
    if (["expert", "extreme", "freeride", "black", "yes"].includes(raw)) return "expert";
    return "intermediate";
  }

  function pisteStyle(diffNorm, isLift) {
    if (isLift) {
      return { color: "#94a3b8", weight: 3, opacity: 0.9, dashArray: "10 8", lineCap: "round" };
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
        return { color: "#64748b", weight: 2.5, opacity: 0.85 };
    }
  }

  function userMaxPisteTier(skillKey) {
    switch (skillKey) {
      case "never":
      case "first-week":
        return 1;
      case "low-intermediate":
        return 2;
      case "high-intermediate":
        return 3;
      case "advanced":
        return 4;
      case "expert":
      case "extreme":
        return 4;
      default:
        return 2;
    }
  }

  function pisteTier(diffNorm) {
    if (diffNorm === "easy") return 1;
    if (diffNorm === "intermediate") return 2;
    if (diffNorm === "advanced") return 3;
    if (diffNorm === "expert") return 4;
    return 2;
  }

  function getRoutingContext() {
    return {
      goal: ($goal && $goal.value) || "comfort",
      userMaxPiste: userMaxPisteTier(($skill && $skill.value) || "low-intermediate"),
    };
  }

  /**
   * Return trip: penalize downhill pistes heavily; favor lifts and gentler connectors.
   * @param {GraphEdge} edge
   */
  function edgeWeightReturnLiftPreferred(edge) {
    let w = edge.lengthMeters;
    if (edge.isLift) return w * 0.35;
    if (edge.difficulty === "easy") return w * 12;
    return w * 500;
  }

  function edgeWeight(edge, ctx) {
    let w = edge.lengthMeters;

    if (ctx.goal === "direct") return w;

    if (edge.isLift) {
      if (ctx.goal === "relaxed") w *= 0.85;
      if (ctx.goal === "training") w *= 1.2;
      if (ctx.goal === "scenic") w *= 0.9;
      return w;
    }

    if (ctx.goal === "relaxed") w *= 5;
    if (ctx.goal === "training") w *= 0.75;
    if (ctx.goal === "scenic") w *= 1.15;

    const userMax = ctx.userMaxPiste;
    const P = pisteTier(edge.difficulty);

    if (ctx.goal === "progression") {
      if (P > userMax + 1) w *= 100;
      else if (P === userMax + 1) w *= 2.5;
    } else {
      if (P > userMax) w *= 100;
    }

    return w;
  }

  function redrawAllTracksFromData() {
    if (!graphLayer || !map) return;
    for (const pl of wayPolylines) {
      if (pl && graphLayer.hasLayer(pl)) graphLayer.removeLayer(pl);
    }
    wayPolylines = [];
    lastParsedWays.forEach((way) => {
      const latlngs = way.coords.map((c) => [c.lat, c.lon]);
      const st = pisteStyle(way.diffNorm, way.isLift);
      const track = L.polyline(latlngs, st);
      wayPolylines.push(track);
      graphLayer.addLayer(track);
    });
    wayPolylines.forEach((pl) => {
      if (pl && pl.bringToBack) pl.bringToBack();
    });
    bringNodeMarkersToFront();
  }

  function osmWayName(tags) {
    const n = (tags.name || tags["name:en"] || "").trim();
    return n || null;
  }

  function assignNodeLabels() {
    nodeStore.forEach((node) => {
      const names = [];
      const seen = new Set();
      for (const e of adjacency.get(node.id) || []) {
        if (e.wayName && !seen.has(e.wayName)) {
          seen.add(e.wayName);
          names.push(e.wayName);
        }
      }
      if (names.length >= 2) {
        node.label =
          "Intersection near " + names.slice(0, 2).join(" & ") + (names.length > 2 ? " +" + (names.length - 2) : "");
      } else if (names.length === 1) {
        node.label = "Junction near " + names[0];
      } else {
        node.label = "Waypoint (" + node.lat.toFixed(4) + ", " + node.lon.toFixed(4) + ")";
      }
    });
  }

  function mergePathEdgeGroups(pathEdges) {
    if (!pathEdges || !pathEdges.length) return [];
    const groups = [];
    let cur = pathEdges[0];
    for (let i = 1; i < pathEdges.length; i++) {
      const e = pathEdges[i];
      const merge = !!(cur.wayName && e.wayName === cur.wayName && e.isLift === cur.isLift);
      if (merge) continue;
      groups.push(cur);
      cur = e;
    }
    groups.push(cur);
    return groups;
  }

  function difficultyListLabel(diffNorm) {
    if (diffNorm === "easy") return "Green";
    if (diffNorm === "intermediate") return "Blue";
    if (diffNorm === "advanced") return "Red";
    if (diffNorm === "expert") return "Black";
    return "Piste";
  }

  function edgeMidpointLatLng(edge) {
    const pl = edge.polyline;
    if (!pl || !pl.length) return null;
    const m = pl[Math.floor(pl.length / 2)];
    return [m.lat, m.lon];
  }

  function pulseMarker(nodeId) {
    const mk = nodeMarkers.get(nodeId);
    if (!mk) return;
    let n = 0;
    const timer = setInterval(() => {
      const flashOn = n % 2 === 0;
      mk.setStyle({
        radius: flashOn ? 11 : 5,
        weight: flashOn ? 3 : 2,
        color: flashOn ? "#f59e0b" : "#eab308",
        fillColor: flashOn ? "#fef9c3" : "#fde047",
        fillOpacity: 1,
      });
      n++;
      if (n >= 8) {
        clearInterval(timer);
        applyNodeMarkerStyle(nodeId, mk);
      }
    }, 130);
  }

  function flyToRouteStep(latlng, isNode, nodeId) {
    if (!map || !latlng) return;
    map.flyTo(latlng, 16, { duration: 0.55 });
    if (isNode && nodeId) {
      pulseMarker(nodeId);
      const mk = nodeMarkers.get(nodeId);
      if (mk) mk.openPopup();
    }
  }

  function vertexLineLabel(nodeId, role) {
    const n = nodeStore.get(nodeId);
    const lbl = n && n.label ? n.label : "Unnamed junction";
    if (role === "start") return "Vertex: " + lbl + " (Start)";
    if (role === "end") return "Vertex: " + lbl + " (End)";
    return "Vertex: " + lbl + " (via)";
  }

  function segmentLineLabel(e) {
    const name = e.wayName || "Unnamed";
    if (e.isLift) return "Lift: " + name;
    return "Piste: " + name + " (" + difficultyListLabel(e.difficulty) + ")";
  }

  /**
   * Outbound list: each vertex and each piste/lift segment, all clickable.
   * @param {string[]} pathNodeIds
   * @param {GraphEdge[]|null|undefined} pathEdges
   */
  function fillForwardRouteFull(pathNodeIds, pathEdges) {
    if (!$routeList || !pathNodeIds.length) return;
    $routeList.innerHTML = "";
    let stepNum = 1;

    function addLi(text, className, onActivate) {
      const li = document.createElement("li");
      li.className = className;
      li.textContent = stepNum++ + ". " + text;
      li.setAttribute("tabindex", "0");
      li.setAttribute("role", "button");
      li.addEventListener("click", (ev) => {
        ev.stopPropagation();
        onActivate();
      });
      li.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          onActivate();
        }
      });
      $routeList.appendChild(li);
    }

    if (!pathEdges || !pathEdges.length) {
      pathNodeIds.forEach((nodeId, i) => {
        const role = i === 0 ? "start" : i === pathNodeIds.length - 1 ? "end" : "via";
        const nu = nodeStore.get(nodeId);
        addLi(vertexLineLabel(nodeId, role), "route-node-item", () => {
          if (nu) flyToRouteStep([nu.lat, nu.lon], true, nodeId);
        });
      });
      return;
    }

    for (let i = 0; i < pathEdges.length; i++) {
      const role = i === 0 ? "start" : "via";
      const u = pathNodeIds[i];
      const nu = nodeStore.get(u);
      addLi(vertexLineLabel(u, role), "route-node-item", () => {
        if (nu) flyToRouteStep([nu.lat, nu.lon], true, u);
      });

      const e = pathEdges[i];
      const mid = edgeMidpointLatLng(e);
      addLi(segmentLineLabel(e), "route-segment-item", () => {
        if (mid) flyToRouteStep(mid, false, null);
      });
    }

    const lastId = pathNodeIds[pathNodeIds.length - 1];
    const lastN = nodeStore.get(lastId);
    addLi(vertexLineLabel(lastId, "end"), "route-node-item", () => {
      if (lastN) flyToRouteStep([lastN.lat, lastN.lon], true, lastId);
    });
  }

  function setReturnSectionVisible(visible) {
    if (!$returnSection) return;
    if (visible) $returnSection.classList.remove("hidden");
    else $returnSection.classList.add("hidden");
  }

  /** Narrative list: End → segments → Start */
  function fillReturnTripList(pathNodeIds, pathEdges) {
    if (!$returnList) return;
    $returnList.innerHTML = "";
    if (!pathNodeIds || pathNodeIds.length < 2) return;

    let step = 1;
    function add(text) {
      const li = document.createElement("li");
      li.textContent = step++ + ". " + text;
      $returnList.appendChild(li);
    }

    const nEnd = nodeStore.get(pathNodeIds[0]);
    add(
      "Vertex: " + (nEnd && nEnd.label ? nEnd.label : "End") + " (End)"
    );

    const groups = mergePathEdgeGroups(pathEdges || []);
    for (const e of groups) {
      const baseName = e.wayName || "Unnamed";
      if (e.isLift) add("Lift: " + baseName);
      else add("Piste: " + baseName + " (" + difficultyListLabel(e.difficulty) + ")");
    }

    const nStart = nodeStore.get(pathNodeIds[pathNodeIds.length - 1]);
    add(
      "Vertex: " + (nStart && nStart.label ? nStart.label : "Start") + " (Start)"
    );
  }

  function clearOutputLists() {
    if ($routeList) $routeList.innerHTML = "";
    if ($returnList) $returnList.innerHTML = "";
    setReturnSectionVisible(false);
  }

  function setAgentOutputVisible(visible) {
    if (!$agentSection) return;
    if (visible) $agentSection.classList.remove("hidden");
    else $agentSection.classList.add("hidden");
  }

  class MinHeap {
    constructor() {
      /** @type {{d:number, id:string}[]} */
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

  function dijkstra(graph, start, end, weightFn) {
    const dist = new Map();
    const prev = new Map();
    for (const k of graph.keys()) dist.set(k, Infinity);
    if (!graph.has(start) || !graph.has(end)) return { path: null, edges: null, dist: Infinity };

    dist.set(start, 0);
    const heap = new MinHeap();
    heap.push(0, start);

    while (true) {
      const cur = heap.pop();
      if (!cur) break;
      const { d: du, id: u } = cur;
      if (du > dist.get(u)) continue;
      if (u === end) break;

      const edges = graph.get(u);
      if (!edges) continue;
      for (const e of edges) {
        const w = weightFn(e);
        const alt = du + w;
        const dv = dist.get(e.to);
        if (alt < dv) {
          dist.set(e.to, alt);
          prev.set(e.to, { from: u, edge: e });
          heap.push(alt, e.to);
        }
      }
    }

    const finalD = dist.get(end);
    if (finalD === Infinity) return { path: null, edges: null, dist: Infinity };

    const nodes = [];
    const pathEdges = [];
    let cur = end;
    while (cur && cur !== start) {
      nodes.push(cur);
      const p = prev.get(cur);
      if (!p) return { path: null, edges: null, dist: Infinity };
      pathEdges.push(p.edge);
      cur = p.from;
    }
    nodes.push(start);
    nodes.reverse();
    pathEdges.reverse();
    return { path: nodes, edges: pathEdges, dist: finalD };
  }

  function addUndirectedEdge(a, b, metaToB, metaToA) {
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push({ ...metaToB, to: b });
    adjacency.get(b).push({ ...metaToA, to: a });
  }

  function reversePolyline(pl) {
    return pl.slice().reverse();
  }

  function buildGraphFromOverpassGeom(json) {
    nodeStore = new Map();
    adjacency = new Map();
    lastParsedWays = [];

    const elements = json.elements || [];
    const parsed = [];

    for (const el of elements) {
      if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
      const tags = el.tags || {};
      const isDownhill = tags["piste:type"] === "downhill";
      const isLift = tags["aerialway"] != null && tags["aerialway"] !== "no";
      if (!isDownhill && !isLift) continue;
      const coords = el.geometry.map((g) => ({ lat: g.lat, lon: g.lon }));
      const diffNorm = isDownhill ? normalizeDifficulty(tags) : null;
      const wayName = osmWayName(tags);
      parsed.push({ coords, tags, isLift, diffNorm, wayName });
    }

    lastParsedWays = parsed;

    if (!parsed.length) return;

    const keyToWayIdx = new Map();
    parsed.forEach((way, wi) => {
      way.coords.forEach((pt) => {
        const k = coordKey(pt.lat, pt.lon);
        if (!keyToWayIdx.has(k)) keyToWayIdx.set(k, new Set());
        keyToWayIdx.get(k).add(wi);
      });
    });

    const intersectionKeys = new Set();
    keyToWayIdx.forEach((set, k) => {
      if (set.size >= 2) intersectionKeys.add(k);
    });

    function isGraphVertex(way, idx) {
      const pt = way.coords[idx];
      const k = coordKey(pt.lat, pt.lon);
      const atEnd = idx === 0 || idx === way.coords.length - 1;
      const inter = intersectionKeys.has(k);
      if (way.isLift) return atEnd || inter;
      return atEnd || inter;
    }

    parsed.forEach((way, wayIdx) => {
      const idxs = [];
      for (let i = 0; i < way.coords.length; i++) {
        if (isGraphVertex(way, i)) idxs.push(i);
      }
      if (idxs.length < 2) return;

      for (let t = 0; t < idxs.length - 1; t++) {
        const i0 = idxs[t];
        const i1 = idxs[t + 1];
        if (i1 <= i0) continue;
        const aPt = way.coords[i0];
        const bPt = way.coords[i1];
        const ka = coordKey(aPt.lat, aPt.lon);
        const kb = coordKey(bPt.lat, bPt.lon);
        if (ka === kb) continue;

        const forward = way.coords.slice(i0, i1 + 1).map((p) => ({ lat: p.lat, lon: p.lon }));
        const backward = reversePolyline(forward);
        const len = polylineLengthMeters(forward);
        if (len < 0.25) continue;

        if (!nodeStore.has(ka))
          nodeStore.set(ka, { id: ka, lat: aPt.lat, lon: aPt.lon, label: "" });
        if (!nodeStore.has(kb))
          nodeStore.set(kb, { id: kb, lat: bPt.lat, lon: bPt.lon, label: "" });

        const base = {
          lengthMeters: len,
          isLift: way.isLift,
          difficulty: way.diffNorm,
          tags: way.tags,
          wayName: way.wayName,
          wayIdx: wayIdx,
        };
        addUndirectedEdge(ka, kb, { ...base, polyline: forward }, { ...base, polyline: backward });
      }
    });

    for (const id of [...nodeStore.keys()]) {
      const edges = adjacency.get(id);
      if (!edges || edges.length === 0) {
        nodeStore.delete(id);
        adjacency.delete(id);
      }
    }

    assignNodeLabels();
  }

  function clearGraphLayer() {
    removeAllRouteGlows();
    if (graphLayer && map) {
      map.removeLayer(graphLayer);
      graphLayer = null;
    }
    wayPolylines = [];
    nodeMarkers.clear();
  }

  function refreshNodeMarkerStyles() {
    nodeMarkers.forEach((m, id) => applyNodeMarkerStyle(id, m));
  }

  function applyNodeMarkerStyle(nodeId, marker) {
    const isStart = nodeId === startNodeId;
    const isEnd = nodeId === endNodeId;
    if (isStart) {
      marker.setStyle({
        radius: 5,
        color: "#15803d",
        weight: 2,
        fillColor: "#4ade80",
        fillOpacity: 0.95,
      });
    } else if (isEnd) {
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

  function nodeLabel(nodeId) {
    const n = nodeStore.get(nodeId);
    if (!n) return "—";
    const title = n.label || n.id;
    return title + "  (" + n.lat.toFixed(5) + ", " + n.lon.toFixed(5) + ")";
  }

  function updateSelectionInputs() {
    $startDisp.value = startNodeId ? nodeLabel(startNodeId) : "—";
    $endDisp.value = endNodeId ? nodeLabel(endNodeId) : "—";
  }

  function onVertexMarkerClick(nodeId, ev) {
    L.DomEvent.stopPropagation(ev);
    const setStart = clickStage % 2 === 0;
    if (setStart) startNodeId = nodeId;
    else endNodeId = nodeId;
    clickStage++;
    refreshNodeMarkerStyles();
    updateSelectionInputs();
    const mk = nodeMarkers.get(nodeId);
    if (mk) mk.bindPopup(setStart ? "Start" : "End").openPopup();
  }

  function renderGraphOnMap() {
    clearGraphLayer();
    if (!map) return;

    graphLayer = L.layerGroup();
    wayPolylines = [];

    lastParsedWays.forEach((way) => {
      const latlngs = way.coords.map((c) => [c.lat, c.lon]);
      const st = pisteStyle(way.diffNorm, way.isLift);
      const track = L.polyline(latlngs, st);
      wayPolylines.push(track);
      graphLayer.addLayer(track);
    });

    nodeStore.forEach((node, id) => {
      const marker = L.circleMarker([node.lat, node.lon], {
        radius: 3,
        color: "#4338ca",
        weight: 1,
        fillColor: "#a5b4fc",
        fillOpacity: 0.85,
      });
      marker.on("click", (e) => onVertexMarkerClick(id, e));
      marker.on("mouseover", () => marker.setStyle({ weight: 2 }));
      marker.on("mouseout", () => applyNodeMarkerStyle(id, marker));
      graphLayer.addLayer(marker);
      nodeMarkers.set(id, marker);
    });

    refreshNodeMarkerStyles();
    graphLayer.addTo(map);
  }

  function mergePathLatLngs(pathEdges, pathNodeIds) {
    if (!pathEdges || !pathEdges.length) {
      return pathNodeIds.map((id) => {
        const n = nodeStore.get(id);
        return [n.lat, n.lon];
      });
    }
    const out = [];
    for (let i = 0; i < pathEdges.length; i++) {
      const pl = pathEdges[i].polyline;
      if (!pl || pl.length === 0) continue;
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
    if (out.length < 2) {
      return pathNodeIds.map((id) => {
        const n = nodeStore.get(id);
        return [n.lat, n.lon];
      });
    }
    return out;
  }

  function showForwardHighlightOnMap() {
    if (!lastForwardLatLngs || lastForwardLatLngs.length < 2 || !map) return;
    removeReturnGlow();
    showRouteGlow(lastForwardLatLngs, "forward");
    map.fitBounds(L.latLngBounds(lastForwardLatLngs), {
      padding: [48, 48],
      maxZoom: 16,
    });
    bringNodeMarkersToFront();
  }

  function onReturnTripPanelActivate() {
    if (!lastReturnLatLngs || lastReturnLatLngs.length < 2 || !map) return;
    removeForwardGlow();
    showRouteGlow(lastReturnLatLngs, "return");
    map.fitBounds(L.latLngBounds(lastReturnLatLngs), { padding: [48, 48], maxZoom: 16 });
    bringNodeMarkersToFront();
  }

  function drawRoute(pathNodeIds, pathEdges) {
    if (!pathNodeIds || pathNodeIds.length < 2) return;

    redrawAllTracksFromData();
    removeReturnGlow();

    const forwardLatLngs = mergePathLatLngs(pathEdges, pathNodeIds);
    lastForwardLatLngs = forwardLatLngs.slice();
    showRouteGlow(forwardLatLngs, "forward");

    if (forwardLatLngs.length >= 2 && map) {
      map.fitBounds(L.latLngBounds(forwardLatLngs), { padding: [48,48], maxZoom: 16 });
    }

    fillForwardRouteFull(pathNodeIds, pathEdges);
    setAgentOutputVisible(true);

    const ret = dijkstra(adjacency, endNodeId, startNodeId, edgeWeightReturnLiftPreferred);
    if (ret.path && ret.edges && ret.path.length >= 2) {
      lastReturnLatLngs = mergePathLatLngs(ret.edges, ret.path);
      fillReturnTripList(ret.path, ret.edges);
      setReturnSectionVisible(true);
    } else {
      lastReturnLatLngs = null;
      if ($returnList) $returnList.innerHTML = "";
      setReturnSectionVisible(false);
    }

    bringNodeMarkersToFront();
  }

  function clearRoute() {
    removeAllRouteGlows();
    if (graphLayer && map) redrawAllTracksFromData();
    clearOutputLists();
  }

  function resetSearch() {
    startNodeId = null;
    endNodeId = null;
    clickStage = 0;
    removeAllRouteGlows();
    if (graphLayer && map) redrawAllTracksFromData();
    refreshNodeMarkerStyles();
    updateSelectionInputs();
    clearOutputLists();
    setAgentOutputVisible(false);
    const r = RESORTS.find((x) => x.id === currentResortId);
    if (map && r) map.setView(r.center, r.zoom);
    if ($appHint)
      $appHint.textContent =
        "Selection cleared. Click two nodes for Start and End, then Find Route.";
  }

  async function loadResort(resort) {
    setLoading(true, "Fetching pistes & lifts from Overpass…");
    clearRoute();
    setAgentOutputVisible(false);
    try {
      const data = await fetchResortData(resort.bbox);
      setLoading(true, "Building graph from geometry…");
      buildGraphFromOverpassGeom(data);
      if (nodeStore.size === 0) {
        if ($appHint)
          $appHint.innerHTML =
            '<span class="text-amber-400">No ski geometry in this bbox. Try another resort.</span>';
        clearGraphLayer();
        setLoading(false);
        return;
      }
      if (map && baseLayer) {
        map.setView(resort.center, resort.zoom);
        renderGraphOnMap();
      }
      startNodeId = endNodeId = null;
      clickStage = 0;
      updateSelectionInputs();
      if ($appHint)
        $appHint.innerHTML =
          "Loaded <strong>" +
          nodeStore.size +
          "</strong> graph nodes and <strong>" +
          lastParsedWays.length +
          "</strong> OSM ways. Set Start and End, then <strong>Find Route</strong>.";
    } catch (err) {
      console.error(err);
      const msg =
        err && err.message
          ? String(err.message)
          : "Unknown error (CORS or network). file:// may block fetch — use a static HTTP server.";
      if ($appHint)
        $appHint.innerHTML =
          '<span class="text-red-400">Could not load resort data: ' + escapeHtml(msg) + "</span>";
    } finally {
      setLoading(false);
    }
  }

  function initMap() {
    map = L.map("map", { zoomControl: true, maxZoom: 22 });

    baseLayer = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 22,
      maxNativeZoom: 17,
      attribution:
        'Map: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors,' +
        ' <a href="http://viewfinderpanoramas.org">SRTM</a> | ' +
        'Style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> ' +
        '(<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
    }).addTo(map);

    L.tileLayer("https://tile.waymarkedtrails.org/slopes/{z}/{x}/{y}.png", {
      maxZoom: 22,
      maxNativeZoom: 18,
      opacity: 0.55,
      attribution:
        'Ski slopes overlay: &copy; <a href="https://slopes.waymarkedtrails.org/">Waymarked Trails</a>',
    }).addTo(map);

    const legend = L.control({ position: "bottomright" });
    legend.onAdd = function () {
      const div = L.DomUtil.create("div", "map-legend leaflet-bar");
      div.innerHTML =
        "<h3>Legend</h3>" +
        '<div class="row"><span class="swatch" style="background:#22c55e"></span> Piste: green (easy)</div>' +
        '<div class="row"><span class="swatch" style="background:#2563eb"></span> Piste: blue</div>' +
        '<div class="row"><span class="swatch" style="background:#dc2626"></span> Piste: red</div>' +
        '<div class="row"><span class="swatch" style="background:#0f172a;border:1px solid #64748b"></span> Piste: black</div>' +
        '<div class="row"><span class="swatch lift"></span> Lift: grey, dashed</div>';
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    };
    legend.addTo(map);

    const r = RESORTS[0];
    map.setView(r.center, r.zoom);
  }

  function populateSelects() {
    $resort.innerHTML = RESORTS.map(
      (r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`
    ).join("");
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function onFindRoute() {
    removeAllRouteGlows();
    redrawAllTracksFromData();

    const ctx = getRoutingContext();

    if (!startNodeId || !endNodeId) {
      if ($appHint)
        $appHint.innerHTML =
          '<span class="text-amber-400">Click two graph nodes on the map for Start and End first.</span>';
      setAgentOutputVisible(false);
      clearOutputLists();
      return;
    }
    if (startNodeId === endNodeId) {
      if ($appHint)
        $appHint.innerHTML =
          '<span class="text-amber-400">Start and End must be different nodes.</span>';
      setAgentOutputVisible(false);
      clearOutputLists();
      return;
    }

    const wfn = (e) => edgeWeight(e, ctx);
    const result = dijkstra(adjacency, startNodeId, endNodeId, wfn);
    if (!result.path) {
      if ($appHint)
        $appHint.innerHTML =
          '<span class="text-amber-400">No connected route between the chosen nodes in this graph.</span>';
      setAgentOutputVisible(false);
      clearOutputLists();
      clearRoute();
      return;
    }
    drawRoute(result.path, result.edges);
  }

  populateSelects();
  initMap();

  if ($routeHeading) {
    $routeHeading.addEventListener("click", (e) => {
      e.stopPropagation();
      showForwardHighlightOnMap();
    });
    $routeHeading.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        showForwardHighlightOnMap();
      }
    });
  }

  if ($returnPanel) {
    $returnPanel.addEventListener("click", onReturnTripPanelActivate);
    $returnPanel.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onReturnTripPanelActivate();
      }
    });
  }

  $resort.addEventListener("change", () => {
    currentResortId = $resort.value;
    const r = RESORTS.find((x) => x.id === currentResortId);
    if (r) loadResort(r);
  });

  $find.addEventListener("click", onFindRoute);
  if ($reset) $reset.addEventListener("click", resetSearch);

  loadResort(RESORTS[0]);
})();
