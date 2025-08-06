/**
 * Centralized DOM element access
 * Follows the DRY principle by providing a single source for DOM queries
 */
export class DOMElements {
    constructor() {
        this.cache = new Map();
        this.initializeElements();
    }

    initializeElements() {
        const elementIds = [
            'fileInput',
            'autoplayToggle',
            'layoutToggle',
            'zoomSlider',
            'zoomLabel',
            'videoLimitSlider',
            'videoLimitLabel',
            'debugInfo',
            'selectionInfo',
            'status',
            'dropZone',
            'videoGrid',
            'contextMenu'
        ];

        elementIds.forEach(id => {
            this.cache.set(id, document.getElementById(id));
        });
    }

    get fileInput() {
        return this.cache.get('fileInput');
    }

    get autoplayToggle() {
        return this.cache.get('autoplayToggle');
    }

    get layoutToggle() {
        return this.cache.get('layoutToggle');
    }

    get zoomSlider() {
        return this.cache.get('zoomSlider');
    }

    get zoomLabel() {
        return this.cache.get('zoomLabel');
    }

    get videoLimitSlider() {
        return this.cache.get('videoLimitSlider');
    }

    get videoLimitLabel() {
        return this.cache.get('videoLimitLabel');
    }

    get debugInfo() {
        return this.cache.get('debugInfo');
    }

    get selectionInfo() {
        return this.cache.get('selectionInfo');
    }

    get status() {
        return this.cache.get('status');
    }

    get dropZone() {
        return this.cache.get('dropZone');
    }

    get videoGrid() {
        return this.cache.get('videoGrid');
    }

    get contextMenu() {
        return this.cache.get('contextMenu');
    }

    getElementById(id) {
        if (!this.cache.has(id)) {
            this.cache.set(id, document.getElementById(id));
        }
        return this.cache.get(id);
    }

    querySelector(selector) {
        return document.querySelector(selector);
    }

    querySelectorAll(selector) {
        return document.querySelectorAll(selector);
    }

    refreshCache() {
        this.cache.clear();
        this.initializeElements();
    }
}
