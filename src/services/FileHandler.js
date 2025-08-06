/**
 * Handles file operations and validation
 * Follows the Single Responsibility Principle by focusing only on file-related operations
 */
export class FileHandler {
    constructor(eventBus) {
        this.eventBus = eventBus;
        this.supportedExtensions = /\.(mp4|mov|avi|mkv|webm|m4v|flv|wmv|3gp|ogv)$/i;
        this.setupEventListeners();
    }

    setupEventListeners() {
        this.eventBus.on('files:selected', (files) => {
            this.handleFileSelection(files);
        });

        this.eventBus.on('files:dropped', (files) => {
            this.handleFileSelection(files);
        });
    }

    handleFileSelection(files) {
        const videoFiles = this.filterVideoFiles(Array.from(files));
        
        if (videoFiles.length === 0) {
            this.eventBus.emit('ui:showStatus', 'No video files found in selection', 'warning');
            return;
        }

        this.eventBus.emit('ui:hideDropZone');
        this.eventBus.emit('videos:clear');
        this.showCodecWarning();
        
        // Process files in batches to avoid blocking the UI
        this.processFilesInBatches(videoFiles);
    }

    filterVideoFiles(files) {
        return files.filter(file => {
            const isVideoType = file.type.startsWith('video/');
            const hasVideoExtension = this.supportedExtensions.test(file.name);
            return isVideoType || hasVideoExtension;
        });
    }

    async processFilesInBatches(files, batchSize = 50) {
        for (let i = 0; i < files.length; i += batchSize) {
            const batch = files.slice(i, i + batchSize);
            
            // Process batch
            batch.forEach(file => {
                this.eventBus.emit('video:create', file);
            });

            // Allow UI to update between batches
            if (i + batchSize < files.length) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
    }

    showCodecWarning() {
        const isChrome = /Chrome/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor);
        const isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
        const isEdge = navigator.userAgent.indexOf('Edg') > -1;

        if (isChrome || isFirefox || isEdge) {
            const message = '⚠️ <strong>Codec Warning:</strong> H.265/HEVC videos are not supported in this browser. Only H.264 videos will play. Consider using Safari or converting HEVC videos to H.264.';
            this.eventBus.emit('ui:showStatus', message, 'warning');
        }
    }
}
