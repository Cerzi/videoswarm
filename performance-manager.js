class PerformanceManager {
    constructor(videoBrowser) {
        this.videoBrowser = videoBrowser;
        this.maxConcurrentLoading = 6; // Back to reasonable level

        // Calculate max loaded based on max playing (with buffer for smooth scrolling)
        this.calculateOptimalLimits();
        this.unloadDistance = 800;
        this.loadQueue = [];
        this.isProcessingQueue = false;

        // Enhanced viewport tracking
        this.viewportItems = new Set();
        this.nearViewportItems = new Set();
        this.lastViewportUpdate = 0;
        this.viewportUpdateThrottle = 200; // Increased for stability

        // Prevent mass loading on initialization
        this.isInitialized = false;
        this.initialLoadComplete = false;
        this.estimatedVideoHeight = 250; // Default estimated height

        // Layout stability tracking
        this.layoutStableCount = 0;
        this.lastLayoutHeight = 0;
        this.isLayoutStable = false;
        this.layoutRefreshInProgress = false; // NEW: Track layout refreshes

        // Queue management
        this.maxQueueSize = 25; // Increased
        this.priorityQueue = [];
        this.normalQueue = [];

        // Performance monitoring
        this.frameDrops = 0;
        this.lastFrameTime = performance.now();

        // Setup layout collapse detection
        this.setupLayoutCollapseDetection();

        this.startPerformanceMonitoring();
        this.setupOptimizedScrollHandling();

        // Wait for layout to stabilize before starting viewport tracking
        this.waitForLayoutStability().then(() => {
            this.startViewportTracking();
        });
    }

    setupLayoutCollapseDetection() {
        let lastHeight = 0;
        let lastScrollY = 0;

        setInterval(() => {
            const currentHeight = document.documentElement.scrollHeight;
            const currentScrollY = window.scrollY;

            const heightDrop = lastHeight - currentHeight;
            const scrollJump = Math.abs(currentScrollY - lastScrollY);

            // Detect layout collapse: big height drop or sudden scroll jump to 0
            if ((heightDrop > window.innerHeight * 2) ||
                (currentScrollY === 0 && lastScrollY > 1000 && scrollJump > 1000)) {

                console.error(`LAYOUT COLLAPSE DETECTED: Height -${heightDrop}px, Scroll jumped ${scrollJump}px`);
                this.handleLayoutCollapse();
            }

            lastHeight = currentHeight;
            lastScrollY = currentScrollY;
        }, 200);
    }

    handleLayoutCollapse() {
        console.log('Handling layout collapse - entering recovery mode');

        this.layoutRefreshInProgress = true;
        this.isLayoutStable = false;
        this.initialLoadComplete = false;

        // Clear all queues immediately
        this.clearQueues();

        // Pause all videos to prevent further layout thrashing
        if (this.videoBrowser.pauseAllVideos) {
            this.videoBrowser.pauseAllVideos();
        }

        // Wait longer before considering layout stable again
        setTimeout(() => {
            this.layoutRefreshInProgress = false;
            this.waitForLayoutStability().then(() => {
                console.log('Layout collapse recovery complete');
                this.performInitialLoad();
            });
        }, 1000);
    }

    calculateOptimalLimits() {
        const maxPlaying = this.videoBrowser.maxConcurrentPlaying || 30;

        // Load 3-4x more than can play for smooth scrolling
        this.maxLoadedVideos = Math.max(60, maxPlaying * 3.5);

        // Ensure loading capacity supports the loaded limit
        this.maxConcurrentLoading = Math.min(8, Math.max(4, Math.floor(maxPlaying / 5)));

        console.log(`Calculated limits: ${this.maxLoadedVideos} loaded, ${this.maxConcurrentLoading} concurrent loading for ${maxPlaying} max playing`);
    }

    // Call this when max playing changes
    updateLimitsForPlayingCount(newMaxPlaying) {
        this.videoBrowser.maxConcurrentPlaying = newMaxPlaying;
        this.calculateOptimalLimits();

        // Clean up if we're now over the new limit
        if (this.videoBrowser.loadedVideos.size > this.maxLoadedVideos) {
            this.smartCleanup();
        }
    }

    async waitForLayoutStability() {
        return new Promise(resolve => {
            const checkStability = () => {
                const currentHeight = document.documentElement.scrollHeight;

                if (Math.abs(currentHeight - this.lastLayoutHeight) < 50) {
                    this.layoutStableCount++;
                } else {
                    this.layoutStableCount = 0;
                }

                this.lastLayoutHeight = currentHeight;

                // Consider layout stable after 3 consecutive stable checks
                if (this.layoutStableCount >= 3) {
                    this.isLayoutStable = true;
                    console.log('Layout stability achieved, enabling viewport tracking');
                    resolve();
                } else {
                    setTimeout(checkStability, 100);
                }
            };

            // Start checking after a brief delay
            setTimeout(checkStability, 200);
        });
    }

    startViewportTracking() {
        // Conservative IntersectionObserver setup
        this.viewportObserver = new IntersectionObserver((entries) => {
            if (!this.isLayoutStable) return;

            entries.forEach(entry => {
                const videoItem = entry.target;

                if (entry.isIntersecting) {
                    this.viewportItems.add(videoItem);
                    this.nearViewportItems.add(videoItem);

                    // Only queue if we have real dimensions and queue isn't full
                    if (this.shouldQueueVideo(videoItem)) {
                        this.addToQueue(videoItem, 'priority');
                    }
                } else {
                    this.viewportItems.delete(videoItem);
                }
            });

            this.processQueues();
        }, {
            root: null,
            rootMargin: '50px 0px 100px 0px', // Much smaller margins
            threshold: [0, 0.1]
        });

        // Extended observer for cleanup
        this.cleanupObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) {
                    const videoItem = entry.target;
                    setTimeout(() => {
                        this.nearViewportItems.delete(videoItem);
                    }, 2000);
                }
            });
        }, {
            root: null,
            rootMargin: '-200px',
            threshold: 0
        });

        // Observe all videos
        this.videoBrowser.videos.forEach(videoItem => {
            this.viewportObserver.observe(videoItem);
            this.cleanupObserver.observe(videoItem);
        });

        // Conservative initial load
        this.performInitialLoad();
    }

    shouldQueueVideo(videoItem) {
        // Don't queue if already loaded or loading
        if (videoItem.dataset.loaded !== 'false' ||
            this.videoBrowser.loadingVideos.has(videoItem)) {
            return false;
        }

        // LAYOUT COLLAPSE PROTECTION: Don't queue during layout refresh
        if (this.layoutRefreshInProgress || !this.isLayoutStable) {
            return false;
        }

        // Don't queue if already in any queue
        if (this.priorityQueue.includes(videoItem) ||
            this.normalQueue.includes(videoItem) ||
            this.loadQueue.includes(videoItem)) {
            return false;
        }

        // Check if video has reasonable dimensions
        const rect = videoItem.getBoundingClientRect();
        const hasRealDimensions = rect.height > 10 && rect.width > 10;

        // COLLAPSED VIDEO PROTECTION: Don't queue collapsed videos during instability
        if (!hasRealDimensions && (!this.isLayoutStable || this.layoutRefreshInProgress)) {
            return false;
        }

        // Don't exceed queue limits
        const totalQueued = this.priorityQueue.length + this.normalQueue.length + this.loadQueue.length;
        if (totalQueued >= this.maxQueueSize) {
            return false;
        }

        return true;
    }

    addToQueue(videoItem, priority = 'normal') {
        if (priority === 'priority') {
            this.priorityQueue.push(videoItem);
        } else {
            this.normalQueue.push(videoItem);
        }

        // Merge queues into main load queue, priority first
        this.loadQueue = [...this.priorityQueue, ...this.normalQueue];

        // Trim if too long
        if (this.loadQueue.length > this.maxQueueSize) {
            this.loadQueue = this.loadQueue.slice(0, this.maxQueueSize);
            this.priorityQueue = this.priorityQueue.slice(0, Math.min(this.priorityQueue.length, 8));
            this.normalQueue = this.normalQueue.slice(0, this.maxQueueSize - this.priorityQueue.length);
        }
    }

    performInitialLoad() {
        if (this.initialLoadComplete) return;

        console.log('Performing initial load...');

        // Calculate how many videos fit in viewport
        const viewportHeight = window.innerHeight;
        const estimatedVideosPerRow = Math.floor(window.innerWidth / 200); // Assume ~200px wide videos
        const estimatedRowsInViewport = Math.ceil(viewportHeight / this.estimatedVideoHeight);
        const estimatedViewportCapacity = estimatedVideosPerRow * estimatedRowsInViewport;

        // Load 2x viewport capacity for initial load
        const maxInitialLoad = Math.min(20, estimatedViewportCapacity * 2);

        console.log(`Estimated viewport capacity: ${estimatedViewportCapacity}, loading: ${maxInitialLoad}`);

        const viewportTop = window.scrollY;
        const viewportBottom = viewportTop + viewportHeight;

        let loadedCount = 0;

        // Get videos sorted by position
        const sortedVideos = Array.from(this.videoBrowser.videos).sort((a, b) => {
            const rectA = a.getBoundingClientRect();
            const rectB = b.getBoundingClientRect();
            return (rectA.top + window.scrollY) - (rectB.top + window.scrollY);
        });

        for (const videoItem of sortedVideos) {
            if (loadedCount >= maxInitialLoad) break;

            const rect = videoItem.getBoundingClientRect();
            const absoluteTop = rect.top + window.scrollY;

            // More generous initial loading - include items just below viewport
            const inExtendedViewport = absoluteTop <= viewportBottom + viewportHeight;
            const hasRealDimensions = rect.height > 10;

            if (inExtendedViewport && this.shouldQueueVideo(videoItem)) {
                this.addToQueue(videoItem, 'priority');
                loadedCount++;
                console.log(`Initial load queued: ${videoItem.dataset.filename}`);
            }
        }

        this.initialLoadComplete = true;
        this.processQueues();
    }

    async processQueues() {
        if (this.isProcessingQueue || !this.isLayoutStable) return;

        // Don't process if we're at loaded limit
        if (this.videoBrowser.loadedVideos.size >= this.maxLoadedVideos) {
            console.log('At loaded limit, cleaning up before processing queue');
            this.smartCleanup();
            return;
        }

        this.isProcessingQueue = true;

        let processed = 0;
        const maxBatchSize = 4; // Increased batch size

        while (this.loadQueue.length > 0 &&
               this.videoBrowser.loadingVideos.size < this.maxConcurrentLoading &&
               this.videoBrowser.loadedVideos.size < this.maxLoadedVideos &&
               processed < maxBatchSize) {

            const videoItem = this.loadQueue.shift();

            // Remove from priority/normal queues too
            this.priorityQueue = this.priorityQueue.filter(v => v !== videoItem);
            this.normalQueue = this.normalQueue.filter(v => v !== videoItem);

            // Double-check the video should still be loaded
            if (!this.shouldLoadVideo(videoItem)) {
                continue;
            }

            try {
                await this.videoBrowser.loadVideoContent(videoItem);
                processed++;

                // Update estimated height based on loaded videos
                this.updateEstimatedHeight(videoItem);

                // Shorter delay between loads
                if (processed < maxBatchSize && this.loadQueue.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }

                // Wait for layout stability after masonry loads
                if (this.videoBrowser.layoutManager.layoutMode === 'masonry-vertical') {
                    await this.waitForMasonryStability();
                }

            } catch (error) {
                console.warn('Failed to load video:', error);
            }
        }

        this.isProcessingQueue = false;

        // Update debug info
        if (this.videoBrowser.uiManager) {
            this.videoBrowser.uiManager.updateDebugInfo();
        }

        // Schedule next processing if needed
        if (this.loadQueue.length > 0 &&
            this.videoBrowser.loadedVideos.size < this.maxLoadedVideos) {
            setTimeout(() => this.processQueues(), 200);
        }
    }

    shouldLoadVideo(videoItem) {
        // Final check before loading
        if (videoItem.dataset.loaded !== 'false') return false;
        if (this.videoBrowser.loadingVideos.has(videoItem)) return false;

        // Check if still relevant (in or near viewport)
        const rect = videoItem.getBoundingClientRect();
        const viewportTop = window.scrollY;
        const viewportBottom = viewportTop + window.innerHeight;
        const buffer = 300;

        const isRelevant = (rect.top + window.scrollY) <= (viewportBottom + buffer) &&
                          (rect.bottom + window.scrollY) >= (viewportTop - buffer);

        return isRelevant;
    }

    updateEstimatedHeight(videoItem) {
        const rect = videoItem.getBoundingClientRect();
        if (rect.height > 10) {
            // Running average of video heights
            this.estimatedVideoHeight = (this.estimatedVideoHeight * 0.8) + (rect.height * 0.2);
        }
    }

    async waitForMasonryStability() {
        return new Promise(resolve => {
            let checks = 0;
            const maxChecks = 10;

            const checkStability = () => {
                checks++;

                if (!this.videoBrowser.layoutManager.isLayouting || checks >= maxChecks) {
                    resolve();
                } else {
                    setTimeout(checkStability, 50);
                }
            };

            checkStability();
        });
    }

    setupOptimizedScrollHandling() {
        let scrollTimeout = null;

        window.addEventListener('scroll', () => {
            // Clear existing timeout
            clearTimeout(scrollTimeout);

            // Debounce scroll handling
            scrollTimeout = setTimeout(() => {
                if (this.isLayoutStable) {
                    this.handleScroll();
                }
            }, 150); // Longer debounce for stability

        }, { passive: true });
    }

    handleScroll() {
        const now = performance.now();
        if (now - this.lastViewportUpdate < this.viewportUpdateThrottle) {
            return;
        }
        this.lastViewportUpdate = now;

        // Manual viewport check as fallback
        this.updateViewportItemsManually();

        // Process queue if items were added
        if (!this.isProcessingQueue && this.loadQueue.length > 0) {
            setTimeout(() => this.processQueues(), 100);
        }
    }

    updateViewportItemsManually() {
        const viewportTop = window.scrollY;
        const viewportBottom = viewportTop + window.innerHeight;
        const buffer = 400; // Increased buffer

        let addedToQueue = 0;
        const maxQueueAdditions = 8; // Increased

        this.videoBrowser.videos.forEach(videoItem => {
            if (addedToQueue >= maxQueueAdditions) return;

            const rect = videoItem.getBoundingClientRect();
            const absoluteTop = rect.top + window.scrollY;
            const height = rect.height > 10 ? rect.height : this.estimatedVideoHeight;
            const absoluteBottom = absoluteTop + height;

            const inViewport = absoluteBottom >= (viewportTop - buffer) &&
                              absoluteTop <= (viewportBottom + buffer);

            if (inViewport) {
                this.viewportItems.add(videoItem);
                this.nearViewportItems.add(videoItem);

                if (this.shouldQueueVideo(videoItem)) {
                    this.addToQueue(videoItem, 'normal');
                    addedToQueue++;
                }
            } else {
                this.viewportItems.delete(videoItem);
                this.nearViewportItems.delete(videoItem);
            }
        });
    }

    // Enhanced cleanup with better prioritization
    smartCleanup() {
        const candidates = [];

        this.videoBrowser.loadedVideos.forEach((timestamp, videoItem) => {
            // Never unload viewport items
            if (this.viewportItems.has(videoItem) || this.nearViewportItems.has(videoItem)) {
                return;
            }

            const rect = videoItem.getBoundingClientRect();
            const distance = Math.abs(rect.top + rect.height/2 - window.innerHeight/2);
            const age = Date.now() - timestamp;

            candidates.push({
                videoItem,
                priority: distance + (age / 1000)
            });
        });

        // Sort by priority (highest = unload first)
        candidates.sort((a, b) => b.priority - a.priority);

        // Unload excess items
        const targetUnload = Math.max(0, this.videoBrowser.loadedVideos.size - this.maxLoadedVideos);

        for (let i = 0; i < Math.min(targetUnload + 5, candidates.length); i++) {
            const { videoItem } = candidates[i];
            this.videoBrowser.unloadVideoContent(videoItem);
        }

        console.log(`Smart cleanup: unloaded ${Math.min(targetUnload + 5, candidates.length)} videos`);
    }

    // Clear queues when layout collapses
    clearQueues() {
        console.log('Clearing all queues due to layout instability');
        this.loadQueue = [];
        this.priorityQueue = [];
        this.normalQueue = [];
        this.isLayoutStable = false;
        this.initialLoadComplete = false;

        // Restart stability detection
        this.waitForLayoutStability().then(() => {
            this.performInitialLoad();
        });
    }

    startPerformanceMonitoring() {
        setInterval(() => {
            // Memory monitoring with dynamic limits based on max playing
            if (performance.memory) {
                const memoryRatio = performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit;
                const baseMaxLoaded = this.videoBrowser.maxConcurrentPlaying * 3.5;

                if (memoryRatio > 0.7) {
                    this.maxLoadedVideos = Math.max(baseMaxLoaded * 0.5, this.maxLoadedVideos - 20);
                    this.maxConcurrentLoading = Math.max(2, this.maxConcurrentLoading - 1);
                    this.emergencyCleanup();
                } else if (memoryRatio > 0.5) {
                    this.maxLoadedVideos = Math.max(baseMaxLoaded * 0.7, this.maxLoadedVideos - 10);
                    this.smartCleanup();
                } else if (memoryRatio < 0.3) {
                    this.maxLoadedVideos = Math.min(baseMaxLoaded, this.maxLoadedVideos + 5);
                    this.maxConcurrentLoading = Math.min(8, this.maxConcurrentLoading + 1);
                }
            }

            this.enforcePlayingLimit();
            this.enforceLoadedLimit();

            if (this.videoBrowser.uiManager) {
                this.videoBrowser.uiManager.updateDebugInfo();
            }
        }, 3000);

        // Less frequent cleanup
        setInterval(() => {
            if (!this.isProcessingQueue && this.isLayoutStable) {
                this.maintainOptimalLoadedItems();
            }
        }, 10000);
    }

    enforcePlayingLimit() {
        const excess = this.videoBrowser.playingVideos.size - this.videoBrowser.maxConcurrentPlaying;
        if (excess > 0) {
            this.videoBrowser.pauseExcessVideos();
        }
    }

    enforceLoadedLimit() {
        if (this.videoBrowser.loadedVideos.size > this.maxLoadedVideos) {
            this.smartCleanup();
        }
    }

    maintainOptimalLoadedItems() {
        if (this.videoBrowser.loadedVideos.size > this.maxLoadedVideos) {
            this.smartCleanup();
        }
    }

    emergencyCleanup() {
        console.log('EMERGENCY CLEANUP');

        // Clear all queues
        this.clearQueues();

        // Pause all videos
        this.videoBrowser.pauseAllVideos();

        // Unload everything except viewport
        const toUnload = [];
        this.videoBrowser.loadedVideos.forEach((timestamp, videoItem) => {
            if (!this.viewportItems.has(videoItem)) {
                toUnload.push(videoItem);
            }
        });

        toUnload.forEach(videoItem => {
            this.videoBrowser.unloadVideoContent(videoItem);
        });

        console.log(`Emergency cleanup: unloaded ${toUnload.length} videos`);
    }

    onVideoAdded(videoItem) {
        if (this.viewportObserver && this.isLayoutStable) {
            this.viewportObserver.observe(videoItem);
            this.cleanupObserver.observe(videoItem);
        }
    }

    onVideoRemoved(videoItem) {
        if (this.viewportObserver) {
            this.viewportObserver.unobserve(videoItem);
            this.cleanupObserver.unobserve(videoItem);
        }

        this.viewportItems.delete(videoItem);
        this.nearViewportItems.delete(videoItem);

        // Remove from all queues
        this.loadQueue = this.loadQueue.filter(v => v !== videoItem);
        this.priorityQueue = this.priorityQueue.filter(v => v !== videoItem);
        this.normalQueue = this.normalQueue.filter(v => v !== videoItem);
    }

    emergencyCleanup() {
        console.log('EMERGENCY CLEANUP');

        // Clear all queues
        this.clearQueues();

        // Pause all videos
        this.videoBrowser.pauseAllVideos();

        // Unload everything except viewport
        const toUnload = [];
        this.videoBrowser.loadedVideos.forEach((timestamp, videoItem) => {
            if (!this.viewportItems.has(videoItem)) {
                toUnload.push(videoItem);
            }
        });

        toUnload.forEach(videoItem => {
            this.videoBrowser.unloadVideoContent(videoItem);
        });

        console.log(`Emergency cleanup: unloaded ${toUnload.length} videos`);
    }

    destroy() {
        if (this.viewportObserver) {
            this.viewportObserver.disconnect();
        }
        if (this.cleanupObserver) {
            this.cleanupObserver.disconnect();
        }
    }
}

window.PerformanceManager = PerformanceManager;
