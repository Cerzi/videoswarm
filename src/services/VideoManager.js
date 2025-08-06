import { VideoItem } from '../components/VideoItem.js';
import { VideoLoader } from '../utils/VideoLoader.js';

/**
 * Manages video items and their lifecycle
 * Follows the Single Responsibility Principle by focusing only on video management
 */
export class VideoManager {
    constructor(eventBus) {
        this.eventBus = eventBus;
        this.videos = new Set();
        this.videoElements = new Map();
        this.loadedVideos = new Map();
        this.playingVideos = new Set();
        this.visibleVideos = new Set();
        this.failedVideos = new Map();
        this.aspectRatioCache = new Map();
        
        this.videoLoader = new VideoLoader(eventBus);
        this.setupEventListeners();
        this.setupIntersectionObserver();
    }

    setupEventListeners() {
        this.eventBus.on('video:create', (file) => {
            this.createVideoItem(file);
        });

        this.eventBus.on('videos:clear', () => {
            this.clearAllVideos();
        });

        this.eventBus.on('video:load', (videoItem) => {
            this.videoLoader.loadVideo(videoItem);
        });

        this.eventBus.on('video:play', (video) => {
            this.playVideo(video);
        });

        this.eventBus.on('video:pause', (video) => {
            this.pauseVideo(video);
        });

        this.eventBus.on('playback:toggle', () => {
            this.toggleAllPlayback();
        });

        this.eventBus.on('playback:pauseAll', () => {
            this.pauseAllVideos();
        });

        this.eventBus.on('playback:resumeAll', () => {
            this.resumeAllVideos();
        });
    }

    setupIntersectionObserver() {
        this.intersectionObserver = new IntersectionObserver(
            this.handleIntersection.bind(this),
            {
                rootMargin: '400px',
                threshold: [0, 0.1, 1.0]
            }
        );

        this.unloadObserver = new IntersectionObserver(
            this.handleUnloadIntersection.bind(this),
            {
                rootMargin: '-800px',
                threshold: 0
            }
        );
    }

    createVideoItem(file) {
        const videoItem = new VideoItem(file, this.eventBus);
        const element = videoItem.createElement();
        
        this.videos.add(element);
        this.intersectionObserver.observe(element);
        this.unloadObserver.observe(element);

        // Add to DOM
        const videoGrid = document.getElementById('videoGrid');
        if (videoGrid) {
            videoGrid.appendChild(element);
        }

        // Animate in
        this.animateVideoItemIn(element);

        return element;
    }

    animateVideoItemIn(element) {
        requestAnimationFrame(() => {
            element.style.opacity = '0';
            element.style.transform = 'scale(0.8)';
            requestAnimationFrame(() => {
                element.style.transition = 'all 0.3s ease';
                element.style.opacity = '1';
                element.style.transform = 'scale(1)';
            });
        });
    }

    handleIntersection(entries) {
        entries.forEach(entry => {
            const videoItem = entry.target;

            if (entry.isIntersecting) {
                this.visibleVideos.add(videoItem);
                
                if (videoItem.dataset.loaded === 'false') {
                    this.eventBus.emit('video:load', videoItem);
                }

                const video = this.videoElements.get(videoItem);
                if (video) {
                    this.eventBus.emit('video:play', video);
                }
            } else {
                if (entry.intersectionRatio < 0.01) {
                    this.visibleVideos.delete(videoItem);
                    
                    const video = this.videoElements.get(videoItem);
                    if (video) {
                        this.eventBus.emit('video:pause', video);
                    }
                }
            }
        });

        // Update performance metrics
        this.updatePerformanceMetrics();
    }

    handleUnloadIntersection(entries) {
        entries.forEach(entry => {
            const videoItem = entry.target;

            if (!entry.isIntersecting &&
                !this.visibleVideos.has(videoItem) &&
                videoItem.dataset.loaded === 'true') {
                
                const rect = videoItem.getBoundingClientRect();
                const viewportHeight = window.innerHeight;
                const distanceFromViewport = Math.min(
                    Math.abs(rect.bottom),
                    Math.abs(rect.top - viewportHeight)
                );

                if (distanceFromViewport > viewportHeight * 3) {
                    this.eventBus.emit('video:unload', videoItem);
                }
            }
        });
    }

    playVideo(video) {
        if (video.readyState >= 3) {
            video.play().then(() => {
                this.playingVideos.add(video);
                this.updatePerformanceMetrics();
            }).catch(error => {
                console.debug('Autoplay prevented:', error);
            });
        }
    }

    pauseVideo(video) {
        video.pause();
        this.playingVideos.delete(video);
        this.updatePerformanceMetrics();
    }

    toggleAllPlayback() {
        const isPlaying = this.playingVideos.size > 0;
        
        if (isPlaying) {
            this.pauseAllVideos();
            this.eventBus.emit('ui:updateAutoplayButton', false);
        } else {
            this.resumeAllVideos();
            this.eventBus.emit('ui:updateAutoplayButton', true);
        }
    }

    pauseAllVideos() {
        this.videoElements.forEach((video) => {
            this.pauseVideo(video);
        });
    }

    resumeAllVideos() {
        this.videoElements.forEach((video, videoItem) => {
            if (this.visibleVideos.has(videoItem)) {
                this.playVideo(video);
            }
        });
    }

    updatePerformanceMetrics() {
        const metrics = {
            playing: this.playingVideos.size,
            loaded: this.loadedVideos.size,
            total: this.videos.size,
            visible: this.visibleVideos.size
        };

        this.eventBus.emit('performance:metricsUpdate', metrics);
    }

    clearAllVideos() {
        // Clean up intersection observers
        this.videos.forEach(videoItem => {
            this.intersectionObserver.unobserve(videoItem);
            this.unloadObserver.unobserve(videoItem);
        });

        // Clean up video elements and blob URLs
        this.videoElements.forEach((video, videoItem) => {
            if (video && video.src && video.src.startsWith('blob:')) {
                URL.revokeObjectURL(video.src);
            }
            video.pause();
            video.removeAttribute('src');
            video.load();
            videoItem.remove();
        });

        // Clear all collections
        this.videos.clear();
        this.videoElements.clear();
        this.loadedVideos.clear();
        this.playingVideos.clear();
        this.visibleVideos.clear();
        this.failedVideos.clear();
        this.aspectRatioCache.clear();

        this.updatePerformanceMetrics();
    }

    cleanup() {
        this.clearAllVideos();
        this.intersectionObserver.disconnect();
        this.unloadObserver.disconnect();
    }
}
