const { Plugin, Notice } = require('obsidian');

// Rainbow gradient — categories sorted alphabetically get evenly-spaced hues
const HUE_START = 0, HUE_END = 360;
const HOMEPAGE_COLOR = { a: 1, rgb: 0xffffff };

// Heatmap: file-age based transparency.
// Leaf nodes fade from maxAlpha (newest) to minAlpha (oldest).
// Category nodes get the average alpha of their leaves.
const MIN_ALPHA = 0.5;
const MAX_ALPHA = 1.0;

// Logarithmic depth progression for saturation & lightness.
// depth 0 (category.md):         pastel  (sat=38, light=80)
// depth 1 (category.a.md):       normal  (sat=77, light=52)
// depth 2 (category.a.b.md):     deeper  (sat=92, light=41)
// depth 3 (category.a.b.c.md):   deeper  (sat=97, light=37)
// depth 4+:                              approaches 100, 35
const SAT_START = 38, SAT_ASYMP = 100;
const LIGHT_START = 80, LIGHT_ASYMP = 35;
const DEPTH_TAU = 1.0;

function hslToRgbInt(h, s, l) {
	s /= 100; l /= 100;
	const a = s * Math.min(l, 1 - l);
	const f = n => {
		const k = (n + h / 30) % 12;
		return Math.round(255 * (l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)));
	};
	return (f(0) << 16) | (f(8) << 8) | f(4);
}

/** Number of dot-segments after the category prefix = depth in hierarchy */
function getFileDepth(fp) {
	const name = fp.replace('.md', '');
	return name.split('.').length - 1;
}

function getCategoryPrefix(fp) {
	if (fp.includes('/') || !fp.endsWith('.md')) return null;
	const n = fp.slice(0, -3);
	return n.includes('.') ? n.split('.')[0] : n;
}

