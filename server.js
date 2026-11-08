"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
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

const config = {
  log: { loglevel: "warning" },
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
        network: "ws",
        wsSettings: {
          path: WSPATH.startsWith("/")
            ? WSPATH
            : `/${WSPATH}`,
        },
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
const app = { server, wss };

function sendToXray(message) {
  const payload = Buffer.isBuffer(message)
    ? message
    : Buffer.from(message);
  app.xray.stdin.write(
    Buffer.concat([
      Buffer.from([0x01, 0x00, 0x00]),
      Buffer.from([(payload.length >> 8) & 0xff, payload.length & 0xff]),
      payload,
    ])
  );
}

wss.on("connection", (socket) => {
  socket.on("message", sendToXray);
  socket.on("close", () => {
    socket.removeAllListeners();
  });
  socket.on("error", (error) => {
    console.error("websocket error", error.message);
  });
});

server.on("upgrade", (req, socket, head) => {
  const urlPath = (req.url || "").split("?")[0];
  if (urlPath === WSPATH && req.headers.upgrade === "websocket") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
    return;
  }
  socket.destroy();
});

function shutdown() {
  try {
    app.xray?.kill("SIGTERM");
  } catch {
    // ignore errors during shutdown
  }
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, () => {
  console.log(`listening on ${PORT}`);
});

writeConfigAndStart();

function writeConfigAndStart() {
  const randomPort = Math.floor(Math.random() * 45000) + 10000;
  config.inbounds[0].port = randomPort;
  fs.writeFileSync(
    path.join(__dirname, "config.json"),
    JSON.stringify(config)
  );
  console.log(`xray config written (port ${randomPort})`);
  startXray();
}

function startXray() {
  const binary = path.join(__dirname, "xray");
  if (!fs.existsSync(binary)) {
    console.error("xray binary missing; postinstall did not run");
    process.exit(1);
  }
  const child = spawn(binary, ["-c", "./config.json"], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  app.xray = child;
  child.on("error", (error) => {
    console.error("failed to start xray", error);
    process.exit(1);
  });
  child.on("exit", (code) => {
    console.error(`xray exited with ${code}`);
    process.exit(code || 1);
  });
}
