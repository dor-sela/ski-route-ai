# Ski Route AI Agent ⛷️

An intelligent navigation system based on an AI Agent for personalized and safe ski route planning.

## 📝 About the Project
This project was born out of a real need for skiers to orient themselves in new and unfamiliar ski resorts. Confusion between piste colors, the complexity of lift networks, and the fear of accidentally ending up on a run beyond one's skill level are significant challenges.

**Ski Route AI Agent** solves these problems through an "Intelligent Agent" that analyzes resort maps, user skill levels, and goals to generate an optimal and safe route in real-time.

## ✨ Key Features
- **Personalized Routing:** An algorithm that accounts for skill levels ranging from "Never Skied Before" to "Expert."
- **Enhanced Dijkstra Algorithm:** Uses a "penalty" and "reward" system on graph edges to prioritize safe routes and block dangerous ones.
- **Autonomous Logic (Uphill Fallback):** Automatically detects uphill scenarios (when the end point is higher than the start) and switches to lift-based routes with appropriate alerts.
- **Mandatory Return Trip:** Always calculates a return path to the origin, maximizing lift usage and minimizing physical strain.
- **Interactive Map:** Accurate geographical display based on OpenStreetMap data with curved geometries mimicking real-life trails.
- **Points of Interest (POIs):** Displays hotels, alpine huts, and restaurants (Muted Yellow Stars) on the map to assist navigation.
- **Dynamic Interface:** Navigation nodes scale up during zoom-in for easier and more accessible interaction.

## 🛠 Technologies
- **Frontend:** Vanilla JavaScript, HTML5, CSS3.
- **Mapping:** [Leaflet.js](https://leafletjs.com/) with Waymarked Trails layer.
- **Data:** Local JSON files containing detailed geographical data for ski resorts (Val Thorens, Bansko, Zermatt).
- **Algorithm:** Custom implementation of Dijkstra's Algorithm for graph-based routing.

## 🚀 AI-Assisted Development
The project was developed in the **Cursor** IDE using **Composer 2**.
- **Agentic AI:** Utilized an autonomous agent to understand project context and perform multi-file changes simultaneously.
- **Iterative Development:** Prompt-Driven Development allowed for continuous monitoring and refinement of the algorithmic logic.

## 📖 How It Works (Algorithmic Explanation)
The algorithm transforms the ski resort into a mathematical graph where nodes are intersections/stations and edges are the trails.
1. **Weighting:** The Agent assigns a high weight ("penalty") to trails that do not match the user's skill level.
2. **Directionality:** The system distinguishes between downhill (ski runs) and uphill (lifts).
3. **Autonomy:** If no valid downhill route is found, the Agent decides to switch to "Ascend" mode and presents a lift-based route.

---
*This project was submitted as part of software development studies.*
