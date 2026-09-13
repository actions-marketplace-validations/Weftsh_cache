// The committed bundles, run as the runner runs them: a child `node
// dist/<entry>/index.js` with the inputs in its env. This is the only test
// that sees a bundling mistake (a deep import ncc could not follow, a
// dynamic require), which the source suites cannot.
import { spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeWeft } from "./fake";

const root = path.resolve(__dirname, "..");
let fake: FakeWeft;
let tmp: string;
let workspace: string;

// Asynchronous on purpose: a spawnSync would block the loop the fake
// answers on, and the child would wait forever.
async function run(
    entry: "restore" | "save" | "restore-only" | "save-only",
    inputs: Record<string, string>,
    state: Record<string, string> = {}
): Promise<{ status: number | null; stdout: string; outputs: Record<string, string>; state: Record<string, string> }> {
    const outputFile = path.join(tmp, `output-${crypto.randomUUID()}`);
    const stateFile = path.join(tmp, `state-${crypto.randomUUID()}`);
    fs.writeFileSync(outputFile, "");
    fs.writeFileSync(stateFile, "");
    const env: Record<string, string> = {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: path.join(tmp, "runner-temp"),
        GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REPOSITORY: "acme-inc/widget",
        GITHUB_OUTPUT: outputFile,
        GITHUB_STATE: stateFile,
        INPUT_TOKEN: fake.token,
        "INPUT_API-URL": fake.url,
        INPUT_PATH: "vendor",
        ...Object.fromEntries(
            Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])
        ),
        ...Object.fromEntries(
            Object.entries(state).map(([k, v]) => [`STATE_${k}`, v])
        )
    };
    const child = spawn(process.execPath, [path.join(root, "dist", entry, "index.js")], {
        cwd: workspace,
        env
    });
    let text = "";
    child.stdout.on("data", c => (text += c));
    child.stderr.on("data", c => (text += c));
    const status = await new Promise<number | null>(resolve =>
        child.on("close", code => resolve(code))
    );
    return {
        status,
        stdout: text,
        outputs: parse(outputFile),
        state: parse(stateFile)
    };
}

function parse(file: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /^([^<\n]+)<<(\S+)\n([\s\S]*?)\n\2\n/gm;
    let m: RegExpExecArray | null;
    const text = fs.readFileSync(file, "utf8");
    while ((m = re.exec(text))) out[m[1]] = m[3];
    return out;
}

beforeEach(async () => {
    fake = new FakeWeft();
    await fake.start();
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "weft-cache-dist-")));
    workspace = path.join(tmp, "ws");
    fs.mkdirSync(path.join(workspace, "vendor"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "runner-temp"));
    fs.writeFileSync(path.join(workspace, "vendor", "lib.bin"), crypto.randomBytes(50_000));
});

afterEach(async () => {
    await fake.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the committed dist", () => {
    it("exists for every entry point action.yml names", () => {
        for (const f of ["action.yml", "restore/action.yml", "save/action.yml"]) {
            const text = fs.readFileSync(path.join(root, f), "utf8");
            for (const m of text.matchAll(/^\s+(?:main|post): (.+)$/gm)) {
                expect(fs.existsSync(path.resolve(root, path.dirname(f), m[1])), m[1]).toBe(true);
            }
        }
    });

    it("saves and restores through the sub-actions", async () => {
        const before = fs.readFileSync(path.join(workspace, "vendor", "lib.bin"));
        const save = await run("save-only", { key: "k1" });
        expect(save.status, save.stdout).toBe(0);
        expect(save.stdout).toContain("Cache saved with key: k1");
        expect(save.stdout).not.toMatch(/::(warning|error)/);

        fs.rmSync(path.join(workspace, "vendor"), { recursive: true });
        const restore = await run("restore-only", { key: "k1" });
        expect(restore.status, restore.stdout).toBe(0);
        expect(restore.outputs).toEqual({
            "cache-primary-key": "k1",
            "cache-matched-key": "k1",
            "cache-hit": "true"
        });
        expect(fs.readFileSync(path.join(workspace, "vendor", "lib.bin")).equals(before)).toBe(true);
    });

    it("the main action restores in main, records state, and its post step honours it", async () => {
        expect((await run("save-only", { key: "k2" })).status).toBe(0);
        const main = await run("restore", { key: "k2" });
        expect(main.status, main.stdout).toBe(0);
        expect(main.outputs["cache-hit"]).toBe("true");
        expect(main.state).toEqual({ CACHE_KEY: "k2", CACHE_RESULT: "k2" });
        const calls = fake.requests.length;
        const post = await run("save", { key: "k2" }, main.state);
        expect(post.status, post.stdout).toBe(0);
        expect(post.stdout).toContain("not saving cache");
        expect(fake.requests.length).toBe(calls);
    });

    it("a miss exits 0 and fail-on-cache-miss exits 1", async () => {
        const miss = await run("restore-only", { key: "nope" });
        expect(miss.status, miss.stdout).toBe(0);
        expect(miss.outputs["cache-hit"]).toBeUndefined();
        const fail = await run("restore-only", { key: "nope", "fail-on-cache-miss": "true" });
        expect(fail.status).toBe(1);
        expect(fail.stdout).toMatch(/::error::.*fail-on-cache-miss is set/);
    });

    it("a refusal exits 0 with a warning", async () => {
        const r = await run("restore-only", { key: "k", token: fake.otherToken });
        expect(r.status, r.stdout).toBe(0);
        expect(r.stdout).toMatch(/::warning::Failed to restore: .*403/);
        const s = await run("save-only", { key: "k", token: fake.otherToken });
        expect(s.status, s.stdout).toBe(0);
        expect(s.stdout).toMatch(/::warning::Failed to save: .*403/);
        expect(s.stdout).toContain("::warning::Cache save failed.");
    });
});
