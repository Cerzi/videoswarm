class UIManager {
    constructor(videoBrowser) {
        this.videoBrowser = videoBrowser;
        this.currentContextVideo = null;
    }

    setupInterface() {
        const isElectron = window.electronAPI?.isElectron;

        // Show appropriate controls
        const electronBtn = document.getElementById('electronFolderBtn');
        const webFallback = document.getElementById('webFallback');
        const electronDropZone = document.getElementById('electronDropZone');
        const webDropZone = document.getElementById('webDropZone');

        if (isElectron) {
            if (electronBtn) electronBtn.style.display = 'block';
            if (webFallback) webFallback.style.display = 'none';
            if (electronDropZone) electronDropZone.style.display = 'block';
            if (webDropZone) webDropZone.style.display = 'none';
        } else {
            if (electronBtn) electronBtn.style.display = 'none';
            if (webFallback) webFallback.style.display = 'block';
            if (electronDropZone) electronDropZone.style.display = 'none';
            if (webDropZone) webDropZone.style.display = 'block';
        }
    }

    showContextMenu(x, y) {
        const menu = document.getElementById('contextMenu');
        if (!menu) return;

        menu.style.display = 'block';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            menu.style.left = `${x - rect.width}px`;
        }
        if (rect.bottom > window.innerHeight) {
            menu.style.top = `${y - rect.height}px`;
        }
    }

    hideContextMenu() {
        const menu = document.getElementById('contextMenu');
        if (menu) menu.style.display = 'none';
    }

    handleContextMenuAction(action) {
        this.hideContextMenu();

        switch (action) {
            case 'show-folder':
                this.showInFileManager();
                break;
            case 'copy-path':
                this.copyFilePath();
                break;
        }
    }

    showInFileManager() {
        console.log('=== SHOW IN FILE MANAGER DEBUG ===');
        console.log('currentContextVideo:', this.currentContextVideo);
        console.log('electronAPI available:', !!window.electronAPI?.showItemInFolder);

        if (!this.currentContextVideo) {
            console.error('No context video set!');
            return;
        }

        const fileName = this.currentContextVideo.name;
        console.log('fileName:', fileName);
        console.log('currentContextVideo.isElectronFile:', this.currentContextVideo.isElectronFile);
        console.log('currentContextVideo.fullPath:', this.currentContextVideo.fullPath);
        console.log('currentContextVideo.webkitRelativePath:', this.currentContextVideo.webkitRelativePath);

        if (window.electronAPI?.showItemInFolder) {
            console.log('Using Electron API...');
            // Check if this is an Electron-loaded file with full path
            if (this.currentContextVideo.isElectronFile && this.currentContextVideo.fullPath) {
                console.log('Opening Electron file:', this.currentContextVideo.fullPath);
                window.electronAPI.showItemInFolder(this.currentContextVideo.fullPath).then(result => {
                    console.log('showItemInFolder result:', result);
                    if (!result.success) {
                        console.error('Failed to open file manager:', result.error);
                        this.showTemporaryMessage(`Error: ${result.error}`, 'error');
                    } else {
                        this.showTemporaryMessage('Opened in file manager!', 'success');
                    }
                }).catch(error => {
                    console.error('Error opening file manager:', error);
                    this.showTemporaryMessage(`Error: ${error.message}`, 'error');
                });
            } else {
                console.log('Not an Electron file or no full path - showing browser dialog');
                console.log('Reason: isElectronFile =', this.currentContextVideo.isElectronFile, 'fullPath =', this.currentContextVideo.fullPath);
                // Browser-selected file - show explanation
                this.showPathResolutionDialog(fileName, this.currentContextVideo.webkitRelativePath);
            }
        } else {
            console.error('Electron API not available - using browser fallback');
            // Fallback for non-Electron environment
            this.showFilePathDialog(fileName, this.currentContextVideo.webkitRelativePath || fileName);
        }
    }

    showPathResolutionDialog(fileName, relativePath) {
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: #2d2d2d;
            border: 1px solid #404040;
            border-radius: 8px;
            padding: 2rem;
            max-width: 600px;
            width: 90%;
            color: white;
            font-family: inherit;
        `;

        const pathInfo = relativePath ?
            `<div style="background: #1a1a1a; padding: 1rem; border-radius: 4px; margin: 1rem 0; font-family: monospace; word-break: break-all;">
                <strong>File:</strong> ${fileName}<br>
                <strong>Relative Path:</strong> ${relativePath}
            </div>` :
            `<div style="background: #1a1a1a; padding: 1rem; border-radius: 4px; margin: 1rem 0; font-family: monospace;">
                <strong>File:</strong> ${fileName}
            </div>`;

        dialog.innerHTML = `
            <h3 style="margin: 0 0 1rem 0; color: #007acc;">📁 Cannot Open File Manager</h3>
            <p style="margin: 0 0 1rem 0; color: #ccc;">
                Due to browser security limitations, we cannot directly open the file manager with the exact file location.
                The browser only provides relative paths from the selected folder.
            </p>
            ${pathInfo}
            <div style="margin: 1rem 0; padding: 1rem; background: #2a4a00; border-radius: 4px; border-left: 4px solid #4CAF50;">
                <strong style="color: #4CAF50;">💡 Tip:</strong> To get full file manager integration, you can:
                <ul style="margin: 0.5rem 0; padding-left: 1.5rem;">
                    <li>Drag & drop files directly from file manager into this app</li>
                    <li>Use the file name to search in your file manager</li>
                    <li>Remember the folder you selected originally</li>
                </ul>
            </div>
            <div style="display: flex; gap: 1rem; justify-content: flex-end; margin-top: 2rem;">
                <button id="copyFileNameBtn" style="background: #007acc; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer;">
                    📋 Copy File Name
                </button>
                ${relativePath ? `
                <button id="copyRelativePathBtn" style="background: #404040; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer;">
                    📋 Copy Relative Path
                </button>
                ` : ''}
                <button id="closeModalBtn" style="background: #666; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer;">
                    Close
                </button>
            </div>
        `;

        modal.appendChild(dialog);
        document.body.appendChild(modal);

        // Add event listeners
        const copyFileNameBtn = dialog.querySelector('#copyFileNameBtn');
        const copyRelativePathBtn = dialog.querySelector('#copyRelativePathBtn');
        const closeModalBtn = dialog.querySelector('#closeModalBtn');

        copyFileNameBtn?.addEventListener('click', () => {
            navigator.clipboard.writeText(fileName).then(() => {
                copyFileNameBtn.textContent = '✅ Copied!';
                setTimeout(() => {
                    copyFileNameBtn.textContent = '📋 Copy File Name';
                }, 2000);
            });
        });

        copyRelativePathBtn?.addEventListener('click', () => {
            navigator.clipboard.writeText(relativePath).then(() => {
                copyRelativePathBtn.textContent = '✅ Copied!';
                setTimeout(() => {
                    copyRelativePathBtn.textContent = '📋 Copy Relative Path';
                }, 2000);
            });
        });

        const closeModal = () => {
            document.body.removeChild(modal);
        };

        closeModalBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });

        // Close on Escape key
        const handleKeydown = (e) => {
            if (e.key === 'Escape') {
                closeModal();
                document.removeEventListener('keydown', handleKeydown);
            }
        };
        document.addEventListener('keydown', handleKeydown);
    }

    showFilePathDialog(fileName, filePath) {
        // Create a modal dialog showing the file information
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: #2d2d2d;
            border: 1px solid #404040;
            border-radius: 8px;
            padding: 2rem;
            max-width: 600px;
            width: 90%;
            color: white;
            font-family: inherit;
        `;

        dialog.innerHTML = `
            <h3 style="margin: 0 0 1rem 0; color: #007acc;">📁 File Location</h3>
            <p style="margin: 0 0 1rem 0; color: #ccc;">Cannot directly open file manager from web browser due to security restrictions.</p>
            <div style="background: #1a1a1a; padding: 1rem; border-radius: 4px; margin: 1rem 0; font-family: monospace; word-break: break-all;">
                <strong>File:</strong> ${fileName}<br>
                ${filePath !== fileName ? `<strong>Path:</strong> ${filePath}` : ''}
            </div>
            <div style="display: flex; gap: 1rem; justify-content: flex-end; margin-top: 2rem;">
                <button id="copyFileNameBtn" style="background: #007acc; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer;">
                    📋 Copy File Name
                </button>
                ${filePath !== fileName ? `
                <button id="copyFilePathBtn" style="background: #404040; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer;">
                    📋 Copy Full Path
                </button>
                ` : ''}
                <button id="closeModalBtn" style="background: #666; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer;">
                    Close
                </button>
            </div>
        `;

        modal.appendChild(dialog);
        document.body.appendChild(modal);

        // Add event listeners
        const copyFileNameBtn = dialog.querySelector('#copyFileNameBtn');
        const copyFilePathBtn = dialog.querySelector('#copyFilePathBtn');
        const closeModalBtn = dialog.querySelector('#closeModalBtn');

        copyFileNameBtn?.addEventListener('click', () => {
            navigator.clipboard.writeText(fileName).then(() => {
                copyFileNameBtn.textContent = '✅ Copied!';
                setTimeout(() => {
                    copyFileNameBtn.textContent = '📋 Copy File Name';
                }, 2000);
            });
        });

        copyFilePathBtn?.addEventListener('click', () => {
            navigator.clipboard.writeText(filePath).then(() => {
                copyFilePathBtn.textContent = '✅ Copied!';
                setTimeout(() => {
                    copyFilePathBtn.textContent = '📋 Copy Full Path';
                }, 2000);
            });
        });

        const closeModal = () => {
            document.body.removeChild(modal);
        };

        closeModalBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });

        // Close on Escape key
        const handleKeydown = (e) => {
            if (e.key === 'Escape') {
                closeModal();
                document.removeEventListener('keydown', handleKeydown);
            }
        };
        document.addEventListener('keydown', handleKeydown);
    }

    showTemporaryMessage(message, type = 'info') {
        const toast = document.createElement('div');
        const bgColor = type === 'error' ? '#ff4444' : type === 'success' ? '#4CAF50' : '#007acc';
        toast.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            background: ${bgColor};
            color: white;
            padding: 1rem 1.5rem;
            border-radius: 6px;
            z-index: 10001;
            font-family: inherit;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            max-width: 300px;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            if (document.body.contains(toast)) {
                document.body.removeChild(toast);
            }
        }, 4000);
    }

    copyFilePath() {
        if (this.currentContextVideo) {
            const pathToCopy = this.currentContextVideo.isElectronFile
                ? this.currentContextVideo.fullPath
                : this.currentContextVideo.webkitRelativePath || this.currentContextVideo.name;

            navigator.clipboard.writeText(pathToCopy).then(() => {
                const pathType = this.currentContextVideo.isElectronFile ? 'Full path' : 'File name';
                this.showTemporaryMessage(`${pathType} copied to clipboard!`, 'success');
            });
        }
    }

    updateSelectionInfo() {
        const info = document.getElementById('selectionInfo');
        if (!info) return;

        const count = this.videoBrowser.selectedVideos.size;

        if (count === 0) {
            info.style.display = 'none';
        } else {
            info.style.display = 'block';
            info.textContent = `${count} selected`;
        }
    }

    updateDebugInfo() {
        const debugInfo = document.getElementById('debugInfo');
        if (!debugInfo) return;

        const memoryInfo = performance.memory ?
            ` | ${Math.round(performance.memory.usedJSHeapSize / 1024 / 1024)}MB` : '';

        debugInfo.textContent =
            `▶️ ${this.videoBrowser.playingVideos.size}/${this.videoBrowser.maxConcurrentPlaying} | ` +
            `📼 ${this.videoBrowser.loadedVideos.size}/${this.videoBrowser.performanceManager.maxLoadedVideos} | ` +
            `📁 ${this.videoBrowser.videos.size}${memoryInfo}`;
    }
}

window.UIManager = UIManager;
