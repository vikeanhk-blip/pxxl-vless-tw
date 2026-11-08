"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const XRAY_VERSION = "v25.10.11";
const ASSETS = {
  "linux-x64": "Xray-linux-64.zip",
  "linux-arm64": "Xray-linux-arm64-v8a.zip",
  "darwin-arm64": "Xray-macos-arm64-v8a.zip",
  "darwin-x64": "Xray-macos-64.zip",
  "win32-x64": "Xray-windows-64.zip",
};

function assetFor(platform, arch) {
  const normalizedArch = arch === "arm64" ? "arm64" : "x64";
  return ASSETS[`${platform}-${normalizedArch}`] || ASSETS["linux-x64"];
}

function run(command, options = {}) {
  console.log(`> ${command}`);
  execSync(command, { stdio: "inherit", ...options });
}

function main() {
  const asset = assetFor(os.platform(), os.arch());
  const url = `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${asset}`;
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "xray-"));
  const archive = path.join(workdir, asset);
  const extracted = path.join(workdir, "extracted");
  const binaryName = os.platform() === "win32" ? "xray.exe" : "xray";

  try {
    fs.mkdirSync(extracted, { recursive: true });
    run(`curl -fL --retry 3 -o "${archive}" "${url}"`);
    run(`unzip -o -q "${archive}" -d "${extracted}"`);
    const source = path.join(extracted, binaryName);
    const target = path.join(__dirname, binaryName);
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o755);
    console.log(`installed ${binaryName} -> ${target}`);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

main();
