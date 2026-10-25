import { setTimeout as delay } from "node:timers/promises";

/** Test-only CDP connection shared by development and packaged lifecycle smoke checks. */
export async function desktopDebugger(url) {
  const socket = new WebSocket(url);
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.done(message.result);
  };
  function call(method, params = {}) {
    return new Promise((done, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Desktop debugger timeout: " + method)); }, 5000);
      pending.set(id, { done, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function wait(expression) {
    for (let attempt = 0; attempt < 150; attempt++) {
      try { if (await evaluate(expression)) return; }
      catch (error) { if (!/context|navigat/i.test(String(error))) throw error; }
      await delay(100);
    }
    throw new Error("Desktop UI did not become ready: " + expression);
  }
  function close() {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Desktop debugger closed")); }
    pending.clear(); socket.close();
  }
  await call("Runtime.enable"); await call("Page.enable");
  return { call, evaluate, wait, errors, close };
}
