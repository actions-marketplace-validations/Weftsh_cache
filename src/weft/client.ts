// The Weft cache client: what replaces @actions/cache's twirp client and its
// Azure block-blob client. Weft implements GitHub's Actions Cache Service v2
// (three twirp calls) and serves the two URLs those calls hand back itself,
// so the "signed" upload and download URLs carry no credential and every
// request, including the blob PUTs and GET, sends the bearer token and the
// repository header.
//
// The wire contract, held to by the server's e2e suite:
//   POST {api}/v1/cache/twirp/github.actions.results.api.v1.CacheService/
//     GetCacheEntryDownloadURL {key, version, restore_keys}
//       -> {ok, signed_download_url, matched_key}; ok:false is a miss
//     CreateCacheEntry {key, version}
//       -> {ok, signed_upload_url}; ok:false is "exists" or "at the cap"
//     FinalizeCacheEntryUpload {key, version, size_bytes}
//       -> {ok, entry_id}; size_bytes must equal the bytes uploaded
//   PUT signed_upload_url                          one archive <= 128 MiB
//   PUT signed_upload_url?comp=block&blockid=<id>  one block of a larger one
//   PUT signed_upload_url?comp=blocklist           <BlockList><Latest>id</Latest>…
//   GET signed_download_url                        the archive; Range -> 206
import * as core from "@actions/core";
import { HttpClient, HttpClientResponse } from "@actions/http-client";
import * as fs from "fs";

import { WeftConfig } from "./config";

/** The largest archive the server takes as one PUT. */
export const SingleShotLimit = 128 * 1024 * 1024;
/** Blocks above that, when the input does not say. */
export const DefaultBlockSize = 64 * 1024 * 1024;
/** The server's body limit leaves room for a block of at most this. */
export const MaxBlockSize = 128 * 1024 * 1024;
export const MinBlockSize = 1024 * 1024;
export const DefaultUploadConcurrency = 4;

const TwirpPath = "/v1/cache/twirp/github.actions.results.api.v1.CacheService";
const UserAgent = "weftsh-cache/1.0.0";

export class WeftCacheError extends Error {
    statusCode?: number;
    constructor(message: string, statusCode?: number) {
        super(message);
        this.name = "WeftCacheError";
        this.statusCode = statusCode;
        Object.setPrototypeOf(this, WeftCacheError.prototype);
    }
}

export interface DownloadUrlResponse {
    ok: boolean;
    signedDownloadUrl: string;
    matchedKey: string;
}

export interface CreateEntryResponse {
    ok: boolean;
    signedUploadUrl: string;
}

export interface FinalizeResponse {
    ok: boolean;
    entryId: string;
}

export interface UploadOptions {
    /** Bytes per block above the single-shot limit. */
    blockSize?: number;
    /** Blocks in flight at once. */
    concurrency?: number;
}

export interface ClientOptions {
    /** Tries for a call that failed on the network or with a 5xx. */
    attempts?: number;
    /** Delay between tries, doubled each time. */
    retryDelayMs?: number;
    /** The single-shot limit and smallest block; the suite lowers them. */
    limits?: { singleShot: number; minBlock: number };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** The server's own sentence when it has one, else the status. */
function describe(status: number, body: string): string {
    try {
        const parsed = JSON.parse(body);
        const msg = parsed?.error ?? parsed?.msg ?? parsed?.message;
        if (typeof msg === "string" && msg) {
            return `${status}: ${msg}`;
        }
    } catch {
        // not JSON
    }
    const text = body.trim();
    return text ? `${status}: ${text.slice(0, 200)}` : `${status}`;
}

function retryable(status: number | undefined): boolean {
    return status === undefined || status >= 500;
}

/** Azure-style block ids: base64 of a zero-padded index, all one length. */
export function blockId(index: number): string {
    return Buffer.from(String(index).padStart(6, "0")).toString("base64");
}

export function blockListXml(ids: string[]): string {
    return `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids
        .map(id => `<Latest>${id}</Latest>`)
        .join("")}</BlockList>`;
}

function onDisk(file: string): number {
    try {
        return fs.statSync(file).size;
    } catch {
        return 0;
    }
}

export class WeftCacheClient {
    private readonly http: HttpClient;
    private readonly attempts: number;
    private readonly retryDelayMs: number;
    private readonly singleShot: number;
    private readonly minBlock: number;

    constructor(
        private readonly config: WeftConfig,
        options: ClientOptions = {}
    ) {
        this.http = new HttpClient(UserAgent);
        this.attempts = options.attempts ?? 3;
        this.retryDelayMs = options.retryDelayMs ?? 1000;
        this.singleShot = options.limits?.singleShot ?? SingleShotLimit;
        this.minBlock = options.limits?.minBlock ?? MinBlockSize;
    }

    dispose(): void {
        this.http.dispose();
    }

    private headers(extra: Record<string, string> = {}): Record<string, string> {
        return {
            Authorization: `Bearer ${this.config.token}`,
            "X-Weft-Repository": this.config.repository,
            ...extra
        };
    }

