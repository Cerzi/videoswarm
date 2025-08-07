class PerformanceManager {
    constructor(videoBrowser) {
        this.videoBrowser = videoBrowser;
        this.maxConcurrentLoading = 6;
        this.maxLoadedVideos = 80;
        this.unloadDistance = 800;
        this.loadQueue = [];
        this.isProcessingQueue = false;

        // Enhanced viewport tracking
        this.viewportItems = new Set();
        this.nearViewportItems = new Set();
        this.lastViewportUpdate = 0;
        this.viewportUpdateThrottle = 100; // ms

        // Masonry-specific optimizations
        this.masonryLoadingPaused = false;
        this.masonryScrollTimeout = null;
        this.lastScrollPosition = 0;
        this.scrollDirection = 'down';
        this.isScrollbarDragging = false; // Track scrollbar usage

        // Performance monitoring
        this.frameDrops = 0;
        this.lastFrameTime = performance.now();

        this.startPerformanceMonitoring();
        this.setupOptimizedScrollHandling();
        this.startViewportTracking();

        // Initial debug info update
        setTimeout(() => {
            if (this.videoBrowser.uiManager) {
                this.videoBrowser.uiManager.updateDebugInfo();
            }
        }, 100);
    }

    startPerformanceMonitoring() {
        setInterval(() => {
            // Memory monitoring (existing logic)
            if (performance.memory) {
                const memoryRatio = performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit;

                if (!this.videoBrowser.userSetVideoLimit) {
                    if (memoryRatio > 0.7) {
                        this.videoBrowser.maxConcurrentPlaying = Math.max(5, this.videoBrowser.maxConcurrentPlaying - 5);
                        this.maxLoadedVideos = Math.max(20, this.maxLoadedVideos - 15);
                        this.emergencyCleanup();
                    } else if (memoryRatio > 0.5) {
                        this.videoBrowser.maxConcurrentPlaying = Math.max(10, this.videoBrowser.maxConcurrentPlaying - 2);
                        this.maxLoadedVideos = Math.max(40, this.maxLoadedVideos - 5);
                        this.smartCleanup();
                    } else if (memoryRatio < 0.3) {
                        this.videoBrowser.maxConcurrentPlaying = Math.min(30, this.videoBrowser.maxConcurrentPlaying + 1);
                        this.maxLoadedVideos = Math.min(80, this.maxLoadedVideos + 2);
                    }
                } else {
                    if (memoryRatio > 0.7) {
                        this.maxLoadedVideos = Math.max(20, this.maxLoadedVideos - 15);
                        this.emergencyCleanup();
                    } else if (memoryRatio > 0.5) {
                        this.maxLoadedVideos = Math.max(40, this.maxLoadedVideos - 5);
                        this.smartCleanup();
                    }
                }
            }

            // Frame rate monitoring
            this.monitorFrameRate();

            // Update debug info in status bar
            if (this.videoBrowser.uiManager) {
                this.videoBrowser.uiManager.updateDebugInfo();
            }
        }, 2000);

        // Periodic smart cleanup to keep only nearby items loaded
        setInterval(() => {
            if (!this.isProcessingQueue) {
                this.maintainOptimalLoadedItems();
            }
        }, 5000);
    }

    setupOptimizedScrollHandling() {
        let ticking = false;
        let scrollEndTimeout = null;

        window.addEventListener('scroll', (e) => {
            const currentScroll = window.scrollY;
            this.scrollDirection = currentScroll > this.lastScrollPosition ? 'down' : 'up';
            this.lastScrollPosition = currentScroll;

            // SCROLLBAR FIX: Detect if scrolling via scrollbar vs wheel/key
            const isScrollbarDrag = e.isTrusted && !e.detail && !e.deltaY;

            if (isScrollbarDrag) {
                // SCROLLBAR DRAG: Use more aggressive throttling to prevent layout breaks
                clearTimeout(scrollEndTimeout);
                scrollEndTimeout = setTimeout(() => {
                    if (!ticking) {
                        requestAnimationFrame(() => {
                            this.handleOptimizedScroll();
                            ticking = false;
                        });
                        ticking = true;
                    }
                }, 100); // Longer delay for scrollbar
            } else {
                // NORMAL SCROLL: Regular handling
                if (!ticking) {
                    requestAnimationFrame(() => {
                        this.handleOptimizedScroll();
                        ticking = false;
                    });
                    ticking = true;
                }
            }
        }, { passive: true });
    }

    handleOptimizedScroll() {
        const now = performance.now();
        if (now - this.lastViewportUpdate < this.viewportUpdateThrottle) {
            return;
        }
        this.lastViewportUpdate = now;

        // Update viewport items efficiently
        this.updateViewportItems();

        // Handle masonry scroll if needed - with enhanced stability
        if (this.videoBrowser.layoutManager.layoutMode === 'masonry-vertical') {
            clearTimeout(this.masonryScrollTimeout);

            // SCROLLBAR FIX: Longer delay to prevent rapid layout changes during scrollbar drag
            const delay = this.isScrollbarDragging ? 300 : 150;

            this.masonryScrollTimeout = setTimeout(() => {
                if (!this.isProcessingQueue &&
                    !this.videoBrowser.layoutManager.isLayouting &&
                    !this.isScrollbarDragging) {
                    this.processLoadQueue();
                }
            }, delay);
        }
    }

    startViewportTracking() {
        // Use IntersectionObserver for efficient viewport detection
        this.viewportObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const videoItem = entry.target;

                if (entry.isIntersecting) {
                    this.viewportItems.add(videoItem);
                    this.nearViewportItems.add(videoItem);

                    // Add to load queue if not loaded
                    if (videoItem.dataset.loaded === 'false' && !this.loadQueue.includes(videoItem)) {
                        this.loadQueue.push(videoItem);
                    }
                } else {
                    this.viewportItems.delete(videoItem);
                    // Keep in nearViewportItems for a bit longer
                }
            });

            // Process load queue if items were added
            if (!this.isProcessingQueue && this.loadQueue.length > 0) {
                this.processLoadQueue();
            }
        }, {
            root: null,
            // INITIAL LOAD FIX: Always load content in and around viewport
            rootMargin: '400px 0px 800px 0px',
            threshold: [0, 0.1]
        });

        // Extended observer for cleanup decisions
        this.cleanupObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const videoItem = entry.target;

                if (!entry.isIntersecting) {
                    // Remove from near viewport after delay
                    setTimeout(() => {
                        this.nearViewportItems.delete(videoItem);
                    }, 1000);
                }
            });
        }, {
            root: null,
            rootMargin: '-1000px',
            threshold: 0
        });

        // Observe all videos
        this.videoBrowser.videos.forEach(videoItem => {
            this.viewportObserver.observe(videoItem);
            this.cleanupObserver.observe(videoItem);
        });

        // INITIAL LOAD FIX: Trigger initial viewport check multiple times with different delays
        // This ensures loading works regardless of when DOM settles
        setTimeout(() => this.forceInitialLoad(), 50);
        setTimeout(() => this.forceInitialLoad(), 200);
        setTimeout(() => this.forceInitialLoad(), 500);

        // Also trigger on next animation frame
        requestAnimationFrame(() => {
            requestAnimationFrame(() => this.forceInitialLoad());
        });
    }

    forceInitialLoad() {
        console.log('Forcing initial load check...');

        // Force viewport detection
        this.updateViewportItems();

        // Also manually check first screen of items
        const viewportHeight = window.innerHeight;
        const buffer = 200;

        this.videoBrowser.videos.forEach(videoItem => {
            const rect = videoItem.getBoundingClientRect();

            // If item is in initial viewport area
            if (rect.top < viewportHeight + buffer && rect.bottom > -buffer) {
                this.viewportItems.add(videoItem);
                this.nearViewportItems.add(videoItem);

                // Add to load queue if not loaded and not already queued
                if (videoItem.dataset.loaded === 'false' && !this.loadQueue.includes(videoItem)) {
                    this.loadQueue.push(videoItem);
                    console.log(`Added to initial load queue: ${videoItem.dataset.filename}`);
                }
            }
        });

        // Force process the queue
        if (this.loadQueue.length > 0 && !this.isProcessingQueue) {
            console.log(`Processing initial load queue: ${this.loadQueue.length} items`);
            this.processLoadQueue();
        }
    }

    updateViewportItems() {
        // Fallback viewport detection (more efficient than before)
        const viewportTop = window.scrollY;
        const viewportBottom = viewportTop + window.innerHeight;
        const preloadBuffer = 400;
        const nearBuffer = 800;

        let viewportCount = 0;
        let nearViewportCount = 0;
        let addedToQueue = 0;

        // Only check items that might have changed status
        this.videoBrowser.videos.forEach(videoItem => {
            // Quick position check using cached layout data when possible
            const rect = videoItem.getBoundingClientRect();
            const elementTop = rect.top + viewportTop;
            const elementBottom = elementTop + rect.height;

            const inViewport = elementBottom >= (viewportTop - preloadBuffer) &&
                              elementTop <= (viewportBottom + preloadBuffer);
            const nearViewport = elementBottom >= (viewportTop - nearBuffer) &&
                                 elementTop <= (viewportBottom + nearBuffer);

            if (inViewport) {
                this.viewportItems.add(videoItem);
                this.nearViewportItems.add(videoItem);
                viewportCount++;
                nearViewportCount++;

                // Add to load queue if not loaded
                if (videoItem.dataset.loaded === 'false' && !this.loadQueue.includes(videoItem)) {
                    this.loadQueue.push(videoItem);
                    addedToQueue++;
                }
            } else if (nearViewport) {
                this.viewportItems.delete(videoItem);
                this.nearViewportItems.add(videoItem);
                nearViewportCount++;

                // Also add near-viewport items to queue for smoother scrolling
                if (videoItem.dataset.loaded === 'false' && !this.loadQueue.includes(videoItem)) {
                    this.loadQueue.push(videoItem);
                    addedToQueue++;
                }
            } else {
                this.viewportItems.delete(videoItem);
                this.nearViewportItems.delete(videoItem);
            }
        });

        console.log(`Viewport update: ${viewportCount} viewport, ${nearViewportCount} near-viewport, ${addedToQueue} added to queue`);

        // If we added items to queue, process it
        if (addedToQueue > 0 && !this.isProcessingQueue) {
            setTimeout(() => this.processLoadQueue(), 100);
        }
    }

    async processLoadQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        let processed = 0;
        const batchSize = 3; // Reduced batch size for smoother performance

        while (this.loadQueue.length > 0 &&
               this.videoBrowser.loadingVideos.size < this.maxConcurrentLoading &&
               processed < batchSize) {

            const videoItem = this.loadQueue.shift();

            // PRIORITY LOADING: Viewport items first, then near-viewport
            const isInViewport = this.viewportItems.has(videoItem);
            const isNearViewport = this.nearViewportItems.has(videoItem);

            if (videoItem.dataset.loaded === 'false' && (isInViewport || isNearViewport)) {
                try {
                    await this.videoBrowser.loadVideoContent(videoItem);
                    processed++;

                    // Smaller delay for viewport items, longer for near-viewport
                    const delay = isInViewport ? 25 : 50;
                    if (processed < batchSize && this.loadQueue.length > 0) {
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }

                    // ANTI-THRASHING: Check if layout is stable after loading
                    if (this.videoBrowser.layoutManager.layoutMode === 'masonry-vertical') {
                        await this.ensureLayoutStability();
                    }
                } catch (error) {
                    console.warn('Failed to load video:', error);
                }
            }
        }

        this.isProcessingQueue = false;

        // Update debug info after processing
        if (this.videoBrowser.uiManager) {
            this.videoBrowser.uiManager.updateDebugInfo();
        }

        // Continue processing if there are more items
        if (this.loadQueue.length > 0 && this.videoBrowser.loadingVideos.size < this.maxConcurrentLoading) {
            setTimeout(() => this.processLoadQueue(), 100);
        }
    }

    async ensureLayoutStability() {
        // Wait for masonry layout to be stable before loading next item
        return new Promise(resolve => {
            if (this.videoBrowser.layoutManager.isLayouting) {
                const checkStability = () => {
                    if (!this.videoBrowser.layoutManager.isLayouting) {
                        resolve();
                    } else {
                        setTimeout(checkStability, 50);
                    }
                };
                checkStability();
            } else {
                resolve();
            }
        });
    }

    maintainOptimalLoadedItems() {
        const maxOptimalLoaded = Math.min(this.maxLoadedVideos, 50); // Cap for performance

        if (this.videoBrowser.loadedVideos.size > maxOptimalLoaded) {
            console.log(`Maintaining optimal loaded items: ${this.videoBrowser.loadedVideos.size} -> ${maxOptimalLoaded}`);
            this.smartCleanup();
        }
    }

    aggressiveCleanup() {
        // Renamed method - keeping old name for compatibility
        this.smartCleanup();
    }
    smartCleanup() {

        const candidatesForUnload = [];

        this.videoBrowser.loadedVideos.forEach((timestamp, videoItem) => {
            // NEVER unload viewport or near-viewport items
            if (this.viewportItems.has(videoItem) || this.nearViewportItems.has(videoItem)) {
                return;
            }

            // Calculate priority for unloading (further = higher priority to unload)
            const rect = videoItem.getBoundingClientRect();
            const distance = Math.min(
                Math.abs(rect.bottom),
                Math.abs(rect.top - window.innerHeight)
            );

            // Factor in how long it's been loaded
            const age = Date.now() - timestamp;
            const priority = distance + (age / 1000); // Distance + seconds loaded

            candidatesForUnload.push({ videoItem, priority, distance });
        });

        // Sort by priority (highest priority = unload first)
        candidatesForUnload.sort((a, b) => b.priority - a.priority);

        // Unload items starting with furthest/oldest
        const targetUnload = Math.min(candidatesForUnload.length,
                                     this.videoBrowser.loadedVideos.size - Math.floor(this.maxLoadedVideos * 0.8));

        for (let i = 0; i < targetUnload; i++) {
            const { videoItem } = candidatesForUnload[i];
            // MASONRY-SAFE: Only unload if not currently playing to avoid layout shifts
            const video = this.videoBrowser.videoElements.get(videoItem);
            if (!video || video.paused) {
                this.videoBrowser.unloadVideoContent(videoItem);
            }
        }

        console.log(`Smart cleanup complete. Unloaded ${targetUnload} items. Now loaded: ${this.videoBrowser.loadedVideos.size}`);
    }

    emergencyCleanup() {
        console.log('EMERGENCY CLEANUP - High memory usage detected');

        // Pause all videos first to prevent layout shifts
        this.videoBrowser.pauseAllVideos();

        const toUnload = [];
        this.videoBrowser.loadedVideos.forEach((timestamp, videoItem) => {
            // Keep only viewport items during emergency
            if (!this.viewportItems.has(videoItem)) {
                toUnload.push(videoItem);
            }
        });

        // Batch unload to reduce layout thrashing
        const batchSize = 5;
        for (let i = 0; i < toUnload.length; i += batchSize) {
            const batch = toUnload.slice(i, i + batchSize);
            batch.forEach(videoItem => {
                this.videoBrowser.unloadVideoContent(videoItem);
            });

            // Small delay between batches to let DOM settle
            if (i + batchSize < toUnload.length) {
                setTimeout(() => {}, 16); // One frame
            }
        }

        console.log(`Emergency cleanup complete. Unloaded ${toUnload.length} videos`);
    }

    monitorFrameRate() {
        const now = performance.now();
        const frameDelta = now - this.lastFrameTime;

        // Detect frame drops (> 20ms = below 50fps)
        if (frameDelta > 20) {
            this.frameDrops++;

            // If we're dropping frames consistently, reduce concurrent operations
            if (this.frameDrops > 10) {
                this.maxConcurrentLoading = Math.max(2, this.maxConcurrentLoading - 1);
                this.viewportUpdateThrottle = Math.min(200, this.viewportUpdateThrottle + 20);
                console.log(`Performance degraded: Reduced concurrent loading to ${this.maxConcurrentLoading}`);
                this.frameDrops = 0; // Reset counter
            }
        } else {
            // Good performance, can increase limits slowly
            if (this.frameDrops === 0 && this.maxConcurrentLoading < 6) {
                this.maxConcurrentLoading = Math.min(6, this.maxConcurrentLoading + 1);
                this.viewportUpdateThrottle = Math.max(50, this.viewportUpdateThrottle - 10);
            }
        }

        this.lastFrameTime = now;
    }

    // PERFORMANCE: Optimized viewport checking
    isNearViewport(videoItem) {
        return this.nearViewportItems.has(videoItem);
    }

    // Legacy method for backward compatibility
    addToMasonryQueue(videoItem, entry) {
        if (this.loadQueue.includes(videoItem)) return;
        this.loadQueue.push(videoItem);

        // Process queue if not already processing
        if (!this.isProcessingQueue) {
            setTimeout(() => this.processLoadQueue(), 50);
        }
    }

    // Legacy method for backward compatibility
    processMasonryLoadQueue() {
        return this.processLoadQueue();
    }
    onVideoAdded(videoItem) {
        if (this.viewportObserver) {
            this.viewportObserver.observe(videoItem);
            this.cleanupObserver.observe(videoItem);
        }
    }

    // Enhanced method for removing videos
    onVideoRemoved(videoItem) {
        if (this.viewportObserver) {
            this.viewportObserver.unobserve(videoItem);
            this.cleanupObserver.unobserve(videoItem);
        }
        this.viewportItems.delete(videoItem);
        this.nearViewportItems.delete(videoItem);

        // Remove from load queue if present
        const queueIndex = this.loadQueue.indexOf(videoItem);
        if (queueIndex > -1) {
            this.loadQueue.splice(queueIndex, 1);
        }
    }

    // Cleanup method
    destroy() {
        if (this.viewportObserver) {
            this.viewportObserver.disconnect();
        }
        if (this.cleanupObserver) {
            this.cleanupObserver.disconnect();
        }
        clearTimeout(this.masonryScrollTimeout);
    }
}

window.PerformanceManager = PerformanceManager;