module.exports = class GraphCategoryColorsPlugin extends Plugin {
	async onload() {
		this.categoryColors = new Map(); // fp → { a: int, rgb: int }
		this._patched = new WeakSet();    // renderers with active prerender hook
		this._preCleanups = [];           // cleanup fns for prerender hooks
		this._hoverHooked = new WeakSet(); // renderers with onNodeHover wrapper
		this._origLineHL = null;          // original colors.lineHighlight
		this._origArrow = null;           // original colors.arrow

		await this.rebuild();
		this.applyToGraphs();

		this.registerEvent(this.app.vault.on('create', () => this.rebuild()));
		this.registerEvent(this.app.vault.on('rename', () => this.rebuild()));
		this.registerEvent(this.app.vault.on('delete', () => this.rebuild()));
		this.registerEvent(this.app.workspace.on('layout-change', () => {
			this.applyToGraphs();
		}));

		this.addCommand({
			id: 'refresh-category-colors',
			name: 'Refresh graph category colors',
			callback: async () => { await this.rebuild(); new Notice('Graph colors refreshed'); },
		});
	}

	onunload() {
		for (const fn of this._preCleanups) fn();
		this._preCleanups = [];
		this._patched = new WeakSet();
		this._hoverHooked = new WeakSet();
		this.restoreGraphs();
		this.cleanupFileExplorerStyles();
	}

	async rebuild() {
		await this.buildColorMap();
		this.injectFileExplorerStyles();
		this.applyToGraphs();
	}

	// --- Color Map ---

	async getHomepagePath() {
		try {
			const adapter = this.app.vault.adapter;
			const hpPath = this.app.vault.configDir + '/plugins/homepage/data.json';
			if (!(await adapter.exists(hpPath))) return null;
			const data = JSON.parse(await adapter.read(hpPath));
			for (const key of Object.keys(data.homepages || {})) {
				const e = data.homepages[key];
				if (e.value && e.kind === 'File')
					return e.value.endsWith('.md') ? e.value : e.value + '.md';
			}
			return null;
		} catch { return null; }
	}

	async buildColorMap() {
		this.categoryColors.clear();
		const files = this.app.vault.getMarkdownFiles();
		const homepagePath = await this.getHomepagePath();

		// Build a path → TFile lookup for O(1) access
		const fileMap = new Map();
		for (const f of files) fileMap.set(f.path, f);

		// Categorize files, skipping the homepage
		const catFiles = new Map(); // prefix → [fp, ...]
		for (const file of files) {
			if (homepagePath && file.path === homepagePath) continue;
			const prefix = getCategoryPrefix(file.path);
			if (prefix) {
				if (!catFiles.has(prefix)) catFiles.set(prefix, []);
				catFiles.get(prefix).push(file.path);
			}
		}

		// --- Heatmap alphas (absolute recency) ---
		// Age-based: newer → brighter, older → faded (logarithmic curve, capped at 1 year)
		const MS_DAY = 86400000;
		const LOG_YEAR = Math.log(1 + 365);
		const now = Date.now();

		const leafAlpha = new Map(); // fp → alpha
		for (const fps of catFiles.values()) {
			for (const fp of fps) {
				if (getFileDepth(fp) >= 1) {
					const ageMs = now - fileMap.get(fp).stat.mtime;
					const days = Math.max(0, ageMs / MS_DAY);
					const t = Math.min(Math.log(1 + days) / LOG_YEAR, 1);
					leafAlpha.set(fp, +(MAX_ALPHA - t * (MAX_ALPHA - MIN_ALPHA)).toFixed(2));
				}
			}
		}

		// Average leaf alpha per category → category node alpha
		const catAlpha = new Map(); // prefix → alpha
		for (const [prefix, fps] of catFiles) {
			const leafs = fps.filter(fp => getFileDepth(fp) >= 1);
			if (leafs.length) {
				const avg = leafs.reduce((s, fp) => s + leafAlpha.get(fp), 0) / leafs.length;
				catAlpha.set(prefix, +avg.toFixed(2));
			} else {
				catAlpha.set(prefix, MAX_ALPHA);
			}
		}

		// --- Assign colors with heatmap alphas ---
		const sorted = Array.from(catFiles.keys()).sort((a, b) => a.localeCompare(b));
		const total = sorted.length;

		for (const [i, cat] of sorted.entries()) {
			const hue = HUE_START + (i / total) * (HUE_END - HUE_START);
			for (const fp of catFiles.get(cat)) {
				const depth = getFileDepth(fp);
				const sat = SAT_ASYMP - (SAT_ASYMP - SAT_START) * Math.exp(-depth / DEPTH_TAU);
				const light = LIGHT_ASYMP + (LIGHT_START - LIGHT_ASYMP) * Math.exp(-depth / DEPTH_TAU);
				const rgb = hslToRgbInt(hue, Math.round(sat), Math.round(light));
				const a = depth >= 1 ? leafAlpha.get(fp) : catAlpha.get(cat);
				this.categoryColors.set(fp, { a, rgb });
			}
		}

		// Handle homepage last (white, full opaque)
		if (homepagePath) {
			this.categoryColors.set(homepagePath, HOMEPAGE_COLOR);
		}
	}

	// --- Graph node coloring via renderer.nodeLookup + PIXI tint ---

	/** Set base colors on nodeLookup AND on every node's circle tint */
	_applyColors(renderer) {
		const nl = renderer?.nodeLookup;
		if (!nl) return false;
		let count = 0;
		for (const [fp, color] of this.categoryColors) {
			if (nl[fp]) { nl[fp].color = color; count++; }
		}
		// Also set PIXI circle tint directly (survives hover reset)
		if (renderer.nodes) {
			for (const node of renderer.nodes) {
				const c = this.categoryColors.get(node.id);
				if (c && node.circle?.tint !== undefined) {
					node.circle.tint = c.rgb;
				}
			}
		}
		return count > 0;
	}

	/** 
	 * When a node is hovered, override renderer.colors (lineHighlight + arrow)
	 * to the hovered node's color. The renderer reads these every frame,
	 * so this is clean and reliable — no fighting PIXI tint resets.
	 */
	_hookRendererHover(renderer) {
		if (this._hoverHooked.has(renderer)) return;
		this._hoverHooked.add(renderer);

		const plugin = this;

		const origHover = renderer.onNodeHover;
		renderer.onNodeHover = function(node) {
			origHover.call(this, node);
			const path = typeof node === 'string' ? node : node?.id;
			if (!path) return;
			const color = plugin.categoryColors.get(path);
			if (!color) return;

			// Store originals once
			if (!plugin._origLineHL) plugin._origLineHL = { ...this.colors.lineHighlight };
			if (!plugin._origArrow) plugin._origArrow = { ...this.colors.arrow };

			// Override renderer's own highlight colors to the node's color
			this.colors.lineHighlight.rgb = color.rgb;
			this.colors.lineHighlight.a = 1;
			this.colors.arrow.rgb = color.rgb;
			this.colors.arrow.a = 1;

			// Hovered node circle: full brightness with its color
			if (node.circle) { node.circle.tint = color.rgb; node.circle.alpha = 1.0; }
		};

		const origUnhover = renderer.onNodeUnhover;
		renderer.onNodeUnhover = function(node) {
			origUnhover.call(this, node);

			// Restore original highlight colors
			if (plugin._origLineHL) {
				this.colors.lineHighlight.rgb = plugin._origLineHL.rgb;
				this.colors.lineHighlight.a = plugin._origLineHL.a;
			}
			if (plugin._origArrow) {
				this.colors.arrow.rgb = plugin._origArrow.rgb;
				this.colors.arrow.a = plugin._origArrow.a;
			}
		};
	}

	/** Per-frame: re-apply override so it survives renderer reset */
	_applyHoverEdges(renderer) {
		const hl = renderer.highlightNode;
		if (!hl) return;
		const path = typeof hl === 'string' ? hl : hl.id;
		if (!path) return;
		const color = this.categoryColors.get(path);
		if (!color) return;

		// Re-assert colors in case renderer recalculated them
		renderer.colors.lineHighlight.rgb = color.rgb;
		renderer.colors.lineHighlight.a = 1;
		renderer.colors.arrow.rgb = color.rgb;
		renderer.colors.arrow.a = 1;
	}

	/** Restore original hover handlers on unload */
	_restoreHoverHooks(renderer) {
		if (!this._hoverHooked.has(renderer)) return;
		this._hoverHooked.delete(renderer);
		// Can't easily restore the original without storing it
		// But since the original is still called via .call(), the behavior is preserved
	}

	applyToGraphs() {
		for (const viewType of ['graph', 'localgraph']) {
			this.app.workspace.getLeavesOfType(viewType).forEach((leaf) => {
				this.applyToView(leaf.view);
			});
		}
	}

	applyToView(view) {
		const renderer = view?.dataEngine?.renderer;
		if (!renderer) return;

			// Install a prerender hook on the PIXI renderer — fires before every frame
		if (!this._patched.has(renderer)) {
			this._patched.add(renderer);

			const pr = renderer.px?.renderer;
			if (pr && typeof pr.on === 'function') {
				const handler = () => {
					this._applyColors(renderer);
					this._applyHoverEdges(renderer);
				};
				pr.on('prerender', handler);
				this._preCleanups.push(() => pr.off('prerender', handler));
			}

			// Hook into the renderer's hover handlers for instant edge tinting
			this._hookRendererHover(renderer);
		}

		this._applyColors(renderer);
		if (renderer.renderCallback) renderer.renderCallback();
	}

	restoreGraphs() {
		for (const viewType of ['graph', 'localgraph']) {
			this.app.workspace.getLeavesOfType(viewType).forEach((leaf) => {
				const renderer = leaf.view?.dataEngine?.renderer;
				const nl = renderer?.nodeLookup;
				if (!nl) return;
				for (const fp of this.categoryColors.keys()) {
					if (nl[fp]) delete nl[fp].color;
				}
				// Also reset PIXI tints on node circles
				if (renderer.nodes) {
					for (const node of renderer.nodes) {
						if (node.circle?.tint !== undefined) node.circle.tint = 0xffffff;
					}
				}
				if (renderer.renderCallback) renderer.renderCallback();
			});
		}
	}

	// --- File Explorer styling ---

	injectFileExplorerStyles() {
		this.cleanupFileExplorerStyles();
		const rules = [];
		for (const [fp, color] of this.categoryColors) {
			const r = (color.rgb >> 16) & 0xff;
			const g = (color.rgb >> 8) & 0xff;
			const b = color.rgb & 0xff;
			const path = fp.replace(/'/g, "\\'");
			rules.push(`.nav-file-title[data-path='${path}'] { color: rgba(${r},${g},${b},${color.a}) !important; }`);
			rules.push(`.nav-file-title[data-path='${path}'] .nav-file-title-content { color: rgba(${r},${g},${b},${color.a}) !important; }`);
		}
		if (rules.length) {
			this.fileExplorerStyle = document.createElement('style');
			this.fileExplorerStyle.id = 'graph-category-colors-file-styles';
			this.fileExplorerStyle.textContent = rules.join('\n');
			document.head.appendChild(this.fileExplorerStyle);
		}
	}

	cleanupFileExplorerStyles() {
		const existing = document.getElementById('graph-category-colors-file-styles');
		if (existing) existing.remove();
		this.fileExplorerStyle = null;
	}
};