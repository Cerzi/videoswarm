/**
 * Manages performance optimization and resource limits
 * Follows the Single Responsibility Principle by focusing only on performance concerns
 */
export class PerformanceManager {
    constructor(eventBus) {
        this.eventBus = eventBus;
        
        // Performance limits
        this.maxConcurrentPlaying = 30;
        this.maxConcurrentLoading = 6;
        this.maxLoadedVideos = 80;
        this.minConcurrentPlaying = 10;
        this.maxConcurrentPlayingLimit = 100;
        
        // Current metrics
        this.currentMetrics = {
            playing: 0,
            loaded: 0,
            total: 0,
            visible: 0
        };

        this.setupEventListeners();
        this.startPerformanceMonitoring();
    }

    setupEventListeners() {
        this.eventBus.on('performance:metricsUpdate', (metrics) => {
            this.updateMetrics(metrics);
        });

        this.eventBus.on('performance:limitChange', (newLimit) => {
            this.setPlayingLimit(newLimit);
        });

        this.eventBus.on('performance:cleanup', () => {
            this.performCleanup();
        });

        this.eventBus.on('performance:emergencyCleanup', () => {
            this.performEmergencyCleanup();
        });
    }

    updateMetrics(metrics) {
        this.currentMetrics = { ...metrics };
        
        // Update UI with current metrics
        const uiMetrics = {
            ...metrics,
            maxPlaying: this.maxConcurrentPlaying,
            maxLoaded: this.maxLoadedVideos
        };
        
        this.eventBus.emit('ui:updateDebugInfo', uiMetrics);

        // Check if cleanup is needed
        if (metrics.loaded > this.maxLoadedVideos * 1.2) {
            this.eventBus.emit('performance:cleanup');
        }

        // Check if playing videos exceed limit
        if (metrics.playing > this.maxConcurrentPlaying) {
            this.eventBus.emit('playback:limitExceeded');
        }
    }

    setPlayingLimit(newLimit) {
        this.maxConcurrentPlaying = Math.max(
            this.minConcurrentPlaying,
            Math.min(this.maxConcurrentPlayingLimit, newLimit)
        );

        // Update UI
        const limitLabel = document.getElementById('videoLimitLabel');
        if (limitLabel) {
            limitLabel.textContent = this.maxConcurrentPlaying.toString();
        }

        // Emit event for other components
        this.eventBus.emit('performance:limitUpdated', this.maxConcurrentPlaying);
    }

    startPerformanceMonitoring() {
        this.monitoringInterval = setInterval(() => {
            this.checkMemoryUsage();
            this.optimizePerformance();
        }, 2000);
    }

    checkMemoryUsage() {
        if (!performance.memory) return;

        const memoryRatio = performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit;

        if (memoryRatio > 0.7) {
            // High memory usage - reduce limits aggressively
            this.maxConcurrentPlaying = Math.max(5, this.maxConcurrentPlaying - 5);
            this.maxLoadedVideos = Math.max(20, this.maxLoadedVideos - 15);
            this.eventBus.emit('performance:emergencyCleanup');
        } else if (memoryRatio > 0.5) {
            // Moderate memory usage - reduce limits moderately
            this.maxConcurrentPlaying = Math.max(10, this.maxConcurrentPlaying - 2);
            this.maxLoadedVideos = Math.max(40, this.maxLoadedVideos - 5);
            this.eventBus.emit('performance:cleanup');
        } else if (memoryRatio < 0.3) {
            // Low memory usage - can increase limits
            this.maxConcurrentPlaying = Math.min(30, this.maxConcurrentPlaying + 1);
            this.maxLoadedVideos = Math.min(80, this.maxLoadedVideos + 2);
        }
    }

    optimizePerformance() {
        // Check if we need to pause excess videos
        if (this.currentMetrics.playing > this.maxConcurrentPlaying) {
            this.eventBus.emit('playback:pauseExcess', {
                current: this.currentMetrics.playing,
                limit: this.maxConcurrentPlaying
            });
        }
    }

    performCleanup() {
        console.log('Performing performance cleanup');
        this.eventBus.emit('videos:cleanup', {
            maxLoaded: this.maxLoadedVideos,
            aggressive: false
        });
    }

    performEmergencyCleanup() {
        console.log('Performing EMERGENCY cleanup - High memory usage detected');
        this.eventBus.emit('playback:pauseAll');
        this.eventBus.emit('videos:cleanup', {
            maxLoaded: this.maxLoadedVideos * 0.5,
            aggressive: true
        });
    }

    getPerformanceLimits() {
        return {
            maxConcurrentPlaying: this.maxConcurrentPlaying,
            maxConcurrentLoading: this.maxConcurrentLoading,
            maxLoadedVideos: this.maxLoadedVideos
        };
    }

    getCurrentMetrics() {
        return { ...this.currentMetrics };
    }

    cleanup() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
        }
    }
}
