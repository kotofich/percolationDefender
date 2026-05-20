let cy;
let currentState = null;
let wsHeartbeat = null;
let autoLayoutEnabled = false;
let hasInitialLayout = false;
let lastTopologyHash = "";

const POSITION_STORAGE_KEY = "mtd-demo-graph-positions-v2";
const savedPositions = new Map();

const metricsEl = document.getElementById("metrics");
const nodeListEl = document.getElementById("nodeList");
const eventsEl = document.getElementById("events");
const userSelectEl = document.getElementById("userSelect");
const metaLineEl = document.getElementById("metaLine");

const rotateBtn = document.getElementById("rotateBtn");
const probeBtn = document.getElementById("probeBtn");
const addUserBtn = document.getElementById("addUserBtn");
const connectUserBtn = document.getElementById("connectUserBtn");
const newUserInput = document.getElementById("newUserInput");
const relayoutBtn = document.getElementById("relayoutBtn");
const layoutModeBtn = document.getElementById("layoutModeBtn");

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return ts;
  }
}

function restoreSavedPositions() {
  try {
    const raw = localStorage.getItem(POSITION_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const payload = JSON.parse(raw);
    if (typeof payload !== "object" || payload === null) {
      return;
    }

    Object.entries(payload).forEach(([id, pos]) => {
      if (
        pos &&
        typeof pos === "object" &&
        typeof pos.x === "number" &&
        typeof pos.y === "number"
      ) {
        savedPositions.set(id, { x: pos.x, y: pos.y });
      }
    });
  } catch {
    // Ignore invalid cached layout data.
  }
}

function persistSavedPositions() {
  const payload = {};
  savedPositions.forEach((pos, id) => {
    payload[id] = { x: pos.x, y: pos.y };
  });
  localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(payload));
}

function rememberNodePosition(node) {
  const id = node.id();
  savedPositions.set(id, {
    x: node.position("x"),
    y: node.position("y"),
  });
}

function renderMetrics(metrics) {
  const items = [
    ["Healthy Nodes", metrics.healthy_nodes],
    ["Compromised Nodes", metrics.compromised_nodes],
    ["Unreachable Nodes", metrics.unreachable_nodes],
    ["Total Users", metrics.total_users],
    ["Active Routes", metrics.active_routes],
    ["Total Rotations", metrics.total_rotations],
    ["Total Connections", metrics.total_connections],
    ["Total Reroutes", metrics.total_reroutes],
  ];

  metricsEl.innerHTML = items
    .map(
      ([label, value]) => `
      <article class="metric">
        <div class="label">${label}</div>
        <div class="value">${value}</div>
      </article>
    `
    )
    .join("");
}

function renderNodeList(nodes) {
  nodeListEl.innerHTML = nodes
    .map((node) => {
      const usage = `${node.total_assignments ?? 0} uses`;
      return `
      <article class="node-item ${node.status}">
        <div><strong>${node.node_id}</strong> · ${node.status}</div>
        <div class="node-meta">assigned ${usage} · last_seen ${formatTime(node.last_seen)}</div>
      </article>
      `;
    })
    .join("");
}

function renderEvents(events) {
  const lastEvents = [...events].slice(-60).reverse();
  eventsEl.innerHTML = lastEvents
    .map((event) => {
      return `
      <article class="event">
        <div class="event-type">${event.type}</div>
        <div>${event.message}</div>
        <div class="event-time">${formatTime(event.ts)}</div>
      </article>
      `;
    })
    .join("");
}

function renderUserSelect(users) {
  const selected = userSelectEl.value;
  userSelectEl.innerHTML = users
    .map((user) => `<option value="${user.user_id}">${user.user_id}</option>`)
    .join("");
  if (selected && users.some((user) => user.user_id === selected)) {
    userSelectEl.value = selected;
  }
}

