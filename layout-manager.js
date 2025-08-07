class LayoutManager {
    constructor(videoBrowser) {
        this.videoBrowser = videoBrowser;
        this.layoutMode = 'grid';
        this.aspectRatioCache = new Map();
        this.zoomLevels = ['zoom-small', 'zoom-medium', 'zoom-large', 'zoom-xlarge'];
        this.zoomLabels = ['75%', '100%', '150%', '200%'];
        this.masonryLayoutTimeout = null;

        // Set up resize observer for responsive masonry
        this.resizeObserver = new ResizeObserver((entries) => {
            if (this.layoutMode === 'masonry-vertical') {
                clearTimeout(this.masonryLayoutTimeout);
                this.masonryLayoutTimeout = setTimeout(() => {
                    this.refreshMasonryLayout();
                }, 100);
            }
        });

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

        grid.classList.remove('masonry-vertical', 'masonry-horizontal');

        if (this.layoutMode === 'masonry-vertical') {
            grid.classList.add('masonry-vertical');
            // Use CSS Grid for proper masonry with left-to-right ordering
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

    initializeMasonryGrid() {
        const grid = document.getElementById('videoGrid');
        if (!grid) return;

        // Check if native masonry is supported
        if (CSS.supports('grid-template-rows', 'masonry')) {
            console.log('Using native CSS masonry');
            return; // Let CSS handle it natively
        }

        // Reset any previous positioning
        this.videoBrowser.videos.forEach(videoItem => {
            videoItem.style.gridRowStart = '';
            videoItem.style.gridRowEnd = '';
        });

        // Use JavaScript masonry for better browser support
        requestAnimationFrame(() => {
            this.layoutMasonryItems();
        });
    }

    layoutMasonryItems() {
        const grid = document.getElementById('videoGrid');
        if (!grid || this.layoutMode !== 'masonry-vertical') return;

        // Get grid properties
        const computedStyle = window.getComputedStyle(grid);
        const columnCount = computedStyle.gridTemplateColumns.split(' ').length;
        const rowHeight = parseInt(computedStyle.gridAutoRows) || 20; // Now 20px
        
        // Parse gap - handle "2px 4px" format
        const gapValue = computedStyle.gap || '2px 4px';
        const gaps = gapValue.split(' ');
        const verticalGap = parseInt(gaps[0]) || 2;
        const horizontalGap = parseInt(gaps[1] || gaps[0]) || 4;

        // Track the next available row for each column
        const columnNextRow = new Array(columnCount).fill(1);
        
        // Process items in DOM order (maintains row-based sorting)
        const items = Array.from(this.videoBrowser.videos);
        
        items.forEach((videoItem, index) => {
            // Determine which column this item should go in
            let targetColumn = index % columnCount;
            
            // Get the item's natural height
            const itemHeight = this.calculateItemHeight(videoItem);
            // Calculate row span with the larger row height
            const rowSpan = Math.ceil((itemHeight + verticalGap) / (rowHeight + verticalGap));
            
            // Find the earliest available row for this column
            let startRow = columnNextRow[targetColumn];
            
            // Try to fill gaps in earlier columns if this would create a large gap
            if (targetColumn > 0) {
                const minRowInRange = Math.min(...columnNextRow.slice(0, targetColumn + 1));
                if (startRow - minRowInRange > 3) { // Adjusted gap tolerance
                    startRow = minRowInRange;
                    // Find which column has this row available
                    for (let col = 0; col <= targetColumn; col++) {
                        if (columnNextRow[col] <= startRow) {
                            targetColumn = col;
                            break;
                        }
                    }
                }
            }
            
            // Position the item
            videoItem.style.gridColumnStart = targetColumn + 1;
            videoItem.style.gridRowStart = startRow;
            videoItem.style.gridRowEnd = startRow + rowSpan;
            
            // Update the column's next available row
            columnNextRow[targetColumn] = startRow + rowSpan;
        });
    }

    calculateItemHeight(videoItem) {
        // Get cached aspect ratio or use default
        const aspectRatio = this.aspectRatioCache.get(videoItem);
        let width = 16, height = 9; // default
        
        if (aspectRatio) {
            [width, height] = aspectRatio.split('/').map(Number);
        } else {
            // Try to get from video element if loaded
            const video = this.videoBrowser.videoElements.get(videoItem);
            if (video && video.videoWidth && video.videoHeight) {
                width = video.videoWidth;
                height = video.videoHeight;
                this.aspectRatioCache.set(videoItem, `${width}/${height}`);
            }
        }
        
        // Calculate height based on actual grid column width
        const grid = document.getElementById('videoGrid');
        const gridRect = grid.getBoundingClientRect();
        const gridWidth = gridRect.width;
        const computedStyle = window.getComputedStyle(grid);
        const columnCount = computedStyle.gridTemplateColumns.split(' ').length;
        
        // Parse gap for horizontal spacing
        const gapValue = computedStyle.gap || '2px 4px';
        const gaps = gapValue.split(' ');
        const horizontalGap = parseInt(gaps[1] || gaps[0]) || 4;
        
        // Calculate actual column width
        const totalGapWidth = horizontalGap * (columnCount - 1);
        const columnWidth = (gridWidth - totalGapWidth) / columnCount;
        
        // Calculate proportional height
        const itemHeight = (columnWidth * height) / width;
        
        // Add minimal padding for filename overlay
        return itemHeight + 25;
    }

    refreshMasonryLayout() {
        if (this.layoutMode === 'masonry-vertical') {
            // Clear existing positioning
            this.videoBrowser.videos.forEach(videoItem => {
                videoItem.style.gridRowStart = '';
                videoItem.style.gridRowEnd = '';
                videoItem.style.gridColumnStart = '';
            });
            
            // Re-layout after a brief delay to ensure grid has recalculated
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this.layoutMasonryItems();
                });
            });
        }
    }
}

window.LayoutManager = LayoutManager;
