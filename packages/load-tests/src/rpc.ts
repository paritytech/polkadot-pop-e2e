import WebSocket from "ws";

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface Subscription {
  onNotification(result: unknown): void;
  onEnd(reason: string): void;
}

/** JSON-RPC error returned by the node. */
export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(`RPC error ${code}: ${message}${data === undefined ? "" : ` (${typeof data === "string" ? data : JSON.stringify(data)})`}`);
  }
}

/**
 * One JSON-RPC WebSocket connection carrying requests and subscriptions for several ghosts,
 * without a client library between the measurement and the socket.
 */
export class RpcConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly subscriptions = new Map<string, Subscription>();
  /** Notifications for subscription ids whose subscribe answer has not arrived yet. */
  private readonly early = new Map<string, unknown[]>();
  private readonly unsubscribed = new Set<string>();
  private closed = false;
  onClose: (reason: string) => void = () => {};

  private constructor(private readonly socket: WebSocket, readonly url: string) {
    socket.on("message", (data) => this.receive(data.toString()));
    socket.on("close", (code, reason) => this.shutdown(`closed ${code} ${reason.toString()}`.trim()));
    socket.on("error", (error) => this.shutdown(`error ${error.message}`));
  }

  /** Fails when the node does not accept the connection within `timeoutMs`. */
  static open(url: string, timeoutMs: number): Promise<RpcConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: timeoutMs, maxPayload: 64 * 1024 * 1024 });
      socket.once("open", () => resolve(new RpcConnection(socket, url)));
      socket.once("error", (error) => reject(new Error(`failed to connect to ${url}: ${error.message}`)));
      socket.once("unexpected-response", (_request, response) => {
        reject(new Error(`failed to connect to ${url}: HTTP ${response.statusCode}`));
        socket.terminate();
      });
    });
  }

  request(method: string, params: unknown[], timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** Resolves with the subscription id; `onEnd` runs when the node or the connection ends it. */
  async subscribe(method: string, params: unknown[], timeoutMs: number, subscription: Subscription): Promise<string> {
    const id = String(await this.request(method, params, timeoutMs));
    this.subscriptions.set(id, subscription);
    for (const result of this.early.get(id) ?? []) subscription.onNotification(result);
    this.early.delete(id);
    return id;
  }

  async unsubscribe(method: string, id: string, timeoutMs: number): Promise<void> {
    if (!this.subscriptions.delete(id) || this.closed) return;
    this.unsubscribed.add(id);
    await this.request(method, [id], timeoutMs);
  }

  close(): void {
    this.socket.close();
    this.shutdown("closed by client");
  }

  private receive(text: string): void {
    const message = JSON.parse(text);
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new RpcError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
      return;
    }
    const id = message.params?.subscription;
    if (id === undefined || this.unsubscribed.has(String(id))) return;
    const subscription = this.subscriptions.get(String(id));
    if (message.params.error !== undefined) {
      this.subscriptions.delete(String(id));
      subscription?.onEnd(`ended by node: ${JSON.stringify(message.params.error)}`);
      return;
    }
    if (subscription) subscription.onNotification(message.params.result);
    else this.early.set(String(id), [...(this.early.get(String(id)) ?? []), message.params.result]);
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`connection ${reason}`));
    }
    this.pending.clear();
    for (const subscription of this.subscriptions.values()) subscription.onEnd(`connection ${reason}`);
    this.subscriptions.clear();
    this.onClose(reason);
  }
}
