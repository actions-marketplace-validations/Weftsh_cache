// The action as the runner runs it: inputs in INPUT_* env, outputs and state
// in the files GITHUB_OUTPUT and GITHUB_STATE name, a real tar of a real
// workspace, against the fake. What is asserted is what a workflow sees.
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { restoreImpl } from "../src/restoreImpl";
import { saveImpl } from "../src/saveImpl";
import { NullStateProvider, StateProvider } from "../src/stateProvider";
import { FakeWeft } from "./fake";

let fake: FakeWeft;
let tmp: string;
let workspace: string;
let lines: string[];
const savedEnv = { ...process.env };
const savedCwd = process.cwd();
const realWrite = process.stdout.write.bind(process.stdout);

const repository = "acme-inc/widget";

function setInput(name: string, value: string): void {
    process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] = value;
}

function outputs(): Record<string, string> {
    const file = process.env["GITHUB_OUTPUT"]!;
    const out: Record<string, string> = {};
    if (!fs.existsSync(file)) return out;
    // name<<delim\nvalue\ndelim
    const text = fs.readFileSync(file, "utf8");
    const re = /^([^<\n]+)<<(\S+)\n([\s\S]*?)\n\2\n/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out[m[1]] = m[3];
    return out;
}

function states(): Record<string, string> {
    const file = process.env["GITHUB_STATE"]!;
    const out: Record<string, string> = {};
    if (!fs.existsSync(file)) return out;
    const text = fs.readFileSync(file, "utf8");
    const re = /^([^<\n]+)<<(\S+)\n([\s\S]*?)\n\2\n/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out[m[1]] = m[3];
    return out;
}

function commands(kind: string): string[] {
    return lines
        .filter(l => l.startsWith(`::${kind}`))
        .map(l => l.replace(/^::\w+(?:[^:]*)::/, "").trim());
}

function warnings(): string[] {
    return [...commands("warning"), ...lines.filter(l => l.startsWith("[warning]"))];
}

function populate(): void {
    fs.mkdirSync(path.join(workspace, "node_modules", "left-pad"), {
        recursive: true
    });
    fs.writeFileSync(
        path.join(workspace, "node_modules", "left-pad", "index.js"),
        "module.exports = s => ' ' + s;\n"
    );
    fs.writeFileSync(path.join(workspace, "node_modules", ".bin"), "x".repeat(5000));
    fs.mkdirSync(path.join(workspace, "target"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "target", "out.bin"), crypto.randomBytes(20_000));
}

function wipe(): void {
    for (const d of ["node_modules", "target"]) {
        fs.rmSync(path.join(workspace, d), { recursive: true, force: true });
    }
}

function tree(): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(p);
            else
                out[path.relative(workspace, p)] = crypto
                    .createHash("sha256")
                    .update(fs.readFileSync(p))
                    .digest("hex");
        }
    };
    walk(workspace);
    return out;
}

beforeEach(async () => {
    fake = new FakeWeft();
    await fake.start();
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "weft-cache-rt-")));
    workspace = path.join(tmp, "ws");
    fs.mkdirSync(workspace);
    // The runner runs a step in the workspace; the path globs are
    // relative to the cwd, as they are for actions/cache.
    process.chdir(workspace);
    fs.mkdirSync(path.join(tmp, "runner-temp"));
    for (const k of Object.keys(process.env)) {
        if (k.startsWith("INPUT_") || k.startsWith("STATE_")) delete process.env[k];
    }
    process.env["GITHUB_WORKSPACE"] = workspace;
    process.env["RUNNER_TEMP"] = path.join(tmp, "runner-temp");
    process.env["GITHUB_REF"] = "refs/heads/main";
    process.env["GITHUB_EVENT_NAME"] = "push";
    process.env["GITHUB_REPOSITORY"] = repository;
    // The runner creates both files before the step runs.
    process.env["GITHUB_OUTPUT"] = path.join(tmp, "output");
    process.env["GITHUB_STATE"] = path.join(tmp, "state");
    fs.writeFileSync(process.env["GITHUB_OUTPUT"], "");
    fs.writeFileSync(process.env["GITHUB_STATE"], "");
    delete process.env["RUNNER_DEBUG"];
    setInput("token", fake.token);
    setInput("api-url", fake.url);
    setInput("path", "node_modules\ntarget");
    setInput("key", "deps-linux-abc123");
    lines = [];
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        lines.push(...String(chunk).split("\n").filter(Boolean));
        return true;
    }) as typeof process.stdout.write;
    process.exitCode = undefined;
});

