import { DOMElements } from '../utils/DOMElements.js';
import { ContextMenu } from '../components/ContextMenu.js';

/**
 * Handles all UI interactions and updates
 * Follows the Single Responsibility Principle by focusing only on UI concerns
 */
export class UIController {
    constructor(eventBus) {
        this.eventBus = eventBus;
        this.dom = new DOMElements();
        this.contextMenu = new ContextMenu(eventBus);
        
        this.zoomLevels = ['zoom-small', 'zoom-medium', 'zoom-large', 'zoom-xlarge'];
        this.zoomLabels = ['75%', '100%', '150%', '200%'];
        
        this.initializeEventListeners();
        this.setupEventBusListeners();
    }

    initializeEventListeners() {
        // File input
        this.dom.fileInput?.addEventListener('change', (e) => {
            this.eventBus.emit('files:selected', e.target.files);
        });

        // Control buttons
        this.dom.autoplayToggle?.addEventListener('click', () => {
            this.eventBus.emit('playback:toggle');
        });

        this.dom.layoutToggle?.addEventListener('click', () => {
            this.eventBus.emit('layout:toggle');
        });

        // Sliders
        this.dom.zoomSlider?.addEventListener('input', (e) => {
            this.eventBus.emit('zoom:change', parseInt(e.target.value));
        });

        this.dom.videoLimitSlider?.addEventListener('input', (e) => {
            this.eventBus.emit('performance:limitChange', parseInt(e.target.value));
        });

        // Drag and drop
        this.setupDragAndDrop();

        // Keyboard shortcuts
        this.setupKeyboardShortcuts();

        // Mouse wheel zoom
        this.setupWheelZoom();
    }

    setupEventBusListeners() {
        this.eventBus.on('ui:updateDebugInfo', (info) => {
            this.updateDebugInfo(info);
        });

        this.eventBus.on('ui:updateSelectionInfo', (count) => {
            this.updateSelectionInfo(count);
        });

        this.eventBus.on('ui:updateZoom', (level) => {
            this.updateZoomDisplay(level);
        });

        this.eventBus.on('ui:updateAutoplayButton', (isEnabled) => {
            this.updateAutoplayButton(isEnabled);
        });

        this.eventBus.on('ui:updateLayoutButton', (mode) => {
            this.updateLayoutButton(mode);
        });

        this.eventBus.on('ui:showStatus', (message, type = 'info') => {
            this.showStatus(message, type);
        });

        this.eventBus.on('ui:hideDropZone', () => {
            this.hideDropZone();
        });
    }

    setupDragAndDrop() {
        const dropZone = this.dom.dropZone;
        if (!dropZone) return;

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, this.preventDefaults, false);
            document.body.addEventListener(eventName, this.preventDefaults, false);
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => {
                dropZone.classList.add('drag-over');
            }, false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => {
                dropZone.classList.remove('drag-over');
            }, false);
        });

        dropZone.addEventListener('drop', (e) => {
            const files = Array.from(e.dataTransfer.files);
            this.eventBus.emit('files:dropped', files);
        }, false);
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'a') {
                e.preventDefault();
                this.eventBus.emit('selection:selectAll');
            } else if (e.key === 'Delete') {
                this.eventBus.emit('selection:delete');
            } else if (e.key === 'Escape') {
                this.eventBus.emit('selection:clear');
            } else if (e.key === ' ') {
                e.preventDefault();
                this.eventBus.emit('playback:toggle');
            }
        });
    }

    setupWheelZoom() {
        this.dom.videoGrid?.addEventListener('wheel', (e) => {
            if (e.ctrlKey) {
                e.preventDefault();
                const currentZoom = parseInt(this.dom.zoomSlider.value);
                const newZoom = e.deltaY > 0 ? 
                    Math.max(0, currentZoom - 1) : 
                    Math.min(3, currentZoom + 1);
                this.dom.zoomSlider.value = newZoom;
                this.eventBus.emit('zoom:change', newZoom);
            }
        });
    }

    preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    updateDebugInfo(info) {
        if (this.dom.debugInfo) {
            const memoryInfo = performance.memory ?
                ` | ${Math.round(performance.memory.usedJSHeapSize / 1024 / 1024)}MB` : '';

            this.dom.debugInfo.textContent =
                `▶️ ${info.playing}/${info.maxPlaying} | ` +
                `📼 ${info.loaded}/${info.maxLoaded} | ` +
                `📁 ${info.total}${memoryInfo}`;
        }
    }

    updateSelectionInfo(count) {
        if (!this.dom.selectionInfo) return;

        if (count === 0) {
            this.dom.selectionInfo.style.display = 'none';
        } else {
            this.dom.selectionInfo.style.display = 'block';
            this.dom.selectionInfo.textContent = `${count} selected`;
        }
    }

    updateZoomDisplay(level) {
        const grid = this.dom.videoGrid;
        const label = this.dom.zoomLabel;
        
        if (grid) {
            this.zoomLevels.forEach(cls => grid.classList.remove(cls));
            grid.classList.add(this.zoomLevels[level]);
        }
        
        if (label) {
            label.textContent = this.zoomLabels[level];
        }
    }

    updateAutoplayButton(isEnabled) {
        const button = this.dom.autoplayToggle;
        if (!button) return;

        if (isEnabled) {
            button.textContent = '⏸️ Pause All';
            button.classList.add('active');
        } else {
            button.textContent = '▶️ Resume All';
            button.classList.remove('active');
        }
    }

    updateLayoutButton(mode) {
        const button = this.dom.layoutToggle;
        if (!button) return;

        const buttonTexts = {
            'grid': '📐 Aspect Ratio',
            'masonry-vertical': '📐 Vertical',
            'masonry-horizontal': '📐 Horizontal'
        };
        button.textContent = buttonTexts[mode];
    }

    showStatus(message, type = 'info') {
        const status = this.dom.status;
        if (!status) return;

        status.style.display = 'block';
        status.innerHTML = message;

        // Apply styling based on type
        switch (type) {
            case 'warning':
                status.style.background = '#3a2f00';
                status.style.color = '#ffcc00';
                break;
            case 'error':
                status.style.background = '#4a0000';
                status.style.color = '#ff6666';
                break;
            default:
                status.style.background = '#262626';
                status.style.color = '#aaa';
        }

        // Auto-hide after 10 seconds for warnings/errors
        if (type !== 'info') {
            setTimeout(() => {
                status.style.display = 'none';
            }, 10000);
        }
    }

    hideDropZone() {
        if (this.dom.dropZone) {
            this.dom.dropZone.style.display = 'none';
        }
    }
}
