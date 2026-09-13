// A Node http fake of Weft's cache routes, as api/cache_api.rs answers them:
// the three twirp calls, the blob PUT (single, block, block list) and the
// ranged blob GET, with the same refusals in the same order (401 no token,
// 403 wrong kind, 400 no usable repository header). It records every
// request so a test can assert what was sent, and it can be told to fail
// in the ways the client has to survive.
import * as http from "http";
import { AddressInfo } from "net";

export interface Recorded {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}

interface Entry {
    id: string;
    repository: string;
    key: string;
    version: string;
    state: "reserving" | "ready";
    blocks: Map<string, Buffer>;
    order: string[];
    single?: Buffer;
}

export interface FakeOptions {
    /** The one token that is a repo:cache token. */
    token?: string;
    /** A token that exists but was minted for something else (403). */
    otherToken?: string;
}

export class FakeWeft {
    readonly requests: Recorded[] = [];
    readonly entries: Entry[] = [];
    /** CreateCacheEntry answers ok:false while this is set. */
    atStorageCap = false;
    /** The next N twirp calls answer 503. */
    failTwirp = 0;
    /** The next N blob PUTs answer 500. */
    failPut = 0;
    /** The first GET is cut off after this many bytes. */
    cutDownloadAfter?: number;
    private cutDone = false;
    private server?: http.Server;
    private next = 1;
    readonly token: string;
    readonly otherToken: string;
    url = "";

    constructor(options: FakeOptions = {}) {
        this.token = options.token ?? "wft_cache_token";
        this.otherToken = options.otherToken ?? "wft_admin_token";
    }

    async start(): Promise<string> {
        this.server = http.createServer((req, res) => this.handle(req, res));
        await new Promise<void>(resolve =>
            this.server!.listen(0, "127.0.0.1", resolve)
        );
        const port = (this.server!.address() as AddressInfo).port;
        this.url = `http://127.0.0.1:${port}`;
        return this.url;
    }

    async stop(): Promise<void> {
        await new Promise<void>(resolve => {
            this.server?.closeAllConnections();
            this.server?.close(() => resolve());
        });
    }

    /** What a finalized entry holds, in order. */
    bytesOf(key: string, version: string, repository: string): Buffer | undefined {
        const e = this.entries.find(
            x =>
                x.repository === repository &&
                x.key === key &&
                x.version === version &&
                x.state === "ready"
        );
        return e && assembled(e);
    }

    /** Puts a ready entry in place without going through the client. */
    seed(repository: string, key: string, version: string, bytes: Buffer): void {
        this.entries.push({
            id: `seed${this.next++}`,
            repository,
            key,
            version,
            state: "ready",
            blocks: new Map(),
            order: [],
            single: bytes
        });
    }

