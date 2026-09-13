// restoreCache and saveCache as @actions/cache 4.1.0 does them for cache
// service v2, with the Weft client in place of its twirp client and Azure
// SDK. Key validation, the version hash (paths, compression method, the
// windows-only marker, the salt) and the tar/zstd archive come from
// @actions/cache's own internals, so an archive saved by this action is the
// one actions/cache would have saved, and the version it is filed under is
// the one actions/cache would compute.
import * as core from "@actions/core";
import * as path from "path";

import * as utils from "@actions/cache/lib/internal/cacheUtils";
import { createTar, extractTar, listTar } from "@actions/cache/lib/internal/tar";

import { WeftCacheClient, WeftCacheError } from "./client";
import { WeftConfig } from "./config";

export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ValidationError";
        Object.setPrototypeOf(this, ValidationError.prototype);
    }
}

export class ReserveCacheError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReserveCacheError";
        Object.setPrototypeOf(this, ReserveCacheError.prototype);
    }
}

function checkPaths(paths: string[]): void {
    if (!paths || paths.length === 0) {
        throw new ValidationError(
            `Path Validation Error: At least one directory or file path is required`
        );
    }
}

function checkKey(key: string): void {
    if (key.length > 512) {
        throw new ValidationError(
            `Key Validation Error: ${key} cannot be larger than 512 characters.`
        );
    }
    const regex = /^[^,]*$/;
    if (!regex.test(key)) {
        throw new ValidationError(
            `Key Validation Error: ${key} cannot contain commas.`
        );
    }
}

/** Log server errors (5xx) as errors, all other errors as warnings. */
function report(prefix: string, error: Error): void {
    if (
        error instanceof WeftCacheError &&
        typeof error.statusCode === "number" &&
        error.statusCode >= 500
    ) {
        core.error(`${prefix}: ${error.message}`);
    } else {
        core.warning(`${prefix}: ${error.message}`);
    }
}

export interface RestoreOptions {
    lookupOnly?: boolean;
}

export interface SaveOptions {
    uploadChunkSize?: number;
}

/**
 * Restores cache from keys
 *
 * @returns string returns the key for the cache hit, otherwise returns undefined
 */
export async function restoreCache(
    client: WeftCacheClient,
    paths: string[],
    primaryKey: string,
    restoreKeys?: string[],
    options?: RestoreOptions,
    enableCrossOsArchive = false
): Promise<string | undefined> {
    checkPaths(paths);
    restoreKeys = restoreKeys || [];
    const keys = [primaryKey, ...restoreKeys];
    core.debug("Resolved Keys:");
    core.debug(JSON.stringify(keys));
    if (keys.length > 10) {
        throw new ValidationError(
            `Key Validation Error: Keys are limited to a maximum of 10.`
        );
    }
    for (const key of keys) {
        checkKey(key);
    }

    let archivePath = "";
    try {
        const compressionMethod = await utils.getCompressionMethod();
        const request = {
            key: primaryKey,
            restoreKeys,
            version: utils.getCacheVersion(
                paths,
                compressionMethod,
                enableCrossOsArchive
            )
        };
        const response = await client.getCacheEntryDownloadURL(request);
        if (!response.ok) {
            core.debug(
                `Cache not found for version ${
                    request.version
                } of keys: ${keys.join(", ")}`
            );
            return undefined;
        }
        const isRestoreKeyMatch = request.key !== response.matchedKey;
        if (isRestoreKeyMatch) {
            core.info(`Cache hit for restore-key: ${response.matchedKey}`);
        } else {
            core.info(`Cache hit for: ${response.matchedKey}`);
        }
        if (options?.lookupOnly) {
            core.info("Lookup only - skipping download");
            return response.matchedKey;
        }
        archivePath = path.join(
            await utils.createTempDirectory(),
            utils.getCacheFileName(compressionMethod)
        );
        core.debug(`Archive path: ${archivePath}`);
        core.debug(`Starting download of archive to: ${archivePath}`);
        await client.downloadArchive(response.signedDownloadUrl, archivePath);
        const archiveFileSize = utils.getArchiveFileSizeInBytes(archivePath);
        core.info(
            `Cache Size: ~${Math.round(
                archiveFileSize / (1024 * 1024)
            )} MB (${archiveFileSize} B)`
        );
        if (core.isDebug()) {
            await listTar(archivePath, compressionMethod);
        }
        await extractTar(archivePath, compressionMethod);
        core.info("Cache restored successfully");
        return response.matchedKey;
    } catch (error) {
        const typedError = error as Error;
        if (typedError.name === ValidationError.name) {
            throw error;
        }
        // Suppress all non-validation cache related errors because caching
        // should be optional
        report("Failed to restore", typedError);
    } finally {
        try {
            if (archivePath) {
                await utils.unlinkFile(archivePath);
            }
        } catch (error) {
            core.debug(`Failed to delete archive: ${error}`);
        }
    }
    return undefined;
}

