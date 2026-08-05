/**
 * Async git info with a 30s cache.
 *
 * Uses `pi.exec` (async, non-blocking) instead of a blocking `execSync`
 * (bug 8 fix). Non-repository directories return null and are cached too,
 * so git is not re-probed on every agent-loop.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface GitInfo {
	dirty: boolean;
	count: number;
	branch: string;
}

export const GIT_CACHE_MS = 30000;

/** The `requesting`-phase easter egg verbs for the current repo state. */
export function gitEggFor(info: GitInfo): string {
	if (info.dirty) {
		return `Pondering ${info.count} uncommitted file${info.count === 1 ? "" : "s"}`;
	}
	if (info.branch) return `Reticulating on ${info.branch}`;
	return "";
}

export class GitStatus {
	private cachedAt = 0;
	private cache: GitInfo | null | undefined;
	private inflight: Promise<GitInfo | null> | null = null;

	/** Fresh cached info, or null when stale/missing. */
	fresh(): GitInfo | null {
		if (this.cache === undefined || Date.now() - this.cachedAt >= GIT_CACHE_MS) return null;
		return this.cache;
	}

	/** Refresh the cache (deduplicated). Never rejects. */
	refresh(pi: ExtensionAPI, cwd: string): Promise<GitInfo | null> {
		if (this.inflight) return this.inflight;
		if (this.cache !== undefined && Date.now() - this.cachedAt < GIT_CACHE_MS) {
			return Promise.resolve(this.cache);
		}
		this.inflight = this.fetch(pi, cwd).then((info) => {
			this.cache = info;
			this.cachedAt = Date.now();
			this.inflight = null;
			return info;
		});
		return this.inflight;
	}

	private async fetch(pi: ExtensionAPI, cwd: string): Promise<GitInfo | null> {
		try {
			const res = await pi.exec("git", ["status", "--porcelain", "--branch"], {
				cwd,
				timeout: 5000,
			});
			if (res.code !== 0) return null; // not a git repository
			let branch = "";
			let count = 0;
			for (const line of res.stdout.split("\n")) {
				if (line.startsWith("## ")) {
					branch = line.slice(3).split("...")[0];
				} else if (line.length > 0) {
					count += 1;
				}
			}
			return { dirty: count > 0, count, branch };
		} catch {
			return null;
		}
	}
}
