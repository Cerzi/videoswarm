/**
 * Handles context menu functionality
 * Follows the Single Responsibility Principle by focusing only on context menu concerns
 */
export class ContextMenu {
    constructor(eventBus) {
        this.eventBus = eventBus;
        this.currentContext = null;
        this.menuElement = document.getElementById('contextMenu');
        this.setupEventListeners();
    }

    setupEventListeners() {
        this.eventBus.on('contextMenu:show', (context) => {
            this.show(context.x, context.y, context.file, context.element);
        });

        this.eventBus.on('contextMenu:hide', () => {
            this.hide();
        });

        // Global click to hide menu
        document.addEventListener('click', () => {
            this.hide();
        });

        // Menu item clicks
        if (this.menuElement) {
            this.menuElement.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = e.target.dataset.action;
                if (action) {
                    this.handleAction(action);
                }
            });
        }
    }

    show(x, y, file, element) {
        if (!this.menuElement) return;

        this.currentContext = { file, element };
        
        this.menuElement.style.display = 'block';
        this.menuElement.style.left = `${x}px`;
        this.menuElement.style.top = `${y}px`;

        // Adjust position if menu would go off-screen
        const rect = this.menuElement.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            this.menuElement.style.left = `${x - rect.width}px`;
        }
        if (rect.bottom > window.innerHeight) {
            this.menuElement.style.top = `${y - rect.height}px`;
        }
    }

    hide() {
        if (this.menuElement) {
            this.menuElement.style.display = 'none';
        }
        this.currentContext = null;
    }

    handleAction(action) {
        if (!this.currentContext) return;

        switch (action) {
            case 'show-folder':
                this.showInFileManager();
                break;
            case 'copy-path':
                this.copyFilePath();
                break;
            case 'copy':
                this.copyFile();
                break;
            case 'delete':
                this.deleteFile();
                break;
        }

        this.hide();
    }

    showInFileManager() {
        // In a real implementation, this would use a native API
        const message = `Would open file manager for: ${this.currentContext.file.name}`;
        this.eventBus.emit('ui:showStatus', message, 'info');
    }

    copyFilePath() {
        if (this.currentContext.file) {
            navigator.clipboard.writeText(this.currentContext.file.name).then(() => {
                this.eventBus.emit('ui:showStatus', 'File path copied to clipboard', 'info');
            }).catch(() => {
                this.eventBus.emit('ui:showStatus', 'Failed to copy file path', 'error');
            });
        }
    }

    copyFile() {
        // In a real implementation, this would copy the actual file
        this.eventBus.emit('selection:copy');
    }

    deleteFile() {
        if (this.currentContext.element) {
            this.eventBus.emit('selection:clear');
            this.eventBus.emit('selection:select', this.currentContext.element);
            this.eventBus.emit('selection:delete');
        }
    }
}