    twirpCalls(method: string): Recorded[] {
        return this.requests.filter(r => r.url.endsWith(`/${method}`));
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const chunks: Buffer[] = [];
        req.on("data", c => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks);
            this.requests.push({
                method: req.method ?? "",
                url: req.url ?? "",
                headers: req.headers,
                body
            });
            try {
                this.route(req, body, res);
            } catch (e) {
                json(res, 500, { error: String(e) });
            }
        });
    }

    private scope(
        req: http.IncomingMessage,
        res: http.ServerResponse
    ): string | undefined {
        const auth = String(req.headers["authorization"] ?? "");
        const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        if (!token) {
            json(res, 401, { error: "a cache token is required" });
            return undefined;
        }
        if (token === this.otherToken) {
            json(res, 403, {
                error: "that token was not minted for the build cache"
            });
            return undefined;
        }
        if (token !== this.token) {
            json(res, 401, {
                error: "that cache token is unknown, revoked or expired"
            });
            return undefined;
        }
        const raw = String(req.headers["x-weft-repository"] ?? "").trim();
        const ok =
            raw.length > 0 &&
            raw.length <= 200 &&
            raw.split("/").length === 2 &&
            raw.split("/").every(s => s.length > 0 && /^[A-Za-z0-9._-]+$/.test(s));
        if (!ok) {
            json(res, 400, {
                error:
                    "a repo:cache token names its repository in X-Weft-Repository as owner/name"
            });
            return undefined;
        }
        return raw;
    }

    private route(
        req: http.IncomingMessage,
        body: Buffer,
        res: http.ServerResponse
    ): void {
        const url = new URL(req.url ?? "/", "http://fake");
        const twirp = url.pathname.match(
            /^\/v1\/cache\/twirp\/github\.actions\.results\.api\.v1\.CacheService\/(\w+)$/
        );
        if (twirp && req.method === "POST") {
            if (this.failTwirp > 0) {
                this.failTwirp--;
                json(res, 503, { error: "try later" });
                return;
            }
            const repository = this.scope(req, res);
            if (!repository) return;
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(body.toString("utf8"));
            } catch (e) {
                json(res, 400, { code: "malformed", msg: String(e) });
                return;
            }
            this.twirp(twirp[1], repository, parsed, res);
            return;
        }
        const blob = url.pathname.match(/^\/v1\/cache\/blob\/([^/]+)$/);
        if (blob) {
            const repository = this.scope(req, res);
            if (!repository) return;
            const entry = this.entries.find(
                e => e.id === blob[1] && e.repository === repository
            );
            if (!entry) {
                json(res, 404, { error: "no such cache entry" });
                return;
            }
            if (req.method === "PUT") {
                this.putBlob(entry, url, body, res);
                return;
            }
            if (req.method === "GET") {
                this.getBlob(entry, req, res);
                return;
            }
        }
        json(res, 404, { error: "no route" });
    }

    private twirp(
        method: string,
        repository: string,
        req: Record<string, unknown>,
        res: http.ServerResponse
    ): void {
        const key = String(req.key ?? "");
        const version = String(req.version ?? "");
        if (!key || !version) {
            json(res, 400, {
                code: "invalid_argument",
                msg: "key and version are required"
            });
            return;
        }
        switch (method) {
            case "GetCacheEntryDownloadURL": {
                const restoreKeys = Array.isArray(req.restore_keys)
                    ? (req.restore_keys as string[])
                    : [];
                const ready = this.entries.filter(
                    e =>
                        e.repository === repository &&
                        e.version === version &&
                        e.state === "ready"
                );
                let hit = ready.find(e => e.key === key);
                for (const rk of restoreKeys) {
                    if (hit) break;
                    // Newest first, as the server does.
                    hit = [...ready].reverse().find(e => e.key.startsWith(rk));
                }
                if (!hit) {
                    json(res, 200, {
                        ok: false,
                        signed_download_url: "",
                        matched_key: ""
                    });
                    return;
                }
                json(res, 200, {
                    ok: true,
                    signed_download_url: `${this.url}/v1/cache/blob/${hit.id}`,
                    matched_key: hit.key
                });
                return;
            }
            case "CreateCacheEntry": {
                if (key.length > 512 || version.length > 128) {
                    json(res, 400, {
                        code: "invalid_argument",
                        msg: "key or version too long"
                    });
                    return;
                }
                const exists = this.entries.some(
                    e =>
                        e.repository === repository &&
                        e.key === key &&
                        e.version === version
                );
                if (exists || this.atStorageCap) {
                    json(res, 200, { ok: false, signed_upload_url: "" });
                    return;
                }
                const entry: Entry = {
                    id: `e${this.next++}`,
                    repository,
                    key,
                    version,
                    state: "reserving",
                    blocks: new Map(),
                    order: []
                };
                this.entries.push(entry);
                json(res, 200, {
                    ok: true,
                    signed_upload_url: `${this.url}/v1/cache/blob/${entry.id}`
                });
                return;
            }
            case "FinalizeCacheEntryUpload": {
                const entry = this.entries.find(
                    e =>
                        e.repository === repository &&
                        e.key === key &&
                        e.version === version &&
                        e.state === "reserving"
                );
                if (!entry) {
                    json(res, 404, {
                        code: "not_found",
                        msg: "no upload in progress for that key and version"
                    });
                    return;
                }
                const held = assembled(entry).length;
                if (held === 0) {
                    json(res, 400, {
                        code: "failed_precondition",
                        msg: "nothing was uploaded for this entry"
                    });
                    return;
                }
                const claimed = req.size_bytes ?? req.sizeBytes;
                if (claimed !== undefined && Number(claimed) !== held) {
                    json(res, 400, {
                        code: "failed_precondition",
                        msg: `the client reports ${claimed} bytes but ${held} were uploaded`
                    });
                    return;
                }
                entry.state = "ready";
                json(res, 200, { ok: true, entry_id: entry.id });
                return;
            }
            default:
                json(res, 404, { code: "bad_route", msg: method });
        }
    }

    private putBlob(
        entry: Entry,
        url: URL,
        body: Buffer,
        res: http.ServerResponse
    ): void {
        if (this.failPut > 0) {
            this.failPut--;
            json(res, 500, { error: "the store hiccuped" });
            return;
        }
        if (entry.state !== "reserving") {
            json(res, 409, { error: "this cache entry is already finalized" });
            return;
        }
        const comp = url.searchParams.get("comp");
        if (comp === "block") {
            const id = url.searchParams.get("blockid") ?? "";
            if (!id || id.length > 128) {
                json(res, 400, { error: "comp=block needs a blockid" });
                return;
            }
            entry.blocks.set(id, body);
            res.writeHead(201).end();
            return;
        }
        if (comp === "blocklist") {
            const ids = [
                ...body.toString("utf8").matchAll(/<Latest>([^<]+)<\/Latest>/g)
            ].map(m => decodeURIComponent(m[1].trim()));
            if (ids.length === 0) {
                json(res, 400, { error: "an empty block list" });
                return;
            }
            if (ids.some(id => !entry.blocks.has(id))) {
                json(res, 400, {
                    error: "the block list names a block that was not uploaded"
                });
                return;
            }
            entry.order = ids;
            res.writeHead(201).end();
            return;
        }
        if (comp !== null) {
            json(res, 400, { error: `unsupported comp=${comp}` });
            return;
        }
        if (body.length === 0) {
            json(res, 400, { error: "an empty archive" });
            return;
        }
        entry.single = body;
        res.writeHead(201).end();
    }

    private getBlob(
        entry: Entry,
        req: http.IncomingMessage,
        res: http.ServerResponse
    ): void {
        if (entry.state !== "ready") {
            json(res, 404, { error: "no such cache entry" });
            return;
        }
        const bytes = assembled(entry);
        const total = bytes.length;
        let start = 0;
        let end = total - 1;
        const range = req.headers["range"];
        if (range) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!m || total === 0) {
                res.writeHead(416, { "Content-Range": `bytes */${total}` }).end();
                return;
            }
            if (m[1] === "") {
                start = Math.max(0, total - Number(m[2]));
            } else {
                start = Number(m[1]);
                if (m[2] !== "") end = Math.min(end, Number(m[2]));
            }
            if (start > end || start >= total) {
                res.writeHead(416, { "Content-Range": `bytes */${total}` }).end();
                return;
            }
        }
        const slice = bytes.subarray(start, end + 1);
        const headers: http.OutgoingHttpHeaders = {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(slice.length),
            "Accept-Ranges": "bytes"
        };
        if (range) {
            headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
        }
        res.writeHead(range ? 206 : 200, headers);
        if (this.cutDownloadAfter !== undefined && !this.cutDone) {
            this.cutDone = true;
            res.write(slice.subarray(0, this.cutDownloadAfter), () => {
                res.socket?.destroy();
            });
            return;
        }
        res.end(slice);
    }
}

function assembled(entry: Entry): Buffer {
    if (entry.single) return entry.single;
    return Buffer.concat(entry.order.map(id => entry.blocks.get(id)!));
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(text))
    }).end(text);
}
