/**
 * Handles video loading operations
 * Follows the Single Responsibility Principle by focusing only on video loading
 */
export class VideoLoader {
    constructor(eventBus) {
        this.eventBus = eventBus;
        this.loadingVideos = new Set();
        this.loadQueue = [];
        this.isProcessingQueue = false;
        this.maxConcurrentLoading = 6;
        this.setupEventListeners();
    }

    setupEventListeners() {
        this.eventBus.on('video:load', (videoItem) => {
            this.queueVideoLoad(videoItem);
        });

        this.eventBus.on('video:unload', (videoItem) => {
            this.unloadVideo(videoItem);
        });

        this.eventBus.on('videos:cleanup', (options) => {
            this.performCleanup(options);
        });
    }

    queueVideoLoad(videoItem) {
        if (videoItem.dataset.loaded === 'true' || this.loadQueue.includes(videoItem)) {
            return;
        }

        this.loadQueue.push(videoItem);

        if (!this.isProcessingQueue) {
            this.processLoadQueue();
        }
    }

    async processLoadQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        let processed = 0;
        while (this.loadQueue.length > 0 &&
               this.loadingVideos.size < this.maxConcurrentLoading &&
               processed < 5) {

            const videoItem = this.loadQueue.shift();

            if (videoItem.dataset.loaded === 'false') {
                const rect = videoItem.getBoundingClientRect();
                const inExtendedViewport = rect.bottom >= -600 && rect.top <= window.innerHeight + 600;

                if (inExtendedViewport) {
                    try {
                        await this.loadVideo(videoItem);
                        processed++;
                    } catch (error) {
                        console.warn('Failed to load video:', error);
                    }
                }
            }
        }

        this.isProcessingQueue = false;

