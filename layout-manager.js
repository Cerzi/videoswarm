class LayoutManager {
    constructor(videoBrowser) {
        this.videoBrowser = videoBrowser;
        this.layoutMode = 'grid';
        this.aspectRatioCache = new Map();
        this.zoomLevels = ['zoom-small', 'zoom-medium', 'zoom-large', 'zoom-xlarge'];
        this.zoomLabels = ['75%', '100%', '150%', '200%'];
        this.masonryLayoutTimeout = null;
        this.isLayouting = false;
        this.cachedGridMeasurements = null;
        this.lastScrollTime = 0; // Track when user last scrolled

        // Simple debounced resize observer
        this.resizeObserver = new ResizeObserver((entries) => {
            if (this.layoutMode === 'masonry-vertical' && !this.isLayouting) {
                clearTimeout(this.masonryLayoutTimeout);
                this.masonryLayoutTimeout = setTimeout(() => {
                    this.cachedGridMeasurements = null;
                    this.refreshMasonryLayout();
                }, 300);
            }
        });

        // Track scroll events to prevent layout during scrolling
        window.addEventListener('scroll', () => {
            this.lastScrollTime = Date.now();
        }, { passive: true });

        // Observe the grid container
        const grid = document.getElementById('videoGrid');
        if (grid) {
            this.resizeObserver.observe(grid);
        }
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

        // Optimized margins for masonry
        const rootMargin = this.layoutMode === 'masonry-vertical' ? '800px' : '400px';
        const unloadMargin = this.layoutMode === 'masonry-vertical' ? '-600px' : '-800px';

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

        // Clear cached measurements when switching layouts
        this.cachedGridMeasurements = null;

        grid.classList.remove('masonry-vertical', 'masonry-horizontal');

        if (this.layoutMode === 'masonry-vertical') {
            grid.classList.add('masonry-vertical');
            this.initializeMasonryGrid();
        } else if (this.layoutMode === 'masonry-horizontal') {
            grid.classList.add('masonry-horizontal');
            grid.style.height = '100vh';
        } else {
            grid.style.height = '';
        }
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

    // SIMPLE PROVEN APPROACH: Use the working method from CSS-Tricks latest article
    initializeMasonryGrid() {
        const grid = document.getElementById('videoGrid');
        if (!grid || this.isLayouting) return;

        // Check if native masonry is supported
        if (CSS.supports('grid-template-rows', 'masonry')) {
            console.log('Using native CSS masonry');
            return;
        }

        this.isLayouting = true;
        console.log('Initializing simple masonry layout');

        // SIMPLE APPROACH: Reset positioning and apply layout
        this.videoBrowser.videos.forEach(videoItem => {
            videoItem.style.gridRowEnd = '';
        });

        // Wait a frame for DOM to settle, then apply layout
        requestAnimationFrame(() => {
            if (this.layoutMode === 'masonry-vertical') {
                this.layoutMasonryItems();
            }
            this.isLayouting = false;
        });
    }

    layoutMasonryItems() {
        const grid = document.getElementById('videoGrid');
        if (!grid || this.layoutMode !== 'masonry-vertical') return;

        // SCROLL PRESERVATION: Don't layout if user is actively scrolling
        const now = Date.now();
        if (this.lastScrollTime && (now - this.lastScrollTime < 500)) {
            console.log('Delaying layout - user is scrolling');
            setTimeout(() => this.layoutMasonryItems(), 200);
            return;
        }

        const computedStyle = window.getComputedStyle(grid);
        const columnGap = parseFloat(computedStyle.columnGap) || 4;

        console.log('Laying out masonry items with columnGap:', columnGap);

        // SIMPLE APPROACH: For each item, get its height and set row span
        this.videoBrowser.videos.forEach((videoItem, index) => {
            // Get the height of the item
            const rect = videoItem.getBoundingClientRect();
            const height = rect.height;

            if (height > 0) {
                // Calculate row span: height + gap (rounded up)
                const rowSpan = Math.round(height + columnGap);
                videoItem.style.gridRowEnd = `span ${rowSpan}`;

                if (index < 5) {
                    console.log(`Item ${index}: height=${height}px, rowSpan=${rowSpan}`);
                }
            } else {
                // Fallback for items without height yet
                const fallbackHeight = this.calculateFallbackHeight(videoItem);
                const rowSpan = Math.round(fallbackHeight + columnGap);
                videoItem.style.gridRowEnd = `span ${rowSpan}`;

                console.log(`Item ${index} (fallback): height=${fallbackHeight}px, rowSpan=${rowSpan}`);
            }
        });
    }

    calculateFallbackHeight(videoItem) {
        // Calculate height based on aspect ratio when DOM height isn't available
        if (!this.cachedGridMeasurements) {
            this.updateCachedGridMeasurements();
        }

        if (!this.cachedGridMeasurements) {
            return 200; // Safe fallback
        }

        // Get aspect ratio
        let aspectRatio = this.aspectRatioCache.get(videoItem);
        if (!aspectRatio) {
            const video = this.videoBrowser.videoElements.get(videoItem);
            if (video && video.videoWidth && video.videoHeight) {
                aspectRatio = `${video.videoWidth}/${video.videoHeight}`;
                this.aspectRatioCache.set(videoItem, aspectRatio);
            } else {
                aspectRatio = '16/9'; // Default
            }
        }

        const [width, height] = aspectRatio.split('/').map(Number);

        // Calculate height based on column width
        const contentHeight = (this.cachedGridMeasurements.columnWidth * height) / width;
        return Math.ceil(contentHeight) + 30; // Add filename overlay space
    }

    updateCachedGridMeasurements() {
        const grid = document.getElementById('videoGrid');
        if (!grid) return;

        const computedStyle = window.getComputedStyle(grid);
        const columnCount = this.getColumnCount(computedStyle);
        const columnGap = parseFloat(computedStyle.columnGap) || 4;

        const gridWidth = grid.clientWidth;
        const padding = (parseFloat(computedStyle.paddingLeft) || 0) + (parseFloat(computedStyle.paddingRight) || 0);

        const availableWidth = gridWidth - padding;
        const totalGapWidth = columnGap * (columnCount - 1);
        const columnWidth = (availableWidth - totalGapWidth) / columnCount;

        this.cachedGridMeasurements = {
            columnWidth: Math.floor(columnWidth),
            columnCount
        };

        console.log('Grid measurements:', this.cachedGridMeasurements);
    }

    getColumnCount(computedStyle) {
        const gridTemplateColumns = computedStyle.gridTemplateColumns;
        if (gridTemplateColumns === 'none') return 1;
        return gridTemplateColumns.split(' ').length;
    }

    refreshMasonryLayout() {
        if (this.layoutMode !== 'masonry-vertical' || this.isLayouting) return;

        console.log('Refreshing masonry layout');

        // SCROLL PRESERVATION: Save current scroll position
        const savedScrollTop = window.scrollY;
        const savedScrollLeft = window.scrollX;

        this.cachedGridMeasurements = null;

        // Use the simple approach but preserve scroll position
        setTimeout(() => {
            this.initializeMasonryGrid();

            // SCROLL PRESERVATION: Restore scroll position after layout
            requestAnimationFrame(() => {
                window.scrollTo(savedScrollLeft, savedScrollTop);
                console.log(`Restored scroll position to ${savedScrollTop}px`);
            });
        }, 100);
    }
}

window.LayoutManager = LayoutManager;