/**
 * Saves a list of files with the specified key
 *
 * @returns number returns cacheId if the cache was saved successfully and -1 otherwise
 */
export async function saveCache(
    client: WeftCacheClient,
    paths: string[],
    key: string,
    options?: SaveOptions,
    enableCrossOsArchive = false
): Promise<number> {
    checkPaths(paths);
    checkKey(key);

    const compressionMethod = await utils.getCompressionMethod();
    let cacheId = -1;
    const cachePaths = await utils.resolvePaths(paths);
    core.debug("Cache Paths:");
    core.debug(`${JSON.stringify(cachePaths)}`);
    if (cachePaths.length === 0) {
        throw new Error(
            `Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.`
        );
    }

    const archiveFolder = await utils.createTempDirectory();
    const archivePath = path.join(
        archiveFolder,
        utils.getCacheFileName(compressionMethod)
    );
    core.debug(`Archive Path: ${archivePath}`);

    try {
        await createTar(archiveFolder, cachePaths, compressionMethod);
        if (core.isDebug()) {
            await listTar(archivePath, compressionMethod);
        }
        const archiveFileSize = utils.getArchiveFileSizeInBytes(archivePath);
        core.debug(`File Size: ${archiveFileSize}`);

        core.debug("Reserving Cache");
        const version = utils.getCacheVersion(
            paths,
            compressionMethod,
            enableCrossOsArchive
        );
        // An `ok: false` is the server saying there is nothing to do: the
        // entry exists, another job is writing it, or the organisation is
        // at its storage cap. A refusal (401, 403, a 5xx) is not that, and
        // is reported with its status rather than read as "another job".
        const response = await client.createCacheEntry({ key, version });
        if (!response.ok) {
            throw new ReserveCacheError(
                `Unable to reserve cache with key ${key}: it already exists, another job is creating it, or the organisation is at its storage cap.`
            );
        }
        const signedUploadUrl = response.signedUploadUrl;

        core.debug(`Attempting to upload cache located at: ${archivePath}`);
        const sent = await client.uploadArchive(signedUploadUrl, archivePath, {
            blockSize: options?.uploadChunkSize
        });
        if (sent !== archiveFileSize) {
            throw new Error(
                `uploaded ${sent} bytes of a ${archiveFileSize} byte archive`
            );
        }
        const finalizeResponse = await client.finalizeCacheEntryUpload({
            key,
            version,
            sizeBytes: archiveFileSize
        });
        core.debug(`FinalizeCacheEntryUploadResponse: ${finalizeResponse.ok}`);
        if (!finalizeResponse.ok) {
            throw new Error(
                `Unable to finalize cache with key ${key}, another job may be finalizing this cache.`
            );
        }
        const parsed = parseInt(finalizeResponse.entryId);
        // Weft's entry ids are not numbers; any finalized entry is a save.
        cacheId = isNaN(parsed) ? 1 : parsed;
    } catch (error) {
        const typedError = error as Error;
        if (typedError.name === ValidationError.name) {
            throw error;
        } else if (typedError.name === ReserveCacheError.name) {
            core.info(`Failed to save: ${typedError.message}`);
        } else {
            report("Failed to save", typedError);
        }
    } finally {
        // Try to delete the archive to save space
        try {
            await utils.unlinkFile(archivePath);
        } catch (error) {
            core.debug(`Failed to delete archive: ${error}`);
        }
    }
    return cacheId;
}

export function newClient(config: WeftConfig): WeftCacheClient {
    return new WeftCacheClient(config);
}
