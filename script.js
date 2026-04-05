(function () {
  "use strict";

  /** @typedef {{ id: string, lat: number, lon: number, label: string }} GraphNode */
  /** @typedef {{ lat: number, lon: number }} LatLon */
  /** @typedef {{ to: string, lengthMeters: number, isLift: boolean, difficulty: string|null, tags: Record<string,string>, polyline: LatLon[], wayName: string|null, wayIdx: number }} GraphEdge */

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

  /** Round for stable intersection keys (~1.1 m). */
  function coordKey(lat, lon) {
    const rLat = Math.round(lat * 1e5) / 1e5;
    const rLon = Math.round(lon * 1e5) / 1e5;
    return rLat + "," + rLon;
  }

  /**
   * @param {number[]} bbox [south, west, north, east]
   * @returns {Promise<any>}
   */
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
  let routeLayer = null;
  /** Piste/lift polylines aligned with `lastParsedWays` indices (not including node markers). */
  /** @type {L.Polyline[]} */
  let wayPolylines = [];

  /** @type {Map<string, GraphNode>} */
  let nodeStore = new Map();
  /** @type {Map<string, GraphEdge[]>} */
  let adjacency = new Map();

  /** Raw ways for styling (from last build). */
  /** @type {{ coords: LatLon[], tags: Record<string,string>, isLift: boolean, diffNorm: string|null, wayName: string|null }[]} */
  let lastParsedWays = [];

  /** @type {Map<string, L.CircleMarker>} */
  let nodeMarkers = new Map();

  let clickStage = 0;
  /** @type {string|null} */
  let startNodeId = null;
  /** @type {string|null} */
  let endNodeId = null;

  /** @type {string} */
  let currentResortId = RESORTS[0].id;

  const $resort = document.getElementById("resort-select");
  const $time = document.getElementById("time-select");
  const $chat = document.getElementById("chat-input");
  const $find = document.getElementById("find-route");
  const $out = document.getElementById("agent-output");
  const $loadingText = document.getElementById("loading-text");
  const $spinner = document.getElementById("loading-spinner");
  const $startDisp = document.getElementById("start-node-display");
  const $endDisp = document.getElementById("end-node-display");
  const $appHint = document.getElementById("app-hint");
  const $agentSection = document.getElementById("agent-output-section");

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

  /** Restore one track polyline to default ski styling (full opacity). */
  function applyDefaultStyleToTrackPolyline(index) {
    const pl = wayPolylines[index];
    const way = lastParsedWays[index];
    if (!pl || !way) return;
    const st = pisteStyle(way.diffNorm, way.isLift);
    pl.setStyle({
      color: st.color,
      weight: st.weight,
      opacity: st.opacity,
      dashArray: st.dashArray,
      lineCap: st.lineCap || "round",
    });
  }

  /** Reset every drawn piste/lift to original colors, weights, and full opacity. */
  function resetAllTrackStyles() {
    for (let i = 0; i < wayPolylines.length; i++) applyDefaultStyleToTrackPolyline(i);
  }

  /**
   * Fade tracks whose way index is not used by the optimal path.
   * @param {Set<number>} usedWayIndices
   */
  function dimTracksNotOnPath(usedWayIndices) {
    for (let i = 0; i < wayPolylines.length; i++) {
      if (usedWayIndices.has(i)) {
        applyDefaultStyleToTrackPolyline(i);
        continue;
      }
      const pl = wayPolylines[i];
      const way = lastParsedWays[i];
      if (!pl || !way) continue;
      const base = pisteStyle(way.diffNorm, way.isLift);
      pl.setStyle({
        color: base.color,
        weight: 1,
        opacity: 0.15,
        dashArray: base.dashArray,
        lineCap: base.lineCap || "round",
      });
    }
  }

  /** @param {GraphEdge[]|null|undefined} pathEdges */
  function pathUsedWayIndices(pathEdges) {
    const s = new Set();
    if (!pathEdges) return s;
    for (const e of pathEdges) {
      if (typeof e.wayIdx === "number") s.add(e.wayIdx);
    }
    return s;
  }

  /** @param {Record<string,string>} tags */
  function osmWayName(tags) {
    const n = (tags.name || tags["name:en"] || "").trim();
    return n || null;
  }

  /** After graph build, assign human-readable labels to vertices from incident named ways. */
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
      const merge =
        !!(cur.wayName && e.wayName === cur.wayName && e.isLift === cur.isLift);
      if (merge) continue;
      groups.push(cur);
      cur = e;
    }
    groups.push(cur);
    return groups;
  }

  function difficultyRunPhrase(d) {
    if (!d) return "ski run (grade not tagged)";
    if (d === "easy") return "green run";
    if (d === "intermediate") return "blue run";
    if (d === "advanced") return "red run";
    if (d === "expert") return "black run";
    return "ski run";
  }

  function buildNarrativeHTML(pathNodeIds, pathEdges, nlp, timeOfDay) {
    const startN = nodeStore.get(pathNodeIds[0]);
    const endN = nodeStore.get(pathNodeIds[pathNodeIds.length - 1]);
    const startName = (startN && startN.label) || pathNodeIds[0];
    const endName = (endN && endN.label) || pathNodeIds[pathNodeIds.length - 1];

    let html = "";
    html += `<p>Based on your request for a <strong>${escapeHtml(nlp.skill)}</strong> route (goal: <strong>${escapeHtml(
      nlp.goal
    )}</strong>) at <strong>${escapeHtml(timeOfDay)}</strong>, I minimized cost on the live OSM ski network — distance (Haversine), time-of-day congestion on lifts, and terrain penalties from your agent profile.</p>`;

    if (nlp.skill === "beginner") {
      html += `<p>Interpreting this as a beginner-focused plan, I heavily penalized black and expert-tagged pistes so the solver prefers greens and blues wherever tags exist, similar to: “I avoided black runs.”</p>`;
    }
    if (nlp.skill === "expert") {
      html += `<p>For an advanced skier, expert and advanced pistes receive lower effective cost than for a novice, so the line can follow steeper named runs when they shorten the path.</p>`;
    }
    if (nlp.goal === "warmup") {
      html += `<p>Warmup routing nudges weights toward easier corridors for the first segments of your day.</p>`;
    }

    html += `<p class="mt-2"><strong>Step-by-step</strong> (piste and lift names from OpenStreetMap <code>name</code> tags where available):</p><ol>`;
    html += `<li>Start at <strong>${escapeHtml(String(startName))}</strong>.</li>`;

    const groups = mergePathEdgeGroups(pathEdges || []);
    for (const e of groups) {
      const nm = e.wayName || (e.isLift ? "Unnamed lift" : "Unnamed piste");
      if (e.isLift) {
        html += `<li>Take the <strong>${escapeHtml(nm)}</strong> lift.</li>`;
      } else {
        const col = difficultyRunPhrase(e.difficulty);
        html += `<li>Ski down <strong>${escapeHtml(nm)}</strong> — the <strong>${escapeHtml(col)}</strong>. Follow the dashed yellow overlay; the green, blue, red, and black polylines remain visible underneath.</li>`;
      }
    }
    html += `<li>Reach your destination at <strong>${escapeHtml(String(endName))}</strong>.</li>`;
    html += `</ol>`;
    return html;
  }

  function setAgentOutputVisible(visible) {
    if (!$agentSection) return;
    if (visible) $agentSection.classList.remove("hidden");
    else $agentSection.classList.add("hidden");
  }

  function parseAgentText(text) {
    const low = (text || "").toLowerCase();
    let skill = "intermediate";
    if (/\b(beginner|first[\s-]*timer|novice|never skied|learning)\b/.test(low)) skill = "beginner";
    else if (/\b(expert|advanced|double[\s-]*black|very advanced|training laps|steep)\b/.test(low))
      skill = "expert";

    let goal = "general";
    if (/\bwarm[\s-]*up|easy start|easy morning|first runs?\b/.test(low)) goal = "warmup";

    return { skill, goal };
  }

  function calculateCongestion(timeOfDay, isLift) {
    const parts = (timeOfDay || "12:00").split(":");
    const h = parseInt(parts[0], 10) || 12;
    if (isLift) {
      if (h >= 9 && h < 11) return 5;
      if (h === 13) return 3;
      if (h === 16) return 4;
      return 1;
    }
    if (h === 13) return 1.85;
    if (h === 16) return 2.35;
    if (h >= 9 && h < 11) return 1.15;
    return 1;
  }

  function agentPenalty(diffNorm, nlp) {
    if (!diffNorm) return 1;
    let m = 1;
    const easy = diffNorm === "easy";
    const inter = diffNorm === "intermediate";
    const adv = diffNorm === "advanced";
    const exp = diffNorm === "expert";

    if (nlp.skill === "beginner") {
      if (adv) m *= 4.2;
      if (exp) m *= 6.5;
    } else if (nlp.skill === "expert") {
      if (easy) m *= 1.2;
      if (adv || exp) m *= 0.8;
    }
    if (nlp.goal === "warmup") {
      if (easy) m *= 0.62;
      if (inter) m *= 0.88;
      if (adv) m *= 2.4;
      if (exp) m *= 3.6;
    }
    return m;
  }

  function edgeWeight(edge, timeOfDay, nlp) {
    const cong = calculateCongestion(timeOfDay, edge.isLift);
    const pen = edge.isLift ? 1 : agentPenalty(edge.difficulty, nlp);
    return edge.lengthMeters * cong * pen;
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

  /**
   * Build graph from Overpass JSON with `out geom`.
   * Vertices: way endpoints, lift endpoints, coordinate shared by ≥2 ways.
   */
  function buildGraphFromOverpassGeom(json) {
    nodeStore = new Map();
    adjacency = new Map();
    lastParsedWays = [];

    const elements = json.elements || [];
    /** @type {{ coords: LatLon[], tags: Record<string,string>, isLift: boolean, diffNorm: string|null, wayName: string|null }[]} */
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

    /** @type {Map<string, Set<number>>} */
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

    /** @param {typeof parsed[number]} way @param {number} idx */
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

  function clearRoute() {
    if (routeLayer && map) {
      map.removeLayer(routeLayer);
      routeLayer = null;
    }
    resetAllTrackStyles();
  }

  function analyzePathFromNodePath(pathNodeIds) {
    const c = { lift: 0, easy: 0, intermediate: 0, advanced: 0, expert: 0, unknown: 0 };
    for (let i = 0; i < pathNodeIds.length - 1; i++) {
      const u = pathNodeIds[i];
      const v = pathNodeIds[i + 1];
      const edges = adjacency.get(u) || [];
      const e = edges.find((x) => x.to === v);
      if (!e) continue;
      if (e.isLift) {
        c.lift++;
        continue;
      }
      const d = e.difficulty;
      if (!d) c.unknown++;
      else if (d === "easy") c.easy++;
      else if (d === "intermediate") c.intermediate++;
      else if (d === "advanced") c.advanced++;
      else if (d === "expert") c.expert++;
    }
    return c;
  }

  /** @param {GraphEdge[]} pathEdges */
  function analyzePathFromEdges(pathEdges) {
    const c = { lift: 0, easy: 0, intermediate: 0, advanced: 0, expert: 0, unknown: 0 };
    for (const e of pathEdges) {
      if (e.isLift) {
        c.lift++;
        continue;
      }
      const d = e.difficulty;
      if (!d) c.unknown++;
      else if (d === "easy") c.easy++;
      else if (d === "intermediate") c.intermediate++;
      else if (d === "advanced") c.advanced++;
      else if (d === "expert") c.expert++;
    }
    return c;
  }

  /** @param {GraphEdge[]|null} pathEdges */
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

  /** @param {string[]|null} pathNodeIds @param {GraphEdge[]|null} pathEdges */
  function drawRoute(pathNodeIds, pathEdges, nlp, timeOfDay) {
    clearRoute();
    if (!pathNodeIds || pathNodeIds.length < 2) return;
    const latlngs = mergePathLatLngs(pathEdges, pathNodeIds);

    resetAllTrackStyles();
    const usedWays = pathUsedWayIndices(pathEdges);
    dimTracksNotOnPath(usedWays);

    routeLayer = L.layerGroup();
    const routeLine = L.polyline(latlngs, {
      color: "yellow",
      weight: 4,
      dashArray: "5, 10",
      opacity: 1,
      lineCap: "round",
      lineJoin: "round",
    });
    routeLayer.addLayer(routeLine);
    routeLayer.addTo(map);
    map.fitBounds(L.latLngBounds(latlngs), { padding: [48, 48], maxZoom: 16 });

    const edgeStats =
      pathEdges && pathEdges.length
        ? analyzePathFromEdges(pathEdges)
        : analyzePathFromNodePath(pathNodeIds);
    const liftCount = edgeStats.lift;
    const liftPeak = calculateCongestion(timeOfDay, true) >= 3;

    const bits = [];
    if (edgeStats.easy) bits.push(edgeStats.easy + " green");
    if (edgeStats.intermediate) bits.push(edgeStats.intermediate + " blue");
    if (edgeStats.advanced) bits.push(edgeStats.advanced + " red");
    if (edgeStats.expert) bits.push(edgeStats.expert + " black");
    if (edgeStats.unknown) bits.push(edgeStats.unknown + " untagged");

    let statsLine =
      "Route legs: " +
      (pathEdges && pathEdges.length ? pathEdges.length : pathNodeIds.length - 1) +
      "; lifts on path: " +
      liftCount +
      ". ";
    if (bits.length) statsLine += "Piste mix: " + bits.join(", ") + ". ";
    if (liftPeak) statsLine += "At this hour, lift congestion multipliers are elevated.";

    setAgentOutputVisible(true);
    $out.innerHTML =
      buildNarrativeHTML(pathNodeIds, pathEdges, nlp, timeOfDay) +
      '<p class="mt-3 text-slate-400 text-xs leading-relaxed">' +
      escapeHtml(statsLine) +
      "</p>";
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
          "</strong> OSM ways. Click small nodes to set <strong>Start</strong> then <strong>End</strong>; open the agent panel with <strong>Find Route</strong>.";
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
    for (let h = 8; h <= 17; h++) {
      const label = String(h).padStart(2, "0") + ":00";
      const o = document.createElement("option");
      o.value = label;
      o.textContent = label;
      $time.appendChild(o);
    }
    $time.value = "10:00";
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function onFindRoute() {
    resetAllTrackStyles();

    const timeOfDay = $time.value;
    const nlp = parseAgentText($chat.value);

    if (!startNodeId || !endNodeId) {
      if ($appHint)
        $appHint.innerHTML =
          '<span class="text-amber-400">Click two graph nodes on the map for Start and End first.</span>';
      setAgentOutputVisible(false);
      return;
    }
    if (startNodeId === endNodeId) {
      if ($appHint)
        $appHint.innerHTML =
          '<span class="text-amber-400">Start and End must be different nodes.</span>';
      setAgentOutputVisible(false);
      return;
    }

    const wfn = (e) => edgeWeight(e, timeOfDay, nlp);
    const result = dijkstra(adjacency, startNodeId, endNodeId, wfn);
    if (!result.path) {
      if ($appHint)
        $appHint.innerHTML =
          '<span class="text-amber-400">No connected route between the chosen nodes in this graph.</span>';
      setAgentOutputVisible(false);
      clearRoute();
      return;
    }
    drawRoute(result.path, result.edges, nlp, timeOfDay);
  }

  populateSelects();
  initMap();

  $resort.addEventListener("change", () => {
    currentResortId = $resort.value;
    const r = RESORTS.find((x) => x.id === currentResortId);
    if (r) loadResort(r);
  });

  $find.addEventListener("click", onFindRoute);

  loadResort(RESORTS[0]);
})();
