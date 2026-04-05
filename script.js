(function () {
  "use strict";

  /** @typedef {{ id: string, lat: number, lon: number }} GraphNode */
  /** @typedef {{ to: string, lengthMeters: number, isLift: boolean, difficulty: string|null, tags: Record<string,string> }} GraphEdge */

  const RESORTS = [
    {
      id: "val-thorens",
      name: "Val Thorens (France)",
      center: [45.298, 6.581],
      zoom: 13,
      bbox: [45.275, 6.52, 45.32, 6.64],
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

  /** @type {L.Map|null} */
  let map = null;
  /** @type {L.TileLayer|null} */
  let baseLayer = null;
  let graphLayer = null;
  let routeLayer = null;
  /** @type {L.Marker|null} */
  let startMarker = null;
  /** @type {L.Marker|null} */
  let endMarker = null;

  /** @type {Map<string, GraphNode>} */
  let nodeStore = new Map();
  /** @type {Map<string, GraphEdge[]>} */
  let adjacency = new Map();

  let clickStage = 0;
  /** @type {string|null} */
  let startNodeId = null;
  /** @type {string|null} */
  let endNodeId = null;

  /** @type {string} */
  let currentResortId = RESORTS[0].id;

  // --- DOM ---
  const $resort = document.getElementById("resort-select");
  const $time = document.getElementById("time-select");
  const $chat = document.getElementById("chat-input");
  const $find = document.getElementById("find-route");
  const $out = document.getElementById("agent-output");
  const $loadingText = document.getElementById("loading-text");
  const $spinner = document.getElementById("loading-spinner");

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

  function buildOverpassQuery(bbox) {
    const [s, w, n, e] = bbox;
    return `[out:json][timeout:120];
(
  way["piste:type"="downhill"](${s},${w},${n},${e});
  way["aerialway"](${s},${w},${n},${e});
);
(._;>;);
out body;`;
  }

  async function fetchResortData(bbox) {
    const body = "data=" + encodeURIComponent(buildOverpassQuery(bbox));
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    });
    if (!res.ok) throw new Error("Overpass HTTP " + res.status);
    return res.json();
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

  function normalizeDifficulty(tags) {
    const raw = (tags["piste:difficulty"] || tags["snowmobile:difficulty"] || "").toLowerCase();
    if (!raw) return null;
    if (["novice", "easy", "beginner"].includes(raw)) return "easy";
    if (["intermediate", "blue"].includes(raw)) return "intermediate";
    if (["advanced", "difficult", "red"].includes(raw)) return "advanced";
    if (["expert", "extreme", "freeride", "black", "yes"].includes(raw)) return "expert";
    return "intermediate";
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

  /**
   * @param {string} timeOfDay "HH:MM"
   * @param {boolean} isLift
   */
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

  /**
   * @param {string|null} diffNorm
   * @param {{ skill: string, goal: string }} nlp
   */
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

  /** Min-heap of { d, id } */
  class MinHeap {
    constructor() {
      /** @type {{d:number, id:string}[]} */
      this.h = [];
    }
    /** @param {number} d @param {string} id */
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
   * @param {(e: GraphEdge) => number} weightFn
   */
  function dijkstra(graph, start, end, weightFn) {
    const dist = new Map();
    const prev = new Map();
    for (const k of graph.keys()) dist.set(k, Infinity);
    if (!graph.has(start) || !graph.has(end)) return { path: null, dist: Infinity };

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
    if (finalD === Infinity) return { path: null, dist: Infinity };

    const nodes = [];
    const edges = [];
    let cur = end;
    while (cur && cur !== start) {
      nodes.push(cur);
      const p = prev.get(cur);
      if (!p) return { path: null, dist: Infinity };
      edges.push(p.edge);
      cur = p.from;
    }
    nodes.push(start);
    nodes.reverse();
    edges.reverse();
    return { path: nodes, edges, dist: finalD };
  }

  function addUndirectedEdge(a, b, edgeMeta) {
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push({ ...edgeMeta, to: b });
    adjacency.get(b).push({ ...edgeMeta, to: a });
  }

  function buildGraphFromOverpass(json) {
    nodeStore = new Map();
    adjacency = new Map();
    const elements = json.elements || [];
    const nodeById = new Map();

    for (const el of elements) {
      if (el.type === "node" && el.lat != null && el.lon != null) {
        const id = String(el.id);
        nodeById.set(id, el);
        nodeStore.set(id, { id, lat: el.lat, lon: el.lon });
      }
    }

    for (const el of elements) {
      if (el.type !== "way" || !el.nodes || el.nodes.length < 2) continue;
      const tags = el.tags || {};
      const isDownhill = tags["piste:type"] === "downhill";
      const isLift = tags["aerialway"] != null && tags["aerialway"] !== "no";
      if (!isDownhill && !isLift) continue;

      const diff = isDownhill ? normalizeDifficulty(tags) : null;

      for (let i = 0; i < el.nodes.length - 1; i++) {
        const na = String(el.nodes[i]);
        const nb = String(el.nodes[i + 1]);
        const A = nodeById.get(na);
        const B = nodeById.get(nb);
        if (!A || !B) continue;
        const len = haversineMeters(A.lat, A.lon, B.lat, B.lon);
        if (len < 0.5) continue;
        const meta = {
          lengthMeters: len,
          isLift,
          difficulty: diff,
          tags,
        };
        addUndirectedEdge(na, nb, meta);
      }
    }

    for (const id of [...nodeStore.keys()]) {
      const edges = adjacency.get(id);
      if (!edges || edges.length === 0) {
        nodeStore.delete(id);
        adjacency.delete(id);
      }
    }
  }

  function nearestNodeId(lat, lon) {
    let best = null;
    let bestD = Infinity;
    for (const n of nodeStore.values()) {
      const d = haversineMeters(lat, lon, n.lat, n.lon);
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best;
  }

  function renderGraphPolylines() {
    if (graphLayer) {
      map.removeLayer(graphLayer);
      graphLayer = null;
    }
    graphLayer = L.layerGroup();
    const seen = new Set();
    for (const [u, edges] of adjacency) {
      const nu = nodeStore.get(u);
      if (!nu) continue;
      for (const e of edges) {
        const key = u < e.to ? u + "|" + e.to : e.to + "|" + u;
        if (seen.has(key)) continue;
        seen.add(key);
        const nv = nodeStore.get(e.to);
        if (!nv) continue;
        const line = L.polyline(
          [
            [nu.lat, nu.lon],
            [nv.lat, nv.lon],
          ],
          {
            color: e.isLift ? "#64748b" : "#334155",
            weight: 1,
            opacity: 0.14,
          }
        );
        graphLayer.addLayer(line);
      }
    }
    graphLayer.addTo(map);
  }

  function clearRoute() {
    if (routeLayer) {
      map.removeLayer(routeLayer);
      routeLayer = null;
    }
  }

  /** Summarize piste difficulties along the chosen path (undirected edge pick). */
  function analyzePathEdges(pathNodeIds) {
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

  function drawRoute(pathNodeIds, nlp, timeOfDay) {
    clearRoute();
    if (!pathNodeIds || pathNodeIds.length < 2) return;
    routeLayer = L.layerGroup();
    const latlngs = pathNodeIds.map((id) => {
      const n = nodeStore.get(id);
      return [n.lat, n.lon];
    });
    const glow = L.polyline(latlngs, {
      color: "#facc15",
      weight: 10,
      opacity: 0.35,
      lineCap: "round",
      lineJoin: "round",
    });
    const core = L.polyline(latlngs, {
      className: "route-glow",
      color: "#eab308",
      weight: 5,
      opacity: 0.95,
      lineCap: "round",
      lineJoin: "round",
    });
    routeLayer.addLayer(glow);
    routeLayer.addLayer(core);
    routeLayer.addTo(map);
    map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], maxZoom: 15 });

    const edgeStats = analyzePathEdges(pathNodeIds);
    const liftCount = edgeStats.lift;

    const parts = [];
    parts.push(
      `It is ${timeOfDay}. Applied congestion multipliers and your agent profile (${nlp.skill}, goal: ${nlp.goal}).`
    );
    const liftPeak = calculateCongestion(timeOfDay, true) >= 3;
    if (liftPeak && liftCount === 0) {
      parts.push("Lift queues are peaking now; this route avoids lift legs where the graph allows.");
    } else if (liftPeak && liftCount > 0) {
      parts.push(
        `Lift queues are peaking; ${liftCount} lift segment(s) still required — total cost minimized with Dijkstra.`
      );
    } else if (liftCount === 0) {
      parts.push("No lift segments on this path under the loaded network.");
    } else {
      parts.push(`Includes ${liftCount} lift segment(s) between pistes.`);
    }

    const bits = [];
    if (edgeStats.easy) bits.push(`${edgeStats.easy} green/easy`);
    if (edgeStats.intermediate) bits.push(`${edgeStats.intermediate} blue/intermediate`);
    if (edgeStats.advanced) bits.push(`${edgeStats.advanced} red/advanced`);
    if (edgeStats.expert) bits.push(`${edgeStats.expert} black/expert`);
    if (edgeStats.unknown) bits.push(`${edgeStats.unknown} unpisted/unknown`);
    if (bits.length) {
      parts.push("Routed via: " + bits.join(", ") + " segments.");
      if (nlp.goal === "warmup" && (edgeStats.easy > 0 || edgeStats.intermediate > 0)) {
        parts.push("Warmup: blues/greens align with your stated easy start.");
      }
    }

    if (nlp.skill === "beginner") parts.push("Beginner: hard pistes were heavily penalized in edge weight.");
    if (nlp.skill === "expert") parts.push("Expert: steeper graded pistes were slightly favored vs. flat greens.");

    $out.innerHTML = "<p>" + parts.join(" ") + "</p>";
  }

  async function loadResort(resort) {
    setLoading(true, "Fetching pistes & lifts from Overpass…");
    clearRoute();
    try {
      const data = await fetchResortData(resort.bbox);
      setLoading(true, "Building graph…");
      buildGraphFromOverpass(data);
      if (nodeStore.size === 0) {
        $out.innerHTML =
          "<p class='text-amber-400'>No ski data in bbox. Try another resort or zoom area later.</p>";
        setLoading(false);
        return;
      }
      if (map && baseLayer) {
        map.setView(resort.center, resort.zoom);
        renderGraphPolylines();
      }
      startNodeId = endNodeId = null;
      clickStage = 0;
      if (startMarker) {
        map.removeLayer(startMarker);
        startMarker = null;
      }
      if (endMarker) {
        map.removeLayer(endMarker);
        endMarker = null;
      }
      $out.innerHTML = `<p>Loaded <strong>${nodeStore.size}</strong> nodes and <strong>${adjacency.size}</strong> graph vertices. Click map to set Start and End.</p>`;
    } catch (err) {
      console.error(err);
      const msg =
        err && err.message
          ? String(err.message)
          : "Unknown error (CORS or network). Opening via file:// may block fetch; use a local static server.";
      $out.innerHTML =
        "<p class='text-red-400'>Could not load resort data: " +
        msg +
        "</p>";
    } finally {
      setLoading(false);
    }
  }

  function initMap() {
    map = L.map("map", { zoomControl: true });
    baseLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap",
    }).addTo(map);
    const r = RESORTS[0];
    map.setView(r.center, r.zoom);

    map.on("click", (ev) => {
      if (!nodeStore.size) return;
      const id = nearestNodeId(ev.latlng.lat, ev.latlng.lng);
      const n = nodeStore.get(id);
      if (!n) return;

      if (clickStage % 2 === 0) {
        startNodeId = id;
        if (startMarker) map.removeLayer(startMarker);
        startMarker = L.circleMarker([n.lat, n.lon], {
          radius: 10,
          color: "#22c55e",
          fillColor: "#4ade80",
          fillOpacity: 0.9,
        })
          .addTo(map)
          .bindPopup("Start")
          .openPopup();
      } else {
        endNodeId = id;
        if (endMarker) map.removeLayer(endMarker);
        endMarker = L.circleMarker([n.lat, n.lon], {
          radius: 10,
          color: "#ef4444",
          fillColor: "#f87171",
          fillOpacity: 0.9,
        })
          .addTo(map)
          .bindPopup("End")
          .openPopup();
      }
      clickStage++;
    });
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
    const timeOfDay = $time.value;
    const nlp = parseAgentText($chat.value);
    if (!startNodeId || !endNodeId) {
      $out.innerHTML = "<p class='text-amber-400'>Set Start and End by clicking the map twice.</p>";
      return;
    }
    if (startNodeId === endNodeId) {
      $out.innerHTML = "<p class='text-amber-400'>Start and End must be different points.</p>";
      return;
    }

    const wfn = (e) => edgeWeight(e, timeOfDay, nlp);
    const result = dijkstra(adjacency, startNodeId, endNodeId, wfn);
    if (!result.path) {
      $out.innerHTML =
        "<p class='text-amber-400'>No connected route between the chosen points in the loaded graph.</p>";
      clearRoute();
      return;
    }
    drawRoute(result.path, nlp, timeOfDay);
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