function computeDefaultPosition(descriptor, totals) {
  const width = cy ? cy.width() : 980;
  const height = cy ? cy.height() : 560;

  if (descriptor.type === "user") {
    const step = totals.userCount > 1 ? (height - 120) / (totals.userCount - 1) : 0;
    return { x: width * 0.13, y: 60 + descriptor.index * step };
  }

  if (descriptor.type === "node") {
    const rows = Math.max(1, Math.ceil(totals.nodeCount / 2));
    const col = Math.floor(descriptor.index / rows);
    const row = descriptor.index % rows;
    const step = rows > 1 ? (height - 150) / (rows - 1) : 0;
    return {
      x: width * (0.47 + col * 0.16),
      y: 75 + row * step,
    };
  }

  return { x: width * 0.88, y: height * 0.5 };
}

function buildGraphModel(state) {
  const activeEntries = new Set(
    state.users.map((user) => user.entry_node).filter(Boolean)
  );
  const activeRelays = new Set(
    state.users.map((user) => user.relay_node).filter(Boolean)
  );

  const userList = [...state.users].sort((a, b) =>
    a.user_id.localeCompare(b.user_id)
  );
  const nodeList = [...state.nodes].sort((a, b) =>
    a.node_id.localeCompare(b.node_id)
  );

  const totals = {
    userCount: Math.max(1, userList.length),
    nodeCount: Math.max(1, nodeList.length),
  };

  const nodes = [];

  userList.forEach((user, index) => {
    nodes.push({
      id: user.user_id,
      label: user.user_id,
      type: "user",
      status: "user",
      index,
      classes: "user-node",
      defaultPosition: computeDefaultPosition(
        { type: "user", index },
        totals
      ),
    });
  });

  nodeList.forEach((node, index) => {
    const classes = [node.status];
    if (activeEntries.has(node.node_id)) {
      classes.push("active-entry");
    }
    if (activeRelays.has(node.node_id)) {
      classes.push("active-relay");
    }

    nodes.push({
      id: node.node_id,
      label: node.node_id,
      type: "node",
      status: node.status,
      index,
      classes: classes.join(" "),
      defaultPosition: computeDefaultPosition(
        { type: "node", index },
        totals
      ),
    });
  });

  nodes.push({
    id: "internet",
    label: "Internet",
    type: "internet",
    status: "internet",
    index: 0,
    classes: "internet-node",
    defaultPosition: computeDefaultPosition(
      { type: "internet", index: 0 },
      totals
    ),
  });

  const edges = state.edges.map((edge) => {
    return {
      id: `${edge.kind}:${edge.user_id}:${edge.source}:${edge.target}`,
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      classes: edge.kind,
    };
  });

  return { nodes, edges };
}

