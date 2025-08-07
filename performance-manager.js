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
            // Simple scroll handling for all modes
            if (this.videoBrowser.layoutManager.layoutMode === 'masonry-vertical') {
                this.handleMasonryScroll();
            }

            let scrollTimeout;
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                this.checkMasonryStability();
            }, 500);
        });
    }

    handleMasonryScroll() {
        // Simplified scroll handling - just add a small delay
        clearTimeout(this.masonryScrollTimeout);
        this.masonryScrollTimeout = setTimeout(() => {
            if (this.loadQueue.length > 0 && !this.isProcessingQueue) {
                this.processLoadQueue();
            }
        }, 150);
    }

    checkMasonryStability() {
        // Simplified stability check
        if (this.loadQueue.length > 0 && !this.isProcessingQueue) {
            this.processLoadQueue();
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

        if (!this.isProcessingQueue && this.loadQueue.length > 0) {
            this.processLoadQueue();
        }
    }

    addToMasonryQueue(videoItem, entry) {
        if (this.loadQueue.includes(videoItem)) return;
        this.loadQueue.push(videoItem);
    }

    async processMasonryLoadQueue() {
        // Use the same logic as regular processLoadQueue
        return this.processLoadQueue();
    }

    async processLoadQueue() {
        if (this.isProcessingQueue) return;

        this.isProcessingQueue = true;

        let processed = 0;
        const batchSize = 5;

        while (this.loadQueue.length > 0 &&
               this.videoBrowser.loadingVideos.size < this.maxConcurrentLoading &&
               processed < batchSize) {

            const videoItem = this.loadQueue.shift();

            if (videoItem.dataset.loaded === 'false') {
                // Simple check - if it's in visibleVideos or near viewport, load it
                if (this.videoBrowser.visibleVideos.has(videoItem) || this.isNearViewport(videoItem)) {
                    try {
                        await this.videoBrowser.loadVideoContent(videoItem);
                        processed++;

                        // Small delay between loads
                        if (processed < batchSize && this.loadQueue.length > 0) {
                            await new Promise(resolve => setTimeout(resolve, 50));
                        }
                    } catch (error) {
                        console.warn('Failed to load video:', error);
                    }
                }
            }
        }

        this.isProcessingQueue = false;

        // Continue processing if there are more items
        if (this.loadQueue.length > 0 && this.videoBrowser.loadingVideos.size < this.maxConcurrentLoading) {
            setTimeout(() => this.processLoadQueue(), 100);
        }
    }

    isNearViewport(videoItem) {
        const rect = videoItem.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const buffer = 800; // Load items within 800px of viewport
        
        return rect.bottom > -buffer && rect.top < viewportHeight + buffer;
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
