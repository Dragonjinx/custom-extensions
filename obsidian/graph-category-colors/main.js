const { Plugin, Notice } = require('obsidian');

// Rainbow gradient — categories sorted alphabetically get evenly-spaced hues
const HUE_START = 0, HUE_END = 360;
const HOMEPAGE_COLOR = '#ffffff';

// Logarithmic depth progression for saturation & lightness.
// depth 0 (category.md):         pastel  (sat=25, light=80)
// depth 1 (category.a.md):       normal  (sat=72, light=52)
// depth 2 (category.a.b.md):     deeper  (sat=90, light=41)
// depth 3 (category.a.b.c.md):   deeper  (sat=96, light=37)
// depth 4+:                              approaches 100, 35
const SAT_START = 25, SAT_ASYMP = 100;
const LIGHT_START = 80, LIGHT_ASYMP = 35;
const DEPTH_TAU = 1.0; // curve steepness

function hslToHex(h, s, l) {
	s /= 100; l /= 100;
	const a = s * Math.min(l, 1 - l);
	const f = n => {
		const k = (n + h / 30) % 12;
		return Math.round(255 * (l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)));
	};
	return '#' + [f(0), f(8), f(4)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function hexToRgbInt(hex) { return parseInt(hex.replace('#', ''), 16); }

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
		this.overlayCanvases = new Map();
		this.renderRAF = null;
		this.removing = false;
		this.categoryColors = new Map();

		await this.rebuild();
		this.setupOverlays();
		this.startRenderLoop();

		this.registerEvent(this.app.vault.on('create', () => this.rebuild()));
		this.registerEvent(this.app.vault.on('delete', () => this.rebuild()));
		this.registerEvent(this.app.workspace.on('layout-change', () => {
			setTimeout(() => this.setupOverlays(), 500);
		}));

		this.addCommand({
			id: 'refresh-category-colors',
			name: 'Refresh graph category colors',
			callback: async () => { await this.rebuild(); new Notice('Graph colors refreshed'); },
		});
	}

	onunload() {
		this.removing = true;
		if (this.renderRAF) { cancelAnimationFrame(this.renderRAF); this.renderRAF = null; }
		this.cleanupOverlays();
	}

	async rebuild() {
		await this.buildColorMap();
		await this.writeGraphJson();
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
		const catFiles = new Map();

		for (const file of files) {
			if (homepagePath && file.path === homepagePath) {
				this.categoryColors.set(file.path, HOMEPAGE_COLOR);
				continue;
			}
			const prefix = getCategoryPrefix(file.path);
			if (prefix) {
				if (!catFiles.has(prefix)) catFiles.set(prefix, []);
				catFiles.get(prefix).push(file.path);
			}
		}

		const sorted = Array.from(catFiles.keys()).sort((a, b) => a.localeCompare(b));
		const total = sorted.length;

		for (const [i, cat] of sorted.entries()) {
			const hue = HUE_START + (i / total) * (HUE_END - HUE_START);
			for (const fp of catFiles.get(cat)) {
				const depth = getFileDepth(fp);
				const sat = SAT_ASYMP - (SAT_ASYMP - SAT_START) * Math.exp(-depth / DEPTH_TAU);
				const light = LIGHT_ASYMP + (LIGHT_START - LIGHT_ASYMP) * Math.exp(-depth / DEPTH_TAU);
				const hex = hslToHex(hue, Math.round(sat), Math.round(light));
				this.categoryColors.set(fp, hex);
			}
		}
	}

	// --- Persistence (graph.json) — fallback for when plugin is disabled ---

	async writeGraphJson() {
		try {
			const adapter = this.app.vault.adapter;
			const graphPath = this.app.vault.configDir + '/graph.json';
			let config = (await adapter.exists(graphPath))
				? JSON.parse(await adapter.read(graphPath))
				: { "collapse-filter": true, "search": "", "showTags": false,
					"showAttachments": false, "hideUnresolved": false, "showOrphans": true,
					"collapse-color-groups": false, "colorGroups": [],
					"collapse-display": true, "showArrow": false, "textFadeMultiplier": 0,
					"nodeSizeMultiplier": 1, "lineSizeMultiplier": 1, "collapse-forces": true,
					"centerStrength": 0.518713248970312, "repelStrength": 10,
					"linkStrength": 1, "linkDistance": 250, "scale": 1, "close": true };

			const groups = [];
			for (const [fp, hex] of this.categoryColors) {
				const path = fp.replace('.md', '');
				groups.push({
					query: `path:/^${path}$/`,
					color: { a: 1, rgb: hexToRgbInt(hex) },
				});
			}
			config.colorGroups = groups;
			await adapter.write(graphPath, JSON.stringify(config, null, 2));
		} catch {}
	}

	// --- Canvas Overlay ---

	getNodeColor(nodeId) {
		return this.categoryColors.get(nodeId) || null;
	}

	setupOverlays() {
		for (const viewType of ['graph', 'localgraph']) {
			this.app.workspace.getLeavesOfType(viewType).forEach((leaf) => {
				const view = leaf.view;
				const containerEl = view.contentEl;
				if (!containerEl) return;

				const key = leaf.id || '';
				if (this.overlayCanvases.has(key)) {
					const existing = this.overlayCanvases.get(key);
					if (existing.isConnected) return;
					existing.remove();
					this.overlayCanvases.delete(key);
				}

				const canvas = document.createElement('canvas');
				canvas.style.position = 'absolute';
				canvas.style.top = '0';
				canvas.style.left = '0';
				canvas.style.width = '100%';
				canvas.style.height = '100%';
				canvas.style.pointerEvents = 'none';
				canvas.style.zIndex = '10';
				canvas.className = 'graph-color-overlay';

				containerEl.style.position = 'relative';
				containerEl.appendChild(canvas);
				this.overlayCanvases.set(key, canvas);

				const syncSize = () => {
					const r = leaf.view?.dataEngine?.renderer;
					const px = r?.px?.renderer;
					if (px) { canvas.width = px.width; canvas.height = px.height; }
					else { canvas.width = containerEl.clientWidth; canvas.height = containerEl.clientHeight; }
				};
				syncSize();
				const ro = new ResizeObserver(() => syncSize());
				ro.observe(containerEl);
				this.register(() => ro.disconnect());
			});
		}
	}

	cleanupOverlays() {
		this.overlayCanvases.forEach((canvas) => {
			const ctx = canvas.getContext('2d');
			if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
			canvas.remove();
		});
		this.overlayCanvases.clear();

		for (const viewType of ['graph', 'localgraph']) {
			this.app.workspace.getLeavesOfType(viewType).forEach((leaf) => {
				const renderer = leaf.view?.dataEngine?.renderer;
				if (!renderer?.nodes) return;
				for (const node of renderer.nodes) {
					if (node.id && node.circle && node.circle.alpha === 0)
						node.circle.alpha = 1;
				}
			});
		}
	}

	startRenderLoop() {
		if (this.removing) return;
		this.setupOverlays();
		const loop = () => {
			if (this.removing) return;
			try { this.renderOverlay(); } catch {}
			this.renderRAF = requestAnimationFrame(loop);
		};
		this.renderRAF = requestAnimationFrame(loop);
	}

	renderOverlay() {
		for (const viewType of ['graph', 'localgraph']) {
			this.app.workspace.getLeavesOfType(viewType).forEach((leaf) => {
				try {
					const dataEngine = leaf.view?.dataEngine;
					const renderer = dataEngine?.renderer;
					if (!renderer?.nodes) return;

					const canvas = this.overlayCanvases.get(leaf.id || '');
					if (!canvas) return;

					const ctx = canvas.getContext('2d');
					if (!ctx) return;

					const px = renderer.px?.renderer;
					if (px && (canvas.width !== px.width || canvas.height !== px.height)) {
						canvas.width = px.width;
						canvas.height = px.height;
					}

					ctx.clearRect(0, 0, canvas.width, canvas.height);

					const scale = renderer.scale || 1;
					const panX = renderer.panX || 0;
					const panY = renderer.panY || 0;
					const nodeScale = renderer.nodeScale || 1;

					for (const node of renderer.nodes) {
						if (!node.id) continue;

						const color = this.getNodeColor(node.id);
						if (!color) {
							if (node.circle && node.circle.alpha === 0) node.circle.alpha = 1;
							continue;
						}

						if (node.circle) node.circle.alpha = 0;

						let x, y, r;
						if (node.circle && typeof node.circle.getBounds === 'function') {
							const b = node.circle.getBounds();
							x = b.x + b.width / 2;
							y = b.y + b.height / 2;
							r = b.width / 2;
						} else {
							x = node.x * scale + panX;
							y = node.y * scale + panY;
							r = 3 * nodeScale * scale;
						}

						ctx.beginPath();
						ctx.arc(x, y, r, 0, 2 * Math.PI);
						ctx.fillStyle = color;
						ctx.fill();
						ctx.strokeStyle = '#333333';
						ctx.lineWidth = 1;
						ctx.stroke();
					}
				} catch {}
			});
		}
	}
};