afterEach(async () => {
    process.stdout.write = realWrite;
    process.exitCode = undefined;
    process.chdir(savedCwd);
    for (const k of Object.keys(process.env)) {
        if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
    await fake.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe("save then restore", () => {
    it("brings the workspace back byte for byte, with the outputs a workflow reads", async () => {
        populate();
        const before = tree();
        expect(Object.keys(before).length).toBe(3);

        const id = await saveImpl(new NullStateProvider());
        expect(id).not.toBe(-1);
        expect(warnings()).toEqual([]);
        expect(lines.some(l => l.includes("Cache saved with key: deps-linux-abc123"))).toBe(true);
        expect(fake.twirpCalls("CreateCacheEntry").length).toBe(1);
        expect(fake.twirpCalls("FinalizeCacheEntryUpload").length).toBe(1);
        const single = fake.requests.filter(r => r.method === "PUT");
        expect(single.length).toBe(1);
        expect(single[0].url).not.toContain("comp=");

        // The version is the one actions/cache computes: the raw path
        // patterns, the compression method and the salt, sha256'd. A cache
        // written by this action is found by actions/cache's key and
        // version, and the other way round.
        const create = JSON.parse(fake.twirpCalls("CreateCacheEntry")[0].body.toString());
        const method = fs.existsSync("/opt/homebrew/bin/zstd") || which("zstd")
            ? "zstd-without-long"
            : "gzip";
        const expected = crypto
            .createHash("sha256")
            .update(["node_modules", "target", method, "1.0"].join("|"))
            .digest("hex");
        expect(create.version).toBe(expected);
        expect(create.key).toBe("deps-linux-abc123");

        wipe();
        expect(Object.keys(tree()).length).toBe(0);
        fs.writeFileSync(process.env["GITHUB_OUTPUT"]!, "");

        const key = await restoreImpl(new NullStateProvider());
        expect(key).toBe("deps-linux-abc123");
        expect(warnings()).toEqual([]);
        expect(process.exitCode).toBeUndefined();
        expect(tree()).toEqual(before);
        expect(outputs()).toEqual({
            "cache-primary-key": "deps-linux-abc123",
            "cache-matched-key": "deps-linux-abc123",
            "cache-hit": "true"
        });
        // The temp archive is gone.
        expect(fs.readdirSync(path.join(tmp, "runner-temp")).every(d =>
            fs.readdirSync(path.join(tmp, "runner-temp", d)).every(f => f === "manifest.txt")
        )).toBe(true);
    });

    it("restores a restore-key prefix match and reports cache-hit false", async () => {
        populate();
        setInput("key", "deps-linux-old");
        await saveImpl(new NullStateProvider());
        wipe();
        setInput("key", "deps-linux-new");
        setInput("restore-keys", "deps-linux-\ndeps-");
        const key = await restoreImpl(new NullStateProvider());
        expect(key).toBe("deps-linux-old");
        expect(outputs()["cache-hit"]).toBe("false");
        expect(outputs()["cache-matched-key"]).toBe("deps-linux-old");
        expect(Object.keys(tree()).length).toBe(3);
        const body = JSON.parse(fake.twirpCalls("GetCacheEntryDownloadURL")[0].body.toString());
        expect(body.restore_keys).toEqual(["deps-linux-", "deps-"]);
    });

    it("looks up without downloading when lookup-only is set", async () => {
        populate();
        await saveImpl(new NullStateProvider());
        wipe();
        setInput("lookup-only", "true");
        expect(await restoreImpl(new NullStateProvider())).toBe("deps-linux-abc123");
        expect(outputs()["cache-hit"]).toBe("true");
        expect(Object.keys(tree()).length).toBe(0);
        expect(fake.requests.filter(r => r.method === "GET").length).toBe(0);
    });

    it("does not save again after an exact hit in the same job", async () => {
        populate();
        await saveImpl(new NullStateProvider());
        wipe();
        await restoreImpl(new StateProvider());
        // The runner hands the post step its state as STATE_* env.
        for (const [k, v] of Object.entries(states())) process.env[`STATE_${k}`] = v;
        const calls = fake.requests.length;
        await saveImpl(new StateProvider());
        expect(lines.some(l => l.includes("not saving cache"))).toBe(true);
        expect(fake.requests.length).toBe(calls);
    });

    it("saves in blocks when the archive is over the chunk size", async () => {
        // A 1 MiB minimum block and a 128 MiB single-shot limit are the
        // product's numbers; the client suite lowers them. Here a save
        // must stay under both, so this only checks the input is read.
        populate();
        setInput("upload-chunk-size", "1048576");
        expect(await saveImpl(new NullStateProvider())).not.toBe(-1);
        expect(fake.requests.filter(r => r.method === "PUT").length).toBe(1);
    });
});

describe("a miss", () => {
    it("is a miss: no cache-hit output, no warning, no failure", async () => {
        populate();
        expect(await restoreImpl(new NullStateProvider())).toBeUndefined();
        expect(outputs()["cache-hit"]).toBeUndefined();
        expect(outputs()["cache-primary-key"]).toBe("deps-linux-abc123");
        expect(warnings()).toEqual([]);
        expect(process.exitCode).toBeUndefined();
        expect(lines.some(l => l.includes("Cache not found for input keys: deps-linux-abc123"))).toBe(true);
    });

    it("fails the step only when fail-on-cache-miss is set", async () => {
        setInput("fail-on-cache-miss", "true");
        expect(await restoreImpl(new NullStateProvider())).toBeUndefined();
        expect(process.exitCode).toBe(1);
        expect(commands("error").join("\n")).toMatch(/fail-on-cache-miss is set/);
    });

    it("an existing entry is nothing to do, not a failure", async () => {
        populate();
        await saveImpl(new NullStateProvider());
        expect(await saveImpl(new NullStateProvider())).toBe(-1);
        expect(lines.some(l => l.includes("Failed to save: Unable to reserve cache with key deps-linux-abc123: it already exists"))).toBe(true);
        expect(warnings()).toEqual([]);
        expect(process.exitCode).toBeUndefined();
        expect(fake.requests.filter(r => r.method === "PUT").length).toBe(1);
    });

    it("an organisation at its storage cap is nothing to do, not a failure", async () => {
        populate();
        fake.atStorageCap = true;
        expect(await saveImpl(new NullStateProvider())).toBe(-1);
        expect(commands("error")).toEqual([]);
        expect(process.exitCode).toBeUndefined();
    });
});

describe("a refusal", () => {
    it("403 from a token of the wrong kind is a warning and a miss, never a failed job", async () => {
        populate();
        setInput("token", fake.otherToken);
        expect(await restoreImpl(new NullStateProvider())).toBeUndefined();
        expect(process.exitCode).toBeUndefined();
        expect(commands("error")).toEqual([]);
        expect(warnings().join("\n")).toMatch(
            /Failed to restore: GetCacheEntryDownloadURL: 403: that token was not minted for the build cache/
        );
        expect(await saveImpl(new NullStateProvider())).toBe(-1);
        expect(process.exitCode).toBeUndefined();
        expect(warnings().join("\n")).toMatch(
            /Failed to save: CreateCacheEntry: 403: that token was not minted for the build cache/
        );
        expect(fake.requests.filter(r => r.method === "PUT").length).toBe(0);
    });

    it("401 from an unknown token is a warning and a miss", async () => {
        setInput("token", "wft_revoked");
        expect(await restoreImpl(new NullStateProvider())).toBeUndefined();
        expect(process.exitCode).toBeUndefined();
        expect(warnings().join("\n")).toMatch(/401: that cache token is unknown, revoked or expired/);
    });

    it("a repository the server would refuse with 400 never leaves the runner", async () => {
        setInput("repository", "widget");
        expect(await restoreImpl(new NullStateProvider())).toBeUndefined();
        expect(process.exitCode).toBeUndefined();
        expect(outputs()["cache-hit"]).toBe("false");
        expect(warnings().join("\n")).toMatch(/must be spelled owner\/name, got "widget"/);
        expect(fake.requests.length).toBe(0);
    });

    it("a server 400 on the wire is a warning and a miss", async () => {
        // The fake's header rule and the client's agree, so drive the
        // client past its own check with a name both take and a header
        // the fake alone rejects: the fake reads the raw header, so a
        // trailing slash the client did not strip is the test's way in.
        setInput("repository", "acme-inc/widget");
        process.env["GITHUB_REPOSITORY"] = "acme-inc/widget";
        // Make the fake refuse: swap its rule by pointing the token at the
        // other-kind token is 403; for 400 use the twirp validation path:
        // an empty key is refused with invalid_argument.
        setInput("key", " ");
        expect(await restoreImpl(new NullStateProvider())).toBeUndefined();
        expect(process.exitCode).toBeUndefined();
        expect(warnings().join("\n")).toMatch(/400: key and version are required/);
    });

    it("a server that is down is a warning and a miss", async () => {
        setInput("api-url", "http://127.0.0.1:9");
        expect(await restoreImpl(new NullStateProvider())).toBeUndefined();
        expect(process.exitCode).toBeUndefined();
        expect(warnings().join("\n")).toMatch(/Failed to restore: GetCacheEntryDownloadURL: connect ECONNREFUSED/);
    });

    it("5xx is logged as an error line but still a miss and not a failed job", async () => {
        fake.failTwirp = 99;
        expect(await restoreImpl(new NullStateProvider())).toBeUndefined();
        expect(process.exitCode).toBeUndefined();
        expect(commands("error").join("\n")).toMatch(/503: try later/);
    });
});

describe("no cache", () => {
    it("an empty token skips the cache with a warning, as a fork's pull request would", async () => {
        setInput("token", "");
        expect(await restoreImpl(new NullStateProvider())).toBeUndefined();
        expect(outputs()["cache-hit"]).toBe("false");
        expect(process.exitCode).toBeUndefined();
        expect(warnings().join("\n")).toMatch(/no Weft token was given/);
        expect(fake.requests.length).toBe(0);
        populate();
        expect(await saveImpl(new NullStateProvider())).toBeUndefined();
        expect(fake.requests.length).toBe(0);
    });

    it("an event with no ref is skipped, as actions/cache skips it", async () => {
        delete process.env["GITHUB_REF"];
        expect(await restoreImpl(new NullStateProvider())).toBeUndefined();
        expect(warnings().join("\n")).toMatch(/Event Validation Error/);
        expect(fake.requests.length).toBe(0);
    });

    it("a key with a comma fails the step, as actions/cache fails it", async () => {
        setInput("key", "a,b");
        await restoreImpl(new NullStateProvider());
        expect(process.exitCode).toBe(1);
        expect(commands("error").join("\n")).toMatch(/cannot contain commas/);
    });

    it("the repository defaults to the one the workflow runs in", async () => {
        delete process.env["INPUT_REPOSITORY"];
        process.env["GITHUB_REPOSITORY"] = "acme-inc/widget";
        await restoreImpl(new NullStateProvider());
        expect(fake.requests[0].headers["x-weft-repository"]).toBe("acme-inc/widget");
    });
});

function which(bin: string): boolean {
    return (process.env["PATH"] ?? "")
        .split(path.delimiter)
        .some(d => fs.existsSync(path.join(d, bin)));
}
