import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    blockId,
    blockListXml,
    WeftCacheClient,
    WeftCacheError
} from "../src/weft/client";
import { isRepositoryName } from "../src/weft/config";
import { FakeWeft } from "./fake";

let fake: FakeWeft;
let tmp: string;

const repository = "acme-inc/widget";

function client(
    overrides: Partial<{ token: string; repository: string }> = {},
    options: ConstructorParameters<typeof WeftCacheClient>[1] = {}
): WeftCacheClient {
    return new WeftCacheClient(
        {
            apiUrl: fake.url,
            token: fake.token,
            repository,
            ...overrides
        },
        { retryDelayMs: 5, ...options }
    );
}

function file(name: string, bytes: Buffer): string {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, bytes);
    return p;
}

function pattern(size: number): Buffer {
    const out = Buffer.alloc(size);
    for (let i = 0; i < size; i++) out[i] = (i * 7 + (i >> 8)) & 0xff;
    return out;
}

beforeEach(async () => {
    fake = new FakeWeft();
    await fake.start();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "weft-cache-"));
});

afterEach(async () => {
    await fake.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe("every request", () => {
    it("carries the bearer token and the repository header", async () => {
        const c = client();
        const bytes = Buffer.from("hello cache");
        const reserved = await c.createCacheEntry({ key: "k", version: "v" });
        expect(reserved.ok).toBe(true);
        expect(reserved.signedUploadUrl).toMatch(/\/v1\/cache\/blob\/e\d+$/);
        await c.uploadArchive(reserved.signedUploadUrl, file("a", bytes));
        await c.finalizeCacheEntryUpload({
            key: "k",
            version: "v",
            sizeBytes: bytes.length
        });
        const hit = await c.getCacheEntryDownloadURL({
            key: "k",
            version: "v",
            restoreKeys: []
        });
        await c.downloadArchive(hit.signedDownloadUrl, path.join(tmp, "out"));
        c.dispose();

        expect(fake.requests.length).toBe(5);
        for (const r of fake.requests) {
            expect(r.headers["authorization"], r.url).toBe(
                `Bearer ${fake.token}`
            );
            expect(r.headers["x-weft-repository"], r.url).toBe(repository);
            expect(r.headers["user-agent"]).toMatch(/^weftsh-cache\//);
        }
        // The signed URLs carry nothing: the credential is the header.
        expect(reserved.signedUploadUrl).not.toContain(fake.token);
        expect(hit.signedDownloadUrl).not.toContain(fake.token);
    });

    it("sends the twirp bodies snake_case, as the server reads them", async () => {
        const c = client();
        await c.getCacheEntryDownloadURL({
            key: "k",
            version: "v",
            restoreKeys: ["k-", "other-"]
        });
        expect(fake.twirpCalls("GetCacheEntryDownloadURL")[0].body.toString()).toBe(
            JSON.stringify({ key: "k", version: "v", restore_keys: ["k-", "other-"] })
        );
        fake.seed(repository, "k", "v", Buffer.from("x"));
        // finalize reports size_bytes as a string, like @actions/cache.
        await c.createCacheEntry({ key: "f", version: "v" });
        await expect(
            c.finalizeCacheEntryUpload({ key: "f", version: "v", sizeBytes: 12 })
        ).rejects.toThrow(/nothing was uploaded/);
        const fin = fake.twirpCalls("FinalizeCacheEntryUpload")[0];
        expect(JSON.parse(fin.body.toString())).toEqual({
            key: "f",
            version: "v",
            size_bytes: "12"
        });
        expect(fin.headers["content-type"]).toBe("application/json");
        c.dispose();
    });
});

describe("upload", () => {
    it("sends an archive at or under the single-shot limit as one PUT", async () => {
        const c = client({}, { limits: { singleShot: 1000, minBlock: 100 } });
        const bytes = pattern(1000);
        const r = await c.createCacheEntry({ key: "one", version: "v" });
        const sent = await c.uploadArchive(r.signedUploadUrl, file("a", bytes));
        expect(sent).toBe(1000);
        const puts = fake.requests.filter(x => x.method === "PUT");
        expect(puts.length).toBe(1);
        expect(puts[0].url).toBe(`/v1/cache/blob/${r.signedUploadUrl.split("/").pop()}`);
        expect(puts[0].headers["x-ms-blob-type"]).toBe("BlockBlob");
        expect(puts[0].headers["content-length"]).toBe("1000");
        expect(puts[0].body.equals(bytes)).toBe(true);
        await c.finalizeCacheEntryUpload({ key: "one", version: "v", sizeBytes: 1000 });
        expect(fake.bytesOf("one", "v", repository)!.equals(bytes)).toBe(true);
        c.dispose();
    });

    it("sends a larger archive as ordered blocks and a block list", async () => {
        const c = client({}, { limits: { singleShot: 1000, minBlock: 100 } });
        const bytes = pattern(1001 + 2 * 300); // 1601 bytes: 5 blocks of 300, 5 of 101
        const r = await c.createCacheEntry({ key: "big", version: "v" });
        const sent = await c.uploadArchive(r.signedUploadUrl, file("a", bytes), {
            blockSize: 300,
            concurrency: 2
        });
        expect(sent).toBe(bytes.length);
        const blocks = fake.requests.filter(x => x.url.includes("comp=block&"));
        expect(blocks.length).toBe(6);
        for (const b of blocks) {
            expect(b.headers["x-ms-blob-type"]).toBe("BlockBlob");
            expect(b.headers["content-length"]).toBe(String(b.body.length));
        }
        const list = fake.requests.filter(x => x.url.endsWith("?comp=blocklist"));
        expect(list.length).toBe(1);
        const ids = [0, 1, 2, 3, 4, 5].map(blockId);
        expect(list[0].body.toString()).toBe(blockListXml(ids));
        expect(list[0].headers["content-type"]).toBe("application/xml");
        // Ids are one length, as Azure requires; the list is the order.
        expect(new Set(ids.map(i => i.length)).size).toBe(1);
        // The list came after every block.
        const lastBlock = Math.max(...blocks.map(b => fake.requests.indexOf(b)));
        expect(fake.requests.indexOf(list[0])).toBeGreaterThan(lastBlock);
        await c.finalizeCacheEntryUpload({ key: "big", version: "v", sizeBytes: sent });
        expect(fake.bytesOf("big", "v", repository)!.equals(bytes)).toBe(true);
        c.dispose();
    });

    it("clamps the block size to what the server takes", async () => {
        const c = client({}, { limits: { singleShot: 100, minBlock: 50 } });
        const bytes = pattern(260);
        const r = await c.createCacheEntry({ key: "clamp", version: "v" });
        await c.uploadArchive(r.signedUploadUrl, file("a", bytes), { blockSize: 1 });
        const blocks = fake.requests.filter(x => x.url.includes("comp=block&"));
        expect(blocks.length).toBe(6); // 260 / 50
        c.dispose();
    });

    it("retries a block that the store dropped", async () => {
        const c = client({}, { limits: { singleShot: 100, minBlock: 50 } });
        const bytes = pattern(150);
        fake.failPut = 1;
        const r = await c.createCacheEntry({ key: "retry", version: "v" });
        await c.uploadArchive(r.signedUploadUrl, file("a", bytes), {
            blockSize: 100,
            concurrency: 1
        });
        await c.finalizeCacheEntryUpload({ key: "retry", version: "v", sizeBytes: 150 });
        expect(fake.bytesOf("retry", "v", repository)!.equals(bytes)).toBe(true);
        expect(fake.requests.filter(x => x.url.includes("comp=block&")).length).toBe(3);
        c.dispose();
    });

    it("refuses an empty archive before sending anything", async () => {
        const c = client();
        await expect(
            c.uploadArchive(`${fake.url}/v1/cache/blob/e1`, file("empty", Buffer.alloc(0)))
        ).rejects.toThrow(/empty/);
        expect(fake.requests.length).toBe(0);
        c.dispose();
    });
});

describe("download", () => {
    it("streams the archive to disk", async () => {
        const bytes = pattern(70_000);
        fake.seed(repository, "k", "v", bytes);
        const c = client();
        const hit = await c.getCacheEntryDownloadURL({ key: "k", version: "v", restoreKeys: [] });
        const out = path.join(tmp, "out");
        expect(await c.downloadArchive(hit.signedDownloadUrl, out)).toBe(70_000);
        expect(fs.readFileSync(out).equals(bytes)).toBe(true);
        c.dispose();
    });

    it("resumes a cut transfer with a Range request from the bytes on disk", async () => {
        const bytes = pattern(200_000);
        fake.seed(repository, "k", "v", bytes);
        fake.cutDownloadAfter = 65_536;
        const c = client();
        const hit = await c.getCacheEntryDownloadURL({ key: "k", version: "v", restoreKeys: [] });
        const out = path.join(tmp, "out");
        expect(await c.downloadArchive(hit.signedDownloadUrl, out)).toBe(200_000);
        expect(fs.readFileSync(out).equals(bytes)).toBe(true);
        const gets = fake.requests.filter(r => r.method === "GET");
        expect(gets.length).toBe(2);
        expect(gets[0].headers["range"]).toBeUndefined();
        expect(gets[1].headers["range"]).toBe("bytes=65536-");
        c.dispose();
    });
});

describe("misses and refusals", () => {
    it("reads ok:false as a miss and a restore-key prefix as a hit", async () => {
        fake.seed(repository, "deps-linux-abc", "v", Buffer.from("old"));
        fake.seed(repository, "deps-linux-def", "v", Buffer.from("new"));
        const c = client();
        const miss = await c.getCacheEntryDownloadURL({
            key: "deps-linux-zzz",
            version: "v",
            restoreKeys: []
        });
        expect(miss).toEqual({ ok: false, signedDownloadUrl: "", matchedKey: "" });
        const hit = await c.getCacheEntryDownloadURL({
            key: "deps-linux-zzz",
            version: "v",
            restoreKeys: ["deps-linux-"]
        });
        expect(hit.ok).toBe(true);
        expect(hit.matchedKey).toBe("deps-linux-def");
        // A different version is a different cache.
        const other = await c.getCacheEntryDownloadURL({
            key: "deps-linux-abc",
            version: "v2",
            restoreKeys: ["deps-"]
        });
        expect(other.ok).toBe(false);
        c.dispose();
    });

    it("reads ok:false from CreateCacheEntry as nothing to do", async () => {
        fake.seed(repository, "k", "v", Buffer.from("x"));
        const c = client();
        expect(await c.createCacheEntry({ key: "k", version: "v" })).toEqual({
            ok: false,
            signedUploadUrl: ""
        });
        fake.atStorageCap = true;
        expect((await c.createCacheEntry({ key: "new", version: "v" })).ok).toBe(false);
        c.dispose();
    });

    it("surfaces a 403 and a 400 as errors that carry the status and the sentence", async () => {
        const wrongKind = client({ token: fake.otherToken });
        await expect(
            wrongKind.getCacheEntryDownloadURL({ key: "k", version: "v", restoreKeys: [] })
        ).rejects.toMatchObject({
            name: "WeftCacheError",
            statusCode: 403,
            message: expect.stringMatching(/not minted for the build cache/)
        });
        wrongKind.dispose();
        const noRepo = client({ repository: "" });
        await expect(
            noRepo.createCacheEntry({ key: "k", version: "v" })
        ).rejects.toMatchObject({ statusCode: 400 });
        noRepo.dispose();
        const unknown = client({ token: "wft_bogus" });
        await expect(
            unknown.createCacheEntry({ key: "k", version: "v" })
        ).rejects.toMatchObject({ statusCode: 401 });
        unknown.dispose();
        // None of those is retried.
        expect(fake.twirpCalls("GetCacheEntryDownloadURL").length).toBe(1);
        expect(fake.twirpCalls("CreateCacheEntry").length).toBe(2);
    });

    it("retries a 5xx and then gives up with the status", async () => {
        fake.failTwirp = 2;
        const c = client({}, { attempts: 3 });
        const out = await c.getCacheEntryDownloadURL({ key: "k", version: "v", restoreKeys: [] });
        expect(out.ok).toBe(false);
        expect(fake.twirpCalls("GetCacheEntryDownloadURL").length).toBe(3);
        fake.failTwirp = 3;
        let err: unknown;
        try {
            await c.getCacheEntryDownloadURL({ key: "k", version: "v", restoreKeys: [] });
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(WeftCacheError);
        expect((err as WeftCacheError).statusCode).toBe(503);
        c.dispose();
    });

    it("reports a server that is not there", async () => {
        const c = new WeftCacheClient(
            { apiUrl: "http://127.0.0.1:9", token: "t", repository },
            { attempts: 2, retryDelayMs: 1 }
        );
        await expect(
            c.getCacheEntryDownloadURL({ key: "k", version: "v", restoreKeys: [] })
        ).rejects.toMatchObject({ name: "WeftCacheError", statusCode: undefined });
        c.dispose();
    });
});

describe("the repository name", () => {
    it("is owner/name as GitHub spells it", () => {
        for (const ok of ["acme-inc/widget", "a/b", "Acme.Inc/w_1", "o/" + "n".repeat(190)]) {
            expect(isRepositoryName(ok), ok).toBe(true);
        }
        for (const bad of ["", "widget", "a/b/c", "acme inc/widget", "/widget", "acme/", "o/" + "n".repeat(199)]) {
            expect(isRepositoryName(bad), bad).toBe(false);
        }
    });
});