function ensureGraph() {
  if (cy) {
    return;
  }

  cy = cytoscape({
    container: document.getElementById("graph"),
    elements: [],
    minZoom: 0.5,
    maxZoom: 2.2,
    wheelSensitivity: 0.16,
    style: [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "font-family": "IBM Plex Mono",
          "font-size": 11,
          "text-valign": "center",
          "text-halign": "center",
          "text-wrap": "ellipsis",
          "text-max-width": 72,
          color: "#0f2e23",
          width: 58,
          height: 58,
          "background-color": "#9ab7ac",
          "border-width": 3,
          "border-color": "#56796b",
        },
      },
      {
        selector: "node.user-node",
        style: {
          shape: "round-rectangle",
          width: 108,
          height: 42,
          "background-color": "#1f6feb",
          "border-color": "#1759bc",
          color: "#f5fbff",
          "font-size": 12,
        },
      },
      {
        selector: "node.internet-node",
        style: {
          shape: "diamond",
          width: 96,
          height: 96,
          "background-color": "#ffe9cc",
          "border-color": "#c78947",
          color: "#5d3a16",
          "font-size": 13,
        },
      },
      {
        selector: "node.compromised",
        style: {
          "background-color": "#c84533",
          "border-color": "#9f3022",
          color: "#fff5f2",
        },
      },
      {
        selector: "node.unreachable",
        style: {
          "background-color": "#8b7f75",
          "border-color": "#6f655e",
          color: "#fff",
        },
      },
      {
        selector: "node.active-entry",
        style: {
          "border-width": 5,
          "border-color": "#1f6feb",
        },
      },
      {
        selector: "node.active-relay",
        style: {
          "overlay-padding": 8,
          "overlay-color": "#d97a2b",
          "overlay-opacity": 0.2,
        },
      },
      {
        selector: "edge",
        style: {
          width: 2.5,
          "curve-style": "bezier",
          "target-arrow-shape": "triangle",
          "target-arrow-color": "#5a8374",
          "line-color": "#5a8374",
          opacity: 0.85,
        },
      },
      {
        selector: "edge.user_to_entry",
        style: {
          width: 2.8,
          "line-color": "#1f6feb",
          "target-arrow-color": "#1f6feb",
        },
      },
      {
        selector: "edge.entry_to_relay",
        style: {
          width: 2.5,
          "line-color": "#0a7f5a",
          "target-arrow-color": "#0a7f5a",
        },
      },
      {
        selector: "edge.relay_to_internet",
        style: {
          width: 2.5,
          "line-color": "#d97a2b",
          "target-arrow-color": "#d97a2b",
          "line-style": "dashed",
        },
      },
    ],
  });

  cy.on("dragfree", "node", (event) => {
    rememberNodePosition(event.target);
    persistSavedPositions();
  });
}

function runAutoLayout({ fit }) {
  if (!cy) {
    return;
  }

  cy.layout({
    name: "breadthfirst",
    directed: true,
    direction: "rightward",
    padding: 30,
    spacingFactor: 1.35,
    fit,
    animate: false,
  }).run();

  cy.nodes().forEach((node) => rememberNodePosition(node));
  persistSavedPositions();
}

function syncGraph(state) {
  ensureGraph();
  const model = buildGraphModel(state);

  const desiredNodeIds = new Set(model.nodes.map((node) => node.id));
  const desiredEdgeIds = new Set(model.edges.map((edge) => edge.id));

  cy.batch(() => {
    cy.edges().forEach((edge) => {
      if (!desiredEdgeIds.has(edge.id())) {
        edge.remove();
      }
    });

    cy.nodes().forEach((node) => {
      if (!desiredNodeIds.has(node.id())) {
        savedPositions.delete(node.id());
        node.remove();
      }
    });

    model.nodes.forEach((descriptor) => {
      const existing = cy.getElementById(descriptor.id);
      if (existing.length === 0) {
        const pos = savedPositions.get(descriptor.id) || descriptor.defaultPosition;
        cy.add({
          group: "nodes",
          data: {
            id: descriptor.id,
            label: descriptor.label,
            type: descriptor.type,
            status: descriptor.status,
          },
          classes: descriptor.classes,
          position: pos,
        });
      } else {
        existing.data({
          label: descriptor.label,
          type: descriptor.type,
          status: descriptor.status,
        });
        existing.classes(descriptor.classes);
      }
    });

    model.edges.forEach((descriptor) => {
      const existing = cy.getElementById(descriptor.id);
      if (existing.length === 0) {
        cy.add({
          group: "edges",
          data: {
            id: descriptor.id,
            source: descriptor.source,
            target: descriptor.target,
            kind: descriptor.kind,
          },
          classes: descriptor.classes,
        });
      } else {
        existing.data({
          source: descriptor.source,
          target: descriptor.target,
          kind: descriptor.kind,
        });
        existing.classes(descriptor.classes);
      }
    });
  });

  if (!hasInitialLayout) {
    runAutoLayout({ fit: true });
    hasInitialLayout = true;
    return;
  }

  if (autoLayoutEnabled) {
    const topologyHash = JSON.stringify({
      nodeStatus: state.nodes
        .map((node) => `${node.node_id}:${node.status}`)
        .sort(),
      edges: state.edges
        .map((edge) => `${edge.source}>${edge.target}:${edge.kind}:${edge.user_id}`)
        .sort(),
      users: state.users.map((user) => user.user_id).sort(),
    });

    if (topologyHash !== lastTopologyHash) {
      runAutoLayout({ fit: false });
      lastTopologyHash = topologyHash;
    }
  }
}

