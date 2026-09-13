// Where the cache is and who is asking: the three inputs that replace the
// runner-provided ACTIONS_RESULTS_URL and ACTIONS_RUNTIME_TOKEN.
import * as core from "@actions/core";

import { DefaultApiUrl, Inputs } from "../constants";

export interface WeftConfig {
    apiUrl: string;
    token: string;
    repository: string;
}

/** `owner/name` as GitHub spells it; what the server accepts in the header. */
export function isRepositoryName(value: string): boolean {
    if (value.length === 0 || value.length > 200) {
        return false;
    }
    const segments = value.split("/");
    return (
        segments.length === 2 &&
        segments.every(s => s.length > 0 && /^[A-Za-z0-9._-]+$/.test(s))
    );
}

/**
 * The configuration from the inputs, or the reason there is none. A
 * missing token is a reason and not a throw: a fork's pull request has no
 * secrets, and actions/cache treats "no cache service" as a miss with a
 * warning, never a failed job.
 */
export function readConfig():
    | { ok: true; config: WeftConfig }
    | { ok: false; reason: string } {
    const token = core.getInput(Inputs.Token).trim();
    if (!token) {
        return {
            ok: false,
            reason:
                "no Weft token was given (the `token` input is empty; a fork's pull request has no secrets)"
        };
    }
    core.setSecret(token);
    const repository = (
        core.getInput(Inputs.Repository) ||
        process.env["GITHUB_REPOSITORY"] ||
        ""
    ).trim();
    if (!isRepositoryName(repository)) {
        return {
            ok: false,
            reason: `the repository must be spelled owner/name, got ${JSON.stringify(
                repository
            )}`
        };
    }
    const apiUrl = (core.getInput(Inputs.ApiUrl) || DefaultApiUrl)
        .trim()
        .replace(/\/+$/, "");
    let parsed: URL;
    try {
        parsed = new URL(apiUrl);
    } catch {
        return { ok: false, reason: `api-url is not a URL: ${apiUrl}` };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { ok: false, reason: `api-url is not http(s): ${apiUrl}` };
    }
    return { ok: true, config: { apiUrl, token, repository } };
}