    /** Runs `send` until it answers without a retryable failure. */
    private async withRetries<T>(
        what: string,
        send: () => Promise<T>
    ): Promise<T> {
        let delay = this.retryDelayMs;
        for (let attempt = 1; ; attempt++) {
            try {
                return await send();
            } catch (error) {
                const status =
                    error instanceof WeftCacheError ? error.statusCode : undefined;
                if (attempt >= this.attempts || !retryable(status)) {
                    throw error;
                }
                core.debug(
                    `${what}: attempt ${attempt} failed (${
                        (error as Error).message
                    }), retrying in ${delay}ms`
                );
                await sleep(delay);
                delay *= 2;
            }
        }
    }

    private async twirp<T>(method: string, body: unknown): Promise<T> {
        const url = `${this.config.apiUrl}${TwirpPath}/${method}`;
        return this.withRetries(method, async () => {
            let response: HttpClientResponse;
            try {
                response = await this.http.post(url, JSON.stringify(body), {
                    ...this.headers(),
                    "Content-Type": "application/json",
                    Accept: "application/json"
                });
            } catch (error) {
                throw new WeftCacheError(
                    `${method}: ${(error as Error).message}`
                );
            }
            const status = response.message.statusCode ?? 0;
            const text = await response.readBody();
            if (status < 200 || status >= 300) {
                throw new WeftCacheError(
                    `${method}: ${describe(status, text)}`,
                    status
                );
            }
            try {
                return JSON.parse(text) as T;
            } catch {
                throw new WeftCacheError(
                    `${method}: the answer was not JSON`,
                    status
                );
            }
        });
    }

    async getCacheEntryDownloadURL(request: {
        key: string;
        version: string;
        restoreKeys: string[];
    }): Promise<DownloadUrlResponse> {
        const out = await this.twirp<Record<string, unknown>>(
            "GetCacheEntryDownloadURL",
            {
                key: request.key,
                version: request.version,
                restore_keys: request.restoreKeys
            }
        );
        return {
            ok: out.ok === true,
            signedDownloadUrl: String(
                out.signed_download_url ?? out.signedDownloadUrl ?? ""
            ),
            matchedKey: String(out.matched_key ?? out.matchedKey ?? "")
        };
    }

    async createCacheEntry(request: {
        key: string;
        version: string;
    }): Promise<CreateEntryResponse> {
        const out = await this.twirp<Record<string, unknown>>(
            "CreateCacheEntry",
            { key: request.key, version: request.version }
        );
        return {
            ok: out.ok === true,
            signedUploadUrl: String(
                out.signed_upload_url ?? out.signedUploadUrl ?? ""
            )
        };
    }

    async finalizeCacheEntryUpload(request: {
        key: string;
        version: string;
        sizeBytes: number;
    }): Promise<FinalizeResponse> {
        const out = await this.twirp<Record<string, unknown>>(
            "FinalizeCacheEntryUpload",
            {
                key: request.key,
                version: request.version,
                size_bytes: String(request.sizeBytes)
            }
        );
        return {
            ok: out.ok === true,
            entryId: String(out.entry_id ?? out.entryId ?? "")
        };
    }

    /** One PUT of a byte range of the archive; 201 or a WeftCacheError. */
    private async putRange(
        what: string,
        url: string,
        archivePath: string,
        start: number,
        end: number, // inclusive
        blobType: boolean
    ): Promise<void> {
        await this.withRetries(what, async () => {
            const length = end - start + 1;
            const stream = fs.createReadStream(archivePath, { start, end });
            let response: HttpClientResponse;
            try {
                response = await this.http.sendStream(
                    "PUT",
                    url,
                    stream,
                    this.headers({
                        "Content-Length": String(length),
                        "Content-Type": "application/octet-stream",
                        ...(blobType ? { "x-ms-blob-type": "BlockBlob" } : {})
                    })
                );
            } catch (error) {
                stream.destroy();
                throw new WeftCacheError(`${what}: ${(error as Error).message}`);
            }
            const status = response.message.statusCode ?? 0;
            const text = await response.readBody();
            if (status !== 201 && status !== 200) {
                throw new WeftCacheError(
                    `${what}: ${describe(status, text)}`,
                    status
                );
            }
        });
    }

    private async putBody(
        what: string,
        url: string,
        body: string,
        contentType: string
    ): Promise<void> {
        await this.withRetries(what, async () => {
            let response: HttpClientResponse;
            try {
                response = await this.http.put(
                    url,
                    body,
                    this.headers({ "Content-Type": contentType })
                );
            } catch (error) {
                throw new WeftCacheError(`${what}: ${(error as Error).message}`);
            }
            const status = response.message.statusCode ?? 0;
            const text = await response.readBody();
            if (status !== 201 && status !== 200) {
                throw new WeftCacheError(
                    `${what}: ${describe(status, text)}`,
                    status
                );
            }
        });
    }