function setLayoutModeButtonLabel() {
  layoutModeBtn.textContent = `Auto Layout: ${autoLayoutEnabled ? "ON" : "OFF"}`;
  layoutModeBtn.classList.toggle("ghost", !autoLayoutEnabled);
}

function applyState(state, reason = "update") {
  currentState = state;
  renderMetrics(state.metrics);
  renderNodeList(state.nodes);
  renderEvents(state.events);
  renderUserSelect(state.users);
  syncGraph(state);

  const lastRotation = formatTime(state.last_rotation_at);
  metaLineEl.textContent = `Reason: ${reason} · Rotation every ${state.rotation_interval_seconds}s · Last rotation ${lastRotation}`;
}

async function callApi(path, method = "POST", body = null) {
  const response = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : null,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Request failed");
  }

  return response.json();
}

async function loadInitialState() {
  const response = await fetch("/api/state");
  const state = await response.json();
  applyState(state, "initial_http");
}

function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${location.host}/ws`);

  ws.onopen = () => {
    if (wsHeartbeat) {
      clearInterval(wsHeartbeat);
    }
    wsHeartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send("ping");
      }
    }, 15000);
  };

  ws.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "state") {
      applyState(payload.state, payload.reason || "ws_state");
    }
  };

  ws.onclose = () => {
    if (wsHeartbeat) {
      clearInterval(wsHeartbeat);
      wsHeartbeat = null;
    }
    setTimeout(connectWebSocket, 1000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

rotateBtn.addEventListener("click", async () => {
  try {
    await callApi("/api/rotate");
  } catch (error) {
    alert(error.message);
  }
});

probeBtn.addEventListener("click", async () => {
  try {
    const result = await callApi("/api/probe");
    if (result && result.changed === false) {
      metaLineEl.textContent = "Probe completed: node statuses unchanged";
    }
  } catch (error) {
    alert(error.message);
  }
});

relayoutBtn.addEventListener("click", () => {
  runAutoLayout({ fit: true });
});

layoutModeBtn.addEventListener("click", () => {
  autoLayoutEnabled = !autoLayoutEnabled;
  setLayoutModeButtonLabel();
});

addUserBtn.addEventListener("click", async () => {
  const userId = newUserInput.value.trim();
  if (!userId) {
    return;
  }

  try {
    await callApi("/api/users", "POST", { user_id: userId });
    newUserInput.value = "";
  } catch (error) {
    alert(error.message);
  }
});

connectUserBtn.addEventListener("click", async () => {
  const userId = userSelectEl.value;
  if (!userId) {
    return;
  }

  try {
    await callApi(`/api/users/${encodeURIComponent(userId)}/connect`, "POST");
  } catch (error) {
    alert(error.message);
  }
});

nodeListEl.addEventListener("click", async (event) => {
  const card = event.target.closest(".node-item");
  if (!card || !currentState) {
    return;
  }

  const nodeName = card.querySelector("strong")?.textContent;
  if (!nodeName) {
    return;
  }

  const node = currentState.nodes.find((item) => item.node_id === nodeName);
  if (!node) {
    return;
  }

  const action = node.status === "compromised" ? "recover" : "compromise";
  const ok = confirm(
    action === "compromise"
      ? `Mark ${nodeName} as compromised?`
      : `Recover ${nodeName} back to healthy?`
  );
  if (!ok) {
    return;
  }

  try {
    await callApi(`/api/nodes/${encodeURIComponent(nodeName)}/${action}`, "POST");
  } catch (error) {
    alert(error.message);
  }
});

(async function init() {
  restoreSavedPositions();
  setLayoutModeButtonLabel();
  await loadInitialState();
  connectWebSocket();
})();
