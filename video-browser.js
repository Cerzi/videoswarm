class VideoBrowser {
    constructor() {
        this.videos = new Set();
        this.selectedVideos = new Set();
        this.videoElements = new Map();
        this.autoplayEnabled = true;
        this.loadingVideos = new Set();
        this.failedVideos = new Map();
        this.filePathMap = new Map();

        // Settings that will be persisted
        this.settings = {
            recursiveMode: false,
            layoutMode: 'grid',
            autoplayEnabled: true,
            maxConcurrentPlaying: 30,
            zoomLevel: 1
        };

        // Performance management
        this.maxConcurrentPlaying = 30;
        this.minConcurrentPlaying = 10;
        this.maxConcurrentPlayingLimit = 100;
        this.visibleVideos = new Set();
        this.playingVideos = new Set();
        this.loadedVideos = new Map();

        // Initialize managers in correct order
        this.layoutManager = new LayoutManager(this);  // CREATE FIRST
        this.performanceManager = new PerformanceManager(this);  // THEN THIS
        this.uiManager = new UIManager(this);

        setTimeout(() => {
            this.forcePlayVisibleVideos();
        }, 2000);

        // START LAYOUT MONITORING
        this.layoutManager.monitorLayoutCollapse();

        this.initializeEventListeners();
        this.loadSettings();
    }

    async loadSettings() {
        if (window.electronAPI?.loadSettings) {
            try {
                const savedSettings = await window.electronAPI.loadSettings();
                this.applySettings(savedSettings);
                console.log('Settings loaded and applied:', savedSettings);
            } catch (error) {
                console.error('Failed to load settings:', error);
            }
        } else {
            // Listen for settings from main process
            if (window.electronAPI?.onSettingsLoaded) {
                window.electronAPI.onSettingsLoaded((settings) => {
                    this.applySettings(settings);
                    console.log('Settings received from main process:', settings);
                });
            }
        }
    }

    applySettings(savedSettings) {
        // Update internal settings
        this.settings = { ...this.settings, ...savedSettings };

        // Apply each setting
        if (savedSettings.recursiveMode !== undefined) {
            this.recursiveMode = savedSettings.recursiveMode;
            this.updateRecursiveButton();
        }

        if (savedSettings.layoutMode !== undefined) {
            this.layoutManager.layoutMode = savedSettings.layoutMode;
            this.layoutManager.updateLayoutButton();
            this.layoutManager.applyLayout();
        }

        if (savedSettings.autoplayEnabled !== undefined) {
            this.autoplayEnabled = savedSettings.autoplayEnabled;
            this.updateAutoplayButton();
        }

        if (savedSettings.maxConcurrentPlaying !== undefined) {
            this.maxConcurrentPlaying = savedSettings.maxConcurrentPlaying;
            this.userSetVideoLimit = this.maxConcurrentPlaying;
            this.updateVideoLimitSlider();
        }

        if (savedSettings.zoomLevel !== undefined) {
            this.updateZoomSlider(savedSettings.zoomLevel);
        }
    }

    async saveSettings() {
        if (!window.electronAPI?.saveSettingsPartial) return;

        const settingsToSave = {
            recursiveMode: this.recursiveMode,
            layoutMode: this.layoutManager.layoutMode,
            autoplayEnabled: this.autoplayEnabled,
            maxConcurrentPlaying: this.maxConcurrentPlaying,
            zoomLevel: parseInt(document.getElementById('zoomSlider')?.value || 1)
        };

        try {
            await window.electronAPI.saveSettingsPartial(settingsToSave);
            this.settings = { ...this.settings, ...settingsToSave };
        } catch (error) {
            console.error('Failed to save settings:', error);
        }
    }

    updateRecursiveButton() {
        const button = document.getElementById('recursiveToggle');
        if (!button) return;

        if (this.recursiveMode) {
            button.classList.add('active');
            button.textContent = '📂 Recursive ON';
        } else {
            button.classList.remove('active');
            button.textContent = '📂 Recursive';
        }

        button.title = this.recursiveMode ?
            'Click to disable recursive folder scanning' :
            'Click to enable recursive folder scanning (includes subfolders)';
    }

    updateAutoplayButton() {
        const button = document.getElementById('autoplayToggle');
        if (!button) return;

        if (this.autoplayEnabled) {
            button.textContent = '⏸️ Pause All';
            button.classList.add('active');
        } else {
            button.textContent = '▶️ Resume All';
            button.classList.remove('active');
        }
    }

    updateVideoLimitSlider() {
        const slider = document.getElementById('videoLimitSlider');
        const label = document.getElementById('videoLimitLabel');
        if (slider) slider.value = this.maxConcurrentPlaying;
        if (label) label.textContent = this.maxConcurrentPlaying.toString();
    }

    updateZoomSlider(zoomLevel) {
        const slider = document.getElementById('zoomSlider');
        if (slider) {
            slider.value = zoomLevel;
            this.layoutManager.setZoom(zoomLevel);
        }
    }

    updateErrorStats() {
        // Count error types
        const errorCounts = {};
        this.failedVideos.forEach((type) => {
            errorCounts[type] = (errorCounts[type] || 0) + 1;
        });

        // Update status if many codec errors
        if (errorCounts.codec >= 3) {
            const status = document.getElementById('status');
            if (status && !status.dataset.codecWarningShown) {
                status.style.display = 'block';
                status.style.background = '#4a0000';
                status.style.color = '#ff6666';
                status.innerHTML = `⚠️ <strong>${errorCounts.codec} videos failed due to unsupported codec (H.265/HEVC)</strong>. These require Safari or video conversion to H.264.`;
                status.dataset.codecWarningShown = 'true';
            }
        }
    }

    setVideoLimit(limit) {
        this.maxConcurrentPlaying = Math.max(this.minConcurrentPlaying,
                                        Math.min(this.maxConcurrentPlayingLimit, limit));
        this.userSetVideoLimit = this.maxConcurrentPlaying;

        // UPDATE PERFORMANCE MANAGER LIMITS
        if (this.performanceManager && this.performanceManager.updateLimitsForPlayingCount) {
            this.performanceManager.updateLimitsForPlayingCount(this.maxConcurrentPlaying);
        }

        this.updateVideoLimitSlider();

        // If we're now over the limit, pause excess videos
        if (this.playingVideos.size > this.maxConcurrentPlaying) {
            this.pauseExcessVideos();
        }

        // Update debug info to reflect new limit
        this.uiManager.updateDebugInfo();

        // Save settings
        this.saveSettings();

        console.log(`Video limit set to: ${this.maxConcurrentPlaying} (user-set: ${this.userSetVideoLimit})`);
    }

    async loadVideoContent(videoItem) {
        if (videoItem.dataset.loaded === 'true') return;

        // Handle both File objects (browser) and file paths (Electron)
        const file = videoItem._file;
        const filePath = videoItem.dataset.fullPath;

        if (!file && !filePath) return;

        return new Promise((resolve, reject) => {
            const video = document.createElement('video');
            video.className = 'video-element';
            video.muted = true;
            video.loop = true;
            video.preload = 'metadata';
            video.playsInline = true;
            video.autoplay = true;

            let hasLoaded = false;
            let hasErrored = false;

            const cleanup = () => {
                this.loadingVideos.delete(videoItem);
                const placeholder = videoItem.querySelector('.video-placeholder');
                if (placeholder) placeholder.remove();
            };

            const fileName = file ? file.name : videoItem.dataset.filename;

            const onError = (error) => {
                if (hasErrored) return;
                hasErrored = true;

                console.error(`Video load error for ${fileName}:`, error);
                cleanup();

                videoItem.classList.add('error');
                const errorIndicator = document.createElement('div');
                errorIndicator.className = 'error-indicator';

                // Provide more helpful error messages
                let errorMessage = '❌<br>';
                let errorType = 'unknown';

                if (error && error.message) {
                    if (error.message.includes('DEMUXER_ERROR_NO_SUPPORTED_STREAMS') ||
                        error.message.includes('no supported streams')) {
                        errorMessage += 'Codec Not Supported<br><small>Likely H.265/HEVC</small>';
                        errorType = 'codec';
                    } else if (error.message.includes('DEMUXER_ERROR')) {
                        errorMessage += 'Format Error';
                        errorType = 'format';
                    } else if (error.message.includes('MEDIA_ELEMENT_ERROR')) {
                        errorMessage += 'Media Error';
                        errorType = 'media';
                    } else {
                        errorMessage += 'Load Error';
                        errorType = 'load';
                    }
                } else {
                    errorMessage += 'Load Error';
                }

                errorIndicator.innerHTML = errorMessage;
                videoItem.appendChild(errorIndicator);

                // Track the error for statistics
                this.failedVideos.set(fileName, errorType);
                this.updateErrorStats();

                reject(error);
            };

            const onLoad = () => {
                if (hasLoaded || hasErrored) return;
                hasLoaded = true;

                cleanup();
                videoItem.dataset.loaded = 'true';

                // Cache aspect ratio for layout calculations
                const aspectRatio = `${video.videoWidth}/${video.videoHeight}`;
                this.layoutManager.aspectRatioCache.set(videoItem, aspectRatio);

                // Apply aspect ratio styling based on layout mode
                if (this.layoutManager.layoutMode !== 'grid') {
                    video.className = 'video-element aspect-ratio';
                    video.style.aspectRatio = aspectRatio;
                } else {
                    video.className = 'video-element';
                    video.style.aspectRatio = '';
                }

                // Trigger masonry re-layout if in masonry mode
                if (this.layoutManager.layoutMode === 'masonry-vertical') {
                    // Debounce layout updates to avoid excessive recalculation
                    clearTimeout(this.layoutManager.masonryLayoutTimeout);
                    this.layoutManager.masonryLayoutTimeout = setTimeout(() => {
                        this.layoutManager.layoutMasonryItems();
                    }, 100);
                }

                const placeholder = videoItem.querySelector('.video-placeholder');
                if (placeholder) {
                    videoItem.replaceChild(video, placeholder);
                } else {
                    videoItem.insertBefore(video, videoItem.querySelector('.video-filename'));
                }

                this.videoElements.set(videoItem, video);
                this.loadedVideos.set(videoItem, Date.now());

                if (this.visibleVideos.has(videoItem) && this.canPlayMoreVideos()) {
                    setTimeout(() => {
                        this.playVideo(video);
                    }, Math.random() * 500);
                }

                resolve();
            };

            video.addEventListener('loadedmetadata', onLoad);
            video.addEventListener('canplay', onLoad);
            video.addEventListener('error', (e) => onError(e.target.error));

            const timeoutId = setTimeout(() => {
                if (!hasLoaded && !hasErrored) {
                    onError(new Error('Loading timeout'));
                }
            }, 15000);

            video.addEventListener('loadedmetadata', () => clearTimeout(timeoutId));

            try {
                // Use file path for Electron, File object for browser
                if (filePath) {
                    // Electron: Use file:// protocol for local files
                    video.src = `file://${filePath}`;
                } else if (file) {
                    // Browser: Use blob URL
                    video.src = URL.createObjectURL(file);
                }
                this.loadingVideos.add(videoItem);
            } catch (error) {
                onError(error);
            }
        });
    }

    initializeEventListeners() {
        // Set up the correct interface based on environment
        this.uiManager.setupInterface();

        // Electron folder selection button
        const electronFolderBtn = document.getElementById('electronFolderBtn');
        if (electronFolderBtn) {
            electronFolderBtn.addEventListener('click', () => {
                this.openElectronFolderDialog();
            });
        }

        // Web file input (fallback)
        const fileInput = document.getElementById('fileInput');
        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                this.handleFileSelection(e.target.files);
            });
        }

        // Listen for Electron folder selection (from menu)
        if (window.electronAPI?.onFolderSelected) {
            window.electronAPI.onFolderSelected((folderPath) => {
                this.handleElectronFolderSelection(folderPath);
            });
        }

        const autoplayToggle = document.getElementById('autoplayToggle');
        if (autoplayToggle) {
            autoplayToggle.addEventListener('click', () => {
                this.toggleAutoplay();
            });
        }

        const layoutToggle = document.getElementById('layoutToggle');
        if (layoutToggle) {
            layoutToggle.addEventListener('click', () => {
                this.layoutManager.toggleLayout();
            });
        }

        const recursiveToggle = document.getElementById('recursiveToggle');
        if (recursiveToggle) {
            recursiveToggle.addEventListener('click', () => {
                this.toggleRecursive();
            });
        }

        // Only set up drag & drop for web mode
        if (!window.electronAPI?.isElectron) {
            this.setupDragAndDrop();
        }

        const zoomSlider = document.getElementById('zoomSlider');
        if (zoomSlider) {
            zoomSlider.addEventListener('input', (e) => {
                this.layoutManager.setZoom(parseInt(e.target.value));
            });
        }

        const videoLimitSlider = document.getElementById('videoLimitSlider');
        if (videoLimitSlider) {
            videoLimitSlider.addEventListener('input', (e) => {
                this.setVideoLimit(parseInt(e.target.value));
            });

            // Add tooltip on hover
            videoLimitSlider.title = 'Adjust max concurrent videos (increase if your system can handle it)';
        }

        const videoGrid = document.getElementById('videoGrid');
        if (videoGrid) {
            videoGrid.addEventListener('wheel', (e) => {
                if (e.ctrlKey) {
                    e.preventDefault();
                    const currentZoom = parseInt(zoomSlider.value);
                    const newZoom = e.deltaY > 0 ? Math.max(0, currentZoom - 1) : Math.min(3, currentZoom + 1);
                    zoomSlider.value = newZoom;
                    this.layoutManager.setZoom(newZoom);
                }
            });
        }

        document.addEventListener('click', () => this.uiManager.hideContextMenu());
        const contextMenu = document.getElementById('contextMenu');
        if (contextMenu) {
            contextMenu.addEventListener('click', (e) => {
                e.stopPropagation();
                this.uiManager.handleContextMenuAction(e.target.dataset.action);
            });
        }

        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'a') {
                e.preventDefault();
                this.selectAll();
            } else if (e.key === 'Delete') {
                this.deleteSelected();
            } else if (e.key === 'Escape') {
                this.clearSelection();
            } else if (e.key === ' ') {
                e.preventDefault();
                this.toggleAutoplay();
            }
        });
    }

    async openElectronFolderDialog() {
        if (!window.electronAPI) {
            console.error('Electron API not available');
            return;
        }

        try {
            // Trigger the same folder dialog as the menu
            // We'll add a new IPC handler for this
            const result = await window.electronAPI.selectFolder();
            if (result && result.folderPath) {
                await this.handleElectronFolderSelection(result.folderPath);
            }
        } catch (error) {
            console.error('Error opening folder dialog:', error);
            this.uiManager.showTemporaryMessage('Error opening folder dialog', 'error');
        }
    }

    setupDragAndDrop() {
        const dropZone = document.getElementById('dropZone');
        if (!dropZone) return;

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, this.preventDefaults, false);
            document.body.addEventListener(eventName, this.preventDefaults, false);
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-over'), false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-over'), false);
        });

        dropZone.addEventListener('drop', (e) => {
            const files = Array.from(e.dataTransfer.files);
            this.handleFileSelection(files);
        }, false);
    }

    preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    async handleFileSelection(files) {
        const videoFiles = Array.from(files).filter(file => {
            const isVideoType = file.type.startsWith('video/');
            const hasVideoExtension = /\.(mp4|mov|avi|mkv|webm|m4v|flv|wmv|3gp|ogv)$/i.test(file.name);
            return isVideoType || hasVideoExtension;
        });

        if (videoFiles.length === 0) {
            this.uiManager.updateDebugInfo();
            return;
        }

        // Store the base directory info if available
        if (videoFiles.length > 0 && videoFiles[0].webkitRelativePath) {
            const firstPath = videoFiles[0].webkitRelativePath;
            const pathParts = firstPath.split('/');
            if (pathParts.length > 1) {
                this.baseDirectory = pathParts[0];
                console.log('Base directory detected:', this.baseDirectory);
            }
        }

        this.hideDropZone();
        this.clearVideos();

        // Show codec warning if needed
        this.showCodecWarning();

        videoFiles.forEach((file) => {
            this.createVideoItem(file);
        });

        // INITIAL LOAD FIX: Trigger initial load after all videos are added
        this.performanceManager.triggerInitialLoad();

        this.uiManager.updateDebugInfo();
        this.performanceManager.processLoadQueue();
    }

    forcePlayVisibleVideos() {
        console.log('Forcing play of visible videos...');
        let playedCount = 0;

        this.visibleVideos.forEach(videoItem => {
            const video = this.videoElements.get(videoItem);
            if (video && this.canPlayMoreVideos() && this.autoplayEnabled) {
                this.playVideo(video);
                playedCount++;
            }
        });

        console.log(`Attempted to play ${playedCount} visible videos`);
        this.uiManager.updateDebugInfo();
    }

    toggleRecursive() {
        this.recursiveMode = !this.recursiveMode;
        this.updateRecursiveButton();

        if (this.recursiveMode) {
            this.uiManager.showTemporaryMessage('Recursive mode enabled - will scan subfolders', 'info');
        } else {
            this.uiManager.showTemporaryMessage('Recursive mode disabled', 'info');
        }

        // Save settings
        this.saveSettings();
    }

    // Handle folder selection from Electron's native dialog
    async handleElectronFolderSelection(folderPath) {
        if (!window.electronAPI?.readDirectory) {
            console.error('Electron readDirectory API not available');
            return;
        }

        try {
            this.hideDropZone();
            this.clearVideos();
            this.showCodecWarning();

            // Show loading message with recursive info
            const recursiveText = this.recursiveMode ? ' (including subfolders)' : '';
            this.updateLoadingStatus(`Scanning ${folderPath}${recursiveText}...`);

            // Get all video files from the selected directory
            const videoFiles = await window.electronAPI.readDirectory(folderPath, this.recursiveMode);

            console.log(`Found ${videoFiles.length} video files in ${folderPath} (recursive: ${this.recursiveMode})`);

            if (videoFiles.length === 0) {
                this.updateLoadingStatus(`No video files found in ${folderPath}${recursiveText}`);
                return;
            }

            this.updateLoadingStatus(`Loading ${videoFiles.length} videos...`);

            // Create video items with full paths
            for (const filePath of videoFiles) {
                await this.createVideoItemFromPath(filePath);
            }

            // INITIAL LOAD FIX: Trigger initial load after all videos are added
            this.performanceManager.triggerInitialLoad();

            this.hideLoadingStatus();
            this.uiManager.updateDebugInfo();
            this.performanceManager.processLoadQueue();
        } catch (error) {
            console.error('Error reading directory:', error);
            this.updateLoadingStatus(`Error reading directory: ${error.message}`);
            setTimeout(() => this.hideLoadingStatus(), 5000);
        }
    }

    updateLoadingStatus(message) {
        const status = document.getElementById('status');
        if (status) {
            status.style.display = 'block';
            status.style.background = '#2a4a00';
            status.style.color = '#4CAF50';
            status.innerHTML = `🔄 ${message}`;
        }
    }

    hideLoadingStatus() {
        const status = document.getElementById('status');
        if (status) {
            status.style.display = 'none';
        }
    }

    // Create video item from full file path (Electron)
    async createVideoItemFromPath(fullPath) {
        if (!window.electronAPI?.getFileInfo) return;

        try {
            const fileInfo = await window.electronAPI.getFileInfo(fullPath);
            if (!fileInfo) return;

            const videoItem = document.createElement('div');
            videoItem.className = 'video-item';
            videoItem.dataset.filename = fileInfo.name;
            videoItem.dataset.loaded = 'false';
            videoItem.dataset.fullPath = fullPath; // Store full path

            const placeholder = document.createElement('div');
            placeholder.className = 'video-placeholder';
            this.layoutManager.updatePlaceholderForLayout(placeholder);
            placeholder.textContent = '📼 Loading...';

            const filename = document.createElement('div');
            filename.className = 'video-filename';
            filename.textContent = fileInfo.name;

            videoItem.appendChild(placeholder);
            videoItem.appendChild(filename);

            // Store the full path for file manager opening
            this.filePathMap.set(videoItem, fullPath);

            videoItem.addEventListener('click', (e) => {
                e.stopPropagation();
                if (e.ctrlKey || e.metaKey) {
                    this.toggleSelection(videoItem);
                } else {
                    this.clearSelection();
                    this.selectVideo(videoItem);
                }
            });

            videoItem.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                // Create a mock file object with the full path info
                this.uiManager.currentContextVideo = {
                    name: fileInfo.name,
                    fullPath: fullPath,
                    isElectronFile: true
                };
                this.uiManager.showContextMenu(e.clientX, e.clientY);
            });

            const videoGrid = document.getElementById('videoGrid');
            if (videoGrid) {
                videoGrid.appendChild(videoItem);
            }
            this.videos.add(videoItem);

            requestAnimationFrame(() => {
                videoItem.style.opacity = '0';
                videoItem.style.transform = 'scale(0.8)';
                requestAnimationFrame(() => {
                    videoItem.style.transition = 'all 0.3s ease';
                    videoItem.style.opacity = '1';
                    videoItem.style.transform = 'scale(1)';
                });
            });

            // INITIAL LOAD FIX: Notify performance manager about new video
            this.performanceManager.onVideoAdded(videoItem);

            return videoItem;
        } catch (error) {
            console.error('Error creating video item from path:', error);
        }
    }

    showCodecWarning() {
        const isChrome = /Chrome/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor);
        const isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
        const isEdge = navigator.userAgent.indexOf('Edg') > -1;

        if (isChrome || isFirefox || isEdge) {
            const status = document.getElementById('status');
            if (status) {
                status.style.display = 'block';
                status.style.background = '#3a2f00';
                status.style.color = '#ffcc00';
                status.innerHTML = '⚠️ <strong>Codec Warning:</strong> H.265/HEVC videos are not supported in this browser. Only H.264 videos will play. Consider using Safari or converting HEVC videos to H.264.';

                // Auto-hide after 10 seconds
                setTimeout(() => {
                    status.style.display = 'none';
                }, 10000);
            }
        }
    }

    createVideoItem(file) {
        const videoItem = document.createElement('div');
        videoItem.className = 'video-item';
        videoItem.dataset.filename = file.name;
        videoItem.dataset.loaded = 'false';

        const placeholder = document.createElement('div');
        placeholder.className = 'video-placeholder';
        this.layoutManager.updatePlaceholderForLayout(placeholder);
        placeholder.textContent = '📼 Loading...';

        const filename = document.createElement('div');
        filename.className = 'video-filename';
        filename.textContent = file.name;

        videoItem.appendChild(placeholder);
        videoItem.appendChild(filename);
        videoItem._file = file;

        videoItem.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.ctrlKey || e.metaKey) {
                this.toggleSelection(videoItem);
            } else {
                this.clearSelection();
                this.selectVideo(videoItem);
            }
        });

        videoItem.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.uiManager.currentContextVideo = file;
            this.uiManager.showContextMenu(e.clientX, e.clientY);
        });

        const videoGrid = document.getElementById('videoGrid');
        if (videoGrid) {
            videoGrid.appendChild(videoItem);
        }
        this.videos.add(videoItem);

        requestAnimationFrame(() => {
            videoItem.style.opacity = '0';
            videoItem.style.transform = 'scale(0.8)';
            requestAnimationFrame(() => {
                videoItem.style.transition = 'all 0.3s ease';
                videoItem.style.opacity = '1';
                videoItem.style.transform = 'scale(1)';
            });
        });

        // INITIAL LOAD FIX: Notify performance manager about new video
        this.performanceManager.onVideoAdded(videoItem);

        return videoItem;
    }

    handleIntersection(entries) {
        // Either remove entirely or keep very simple version for play/pause only
        console.warn('VideoBrowser handleIntersection called - PerformanceManager should handle this');
    }

    handleUnloadIntersection(entries) {
        // Either remove entirely
        console.warn('VideoBrowser handleUnloadIntersection called - PerformanceManager should handle this');
    }

    unloadVideoContent(videoItem) {
        const video = this.videoElements.get(videoItem);
        if (!video) return;

        console.log(`Unloading video: ${videoItem.dataset.filename}`);

        video.pause();
        video.removeAttribute('src');
        video.load();

        if (video.src && video.src.startsWith('blob:')) {
            URL.revokeObjectURL(video.src);
        }

        this.videoElements.delete(videoItem);
        this.loadedVideos.delete(videoItem);
        this.playingVideos.delete(video);
        this.loadingVideos.delete(videoItem);

        // Let PerformanceManager handle queue cleanup
        if (this.performanceManager && this.performanceManager.onVideoRemoved) {
            this.performanceManager.onVideoRemoved(videoItem);
        }

        const placeholder = document.createElement('div');
        placeholder.className = 'video-placeholder';
        this.layoutManager.updatePlaceholderForLayout(placeholder);
        placeholder.textContent = '📼 Scroll to reload...';

        // Simple click handler - no queue management
        placeholder.addEventListener('click', () => {
            if (videoItem.dataset.loaded === 'false') {
                placeholder.textContent = '📼 Loading...';
                placeholder.style.background = '#2a4a2a';
                // PerformanceManager will pick this up automatically via its observers
            }
        });

        const filename = videoItem.querySelector('.video-filename');
        videoItem.innerHTML = '';
        videoItem.appendChild(placeholder);
        if (filename) videoItem.appendChild(filename);

        videoItem.dataset.loaded = 'false';

        if (window.gc) {
            window.gc();
        }
    }

    canPlayMoreVideos() {
        return this.playingVideos.size < this.maxConcurrentPlaying;
    }

    toggleAutoplay() {
        this.autoplayEnabled = !this.autoplayEnabled;
        this.updateAutoplayButton();

        if (this.autoplayEnabled) {
            this.startAllVideos();
        } else {
            this.pauseAllVideos();
        }

        // Save settings
        this.saveSettings();
    }

    startAllVideos() {
        this.videoElements.forEach((video) => {
            if (this.visibleVideos.has(Array.from(this.videoElements.entries()).find(([item, vid]) => vid === video)?.[0])) {
                this.playVideo(video);
            }
        });
    }

    pauseAllVideos() {
        this.videoElements.forEach((video) => {
            video.pause();
            this.playingVideos.delete(video);
        });
    }

    playVideo(video) {
        if (video.readyState >= 3 && this.canPlayMoreVideos()) {
            video.play().then(() => {
                this.playingVideos.add(video);
            }).catch(error => {
                console.debug('Autoplay prevented:', error);
            });
        }
    }

    selectVideo(videoItem) {
        videoItem.classList.add('selected');
        this.selectedVideos.add(videoItem);
        this.uiManager.updateSelectionInfo();
    }

    toggleSelection(videoItem) {
        if (this.selectedVideos.has(videoItem)) {
            videoItem.classList.remove('selected');
            this.selectedVideos.delete(videoItem);
        } else {
            this.selectVideo(videoItem);
        }
    }

    clearSelection() {
        this.selectedVideos.forEach(item => item.classList.remove('selected'));
        this.selectedVideos.clear();
        this.uiManager.updateSelectionInfo();
    }

    selectAll() {
        this.videos.forEach(item => this.selectVideo(item));
    }

    clearVideos() {
        this.videoElements.forEach((video, videoItem) => {
            if (video && video.src && video.src.startsWith('blob:')) {
                URL.revokeObjectURL(video.src);
            }
            video.pause();
            video.removeAttribute('src');
            video.load();
            videoItem.remove();
        });

        this.videos.clear();
        this.videoElements.clear();
        this.selectedVideos.clear();
        this.loadingVideos.clear();
        this.visibleVideos.clear();
        this.playingVideos.clear();
        this.loadedVideos.clear();
        if (this.performanceManager && this.performanceManager.clearQueues) {
            this.performanceManager.clearQueues();
        }
        this.layoutManager.aspectRatioCache.clear();
        this.uiManager.updateSelectionInfo();
        this.uiManager.updateDebugInfo();
    }

    hideDropZone() {
        const dropZone = document.getElementById('dropZone');
        if (dropZone) dropZone.style.display = 'none';
    }

    pauseExcessVideos() {
        const excessCount = this.playingVideos.size - this.maxConcurrentPlaying;
        if (excessCount <= 0) return;

        const viewportCenter = window.innerHeight / 2;
        const playingArray = Array.from(this.playingVideos);

        const videosWithDistance = playingArray.map(video => {
            const videoItem = Array.from(this.videoElements.entries())
                .find(([item, vid]) => vid === video)?.[0];

            if (videoItem) {
                const rect = videoItem.getBoundingClientRect();
                const distance = Math.abs(rect.top + rect.height / 2 - viewportCenter);
                return { video, distance };
            }
            return { video, distance: Infinity };
        });

        videosWithDistance
            .sort((a, b) => b.distance - a.distance)
            .slice(0, excessCount)
            .forEach(({ video }) => {
                video.pause();
                this.playingVideos.delete(video);
            });
    }

    handleLayoutCollapse() {
        console.log('Layout collapse detected - resetting performance manager');
        this.performanceManager.clearQueues();

        // Pause all videos to prevent layout thrashing
        this.pauseAllVideos();

        // Force layout recalculation
        if (this.layoutManager) {
            setTimeout(() => {
                this.layoutManager.forceLayout();
            }, 500);
        }
    }
}

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
    new VideoBrowser();
});
