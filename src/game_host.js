import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const DEFAULT_COMMAND_TIMEOUT_MS = 5000;

export class GameHost {
  constructor(socket, id, onClose) {
    this.socket = socket;
    this.id = id;
    this.runtime = "unknown";
    this.protocol = null;
    this.capabilities = [];
    this.connectedAt = new Date().toISOString();
    this.lastSeenAt = this.connectedAt;
    this.latestState = null;
    this.latestLogs = [];
    this.latestFrame = null;
    this.latestRenderTree = null;
    this.pending = new Map();
    this.commandCounter = 0;
    this.closed = false;
    this._onClose = onClose;

    socket.on("message", (data) => this.#receive(data));
    socket.on("close", () => this.close(new Error("game host disconnected")));
    socket.on("error", (error) => this.close(error));
  }

  get ready() {
    return this.protocol !== null && !this.closed;
  }

  async waitUntilReady(timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (!this.ready && !this.closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!this.ready) throw new Error(`game host ${this.id} is not ready`);
  }

  snapshot() {
    return {
      id: this.id,
      runtime: this.runtime,
      protocol: this.protocol,
      capabilities: this.capabilities,
      connectedAt: this.connectedAt,
      lastSeenAt: this.lastSeenAt,
      latestFrame: this.latestFrame,
      hasState: this.latestState !== null,
      hasRenderTree: this.latestRenderTree !== null,
      logCount: this.latestLogs.length,
    };
  }

  async sendCommand(method, params = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`game host ${this.id} is not connected`);
    }
    await this.waitUntilReady(timeoutMs);
    const id = `mcp-${++this.commandCounter}-${randomUUID()}`;
    const message = { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`game host ${this.id} timed out handling ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close(error = new Error("game host disconnected")) {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      try {
        this.socket.close(1000, "server shutting down");
      } catch {
        // The close event will still remove the host from the registry.
      }
    }
    this._onClose(this);
  }

  #receive(data) {
    this.lastSeenAt = new Date().toISOString();
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    if (message.type === "hello") {
      this.protocol = message.protocol ?? null;
      this.runtime = message.runtime || "unknown";
      this.capabilities = Array.isArray(message.capabilities)
        ? message.capabilities
        : [];
      return;
    }
    if (message.type === "response" && message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result ?? null);
      else pending.reject(new Error(message.error?.message || "game command failed"));
      return;
    }
    if (message.type === "state") {
      this.latestState = message.state ?? null;
    } else if (message.type === "log") {
      this.latestLogs.push({
        level: message.level || "info",
        message: String(message.message ?? ""),
        receivedAt: this.lastSeenAt,
      });
      if (this.latestLogs.length > 64) this.latestLogs.shift();
    } else if (message.type === "frame") {
      this.latestFrame = message;
    }
  }
}

export class GameRegistry {
  constructor() {
    this.hosts = new Map();
    this.nextId = 1;
  }

  add(socket) {
    const id = `game-${this.nextId++}`;
    const host = new GameHost(socket, id, (closedHost) => {
      if (this.hosts.get(closedHost.id) === closedHost) {
        this.hosts.delete(closedHost.id);
      }
    });
    this.hosts.set(id, host);
    return host;
  }

  list() {
    return [...this.hosts.values()].map((host) => host.snapshot());
  }

  resolve(id) {
    if (id) {
      const host = this.hosts.get(id);
      if (!host) throw new Error(`unknown game host '${id}'`);
      return host;
    }
    const hosts = [...this.hosts.values()].filter((host) => !host.closed);
    if (hosts.length === 1) return hosts[0];
    if (hosts.length === 0) throw new Error("no game host is connected");
    throw new Error("multiple game hosts are connected; provide gameId");
  }
}
