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
        this.lastScrollTime = 0;
        this.isUserScrolling = false; // FIX: Add missing property
        this.layoutRefreshInProgress = false; // Track layout refreshes

        // Setup scroll detection
        this.setupScrollDetection();
        this.setupResizeHandling();
    }

    setupResizeHandling() {
        let resizeTimeout;
        let isResizing = false;

        window.addEventListener('resize', () => {
            // Don't do anything during resize - just mark that we're resizing
            isResizing = true;
            clearTimeout(resizeTimeout);

            // Only handle resize AFTER user stops resizing for 1 second
            resizeTimeout = setTimeout(() => {
                isResizing = false;
                this.handleResizeComplete();
            }, 1000);
        });

        // Store resize state for other methods to check
        this.isResizing = () => isResizing;
    }

    setupScrollDetection() {
        let scrollTimeout;

        window.addEventListener('scroll', () => {
            this.lastScrollTime = Date.now();
            this.isUserScrolling = true;

            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                this.isUserScrolling = false;
            }, 150);
        }, { passive: true });
    }

    handleResizeComplete() {
        console.log('Window resize complete - updating layout');

        // Clear cached measurements
        this.cachedGridMeasurements = null;

        // Only re-layout if we're in masonry mode and not doing other operations
        if (this.layoutMode === 'masonry-vertical' &&
            !this.isLayouting &&
            !this.isUserScrolling) {

            // Just update the layout quietly without triggering collapse detection
            this.layoutMasonryItems();
        }

        // FIX: Let PerformanceManager handle post-resize video management
        setTimeout(() => {
            if (this.videoBrowser.performanceManager) {
                this.videoBrowser.performanceManager.handlePostResize();
            }
        }, 300);
    }

    toggleLayout() {
        const layoutButton = document.getElementById('layoutToggle');
        if (!layoutButton) return;

        const modes = ['grid', 'masonry-vertical', 'masonry-horizontal'];
        const currentIndex = modes.indexOf(this.layoutMode);
        const nextIndex = (currentIndex + 1) % modes.length;
        this.layoutMode = modes[nextIndex];

        this.updateLayoutButton();

        // Reset performance manager state safely
        if (this.videoBrowser.performanceManager) {
            // Clear queues to prevent issues during layout change
            this.videoBrowser.performanceManager.clearQueues();
        }

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
        console.log('LayoutManager: Notifying PerformanceManager about layout change');
        
        // FIX: Just notify PerformanceManager to refresh its observers
        if (this.videoBrowser.performanceManager) {
            this.videoBrowser.performanceManager.clearQueues();
            this.videoBrowser.performanceManager.refreshObservers();
        }
    }

    applyLayout() {
        const grid = document.getElementById('videoGrid');
        if (!grid) return;

        // Preserve scroll position during layout changes
        const currentScrollY = window.scrollY;

        // Clear cached measurements when switching layouts
        this.cachedGridMeasurements = null;

        grid.classList.remove('masonry-vertical', 'masonry-horizontal');

        if (this.layoutMode === 'masonry-vertical') {
            grid.classList.add('masonry-vertical');
            // Use setTimeout to ensure CSS changes are applied first
            setTimeout(() => {
                this.initializeMasonryGrid();
                // Restore scroll position after layout
                if (currentScrollY > 0) {
                    requestAnimationFrame(() => {
                        window.scrollTo(0, currentScrollY);
                    });
                }
            }, 50);
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

        // Refresh masonry layout after zoom change
        if (this.layoutMode === 'masonry-vertical') {
            clearTimeout(this.masonryLayoutTimeout);
            this.masonryLayoutTimeout = setTimeout(() => {
                this.cachedGridMeasurements = null;
                this.initializeMasonryGrid();
            }, 300);
        }

        // Save settings (with slight delay to avoid rapid saves during dragging)
        clearTimeout(this.videoBrowser.zoomSaveTimeout);
        this.videoBrowser.zoomSaveTimeout = setTimeout(() => {
            this.videoBrowser.saveSettings();
        }, 500);
    }

    initializeMasonryGrid() {
        const grid = document.getElementById('videoGrid');
        if (!grid || this.isLayouting || this.isUserScrolling) return;

        // Check if native masonry is supported
        if (CSS.supports('grid-template-rows', 'masonry')) {
            console.log('Using native CSS masonry');
            return;
        }

        // Prevent layout loops
        if (this.layoutRefreshInProgress) {
            console.log('Skipping masonry init - refresh in progress');
            return;
        }

        this.isLayouting = true;
        this.layoutRefreshInProgress = true;

        console.log('Initializing masonry layout');

        // Preserve scroll position
        const currentScrollY = window.scrollY;

        // Reset positioning first
        this.videoBrowser.videos.forEach(videoItem => {
            videoItem.style.gridRowEnd = '';
        });

        // Wait for DOM to settle, then apply layout
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (this.layoutMode === 'masonry-vertical' && !this.isUserScrolling) {
                    this.layoutMasonryItems();
                }

                // Restore scroll position ONLY if it was significant
                if (currentScrollY > 100) {
                    setTimeout(() => {
                        if (!this.isUserScrolling) { // Don't restore if user is scrolling
                            window.scrollTo(0, currentScrollY);
                            console.log(`Restored scroll position to ${currentScrollY}px`);
                        }
                    }, 100); // Longer delay
                }

                this.isLayouting = false;

                // Longer delay before allowing refresh again
                setTimeout(() => {
                    this.layoutRefreshInProgress = false;
                }, 500);
            });
        });
    }

    layoutMasonryItems() {
        const grid = document.getElementById('videoGrid');
        if (!grid || this.layoutMode !== 'masonry-vertical') return;

        // SCROLL PRESERVATION: Don't layout if user is actively scrolling
        const now = Date.now();
        if (this.isUserScrolling || (this.lastScrollTime && (now - this.lastScrollTime < 300))) {
            console.log('Delaying layout - user is scrolling');
            setTimeout(() => this.layoutMasonryItems(), 200);
            return;
        }

        const computedStyle = window.getComputedStyle(grid);
        const columnGap = parseFloat(computedStyle.columnGap) || 4;

        console.log('Laying out masonry items with columnGap:', columnGap);

        // Batch DOM updates for better performance
        const updates = [];

        this.videoBrowser.videos.forEach((videoItem, index) => {
            const rect = videoItem.getBoundingClientRect();
            const height = rect.height;

            if (height > 0) {
                const rowSpan = Math.round(height + columnGap);
                updates.push({ videoItem, rowSpan });
            } else {
                // Fallback for items without height
                const fallbackHeight = this.calculateFallbackHeight(videoItem);
                const rowSpan = Math.round(fallbackHeight + columnGap);
                updates.push({ videoItem, rowSpan });
            }
        });

        // Apply all updates at once
        updates.forEach(({ videoItem, rowSpan }) => {
            videoItem.style.gridRowEnd = `span ${rowSpan}`;
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

    // FIX: Much more conservative refresh
    refreshMasonryLayout() {
        // Don't refresh if user is interacting or layout is already in progress
        if (this.isUserScrolling ||
            this.layoutRefreshInProgress ||
            this.isLayouting ||
            (this.videoBrowser.performanceManager?.layoutRefreshInProgress)) {
            console.log('Skipping layout refresh - interaction or refresh in progress');
            return;
        }

        // Don't refresh too frequently
        const now = Date.now();
        if (this.lastScrollTime && (now - this.lastScrollTime < 2000)) { // Much longer delay
            console.log('Skipping layout refresh - recent user activity');
            return;
        }

        console.log('Refreshing masonry layout');
        this.initializeMasonryGrid();
    }

    // Force layout with scroll preservation
    forceLayout() {
        const currentScrollY = window.scrollY;

        if (this.layoutMode === 'masonry-vertical') {
            this.initializeMasonryGrid();
        }

        // Restore scroll position
        setTimeout(() => {
            if (currentScrollY > 0) {
                window.scrollTo(0, currentScrollY);
            }
        }, 100);
    }

    // Layout collapse monitoring - MUCH more conservative
    monitorLayoutCollapse() {
        let lastHeight = document.documentElement.scrollHeight;
        let consecutiveChecks = 0;

        setInterval(() => {
            // Skip monitoring during layout operations
            if (this.isLayouting || this.layoutRefreshInProgress) {
                return;
            }

            const currentHeight = document.documentElement.scrollHeight;
            const heightChange = Math.abs(currentHeight - lastHeight);

            // Only trigger on MASSIVE height changes (real collapses, not normal layout)
            if (heightChange > window.innerHeight * 4) {
                consecutiveChecks++;

                // Only trigger after multiple consecutive detections to avoid false positives
                if (consecutiveChecks >= 2) {
                    console.warn(`SEVERE LAYOUT COLLAPSE DETECTED: Height changed by ${heightChange}px`);
                    console.trace('Layout collapse stack trace');

                    // Notify performance manager ONLY for severe collapses
                    if (this.videoBrowser.performanceManager?.handleLayoutCollapse) {
                        this.videoBrowser.performanceManager.handleLayoutCollapse();
                    }

                    consecutiveChecks = 0;
                }
            } else {
                consecutiveChecks = 0;
            }

            lastHeight = currentHeight;
        }, 1000); // Much less frequent checking
    }

    destroy() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        clearTimeout(this.masonryLayoutTimeout);
    }
}

window.LayoutManager = LayoutManager;