class PerformanceManager {
    constructor(videoBrowser) {
        this.videoBrowser = videoBrowser;
        this.maxConcurrentLoading = 6;
        this.maxLoadedVideos = 80;
        this.unloadDistance = 800;
        this.loadQueue = [];
        this.isProcessingQueue = false;
        
        // Masonry-specific loading control
        this.masonryLoadingPaused = false;
        this.masonryStableHeight = 0;
        this.masonryHeightCheckCount = 0;
        this.masonryScrollTimeout = null;
        this.masonryBatchProcessing = false;
        
        this.startPerformanceMonitoring();
        this.setupScrollBackup();
    }

    startPerformanceMonitoring() {
        setInterval(() => {
            if (performance.memory) {
                const memoryRatio = performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit;

                // Only auto-adjust if user hasn't manually set a limit
                if (!this.videoBrowser.userSetVideoLimit) {
                    if (memoryRatio > 0.7) {
                        this.videoBrowser.maxConcurrentPlaying = Math.max(5, this.videoBrowser.maxConcurrentPlaying - 5);
                        this.maxLoadedVideos = Math.max(20, this.maxLoadedVideos - 15);
                        this.emergencyCleanup();
                    } else if (memoryRatio > 0.5) {
                        this.videoBrowser.maxConcurrentPlaying = Math.max(10, this.videoBrowser.maxConcurrentPlaying - 2);
                        this.maxLoadedVideos = Math.max(40, this.maxLoadedVideos - 5);
                        this.aggressiveCleanup();
                    } else if (memoryRatio < 0.3) {
                        this.videoBrowser.maxConcurrentPlaying = Math.min(30, this.videoBrowser.maxConcurrentPlaying + 1);
                        this.maxLoadedVideos = Math.min(80, this.maxLoadedVideos + 2);
                    }
                } else {
                    // Still do cleanup if needed, but don't adjust playing limit
                    if (memoryRatio > 0.7) {
                        this.maxLoadedVideos = Math.max(20, this.maxLoadedVideos - 15);
                        this.emergencyCleanup();
                    } else if (memoryRatio > 0.5) {
                        this.maxLoadedVideos = Math.max(40, this.maxLoadedVideos - 5);
                        this.aggressiveCleanup();
                    }
                }
            }

            this.videoBrowser.updateDebugInfo();
        }, 2000);
    }

