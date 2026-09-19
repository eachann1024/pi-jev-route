import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

// On-demand loopback UI only. No background server or external assets.
export async function startWeb(
  snapshot: () => { settings: unknown },
  save: (value: unknown, previous: string) => void,
  note: (id: string, value: string, previous: string) => void,
  idleMs = 300000,
) {
  const html = await readFile(new URL("../web/index.html", import.meta.url));
  const token = randomBytes(24).toString("hex");
  let origin = "", closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const etag = (settings: unknown) => `"${createHash("sha256").update(JSON.stringify(settings)).digest("hex")}"`;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };
  const touch = () => {
    clearTimeout(timer);
    if (!closed) { timer = setTimeout(close, idleMs); timer.unref(); }
  };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (req.headers.host !== origin.slice(7) || (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403).end(); return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    const noteMatch = /^\/notes\/([0-9a-f-]{36})$/.exec(req.url ?? "");
    if (req.url !== "/settings" && !noteMatch) { res.writeHead(404).end(); return; }
    try {
      if (req.method === "PUT" || req.method === "PATCH") {
        if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") { res.writeHead(415).end(); return; }
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 262144) { res.writeHead(413).end(); return; }
          chunks.push(Buffer.from(chunk));
        }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (req.url === "/settings" && req.method === "PUT") {
          const previous = snapshot().settings;
          if (req.headers["if-match"] !== etag(previous)) { res.writeHead(409).end("设置已变化，请刷新后重试。未覆盖当前设置。"); return; }
          save(value, JSON.stringify(previous));
        } else if (noteMatch && req.method === "PATCH") {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
          const record = value as Record<string, unknown>;
          if (Object.keys(record).some(key => !["note", "previousNote"].includes(key)) || typeof record.note !== "string" || typeof record.previousNote !== "string"
            || record.note.length > 1000 || record.previousNote.length > 1000) throw new TypeError();
          note(noteMatch[1], record.note, record.previousNote);
        } else { res.writeHead(405).end(); return; }
      } else if (req.method !== "GET" || req.url !== "/settings") { res.writeHead(405).end(); return; }
      const data = snapshot();
      touch();
      res.setHeader("ETag", etag(data.settings));
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(data));
    } catch (error) {
      const conflict = error instanceof Error && error.message === "conflict";
      res.writeHead(conflict ? 409 : error instanceof TypeError || error instanceof SyntaxError ? 400 : 500);
      res.end(conflict ? "内容已由其他窗口修改，请刷新后重试。" : "无法保存，请检查输入或文件权限。原有数据未被覆盖。");
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { close(); throw new Error("Unable to open settings"); }
  origin = `http://127.0.0.1:${address.port}`;
  server.unref();
  touch();
  return { url: `${origin}/#${token}`, close, touch, get closed() { return closed; } };
}
