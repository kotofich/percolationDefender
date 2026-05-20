let cy;
let currentState = null;
let wsHeartbeat = null;

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

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return ts;
  }
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
      return `
      <article class="node-item ${node.status}">
        <div><strong>${node.node_id}</strong> · ${node.status}</div>
        <div class="node-meta">last_seen ${formatTime(node.last_seen)}</div>
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
  if (selected && users.some((u) => u.user_id === selected)) {
    userSelectEl.value = selected;
  }
}

function buildGraphElements(state) {
  const elements = [];

  const activeEntries = new Set(
    state.users.map((user) => user.entry_node).filter(Boolean)
  );
  const activeRelays = new Set(
    state.users.map((user) => user.relay_node).filter(Boolean)
  );

  const users = state.users;
  users.forEach((user, index) => {
    elements.push({
      data: { id: user.user_id, label: user.user_id, type: "user" },
      position: { x: 90, y: 90 + index * 80 },
    });
  });

  const nodes = [...state.nodes].sort((a, b) => a.node_id.localeCompare(b.node_id));
  nodes.forEach((node, index) => {
    const classes = [node.status];
    if (activeEntries.has(node.node_id)) {
      classes.push("active-entry");
    }
    if (activeRelays.has(node.node_id)) {
      classes.push("active-relay");
    }

    elements.push({
      data: {
        id: node.node_id,
        label: node.node_id,
        type: "node",
        status: node.status,
      },
      classes: classes.join(" "),
      position: { x: 360, y: 60 + index * 52 },
    });
  });

  elements.push({
    data: { id: "internet", label: "Internet", type: "internet" },
    position: { x: 640, y: 310 },
  });

  state.edges.forEach((edge, index) => {
    elements.push({
      data: {
        id: `${edge.kind}-${edge.user_id}-${index}`,
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
      },
      classes: edge.kind,
    });
  });

  return elements;
}

function ensureGraph() {
  if (cy) {
    return;
  }

  cy = cytoscape({
    container: document.getElementById("graph"),
    elements: [],
    style: [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "font-family": "IBM Plex Mono",
          "font-size": 10,
          "text-valign": "center",
          "text-halign": "center",
          color: "#0f2e23",
          width: 42,
          height: 42,
          "background-color": "#95b6a9",
          "border-width": 2,
          "border-color": "#527567",
        },
      },
      {
        selector: "node[type = 'user']",
        style: {
          shape: "round-rectangle",
          width: 86,
          height: 36,
          "background-color": "#1f6feb",
          "border-color": "#1759bc",
          color: "#f5fbff",
        },
      },
      {
        selector: "node[type = 'internet']",
        style: {
          shape: "diamond",
          width: 80,
          height: 80,
          "background-color": "#ffe8cf",
          "border-color": "#ce8f4f",
          color: "#5d3a16",
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
          "border-width": 4,
          "border-color": "#1f6feb",
        },
      },
      {
        selector: "node.active-relay",
        style: {
          "overlay-padding": 6,
          "overlay-color": "#d97a2b",
          "overlay-opacity": 0.15,
        },
      },
      {
        selector: "edge",
        style: {
          width: 2,
          "curve-style": "bezier",
          "target-arrow-shape": "triangle",
          "target-arrow-color": "#5a8374",
          "line-color": "#5a8374",
          opacity: 0.78,
        },
      },
      {
        selector: "edge.user_to_entry",
        style: {
          "line-color": "#1f6feb",
          "target-arrow-color": "#1f6feb",
        },
      },
      {
        selector: "edge.entry_to_relay",
        style: {
          "line-color": "#0a7f5a",
          "target-arrow-color": "#0a7f5a",
        },
      },
      {
        selector: "edge.relay_to_internet",
        style: {
          "line-color": "#d97a2b",
          "target-arrow-color": "#d97a2b",
          "line-style": "dashed",
        },
      },
    ],
  });
}

function renderGraph(state) {
  ensureGraph();
  cy.elements().remove();
  cy.add(buildGraphElements(state));
  cy.layout({ name: "preset", fit: true, padding: 24 }).run();
}

function applyState(state, reason = "update") {
  currentState = state;
  renderMetrics(state.metrics);
  renderNodeList(state.nodes);
  renderEvents(state.events);
  renderUserSelect(state.users);
  renderGraph(state);

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
  await loadInitialState();
  connectWebSocket();
})();