    setupScrollBackup() {
        setInterval(() => {
            this.checkAndFixStuckPlaceholders();
        }, 3000);

        window.addEventListener('scroll', () => {
            // Enhanced masonry scroll handling
            if (this.videoBrowser.layoutManager.layoutMode === 'masonry-vertical') {
                this.handleMasonryScroll();
            }

            // Original scroll timeout logic for other modes
            let scrollTimeout;
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                if (this.videoBrowser.layoutManager.layoutMode === 'masonry-vertical') {
                    this.checkMasonryStability();
                }
            }, 500);
        });
    }

    handleMasonryScroll() {
        // Pause loading immediately on scroll
        this.masonryLoadingPaused = true;

        // Clear any existing timeout
        clearTimeout(this.masonryScrollTimeout);

        // Resume loading after scroll stops, with longer delay
        this.masonryScrollTimeout = setTimeout(() => {
            this.masonryLoadingPaused = false;
            if (this.loadQueue.length > 0 && !this.masonryBatchProcessing) {
                this.processMasonryLoadQueue();
            }
        }, 300);
    }

    checkMasonryStability() {
        if (this.videoBrowser.layoutManager.layoutMode !== 'masonry-vertical') return;

        const grid = document.getElementById('videoGrid');
        if (!grid) return;

        const currentHeight = grid.scrollHeight;

        if (Math.abs(currentHeight - this.masonryStableHeight) < 50) {
            this.masonryHeightCheckCount++;
            if (this.masonryHeightCheckCount >= 3) {
                // Height has been stable, resume normal loading
                this.masonryLoadingPaused = false;
                if (this.loadQueue.length > 0) {
                    this.processLoadQueue();
                }
            }
        } else {
            this.masonryStableHeight = currentHeight;
            this.masonryHeightCheckCount = 0;
        }
    }

    checkAndFixStuckPlaceholders() {
        const viewportTop = window.scrollY;
        const viewportBottom = viewportTop + window.innerHeight;
        const buffer = 200;

        this.videoBrowser.videos.forEach(videoItem => {
            if (videoItem.dataset.loaded === 'false') {
                const rect = videoItem.getBoundingClientRect();
                const elementTop = rect.top + window.scrollY;
                const elementBottom = elementTop + rect.height;

                const inExtendedViewport = elementBottom >= (viewportTop - buffer) &&
                                         elementTop <= (viewportBottom + buffer);

                if (inExtendedViewport && !this.loadQueue.includes(videoItem)) {
                    console.log(`Fixing stuck placeholder: ${videoItem.dataset.filename}`);
                    this.videoBrowser.visibleVideos.add(videoItem);
                    this.loadQueue.push(videoItem);

                    const placeholder = videoItem.querySelector('.video-placeholder');
                    if (placeholder) {
                        placeholder.textContent = '📼 Loading...';
                        placeholder.style.background = '#2a4a2a';
                    }
                }
            }
        });

        if (!this.isProcessingQueue && this.loadQueue.length > 0 && !this.masonryLoadingPaused) {
            if (this.videoBrowser.layoutManager.layoutMode === 'masonry-vertical') {
                this.processMasonryLoadQueue();
            } else {
                this.processLoadQueue();
            }
        }
    }

    addToMasonryQueue(videoItem, entry) {
        if (this.loadQueue.includes(videoItem)) return;

        // Calculate priority based on viewport position
        const rect = videoItem.getBoundingClientRect();
        const viewportCenter = window.innerHeight / 2;
        const itemCenter = rect.top + rect.height / 2;
        const distanceFromCenter = Math.abs(itemCenter - viewportCenter);

        // Add priority data
        videoItem._masonryPriority = {
            distanceFromCenter,
            intersectionRatio: entry.intersectionRatio,
            timestamp: Date.now()
        };

        this.loadQueue.push(videoItem);

        // Sort queue by priority (closer to center = higher priority)
        this.loadQueue.sort((a, b) => {
            const aPriority = a._masonryPriority;
            const bPriority = b._masonryPriority;

            if (!aPriority) return 1;
            if (!bPriority) return -1;

            // Primary: distance from viewport center
            const distanceDiff = aPriority.distanceFromCenter - bPriority.distanceFromCenter;
            if (Math.abs(distanceDiff) > 50) return distanceDiff;

            // Secondary: intersection ratio (more visible = higher priority)
            return bPriority.intersectionRatio - aPriority.intersectionRatio;
        });
    }

    async processMasonryLoadQueue() {
        if (this.masonryBatchProcessing || this.masonryLoadingPaused) return;

        this.masonryBatchProcessing = true;

        let processed = 0;
        const batchSize = 2; // Very small batches for masonry
        const maxConcurrentForMasonry = Math.min(this.maxConcurrentLoading, 3);

        while (this.loadQueue.length > 0 &&
               this.videoBrowser.loadingVideos.size < maxConcurrentForMasonry &&
               processed < batchSize &&
               !this.masonryLoadingPaused) {

            const videoItem = this.loadQueue.shift();

            if (videoItem.dataset.loaded === 'false') {
                // Double-check viewport visibility for masonry
                const rect = videoItem.getBoundingClientRect();
                const extendedViewport = rect.bottom >= -1200 && rect.top <= window.innerHeight + 1200;

                if (extendedViewport || this.videoBrowser.visibleVideos.has(videoItem)) {
                    try {
                        await this.videoBrowser.loadVideoContent(videoItem);
                        processed++;

                        // Longer delay between masonry loads to prevent cascade
                        if (processed < batchSize && this.loadQueue.length > 0) {
                            await new Promise(resolve => setTimeout(resolve, 200));
                        }
                    } catch (error) {
                        console.warn('Failed to load video:', error);
                    }
                }
            }

            // Clean up priority data
            if (videoItem._masonryPriority) {
                delete videoItem._masonryPriority;
            }
        }

        this.masonryBatchProcessing = false;

        // Continue processing if queue has items and we're not paused
        if (this.loadQueue.length > 0 &&
            !this.masonryLoadingPaused &&
            this.videoBrowser.loadingVideos.size < maxConcurrentForMasonry) {

            // Longer delay between batches for masonry stability
            setTimeout(() => {
                if (!this.masonryLoadingPaused) {
                    this.processMasonryLoadQueue();
                }
            }, 400);
        }
    }

    async processLoadQueue() {
        if (this.isProcessingQueue) return;

        // Skip processing if masonry loading is paused
        if (this.videoBrowser.layoutManager.layoutMode === 'masonry-vertical' && this.masonryLoadingPaused) {
            return;
        }

        this.isProcessingQueue = true;

        let processed = 0;
        const batchSize = this.videoBrowser.layoutManager.layoutMode === 'masonry-vertical' ? 2 : 5; // Smaller batches for masonry

        while (this.loadQueue.length > 0 &&
               this.videoBrowser.loadingVideos.size < this.maxConcurrentLoading &&
               processed < batchSize) {

            const videoItem = this.loadQueue.shift();

            if (videoItem.dataset.loaded === 'false') {
                const rect = videoItem.getBoundingClientRect();
                const inExtendedViewport = rect.bottom >= -600 && rect.top <= window.innerHeight + 600;

                if (inExtendedViewport || this.videoBrowser.visibleVideos.has(videoItem)) {
                    try {
                        await this.videoBrowser.loadVideoContent(videoItem);
                        processed++;

                        // For masonry, add a small delay between loads to prevent cascade
                        if (this.videoBrowser.layoutManager.layoutMode === 'masonry-vertical' && processed < batchSize) {
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                    } catch (error) {
                        console.warn('Failed to load video:', error);
                    }
                } else {
                    console.log(`Skipping load for ${videoItem.dataset.filename} - out of viewport`);
                }
            }
        }

        this.isProcessingQueue = false;

        // Continue processing with a delay for masonry mode
        if (this.loadQueue.length > 0 && this.videoBrowser.loadingVideos.size < this.maxConcurrentLoading) {
            const delay = this.videoBrowser.layoutManager.layoutMode === 'masonry-vertical' ? 300 : 100;
            setTimeout(() => this.processLoadQueue(), delay);
        }
    }

    aggressiveCleanup() {
        console.log(`Starting aggressive cleanup. Currently loaded: ${this.videoBrowser.loadedVideos.size}`);

        const candidatesForUnload = [];
        this.videoBrowser.loadedVideos.forEach((timestamp, videoItem) => {
            if (!this.videoBrowser.visibleVideos.has(videoItem)) {
                const rect = videoItem.getBoundingClientRect();
                const distance = Math.min(
                    Math.abs(rect.bottom),
                    Math.abs(rect.top - window.innerHeight)
                );
                candidatesForUnload.push({ videoItem, distance, timestamp });
            }
        });

        candidatesForUnload
            .sort((a, b) => b.distance - a.distance)
            .forEach(({ videoItem }) => {
                if (this.videoBrowser.loadedVideos.size > this.maxLoadedVideos * 0.7) {
                    this.videoBrowser.unloadVideoContent(videoItem);
                }
            });

        console.log(`Aggressive cleanup complete. Now loaded: ${this.videoBrowser.loadedVideos.size}`);
    }

    emergencyCleanup() {
        console.log('EMERGENCY CLEANUP - High memory usage detected');

        this.videoBrowser.pauseAllVideos();

        const toUnload = [];
        this.videoBrowser.loadedVideos.forEach((timestamp, videoItem) => {
            if (!this.videoBrowser.visibleVideos.has(videoItem)) {
                toUnload.push(videoItem);
            }
        });

        toUnload.forEach(videoItem => {
            this.videoBrowser.unloadVideoContent(videoItem);
        });

        console.log(`Emergency cleanup complete. Unloaded ${toUnload.length} videos`);
    }
}

window.PerformanceManager = PerformanceManager;
