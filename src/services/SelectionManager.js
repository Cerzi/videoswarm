/**
 * Manages video selection state and operations
 * Follows the Single Responsibility Principle by focusing only on selection concerns
 */
export class SelectionManager {
    constructor(eventBus) {
        this.eventBus = eventBus;
        this.selectedVideos = new Set();
        this.setupEventListeners();
    }

    setupEventListeners() {
        this.eventBus.on('selection:toggle', (videoItem) => {
            this.toggleSelection(videoItem);
        });

        this.eventBus.on('selection:select', (videoItem) => {
            this.selectVideo(videoItem);
        });

        this.eventBus.on('selection:clear', () => {
            this.clearSelection();
        });

        this.eventBus.on('selection:selectAll', () => {
            this.selectAll();
        });

        this.eventBus.on('selection:delete', () => {
            this.deleteSelected();
        });

        this.eventBus.on('selection:copy', () => {
            this.copySelected();
        });
    }

    selectVideo(videoItem) {
        videoItem.classList.add('selected');
        this.selectedVideos.add(videoItem);
        this.updateSelectionInfo();
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
        this.selectedVideos.forEach(item => {
            item.classList.remove('selected');
        });
        this.selectedVideos.clear();
        this.updateSelectionInfo();
    }

    selectAll() {
        const allVideos = document.querySelectorAll('.video-item');
        allVideos.forEach(item => {
            this.selectVideo(item);
        });
    }

    deleteSelected() {
        if (this.selectedVideos.size === 0) return;

        const count = this.selectedVideos.size;
        if (confirm(`Delete ${count} selected video(s)?`)) {
            this.selectedVideos.forEach(item => {
                this.eventBus.emit('video:delete', item);
            });
            this.selectedVideos.clear();
            this.updateSelectionInfo();
        }
    }

    copySelected() {
        const count = this.selectedVideos.size;
        if (count > 0) {
            // In a real implementation, this would copy file references
            console.log(`Would copy ${count} selected videos`);
            this.eventBus.emit('ui:showStatus', `${count} videos copied to clipboard`, 'info');
        }
    }

    updateSelectionInfo() {
        const count = this.selectedVideos.size;
        this.eventBus.emit('ui:updateSelectionInfo', count);
    }

    getSelectedCount() {
        return this.selectedVideos.size;
    }

    getSelectedVideos() {
        return Array.from(this.selectedVideos);
    }
}