    /**
     * Uploads the archive at `archivePath` to the signed upload URL: one
     * PUT up to the single-shot limit, blocks and a block list above it.
     * Returns the bytes sent, which is what finalize must be told.
     */
    async uploadArchive(
        signedUploadUrl: string,
        archivePath: string,
        options: UploadOptions = {}
    ): Promise<number> {
        const size = fs.statSync(archivePath).size;
        if (size === 0) {
            throw new WeftCacheError("the archive is empty");
        }
        if (size <= this.singleShot) {
            core.debug(`Uploading ${size} bytes in one PUT`);
            await this.putRange(
                "upload",
                signedUploadUrl,
                archivePath,
                0,
                size - 1,
                true
            );
            return size;
        }
        const blockSize = Math.min(
            MaxBlockSize,
            Math.max(this.minBlock, options.blockSize ?? DefaultBlockSize)
        );
        const concurrency = Math.max(
            1,
            options.concurrency ?? DefaultUploadConcurrency
        );
        const count = Math.ceil(size / blockSize);
        core.debug(
            `Uploading ${size} bytes as ${count} blocks of ${blockSize}, ${concurrency} at a time`
        );
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
            ids.push(blockId(i));
        }
        let next = 0;
        let sent = 0;
        const worker = async (): Promise<void> => {
            for (;;) {
                const i = next++;
                if (i >= count) {
                    return;
                }
                const start = i * blockSize;
                const end = Math.min(size, start + blockSize) - 1;
                const url = `${signedUploadUrl}?comp=block&blockid=${encodeURIComponent(
                    ids[i]
                )}`;
                await this.putRange(
                    `block ${i + 1}/${count}`,
                    url,
                    archivePath,
                    start,
                    end,
                    true
                );
                sent += end - start + 1;
                core.info(
                    `Sent ${sent} of ${size} (${((100 * sent) / size).toFixed(
                        1
                    )}%)`
                );
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(concurrency, count) }, worker)
        );
        await this.putBody(
            "block list",
            `${signedUploadUrl}?comp=blocklist`,
            blockListXml(ids),
            "application/xml"
        );
        return size;
    }

    /**
     * Streams the signed download URL to `archivePath`. A transfer that
     * breaks off is resumed with a Range request from the bytes on disk.
     * Returns the bytes written.
     */
    async downloadArchive(
        signedDownloadUrl: string,
        archivePath: string
    ): Promise<number> {
        let written = 0;
        let total: number | undefined;
        let delay = this.retryDelayMs;
        for (let attempt = 1; ; attempt++) {
            try {
                const headers = this.headers(
                    written > 0 ? { Range: `bytes=${written}-` } : {}
                );
                let response: HttpClientResponse;
                try {
                    response = await this.http.get(signedDownloadUrl, headers);
                } catch (error) {
                    throw new WeftCacheError(
                        `download: ${(error as Error).message}`
                    );
                }
                const status = response.message.statusCode ?? 0;
                const expected = written > 0 ? 206 : 200;
                if (status !== expected) {
                    const text = await response.readBody();
                    throw new WeftCacheError(
                        `download: ${describe(status, text)}`,
                        status
                    );
                }
                if (written > 0) {
                    const range = response.message.headers["content-range"];
                    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
                        String(range ?? "")
                    );
                    if (!match || Number(match[1]) !== written) {
                        await response.readBody();
                        throw new WeftCacheError(
                            `download: the server resumed at ${range}, not ${written}`
                        );
                    }
                    total = Number(match[3]);
                } else {
                    const length = response.message.headers["content-length"];
                    total = length ? Number(length) : undefined;
                }
                // Each chunk goes to disk as it arrives, so a transfer that
                // breaks off resumes at the byte after the last one written.
                // (An async iterator over the message would drop the chunks
                // it still held when the reset came in.)
                const fd = fs.openSync(archivePath, written > 0 ? "a" : "w");
                try {
                    await new Promise<void>((resolve, reject) => {
                        const message = response.message;
                        message.on("data", (chunk: Buffer) => {
                            try {
                                fs.writeSync(fd, chunk);
                                written += chunk.length;
                            } catch (e) {
                                message.destroy(e as Error);
                            }
                        });
                        message.on("end", resolve);
                        message.on("error", reject);
                    });
                } finally {
                    fs.closeSync(fd);
                    written = onDisk(archivePath);
                }
                if (total !== undefined && written !== total) {
                    throw new WeftCacheError(
                        `download: ${written} of ${total} bytes arrived`
                    );
                }
                return written;
            } catch (error) {
                const status =
                    error instanceof WeftCacheError ? error.statusCode : undefined;
                if (attempt >= this.attempts || !retryable(status)) {
                    throw error;
                }
                core.debug(
                    `download: attempt ${attempt} failed at ${written} bytes (${
                        (error as Error).message
                    }), resuming in ${delay}ms`
                );
                await sleep(delay);
                delay *= 2;
            }
        }
    }
}
