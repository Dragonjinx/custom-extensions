/**
 * Cost Prediction Extension
 *
 * Adds a next-turn cost prediction to the center of pi's status bar,
 * with a color-coded breakdown of cached vs uncached cost.
 *
 * Key improvements over v1:
 * - Cost estimation uses CURRENT context size × per-token pricing,
 *   not historical turn averages — so after compaction the cost
 *   correctly drops to near-zero.
 * - No scientific notation: tiny costs round to "~$0".
 * - Consistent "Cached" / "Uncached" labels everywhere.
 * - Colored terminal output: green for cached, amber/yellow for uncached.
 * - Handles branching via session_tree: backfills from the new branch.
 *
 * Usage:
 *   /costpred   — toggle the custom footer on/off
 *   (auto-enabled on session start)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface TurnStats {
	input: number;
	cacheRead: number;
	output: number;
	inputCost: number;
	cacheCost: number;
	outputCost: number;
	totalCost: number;
}

export default function (pi: ExtensionAPI) {
	const MAX_TURNS = 5;
	const recentTurns: TurnStats[] = [];

	// Cumulative session totals (in-memory, survives compaction)
	let totalCost = 0;
	let totalCacheRead = 0;
	let totalOutput = 0;
	let totalInput = 0;
	let totalInputCost = 0;
	let totalCacheCost = 0;
	let totalOutputCost = 0;

	// Track thinking level for right-side display
	let thinkingLevel = "high";

	pi.on("thinking_level_select", async (event) => {
		thinkingLevel = event.level;
	});

	pi.on("turn_end", async (event) => {
		const msg = event.message;
		if (msg.role === "assistant" && msg.usage?.totalTokens > 0) {
			const u = msg.usage;
			totalCost += u.cost?.total ?? 0;
			totalCacheRead += u.cacheRead;
			totalOutput += u.output;
			totalInput += u.input;
			totalInputCost += u.cost?.input ?? 0;
			totalCacheCost += u.cost?.cacheRead ?? 0;
			totalOutputCost += u.cost?.output ?? 0;

			recentTurns.push({
				input: u.input,
				cacheRead: u.cacheRead,
				output: u.output,
				inputCost: u.cost?.input ?? 0,
				cacheCost: u.cost?.cacheRead ?? 0,
				outputCost: u.cost?.output ?? 0,
				totalCost: u.cost?.total ?? 0,
			});

			if (recentTurns.length > MAX_TURNS) recentTurns.shift();
		}
	});

	// Format numbers: 123 → "123", 12345 → "12.3k", 1234567 → "1.2M"
	function fmt(n: number): string {
		if (n < 1_000) return `${n}`;
		if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
		return `${(n / 1_000_000).toFixed(1)}M`;
	}

	// Format for token estimates: 3 significant figures
	function fmt3(n: number): string {
		if (n === 0) return "0";
		if (n < 1_000) return `${n}`;
		if (n < 10_000) return `${(n / 1_000).toFixed(2)}k`;
		if (n < 100_000) return `${(n / 1_000).toFixed(1)}k`;
		if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
		if (n < 10_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
		if (n < 100_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		return `${Math.round(n / 1_000_000)}M`;
	}

	// Format dollar amounts — no scientific notation.
	// Tiny values (< $0.0001) round to "~$0" since this is an estimate anyway.
	function fmtCost(cents: number): string {
		if (cents === 0) return "$0";
		if (cents < 0.0001) return "~$0";
		if (cents < 0.001) return `$${cents.toFixed(5)}`;
		if (cents < 0.01) return `$${cents.toFixed(4)}`;
		if (cents < 1) return `$${cents.toFixed(4)}`;
		return `$${cents.toFixed(3)}`;
	}

	let enabled = false;

	function buildFooter(
		tui: any,
		theme: any,
		footerData: {
			getGitBranch: () => string | null;
			getExtensionStatuses: () => Map<string, string>;
			onBranchChange: (fn: () => void) => () => void;
		},
		ctx: any,
	) {
		const unsub = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsub,
			invalidate() {},
			render(width: number): string[] {
				// --- Derive per-token pricing ---
				// Model costs in pi are per-million-tokens (e.g. $3/M input).
				// Convert to per-token by dividing by 1_000_000.
				// Fall back to session-derived averages (which are already per-token).
				const mc = ctx.model?.cost;
				const inputPrice =
					(mc?.input ?? 0) > 0
						? mc!.input / 1_000_000
						: totalInput > 0
							? totalInputCost / totalInput
							: 0;
				const cachePrice =
					(mc?.cacheRead ?? 0) > 0
						? mc!.cacheRead / 1_000_000
						: totalCacheRead > 0
							? totalCacheCost / totalCacheRead
							: 0;
				const outputPrice =
					(mc?.output ?? 0) > 0
						? mc!.output / 1_000_000
						: totalOutput > 0
							? totalOutputCost / totalOutput
							: 0;

				// --- Left: token stats ---
				const usage = ctx.getContextUsage();
				const contextTokens = usage?.tokens ?? 0;
				const contextWindow = usage?.contextWindow ?? 0;
				const contextPct = usage?.percent ?? 0;

				const lastTurn = recentTurns[recentTurns.length - 1];
				const lastTotalInput = lastTurn ? lastTurn.input + lastTurn.cacheRead : 0;
				const lastCH = lastTotalInput > 0 ? (lastTurn!.cacheRead / lastTotalInput) * 100 : 0;

				const leftStr = `↑${fmt(contextTokens)} ↓${fmt(lastTurn?.output ?? 0)} R${fmt(totalCacheRead)} CH${lastCH.toFixed(1)}% ${fmtCost(totalCost)} ${contextPct.toFixed(1)}%/${fmt(contextWindow)}`;

				// --- Center: cost prediction from CURRENT context ---
				// After compaction, contextTokens drops sharply, so the
				// estimated cost correctly reflects the smaller window.
				const sessionTotalTokens = totalInput + totalCacheRead;
				const sessionCH = sessionTotalTokens > 0 ? totalCacheRead / sessionTotalTokens : 0;

				// Estimate next turn's token split:
				//   - The user's next prompt (~1K tokens) is always uncached
				//   - Remaining context tokens split by session cache rate
				const promptEstimate = 1000;
				const cachedTokens = Math.max(0, Math.round((contextTokens - promptEstimate) * sessionCH));
				const uncachedTokens = Math.max(0, contextTokens - cachedTokens);

				// Estimate next-turn cost from context size × per-token pricing
				const nextCachedCost = cachedTokens * cachePrice;
				const nextUncachedCost = uncachedTokens * inputPrice;

				// Estimate output cost: average output from recent turns (or 500 fallback)
				const avgOutputTokens =
					recentTurns.length > 0
						? recentTurns.reduce((s, t) => s + t.output, 0) / recentTurns.length
						: 500;
				const nextOutputCost = avgOutputTokens * outputPrice;

				const nextTotalEst = nextCachedCost + nextUncachedCost + nextOutputCost;

				let centerStr: string;
				if (recentTurns.length > 0) {
					// Colored components by hue (theme-aware, survives color scheme changes):
					//   muted → cached (subtle, efficient)
					//   dim   → uncached (even subtler)
					//   accent → total estimate (highlight)
					const nextTag = theme.fg("accent", `Next:~${fmtCost(nextTotalEst)}`);
					const cachedCostTag = theme.fg("muted", `C:${fmtCost(nextCachedCost)}`);
					const uncachedCostTag = theme.fg("dim", `U:${fmtCost(nextUncachedCost)}`);
					const cachedTokenTag = theme.fg("muted", fmt3(cachedTokens));
					const uncachedTokenTag = theme.fg("dim", fmt3(uncachedTokens));
					centerStr = `${nextTag}  ${cachedCostTag}  ${uncachedCostTag}  ${cachedTokenTag} C / ${uncachedTokenTag} U`;
				} else {
					centerStr = theme.fg("dim", "Next: estimating...");
				}

				// --- Right: model info + extension statuses ---
				const modelId = ctx.model?.id ?? "no-model";
				const extStatuses = [...footerData.getExtensionStatuses().values()].join(" ");
				const rightParts = [modelId];
				if (thinkingLevel) rightParts.push(`• ${thinkingLevel}`);
				if (extStatuses) rightParts.push(extStatuses);
				const rightStr = rightParts.join(" ");

				// --- Layout: left + center + right ---
				const left = theme.fg("dim", leftStr);
				const center = centerStr;
				const right = theme.fg("dim", rightStr);

				const lw = visibleWidth(left);
				const cw = visibleWidth(center);
				const rw = visibleWidth(right);
				const availPad = width - lw - cw - rw;

				if (availPad >= 2) {
					const padL = Math.floor(availPad / 2);
					const padR = availPad - padL;
					return [truncateToWidth(left + " ".repeat(padL) + center + " ".repeat(padR) + right, width)];
				}

				// Narrow terminal: just show left + right with minimal padding
				const pad = Math.max(0, width - lw - rw);
				return [truncateToWidth(left + " ".repeat(pad) + right, width)];
			},
		};
	}

	// Backfill recentTurns and cumulative totals from existing session history
	function backfillFromSession(ctx: any) {
		recentTurns.length = 0;
		totalCost = 0;
		totalCacheRead = 0;
		totalOutput = 0;
		totalInput = 0;
		totalInputCost = 0;
		totalCacheCost = 0;
		totalOutputCost = 0;

		try {
			// Collect all assistant messages with usage
			const allTurns: { usage: TurnStats; order: number }[] = [];
			let order = 0;
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					const m = entry.message as AssistantMessage;
					if (m.usage?.totalTokens > 0) {
						const u = m.usage;
						allTurns.push({
							usage: {
								input: u.input,
								cacheRead: u.cacheRead,
								output: u.output,
								inputCost: u.cost?.input ?? 0,
								cacheCost: u.cost?.cacheRead ?? 0,
								outputCost: u.cost?.output ?? 0,
								totalCost: u.cost?.total ?? 0,
							},
							order: order++,
						});
					}
				}
			}

			// Populate recentTurns with the last MAX_TURNS messages (in chronological order)
			const sorted = allTurns.sort((a, b) => a.order - b.order);
			const lastN = sorted.slice(-MAX_TURNS);
			for (const t of lastN) {
				recentTurns.push(t.usage);
			}

			// Recompute cumulative totals from all assistant messages
			totalCost = allTurns.reduce((s, t) => s + t.usage.totalCost, 0);
			totalCacheRead = allTurns.reduce((s, t) => s + t.usage.cacheRead, 0);
			totalOutput = allTurns.reduce((s, t) => s + t.usage.output, 0);
			totalInput = allTurns.reduce((s, t) => s + t.usage.input, 0);
			totalInputCost = allTurns.reduce((s, t) => s + t.usage.inputCost, 0);
			totalCacheCost = allTurns.reduce((s, t) => s + t.usage.cacheCost, 0);
			totalOutputCost = allTurns.reduce((s, t) => s + t.usage.outputCost, 0);
		} catch {
			// session not fully initialised
		}
	}

	// On compaction: refresh recentTurns from post-compaction branch.
	// Cumulative totals are NOT reset here — they survive compaction
	// (tracked in-memory via turn_end). Only recentTurns is rebuilt so
	// avgOutputTokens reflects the current branch.
	pi.on("session_compact", async (_event, ctx: any) => {
		recentTurns.length = 0;
		try {
			const allTurns: { usage: TurnStats; order: number }[] = [];
			let order = 0;
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					const m = entry.message as AssistantMessage;
					if (m.usage?.totalTokens > 0) {
						const u = m.usage;
						allTurns.push({
							usage: {
								input: u.input,
								cacheRead: u.cacheRead,
								output: u.output,
								inputCost: u.cost?.input ?? 0,
								cacheCost: u.cost?.cacheRead ?? 0,
								outputCost: u.cost?.output ?? 0,
								totalCost: u.cost?.total ?? 0,
							},
							order: order++,
						});
					}
				}
			}
			const sorted = allTurns.sort((a, b) => a.order - b.order);
			const lastN = sorted.slice(-MAX_TURNS);
			for (const t of lastN) {
				recentTurns.push(t.usage);
			}
		} catch {
			// session not fully initialised
		}
	});

	// On /tree navigation: same session, different branch.
	// Refresh all data to match the new active path.
	pi.on("session_tree", async (_event, ctx: any) => {
		backfillFromSession(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		enabled = true;
		backfillFromSession(ctx);
		ctx.ui.setFooter((tui, theme, footerData) => buildFooter(tui, theme, footerData, ctx));
	});

	pi.registerCommand("costpred", {
		description: "Toggle cost prediction in footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;

			if (enabled) {
				backfillFromSession(ctx);
				ctx.ui.setFooter((tui, theme, footerData) => buildFooter(tui, theme, footerData, ctx));
				ctx.ui.notify("Cost prediction footer enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});
}
