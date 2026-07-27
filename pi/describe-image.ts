/**
 * Describe Image Extension
 *
 * Adds a `describe_image` tool that lets the agent analyze images
 * through Gemini 2.5 Flash (multimodal) via OpenRouter, without
 * switching the conversation model away from DeepSeek.
 *
 * Flow:
 *   1. Agent reads an image path (screenshot, diagram, UI mockup, etc.)
 *   2. Extension reads the file, base64-encodes it
 *   3. Sends to Gemini 2.5 Flash via OpenRouter API
 *   4. Returns the description as text to the conversation model
 *
 * Requirements:
 *   - OpenRouter configured in auth.json
 *   - google/gemini-2.5-flash accessible through OpenRouter
 *
 * Usage:
 *   The agent calls describe_image() automatically when it needs to
 *   analyze an image. No user-facing commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const MIME_MAP: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
};

const SUPPORTED_FORMATS = Object.keys(MIME_MAP).join(", ");

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "describe_image",
		label: "Describe Image",
		description:
			"Analyze an image file and return a detailed description. " +
			`Supports: ${SUPPORTED_FORMATS}. ` +
			"Uses Gemini 2.5 Flash via OpenRouter — does not affect the conversation model. " +
			"Call this when you need to understand a screenshot, diagram, UI mockup, or any image.",
		parameters: Type.Object({
			path: Type.String({
				description: "Path to the image file (absolute or relative to cwd)",
			}),
			prompt: Type.Optional(
				Type.String({
					description:
						"Optional specific question about the image. " +
						'Examples: "What error message is shown?", "Describe the UI layout", "Read the text in this screenshot". ' +
						'Default: "Describe this image in detail"',
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const imagePath = resolve(params.path);
			const question = params.prompt || "Describe this image in detail";

			// --- Validate file ---
			if (!existsSync(imagePath)) {
				return {
					content: [{ type: "text", text: `Error: File not found: ${imagePath}` }],
					details: {},
				};
			}

			const ext = extname(imagePath).toLowerCase().slice(1);
			const mime = MIME_MAP[ext];
			if (!mime) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Unsupported format '.${ext}'. Supported: ${SUPPORTED_FORMATS}`,
						},
					],
					details: {},
				};
			}

			// --- Read and encode ---
			let buffer: Buffer;
			try {
				buffer = readFileSync(imagePath);
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
				};
			}

			const base64 = buffer.toString("base64");
			const dataUrl = `data:${mime};base64,${base64}`;

			// --- Read OpenRouter API key directly from auth file ---
			let apiKey: string;
			try {
				const authPath = join(homedir(), ".pi", "agent", "auth.json");
				const authRaw = readFileSync(authPath, "utf-8");
				const authData = JSON.parse(authRaw);
				apiKey = authData.openrouter?.key;
				if (!apiKey) {
					return {
						content: [{ type: "text", text: "Error: OpenRouter API key not found in auth.json" }],
						details: {},
					};
				}
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Error reading auth.json: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
				};
			}

			// --- Build content array ---
			const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
				{ type: "text", text: question },
				{ type: "image_url" as const, image_url: { url: dataUrl } },
			];

			// --- Call OpenRouter ---
			let response: Response;
			try {
				response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
						"HTTP-Referer": "https://pi.dev",
						"X-Title": "pi-agent",
					},
					body: JSON.stringify({
						model: "google/gemini-2.5-flash",
						messages: [
							{
								role: "user",
								content: contentParts,
							},
						],
						max_tokens: 4096,
					}),
					signal,
				});
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Network error calling Gemini: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
				};
			}

			if (!response.ok) {
				const errBody = await response.text().catch(() => "unknown");
				return {
					content: [
						{
							type: "text",
							text: `Gemini API error (${response.status}): ${errBody.slice(0, 2000)}`,
						},
					],
					details: {},
				};
			}

			let result: any;
			try {
				result = await response.json();
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to parse Gemini response: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {},
				};
			}

			const description =
				result.choices?.[0]?.message?.content || "No description returned.";
			const usage = result.usage || {};
			const model_ = result.model || "google/gemini-2.5-flash";

			// Log cost for transparency
			const costInfo = usage.total_cost
				? ` (cost: $${(usage.total_cost as number).toFixed(6)})`
				: "";

			// Add a summary header with metadata, then the full description
			const fullText = `[Image description via ${model_}${costInfo}]\n\n${description}`;

			return {
				content: [{ type: "text", text: fullText }],
				details: {
					model: model_,
					usage,
					imagePath,
				},
			};
		},
	});

		function findWindow(query: string): { x: number; y: number; w: number; h: number; title: string; cls: string } | null {
		try {
			const out = execSync("hyprctl clients -j", { timeout: 5000, encoding: "utf-8" });
			const clients = JSON.parse(out);
			const q = query.toLowerCase();
			for (const c of clients) {
				const title = (c.title || "").toLowerCase();
				const cls = (c.class || "").toLowerCase();
				if (title.includes(q) || cls.includes(q)) {
					const [x, y] = c.at || [0, 0];
					const [w, h] = c.size || [0, 0];
					return { x, y, w, h, title: c.title || "", cls: c.class || "" };
				}
			}
			return null;
		} catch {
			return null;
		}
	}

	function captureWithGrim(geometry: string, outputPath: string): boolean {
		try {
			execSync(`grim -g "${geometry}" "${outputPath}"`, { timeout: 10000 });
			return existsSync(outputPath);
		} catch {
			return false;
		}
	}
	pi.registerTool({

		name: "capture_screen",
		label: "Capture Screen",
		description:
			"Capture a screenshot of the screen, window, or active window. " +
			"Uses hyprshot + grim on Hyprland. Saves to ~/Pictures/Screenshots/ by default. " +
			"Returns the path to the saved image. " +
			"Use this when you need to see what's on screen, then pass the path to describe_image.",
		parameters: Type.Object({
			mode: Type.Optional(
				Type.Enum({
					output: "output",
					window: "window",
					active: "active",
				}, {
					description:
						'What to capture: "output" (entire monitor), "window" (interactive select), ' +
						'"active" (focused window). Default: "active"',
				}),
			),
			window: Type.Optional(
				Type.String({
					description:
						"Window title or class to search for (e.g. 'obsidian', 'firefox', 'kitty'). " +
						"Searches by both title and class using hyprctl. " +
						"Overrides 'mode' when provided.",
				}),
			),
			path: Type.Optional(
				Type.String({
					description:
						"Full output path for the screenshot. " +
						"Defaults to ~/Pictures/Screenshots/{timestamp}_hyprshot.png",
				}),
			),
		}),

		async execute(_toolCallId, params) {
			const outDir = params.path
				? dirname(resolve(params.path))
				: join(homedir(), "Pictures", "Screenshots");
			const filename = params.path
				? resolve(params.path)
				: `hyprshot_${Date.now()}.png`;
			const filePath = params.path ? resolve(params.path) : join(outDir, filename);

			try {
				mkdirSync(outDir, { recursive: true });
			} catch {
				// dir exists
			}

			// --- Window-by-title mode ---
			if (params.window) {
				const win = findWindow(params.window);
				if (!win) {
					return {
						content: [
							{
								type: "text",
								text:
									`No window found matching "${params.window}". ` +
									"Try a different search term.",
							},
						],
						details: {},
					};
				}

				const geometry = `${win.x},${win.y} ${win.w}x${win.h}`;
				const ok = captureWithGrim(geometry, filePath);
				if (!ok) {
					return {
						content: [
							{
								type: "text",
								text:
									`Failed to capture window "${params.window}" ` +
									`(${win.cls}: ${win.title}). ` +
									"Make sure grim is available.",
							},
						],
						details: {},
					};
				}

				const stat = await import("node:fs").then(m => m.statSync(filePath));
				return {
					content: [
						{
							type: "text",
							text:
								`Screenshot of "${win.cls}" (${win.title}) saved to ${filePath}` +
								` (${(stat.size / 1024).toFixed(0)}KB). ` +
								"Pass this path to describe_image to analyze it.",
						},
					],
					details: {
						screenshotPath: filePath,
						windowClass: win.cls,
						windowTitle: win.title,
						sizeBytes: stat.size,
					},
				};
			}

			// --- Mode-based capture (hyprshot) ---
			const mode = params.mode || "active";
			const args = ["hyprshot", "-m", mode];
			if (mode === "active") {
				args.push("-m", "window");
			}
			args.push("-o", outDir, "-f", filename, "-s");

			try {
				execSync(args.join(" "), { timeout: 10000 });
			} catch (err) {
				if (!existsSync(filePath)) {
					return {
						content: [
							{
								type: "text",
								text:
									`Screenshot failed: ${err instanceof Error ? err.message : String(err)}. ` +
									"Make sure hyprshot is installed.",
							},
						],
						details: {},
					};
				}
			}

			if (!existsSync(filePath)) {
				return {
					content: [
						{
							type: "text",
							text: `Screenshot was not saved to ${filePath}. Try a different mode.`,
						},
					],
					details: {},
				};
			}

			const stat = await import("node:fs").then(m => m.statSync(filePath));
			return {
				content: [
					{
						type: "text",
						text:
							`Screenshot saved to ${filePath} (${(stat.size / 1024).toFixed(0)}KB). ` +
							"Pass this path to describe_image to analyze it.",
					},
				],
				details: {
					screenshotPath: filePath,
					mode,
					sizeBytes: stat.size,
				},
			};
		},
	});

	// Notify on load
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("describe_image + capture_screen tools loaded — I can see your screen", "info");
	});
}
