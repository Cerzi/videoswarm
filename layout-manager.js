class LayoutManager {
    constructor(videoBrowser) {
        this.videoBrowser = videoBrowser;
        this.layoutMode = 'grid';
        this.aspectRatioCache = new Map();
        this.zoomLevels = ['zoom-small', 'zoom-medium', 'zoom-large', 'zoom-xlarge'];
        this.zoomLabels = ['75%', '100%', '150%', '200%'];
    }

    toggleLayout() {
        const layoutButton = document.getElementById('layoutToggle');
        if (!layoutButton) return;

        const modes = ['grid', 'masonry-vertical', 'masonry-horizontal'];
        const currentIndex = modes.indexOf(this.layoutMode);
        const nextIndex = (currentIndex + 1) % modes.length;
        this.layoutMode = modes[nextIndex];

        this.updateLayoutButton();

        // Reset masonry loading controls
        this.videoBrowser.performanceManager.masonryLoadingPaused = false;
        this.videoBrowser.performanceManager.masonryStableHeight = 0;
        this.videoBrowser.performanceManager.masonryHeightCheckCount = 0;
        this.videoBrowser.performanceManager.masonryBatchProcessing = false;
        clearTimeout(this.videoBrowser.performanceManager.masonryScrollTimeout);

        // Update intersection observer margins for new layout
        this.updateIntersectionObservers();

        this.applyLayout();
        this.updateVideosForLayout();

        // Save settings
        this.videoBrowser.saveSettings();
    }

    updateLayoutButton() {
        const layoutButton = document.getElementById('layoutToggle');
        if (!layoutButton) return;

        const buttonTexts = {
            'grid': '📐 Aspect Ratio',
            'masonry-vertical': '📐 Vertical',
            'masonry-horizontal': '📐 Horizontal'
        };
        layoutButton.textContent = buttonTexts[this.layoutMode];
    }

    updateIntersectionObservers() {
        // Disconnect existing observers
        this.videoBrowser.intersectionObserver.disconnect();
        this.videoBrowser.unloadObserver.disconnect();

        // Create new observers with appropriate margins
        const rootMargin = this.layoutMode === 'masonry-vertical' ? '1200px' : '400px';
        const unloadMargin = this.layoutMode === 'masonry-vertical' ? '-1200px' : '-800px';

        this.videoBrowser.intersectionObserver = new IntersectionObserver(
            this.videoBrowser.handleIntersection.bind(this.videoBrowser),
            {
                rootMargin: rootMargin,
                threshold: [0, 0.1, 1.0]
            }
        );

        this.videoBrowser.unloadObserver = new IntersectionObserver(
            this.videoBrowser.handleUnloadIntersection.bind(this.videoBrowser),
            {
                rootMargin: unloadMargin,
                threshold: 0
            }
        );

        // Re-observe all video items
        this.videoBrowser.videos.forEach(videoItem => {
            this.videoBrowser.intersectionObserver.observe(videoItem);
            this.videoBrowser.unloadObserver.observe(videoItem);
        });
    }

    applyLayout() {
        const grid = document.getElementById('videoGrid');
        if (!grid) return;

        grid.classList.remove('masonry-vertical', 'masonry-horizontal');

        if (this.layoutMode !== 'grid') {
            grid.classList.add(this.layoutMode);
        }

        requestAnimationFrame(() => {
            if (this.layoutMode === 'masonry-horizontal') {
                grid.style.height = '100vh';
            } else {
                grid.style.height = '';
            }
        });
    }

    updateVideosForLayout() {
        this.videoBrowser.videoElements.forEach((video, videoItem) => {
            if (this.layoutMode === 'grid') {
                video.className = 'video-element';
                video.style.aspectRatio = '';
            } else {
                video.className = 'video-element aspect-ratio';
                const aspectRatio = this.aspectRatioCache.get(videoItem);
                if (aspectRatio) {
                    video.style.aspectRatio = aspectRatio;
                }
            }
        });

        this.videoBrowser.videos.forEach(videoItem => {
            if (videoItem.dataset.loaded === 'false') {
                const placeholder = videoItem.querySelector('.video-placeholder');
                if (placeholder) {
                    this.updatePlaceholderForLayout(placeholder);
                }
            }
        });
    }

    updatePlaceholderForLayout(placeholder) {
        if (this.layoutMode === 'grid') {
            placeholder.className = 'video-placeholder';
            placeholder.style.cssText = `
                width: 100%;
                height: 140px;
                background: #2d2d2d;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #666;
                font-size: 0.8rem;
            `;
        } else {
            placeholder.className = 'video-placeholder aspect-ratio';
            placeholder.style.cssText = `
                width: 100%;
                height: auto;
                aspect-ratio: 16/9;
                background: #2d2d2d;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #666;
                font-size: 0.8rem;
                min-height: 100px;
            `;
        }
    }

    setZoom(level) {
        const grid = document.getElementById('videoGrid');
        const zoomLabel = document.getElementById('zoomLabel');
        if (!grid || !zoomLabel) return;

        this.zoomLevels.forEach(cls => grid.classList.remove(cls));
        grid.classList.add(this.zoomLevels[level]);
        zoomLabel.textContent = this.zoomLabels[level];

        // Save settings (with slight delay to avoid rapid saves during dragging)
        clearTimeout(this.videoBrowser.zoomSaveTimeout);
        this.videoBrowser.zoomSaveTimeout = setTimeout(() => {
            this.videoBrowser.saveSettings();
        }, 500);
    }
}

window.LayoutManager = LayoutManager;
