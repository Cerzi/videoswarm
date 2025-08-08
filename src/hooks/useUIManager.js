import { useState, useRef, useCallback } from 'react'

export const useUIManager = () => {
  const [contextMenuVisible, setContextMenuVisible] = useState(false)
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 })
  const [currentContextVideo, setCurrentContextVideo] = useState(null)
  
  const lastDebugUpdateRef = useRef(0)
  const debugUpdateThrottleRef = useRef(500)

  const setupInterface = useCallback(() => {
    const isElectron = window.electronAPI?.isElectron
    
    // Interface is handled by React components, but we can return the state
    return { isElectron }
  }, [])

  const showContextMenu = useCallback((x, y, videoData) => {
    setCurrentContextVideo(videoData)
    
    // Adjust position if menu would go off screen
    const menuWidth = 200 // Approximate width
    const menuHeight = 100 // Approximate height
    
    let adjustedX = x
    let adjustedY = y
    
    if (x + menuWidth > window.innerWidth) {
      adjustedX = x - menuWidth
    }
    if (y + menuHeight > window.innerHeight) {
      adjustedY = y - menuHeight
    }
    
    setContextMenuPosition({ x: adjustedX, y: adjustedY })
    setContextMenuVisible(true)
  }, [])

  const hideContextMenu = useCallback(() => {
    setContextMenuVisible(false)
    setCurrentContextVideo(null)
  }, [])

  const handleContextMenuAction = useCallback(async (action) => {
    hideContextMenu()

    switch (action) {
      case 'show-folder':
        await showInFileManager()
        break
      case 'copy-path':
        await copyFilePath()
        break
      default:
        console.warn('Unknown context menu action:', action)
    }
  }, [])

  const showInFileManager = useCallback(async () => {
    console.log('=== SHOW IN FILE MANAGER DEBUG ===')
    console.log('currentContextVideo:', currentContextVideo)
    console.log('electronAPI available:', !!window.electronAPI?.showItemInFolder)

    if (!currentContextVideo) {
      console.error('No context video set!')
      return
    }

    const fileName = currentContextVideo.name
    console.log('fileName:', fileName)
    console.log('currentContextVideo.isElectronFile:', currentContextVideo.isElectronFile)
    console.log('currentContextVideo.fullPath:', currentContextVideo.fullPath)
    console.log('currentContextVideo.webkitRelativePath:', currentContextVideo.webkitRelativePath)

    if (window.electronAPI?.showItemInFolder) {
      console.log('Using Electron API...')
      // Check if this is an Electron-loaded file with full path
      if (currentContextVideo.isElectronFile && currentContextVideo.fullPath) {
        console.log('Opening Electron file:', currentContextVideo.fullPath)
        try {
          const result = await window.electronAPI.showItemInFolder(currentContextVideo.fullPath)
          console.log('showItemInFolder result:', result)
          if (!result.success) {
            console.error('Failed to open file manager:', result.error)
            showTemporaryMessage(`Error: ${result.error}`, 'error')
          } else {
            showTemporaryMessage('Opened in file manager!', 'success')
          }
        } catch (error) {
          console.error('Error opening file manager:', error)
          showTemporaryMessage(`Error: ${error.message}`, 'error')
        }
      } else {
        console.log('Not an Electron file or no full path - showing browser dialog')
        console.log('Reason: isElectronFile =', currentContextVideo.isElectronFile, 'fullPath =', currentContextVideo.fullPath)
        // Browser-selected file - show explanation
        showPathResolutionDialog(fileName, currentContextVideo.webkitRelativePath)
      }
    } else {
      console.error('Electron API not available - using browser fallback')
      // Fallback for non-Electron environment
      showFilePathDialog(fileName, currentContextVideo.webkitRelativePath || fileName)
    }
  }, [currentContextVideo])

  const showPathResolutionDialog = useCallback((fileName, relativePath) => {
    const modal = document.createElement('div')
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
    `

    const dialog = document.createElement('div')
    dialog.style.cssText = `
      background: #2d2d2d;
      border: 1px solid #404040;
      border-radius: 8px;
      padding: 2rem;
      max-width: 600px;
      width: 90%;
      color: white;
      font-family: inherit;
    `

    const pathInfo = relativePath ?
      `<div style="background: #1a1a1a; padding: 1rem; border-radius: 4px; margin: 1rem 0; font-family: monospace; word-break: break-all;">
          <strong>File:</strong> ${fileName}<br>
          <strong>Relative Path:</strong> ${relativePath}
      </div>` :
      `<div style="background: #1a1a1a; padding: 1rem; border-radius: 4px; margin: 1rem 0; font-family: monospace;">
          <strong>File:</strong> ${fileName}
      </div>`

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
    `

    modal.appendChild(dialog)
    document.body.appendChild(modal)

    // Add event listeners
    const copyFileNameBtn = dialog.querySelector('#copyFileNameBtn')
    const copyRelativePathBtn = dialog.querySelector('#copyRelativePathBtn')
    const closeModalBtn = dialog.querySelector('#closeModalBtn')

    copyFileNameBtn?.addEventListener('click', () => {
      navigator.clipboard.writeText(fileName).then(() => {
        copyFileNameBtn.textContent = '✅ Copied!'
        setTimeout(() => {
          copyFileNameBtn.textContent = '📋 Copy File Name'
        }, 2000)
      })
    })

    copyRelativePathBtn?.addEventListener('click', () => {
      navigator.clipboard.writeText(relativePath).then(() => {
        copyRelativePathBtn.textContent = '✅ Copied!'
        setTimeout(() => {
          copyRelativePathBtn.textContent = '📋 Copy Relative Path'
        }, 2000)
      })
    })

    const closeModal = () => {
      document.body.removeChild(modal)
    }

    closeModalBtn.addEventListener('click', closeModal)
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal()
    })

    // Close on Escape key
    const handleKeydown = (e) => {
      if (e.key === 'Escape') {
        closeModal()
        document.removeEventListener('keydown', handleKeydown)
      }
    }
    document.addEventListener('keydown', handleKeydown)
  }, [])

  const showFilePathDialog = useCallback((fileName, filePath) => {
    // Create a modal dialog showing the file information
    const modal = document.createElement('div')
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
    `

    const dialog = document.createElement('div')
    dialog.style.cssText = `
      background: #2d2d2d;
      border: 1px solid #404040;
      border-radius: 8px;
      padding: 2rem;
      max-width: 600px;
      width: 90%;
      color: white;
      font-family: inherit;
    `

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
    `

    modal.appendChild(dialog)
    document.body.appendChild(modal)

    // Add event listeners
    const copyFileNameBtn = dialog.querySelector('#copyFileNameBtn')
    const copyFilePathBtn = dialog.querySelector('#copyFilePathBtn')
    const closeModalBtn = dialog.querySelector('#closeModalBtn')

    copyFileNameBtn?.addEventListener('click', () => {
      navigator.clipboard.writeText(fileName).then(() => {
        copyFileNameBtn.textContent = '✅ Copied!'
        setTimeout(() => {
          copyFileNameBtn.textContent = '📋 Copy File Name'
        }, 2000)
      })
    })

    copyFilePathBtn?.addEventListener('click', () => {
      navigator.clipboard.writeText(filePath).then(() => {
        copyFilePathBtn.textContent = '✅ Copied!'
        setTimeout(() => {
          copyFilePathBtn.textContent = '📋 Copy Full Path'
        }, 2000)
      })
    })

    const closeModal = () => {
      document.body.removeChild(modal)
    }

    closeModalBtn.addEventListener('click', closeModal)
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal()
    })

    // Close on Escape key
    const handleKeydown = (e) => {
      if (e.key === 'Escape') {
        closeModal()
        document.removeEventListener('keydown', handleKeydown)
      }
    }
    document.addEventListener('keydown', handleKeydown)
  }, [])

  const showTemporaryMessage = useCallback((message, type = 'info') => {
    const toast = document.createElement('div')
    const bgColor = type === 'error' ? '#ff4444' : type === 'success' ? '#4CAF50' : '#007acc'
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
    `
    toast.textContent = message
    document.body.appendChild(toast)

    setTimeout(() => {
      if (document.body.contains(toast)) {
        document.body.removeChild(toast)
      }
    }, 4000)
  }, [])

  const copyFilePath = useCallback(() => {
    if (currentContextVideo) {
      const pathToCopy = currentContextVideo.isElectronFile
        ? currentContextVideo.fullPath
        : currentContextVideo.webkitRelativePath || currentContextVideo.name

      navigator.clipboard.writeText(pathToCopy).then(() => {
        const pathType = currentContextVideo.isElectronFile ? 'Full path' : 'File name'
        showTemporaryMessage(`${pathType} copied to clipboard!`, 'success')
      })
    }
  }, [currentContextVideo, showTemporaryMessage])

  const updateDebugInfo = useCallback((debugData) => {
    // Throttle updates for performance
    const now = Date.now()
    if (now - lastDebugUpdateRef.current < debugUpdateThrottleRef.current) {
      return null
    }
    lastDebugUpdateRef.current = now

    const {
      playingCount = 0,
      maxPlaying = 30,
      loadedCount = 0,
      maxLoaded = 60,
      totalVideos = 0,
      visibleCount = 0,
      loadingCount = 0,
      queueCount = 0,
      layoutMode = 'grid'
    } = debugData

    // Memory info with better formatting
    let memoryInfo = ''
    if (performance.memory) {
      const usedMB = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024)
      const totalMB = Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024)
      const percentage = Math.round((performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100)
      memoryInfo = ` | 🧠 ${usedMB}MB (${percentage}%)`
    }

    // Enhanced status with more detailed info
    let statusText = `▶️ ${playingCount}/${maxPlaying} playing | 📼 ${loadedCount}/${maxLoaded} loaded | 📁 ${totalVideos} total`

    // Add additional info when relevant
    if (visibleCount > 0) {
      statusText += ` | 👁️ ${visibleCount} visible`
    }

    if (loadingCount > 0) {
      statusText += ` | ⏳ ${loadingCount} loading`
    }

    if (queueCount > 0) {
      statusText += ` | 📋 ${queueCount} queued`
    }

    // Add layout mode indicator
    const layoutIcon = layoutMode === 'masonry-vertical' ? '🧱' :
                      layoutMode === 'masonry-horizontal' ? '🔄' : '📐'
    statusText += ` | ${layoutIcon} ${layoutMode}`

    statusText += memoryInfo

    // Color coding based on memory usage
    let textColor = '#aaa'
    if (performance.memory) {
      const memoryRatio = performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit
      if (memoryRatio > 0.8) {
        textColor = '#ff6666' // Red - high memory
      } else if (memoryRatio > 0.6) {
        textColor = '#ffcc00' // Yellow - medium memory
      }
    }

    return { statusText, textColor }
  }, [])

  // Force an immediate debug update (bypasses throttling)
  const forceDebugUpdate = useCallback((debugData) => {
    lastDebugUpdateRef.current = 0
    return updateDebugInfo(debugData)
  }, [updateDebugInfo])

  return {
    // Context menu state
    contextMenuVisible,
    contextMenuPosition,
    currentContextVideo,
    
    // Context menu actions
    showContextMenu,
    hideContextMenu,
    handleContextMenuAction,
    
    // File operations
    showInFileManager,
    copyFilePath,
    
    // UI utilities
    showTemporaryMessage,
    showPathResolutionDialog,
    showFilePathDialog,
    
    // Debug info
    updateDebugInfo,
    forceDebugUpdate,
    
    // Setup
    setupInterface
  }
}