        if (this.loadQueue.length > 0 && this.loadingVideos.size < this.maxConcurrentLoading) {
            setTimeout(() => this.processLoadQueue(), 100);
        }
    }

    async loadVideo(videoItem) {
        if (videoItem.dataset.loaded === 'true') return;

        const file = videoItem._file;
        if (!file) return;

        // Quick format check - skip obviously problematic files
        if (this.isLikelyProblematicFile(file)) {
            this.eventBus.emit('video:loadError', {
                videoItem,
                file,
                error: { code: 4, message: 'Likely unsupported format' },
                errorType: 'codec'
            });
            return;
        }

        return new Promise((resolve) => {
            const video = document.createElement('video');
            video.className = 'video-element';
            video.muted = true;
            video.loop = true;
            video.preload = 'metadata';
            video.playsInline = true;
            video.autoplay = false;

            let hasLoaded = false;
            let hasErrored = false;
            let timeoutId;

            const cleanup = () => {
                this.loadingVideos.delete(videoItem);
                if (timeoutId) clearTimeout(timeoutId);
                const placeholder = videoItem.querySelector('.video-placeholder');
                if (placeholder) placeholder.remove();
            };

            const onError = (error) => {
                if (hasErrored) return;
                hasErrored = true;

                console.error(`Video load error for ${file.name}:`, error);
                cleanup();

                videoItem.classList.add('error');
                const errorIndicator = document.createElement('div');
                errorIndicator.className = 'error-indicator';
                errorIndicator.innerHTML = '❌<br>Load Error';
                videoItem.appendChild(errorIndicator);

                this.eventBus.emit('video:loadError', {
                    videoItem,
                    file,
                    error,
                    errorType: 'codec'
                });

                resolve(); // Always resolve to continue processing
            };

            const onSuccess = () => {
                console.log(`Video loaded: ${file.name}, dimensions: ${video.videoWidth}x${video.videoHeight}, aspectRatio: ${aspectRatio}`);

                if (hasLoaded || hasErrored) return;
                hasLoaded = true;

                cleanup();
                videoItem.dataset.loaded = 'true';

                // Cache aspect ratio
                const aspectRatio = video.videoWidth / video.videoHeight;

                // Replace placeholder with video
                const placeholder = videoItem.querySelector('.video-placeholder');
                if (placeholder) {
                    videoItem.replaceChild(video, placeholder);
                } else {
                    videoItem.insertBefore(video, videoItem.querySelector('.video-filename'));
                }

                this.eventBus.emit('video:loadSuccess', {
                    videoItem,
                    video,
                    aspectRatio
                });

                resolve();
            };

            // Set up event listeners
            video.addEventListener('loadedmetadata', onSuccess);
            video.addEventListener('canplay', onSuccess);
            video.addEventListener('error', (e) => onError(e.target.error));

            // Timeout for loading
            timeoutId = setTimeout(() => {
                if (!hasLoaded && !hasErrored) {
                    onError({ code: 4, message: 'Loading timeout' });
                }
            }, 15000);

            try {
                this.loadingVideos.add(videoItem);
                // Use blob URL for local files (no server upload needed)
                video.src = URL.createObjectURL(file);
            } catch (error) {
                onError(error);
            }
        });
    }

    isLikelyProblematicFile(file) {
        // Skip files that are likely to cause issues
        const name = file.name.toLowerCase();

        // Very small files are likely corrupted
        if (file.size < 1000) return true;

        // Files with certain patterns that we've seen fail
        if (name.includes('_preview') && file.size < 100000) return true;

        return false;
    }

    unloadVideo(videoItem) {
        const video = videoItem.querySelector('.video-element');
        if (!video) return;

        console.log(`Unloading video: ${videoItem.dataset.filename}`);

        video.pause();

        // Revoke blob URL to free memory
        if (video.src && video.src.startsWith('blob:')) {
            URL.revokeObjectURL(video.src);
        }

        video.removeAttribute('src');
        video.load();

        this.loadingVideos.delete(videoItem);

        // Remove from load queue if present
        const queueIndex = this.loadQueue.indexOf(videoItem);
        if (queueIndex > -1) {
            this.loadQueue.splice(queueIndex, 1);
        }

        // Replace with placeholder
        const placeholder = document.createElement('div');
        placeholder.className = 'video-placeholder';
        placeholder.textContent = '📼 Scroll to reload...';

        placeholder.addEventListener('click', () => {
            if (videoItem.dataset.loaded === 'false') {
                placeholder.textContent = '📼 Loading...';
                placeholder.style.background = '#2a4a2a';
                this.queueVideoLoad(videoItem);
            }
        });

        const filename = videoItem.querySelector('.video-filename');
        videoItem.innerHTML = '';
        videoItem.appendChild(placeholder);
        if (filename) videoItem.appendChild(filename);

        videoItem.dataset.loaded = 'false';

        this.eventBus.emit('video:unloaded', videoItem);
    }

    performCleanup(options = {}) {
        const { maxLoaded = 80, aggressive = false } = options;

        console.log(`Starting ${aggressive ? 'aggressive' : 'normal'} cleanup`);

        const allVideoItems = document.querySelectorAll('.video-item[data-loaded="true"]');
        const candidatesForUnload = [];

        allVideoItems.forEach(videoItem => {
            const rect = videoItem.getBoundingClientRect();
            const distance = Math.min(
                Math.abs(rect.bottom),
                Math.abs(rect.top - window.innerHeight)
            );
            candidatesForUnload.push({ videoItem, distance });
        });

        // Sort by distance (furthest first)
        candidatesForUnload.sort((a, b) => b.distance - a.distance);

        // Unload videos until we're under the limit
        const targetCount = aggressive ? maxLoaded * 0.5 : maxLoaded;
        let unloadCount = Math.max(0, allVideoItems.length - targetCount);

        candidatesForUnload.slice(0, unloadCount).forEach(({ videoItem }) => {
            this.unloadVideo(videoItem);
        });

        console.log(`Cleanup complete. Unloaded ${unloadCount} videos`);
    }
}
