/**
 * Represents a single video item in the grid
 * Follows the Single Responsibility Principle by focusing only on video item concerns
 */
export class VideoItem {
    constructor(file, eventBus) {
        this.file = file;
        this.eventBus = eventBus;
        this.element = null;
        this.isLoaded = false;
    }

    createElement() {
        this.element = document.createElement('div');
        this.element.className = 'video-item';
        this.element.dataset.filename = this.file.name;
        this.element.dataset.loaded = 'false';
        this.element._file = this.file;

        // Create placeholder
        const placeholder = this.createPlaceholder();
        
        // Create filename display
        const filename = this.createFilename();

        this.element.appendChild(placeholder);
        this.element.appendChild(filename);

        this.setupEventListeners();

        return this.element;
    }

    createPlaceholder() {
        const placeholder = document.createElement('div');
        placeholder.className = 'video-placeholder';
        placeholder.textContent = '📼 Loading...';
        return placeholder;
    }

    createFilename() {
        const filename = document.createElement('div');
        filename.className = 'video-filename';
        filename.textContent = this.file.name;
        return filename;
    }

    setupEventListeners() {
        // Click handling for selection
        this.element.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.ctrlKey || e.metaKey) {
                this.eventBus.emit('selection:toggle', this.element);
            } else {
                this.eventBus.emit('selection:clear');
                this.eventBus.emit('selection:select', this.element);
            }
        });

        // Context menu
        this.element.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.eventBus.emit('contextMenu:show', {
                x: e.pageX,
                y: e.pageY,
                file: this.file,
                element: this.element
            });
        });
    }

    updateForLayout(layoutMode) {
        const placeholder = this.element.querySelector('.video-placeholder');
        const video = this.element.querySelector('.video-element');

        if (layoutMode === 'grid') {
            // Fixed height layout
            if (placeholder) {
                placeholder.className = 'video-placeholder';
                placeholder.style.height = '140px';
                placeholder.style.aspectRatio = '';
            }
            if (video) {
                video.className = 'video-element';
                video.style.aspectRatio = '';
            }
        } else {
            // Aspect ratio preserved layout
            if (placeholder) {
                placeholder.className = 'video-placeholder aspect-ratio';
                placeholder.style.height = 'auto';
                placeholder.style.aspectRatio = '16/9';
            }
            if (video) {
                video.className = 'video-element aspect-ratio';
                // Aspect ratio will be set when video loads
            }
        }
    }

    showError(errorMessage, errorType = 'unknown') {
        this.element.classList.add('error');
        
        const errorIndicator = document.createElement('div');
        errorIndicator.className = 'error-indicator';
        
        let displayMessage = '❌<br>';
        
        switch (errorType) {
            case 'codec':
                displayMessage += 'Codec Not Supported<br><small>Likely H.265/HEVC</small>';
                break;
            case 'format':
                displayMessage += 'Format Error';
                break;
            case 'media':
                displayMessage += 'Media Error';
                break;
            case 'timeout':
                displayMessage += 'Loading Timeout';
                break;
            default:
                displayMessage += 'Load Error';
        }
        
        errorIndicator.innerHTML = displayMessage;
        this.element.appendChild(errorIndicator);

        // Remove placeholder
        const placeholder = this.element.querySelector('.video-placeholder');
        if (placeholder) {
            placeholder.remove();
        }
    }

    replaceWithVideo(videoElement) {
        const placeholder = this.element.querySelector('.video-placeholder');
        const filename = this.element.querySelector('.video-filename');
        
        if (placeholder) {
            this.element.replaceChild(videoElement, placeholder);
        } else {
            this.element.insertBefore(videoElement, filename);
        }
        
        this.element.dataset.loaded = 'true';
        this.isLoaded = true;
    }

    getFile() {
        return this.file;
    }

    getElement() {
        return this.element;
    }

    isVideoLoaded() {
        return this.isLoaded;
    }
}
