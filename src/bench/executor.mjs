// Executors give the agent a place to run shell commands and edit files. Two backends, same
// interface, so the shell tools and the benchmark runner don't care which is in use:
//   • LocalExecutor  — a disposable temp workdir on the host. Works with no Docker. Fine for the
//                      built-in task suite (tasks we author with known verifiers); do NOT point it
//                      at untrusted tasks, since the agent's commands run on your machine.
//   • DockerExecutor — one container per task (real isolation). Use this for real Terminal-Bench or
//                      any task you didn't write. Requires the Docker daemon.
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const pexec = promisify(execFile);

export class LocalExecutor {
  constructor() { this.dir = mkdtempSync(join(tmpdir(), "hero-bench-")); }
  async exec(cmd, { timeout = 30000 } = {}) {
    try { const { stdout, stderr } = await pexec("sh", ["-c", cmd], { cwd: this.dir, timeout, maxBuffer: 4 << 20 }); return { code: 0, stdout, stderr }; }
    catch (e) { return { code: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || String(e.message) }; }
  }
  async write(path, content) { const p = join(this.dir, path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); return { code: 0 }; }
  async read(path) { try { return readFileSync(join(this.dir, path), "utf8"); } catch (e) { return `read error: ${e.message}`; } }
  async cleanup() { try { rmSync(this.dir, { recursive: true, force: true }); } catch {} }
  label() { return `local:${this.dir}`; }
}

export class DockerExecutor {
  constructor({ image = "python:3.12-slim", name } = {}) {
    this.image = image;
    this.name = name || `hero-bench-${Math.floor(Date.now() % 1e9)}`;
    this.started = false;
  }
  async _start() {
    if (this.started) return;
    await pexec("docker", ["run", "-d", "--rm", "--network", "none", "--name", this.name, this.image, "sleep", "3600"]);
    this.started = true;
  }
  async exec(cmd, { timeout = 30000 } = {}) {
    await this._start();
    try { const { stdout, stderr } = await pexec("docker", ["exec", this.name, "sh", "-c", cmd], { timeout, maxBuffer: 4 << 20 }); return { code: 0, stdout, stderr }; }
    catch (e) { return { code: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || String(e.message) }; }
  }
  async write(path, content) {
    await this._start();
    const b64 = Buffer.from(content).toString("base64");
    return this.exec(`mkdir -p "$(dirname '${path}')" && echo '${b64}' | base64 -d > '${path}'`);
  }
  async read(path) { const r = await this.exec(`cat '${path}'`); return r.code === 0 ? r.stdout : `read error: ${r.stderr}`; }
  async cleanup() { try { await pexec("docker", ["rm", "-f", this.name]); } catch {} }
  label() { return `docker:${this.image}`; }
}
