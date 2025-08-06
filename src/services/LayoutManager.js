/**
 * Manages layout modes and zoom levels
 * Follows the Single Responsibility Principle by focusing only on layout concerns
 */
export class LayoutManager {
    constructor(eventBus) {
        this.eventBus = eventBus;
        this.layoutMode = 'grid';
        this.currentZoom = 1;
        this.setupEventListeners();
    }

    setupEventListeners() {
        this.eventBus.on('layout:toggle', () => {
            this.toggleLayout();
        });

        this.eventBus.on('zoom:change', (level) => {
            this.setZoom(level);
        });

        this.eventBus.on('layout:apply', () => {
            this.applyCurrentLayout();
        });
    }

    toggleLayout() {
        const modes = ['grid', 'masonry-vertical', 'masonry-horizontal'];
        const currentIndex = modes.indexOf(this.layoutMode);
        const nextIndex = (currentIndex + 1) % modes.length;
        this.layoutMode = modes[nextIndex];

        this.applyCurrentLayout();
        this.eventBus.emit('ui:updateLayoutButton', this.layoutMode);
        this.eventBus.emit('videos:updateForLayout', this.layoutMode);
    }

    setZoom(level) {
        this.currentZoom = level;
        this.eventBus.emit('ui:updateZoom', level);
    }

    applyCurrentLayout() {
        const grid = document.getElementById('videoGrid');
        if (!grid) return;

        // Remove all layout classes
        grid.classList.remove('masonry-vertical', 'masonry-horizontal');

        // Apply current layout
        if (this.layoutMode !== 'grid') {
            grid.classList.add(this.layoutMode);
        }

        // Adjust grid height for horizontal masonry
        requestAnimationFrame(() => {
            if (this.layoutMode === 'masonry-horizontal') {
                grid.style.height = '100vh';
            } else {
                grid.style.height = '';
            }
        });
    }

    getCurrentLayout() {
        return this.layoutMode;
    }

    getCurrentZoom() {
        return this.currentZoom;
    }
}
