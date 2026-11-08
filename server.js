"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const net = require("net");
const WebSocket = require("ws");

const UUID = process.env.UUID || "";
const WSPATH = process.env.WSPATH || "/ws";
const PORT = Number(process.env.PORT || 8080);

if (!UUID) {
  console.error("missing UUID environment variable");
  process.exit(1);
}
if (!WSPATH.startsWith("/")) {
  console.error("WSPATH must start with /");
  process.exit(1);
}

// Xray 入站改为纯 TCP 的 VLESS（network: "tcp"），监听 127.0.0.1 上的随机端口。
// 之前是 network: "ws"：Xray 自己在随机端口上等 WebSocket 握手，
// 但 Node 从未向那个端口发起过任何连接——它把客户端 WS 消息写进了
// Xray 的 stdin，而 Xray 不从 stdin 读流量，且回包也从未发回客户端。
// 所以客户端能连上 WS、健康检查也能通过，却永远上不了网。
const config = {
  log: { loglevel: "info" },
  inbounds: [
    {
      port: 0,
      listen: "127.0.0.1",
      protocol: "vless",
      settings: {
        clients: [{ id: UUID, flow: "" }],
        decryption: "none",
      },
      streamSettings: {
        network: "tcp",
      },
    },
  ],
  outbounds: [{ protocol: "freedom", tag: "direct" }],
};

const server = http.createServer((req, res) => {
  const rawPath = req.url || "/";
  const urlPath = rawPath.split("?")[0];
  if (urlPath === "/") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

const wss = new WebSocket.Server({ noServer: true });
const app = { server, wss, xray: null, xrayPort: null };

function writeConfigAndStart() {
  const randomPort = 10000 + Math.floor(Math.random() * 45000);
  config.inbounds[0].port = randomPort;
  app.xrayPort = randomPort;
  // 配置写到 /tmp：工作区只读，写 ./config.json 会在部署时失败，见 2ddc95a
  const configPath = path.join(os.tmpdir(), "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`✅ xray config written (port ${randomPort})`);
  startXray(configPath);
}

function startXray(configPath) {
  const binaryPath = "/workspace/app/xray";
  // stdin 已不再用于传流量，设为 ignore；stdout/stderr 仍继承到容器日志。
  const xray = spawn(binaryPath, ["-c", configPath], { stdio: ["ignore", "inherit", "inherit"] });
  xray.on("error", (err) => console.error("❌ failed to start xray:", err));
  xray.on("exit", (code, signal) => console.error(`❌ xray exited code=${code} signal=${signal}`));
  app.xray = xray;
}

// 每条入站 WS 连接 <-> 一条到 Xray 内部 TCP 入站的 TCP 连接，双向转发。
wss.on("connection", (ws) => {
  const upstream = net.connect(app.xrayPort, "127.0.0.1");
  upstream.on("connect", () => console.log(`🔗 ws -> xray tcp connected (port ${app.xrayPort})`));
  upstream.on("data", (chunk) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  });
  upstream.on("error", (err) => {
    console.error("❌ xray tcp error:", err.message);
    try { ws.close(); } catch {}
  });
  upstream.on("close", () => {
    try { ws.close(); } catch {}
  });
  ws.on("message", (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    upstream.write(buf);
  });
  ws.on("error", () => upstream.destroy());
  ws.on("close", () => upstream.destroy());
});

server.on("upgrade", (req, socket, head) => {
  let urlPath = "/";
  try { urlPath = new URL(req.url || "/", "http://127.0.0.1").pathname; } catch {}
  if (urlPath === WSPATH && String(req.headers.upgrade || "").toLowerCase() === "websocket") {
    wss.handleUpgrade(req, socket, head, (ws) => { wss.emit("connection", ws, req); });
  } else {
    socket.destroy();
  }
});

writeConfigAndStart();
server.listen(PORT, () => {
  console.log(`🌐 listening on ${PORT}`);
});
