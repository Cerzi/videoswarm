import { useState, useCallback } from 'react';

export const useContextMenu = () => {
  const [contextMenu, setContextMenu] = useState({
    visible: false,
    video: null,
    position: { x: 0, y: 0 }
  });

  const showContextMenu = useCallback((event, video) => {
    console.log('useContextMenu: showContextMenu called with:', video.name);
    event.preventDefault();
    event.stopPropagation();

    // Clean up any existing raw DOM menus
    const existingMenu = document.getElementById('debug-context-menu');
    if (existingMenu) {
      existingMenu.remove();
    }

    // Set React state for the component
    setContextMenu({
      visible: true,
      video: video,
      position: {
        x: event.clientX,
        y: event.clientY
      }
    });
    
    console.log('useContextMenu: React context menu state set to visible');
  }, []);

  const hideContextMenu = useCallback(() => {
    setContextMenu({
      visible: false,
      video: null,
      position: { x: 0, y: 0 }
    });
  }, []);

  const handleContextAction = useCallback(async (action) => {
    const { video } = contextMenu;
    if (!video) return;

    try {
      switch (action) {
        case 'show-in-folder':
          if (video.isElectronFile && video.fullPath && window.electronAPI?.showItemInFolder) {
            const result = await window.electronAPI.showItemInFolder(video.fullPath);
            if (result.success) {
              console.log('Opened in file explorer');
              showNotification('Opened in file explorer', 'success');
            } else {
              console.error('Failed to open in file explorer:', result.error);
              showNotification('Failed to open file explorer', 'error');
            }
          } else {
            showNotification('File explorer not available in web mode', 'warning');
          }
          break;

        case 'open-external':
          if (video.isElectronFile && video.fullPath && window.electronAPI?.openInExternalPlayer) {
            const result = await window.electronAPI.openInExternalPlayer(video.fullPath);
            if (result.success) {
              console.log('Opened in external player');
              showNotification('Opened in external player', 'success');
            } else {
              console.error('Failed to open in external player:', result.error);
              showNotification('Failed to open external player', 'error');
            }
          } else {
            showNotification('External player not available in web mode', 'warning');
          }
          break;

        case 'copy-path':
          if (video.isElectronFile && video.fullPath && window.electronAPI?.copyToClipboard) {
            const result = await window.electronAPI.copyToClipboard(video.fullPath);
            if (result.success) {
              showNotification('File path copied to clipboard', 'success');
            } else {
              console.error('Failed to copy path:', result.error);
              showNotification('Failed to copy path', 'error');
            }
          } else {
            showNotification('Full path not available in web mode', 'warning');
          }
          break;

        case 'copy-filename':
          const filename = video.name;
          if (window.electronAPI?.copyToClipboard) {
            const result = await window.electronAPI.copyToClipboard(filename);
            if (result.success) {
              showNotification('Filename copied to clipboard', 'success');
            } else {
              console.error('Failed to copy filename:', result.error);
              showNotification('Failed to copy filename', 'error');
            }
          } else {
            // Fallback for web mode
            try {
              await navigator.clipboard.writeText(filename);
              showNotification('Filename copied to clipboard', 'success');
            } catch (error) {
              console.error('Failed to copy filename (web):', error);
              showNotification('Failed to copy filename', 'error');
            }
          }
          break;

        case 'copy-relative-path':
          const relativePath = video.webkitRelativePath || video.relativePath || video.name;
          if (window.electronAPI?.copyToClipboard) {
            const result = await window.electronAPI.copyToClipboard(relativePath);
            if (result.success) {
              showNotification('Relative path copied to clipboard', 'success');
            } else {
              showNotification('Failed to copy relative path', 'error');
            }
          } else {
            try {
              await navigator.clipboard.writeText(relativePath);
              showNotification('Relative path copied to clipboard', 'success');
            } catch (error) {
              showNotification('Failed to copy relative path', 'error');
            }
          }
          break;

        case 'file-properties':
          if (video.isElectronFile && video.fullPath && window.electronAPI?.getFileProperties) {
            const properties = await window.electronAPI.getFileProperties(video.fullPath);
            if (properties) {
              showFilePropertiesModal(video, properties);
            } else {
              showNotification('Could not retrieve file properties', 'error');
            }
          } else {
            // Show basic web file properties
            showFilePropertiesModal(video, null);
          }
          break;

        case 'move-to-trash':
          if (video.isElectronFile && video.fullPath && window.electronAPI?.moveToTrash) {
            // Confirm deletion
            const confirmed = window.confirm(`Move "${video.name}" to trash?`);
            if (confirmed) {
              const result = await window.electronAPI.moveToTrash(video.fullPath);
              if (result.success) {
                showNotification('File moved to trash', 'success');
                // The file watcher should automatically update the UI
              } else {
                console.error('Failed to move to trash:', result.error);
                showNotification('Failed to move file to trash', 'error');
              }
            }
          } else {
            showNotification('Delete not available in web mode', 'warning');
          }
          break;

        default:
          console.warn('Unknown context action:', action);
      }
    } catch (error) {
      console.error('Context action error:', error);
      showNotification('Action failed', 'error');
    }
  }, [contextMenu]);

  // Enhanced notification system with different types
  const showNotification = useCallback((message, type = 'info') => {
    const notification = document.createElement('div');
    
    const colors = {
      error: '#ff4444',
      success: '#4CAF50',
      warning: '#ff9800',
      info: '#007acc'
    };
    
    const icons = {
      error: '❌',
      success: '✅',
      warning: '⚠️',
      info: 'ℹ️'
    };
    
    notification.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      background: ${colors[type]};
      color: white;
      padding: 12px 16px;
      border-radius: 8px;
      z-index: 10001;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      max-width: 300px;
      word-wrap: break-word;
      display: flex;
      align-items: center;
      gap: 8px;
      animation: slideInFromRight 0.3s ease-out;
    `;
    
    // Add CSS animation
    if (!document.getElementById('notification-styles')) {
      const style = document.createElement('style');
      style.id = 'notification-styles';
      style.textContent = `
        @keyframes slideInFromRight {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
      `;
      document.head.appendChild(style);
    }
    
    notification.innerHTML = `${icons[type]} ${message}`;
    document.body.appendChild(notification);

    // Auto remove after 4 seconds
    setTimeout(() => {
      if (document.body.contains(notification)) {
        notification.style.animation = 'slideInFromRight 0.3s ease-out reverse';
        setTimeout(() => {
          if (document.body.contains(notification)) {
            document.body.removeChild(notification);
          }
        }, 300);
      }
    }, 4000);
  }, []);

  // Simple file properties modal
  const showFilePropertiesModal = useCallback((video, properties) => {
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10002;
      font-family: system-ui, -apple-system, sans-serif;
    `;

    const formatFileSize = (bytes) => {
      if (!bytes) return 'Unknown';
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
    };

    const formatDate = (date) => {
      if (!date) return 'Unknown';
      return new Date(date).toLocaleString();
    };

    const content = `
      <div style="
        background: #2d2d2d;
        border-radius: 12px;
        padding: 24px;
        max-width: 500px;
        width: 90%;
        color: white;
        box-shadow: 0 20px 40px rgba(0,0,0,0.5);
      ">
        <h3 style="margin: 0 0 20px 0; color: #fff; font-size: 18px;">File Properties</h3>
        
        <div style="margin-bottom: 12px;">
          <strong>Name:</strong><br>
          <span style="color: #ccc; word-break: break-all;">${video.name}</span>
        </div>
        
        ${video.fullPath ? `
          <div style="margin-bottom: 12px;">
            <strong>Path:</strong><br>
            <span style="color: #ccc; word-break: break-all; font-size: 12px;">${video.fullPath}</span>
          </div>
        ` : ''}
        
        ${properties ? `
          <div style="margin-bottom: 12px;">
            <strong>Size:</strong> <span style="color: #ccc;">${formatFileSize(properties.size)}</span>
          </div>
          
          <div style="margin-bottom: 12px;">
            <strong>Created:</strong> <span style="color: #ccc;">${formatDate(properties.created)}</span>
          </div>
          
          <div style="margin-bottom: 12px;">
            <strong>Modified:</strong> <span style="color: #ccc;">${formatDate(properties.modified)}</span>
          </div>
        ` : video.metadata ? `
          <div style="margin-bottom: 12px;">
            <strong>Size:</strong> <span style="color: #ccc;">${video.metadata.sizeFormatted || 'Unknown'}</span>
          </div>
          
          <div style="margin-bottom: 12px;">
            <strong>Created:</strong> <span style="color: #ccc;">${video.metadata.dateCreatedFormatted || 'Unknown'}</span>
          </div>
          
          <div style="margin-bottom: 12px;">
            <strong>Modified:</strong> <span style="color: #ccc;">${video.metadata.dateModifiedFormatted || 'Unknown'}</span>
          </div>
        ` : ''}
        
        <button onclick="this.closest('div').parentElement.remove()" style="
          background: #007acc;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          margin-top: 16px;
        ">Close</button>
      </div>
    `;

    modal.innerHTML = content;
    modal.onclick = (e) => {
      if (e.target === modal) modal.remove();
    };

    document.body.appendChild(modal);
  }, []);

  return {
    contextMenu,
    showContextMenu,
    hideContextMenu,
    handleContextAction
  };
};