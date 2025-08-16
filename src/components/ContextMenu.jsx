import React, { useEffect, useRef } from 'react';

const ContextMenu = ({ 
  video, 
  position, 
  onClose, 
  onAction 
}) => {
  const rootRef = useRef(null);

  // Don't render if no video or position
  const isVisible = !!(video && position);
  if (!isVisible) {
    return null;
  }

  // Close on left-click (or tap) outside, Esc, resize/scroll
  useEffect(() => {
    const handlePointerDown = (e) => {
      // if click is outside the menu, close
      const root = rootRef.current;
      if (root && !root.contains(e.target)) {
        onClose();
      }
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };

    const handleWindowChange = () => {
      onClose();
    };

    // capture phase so we close even if inner elements call stopPropagation
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('touchstart', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', handleWindowChange);
    window.addEventListener('scroll', handleWindowChange, true);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('touchstart', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', handleWindowChange);
      window.removeEventListener('scroll', handleWindowChange, true);
    };
  }, [onClose]);

  const handleAction = (action) => {
    onAction(action);
    onClose();
  };

  // Enhanced menu items based on file type and context
  const getMenuItems = () => {
    const baseItems = [
      { id: 'copy-filename', label: '📄 Copy Filename', action: 'copy-filename' }
    ];

    if (video.isElectronFile && video.fullPath) {
      return [
        { id: 'show-in-folder', label: '📁 Show in File Explorer', action: 'show-in-folder' },
        { id: 'open-external', label: '🎬 Open in External Player', action: 'open-external' },
        { type: 'separator' },
        { id: 'copy-path', label: '📋 Copy Full Path', action: 'copy-path' },
        { id: 'copy-relative-path', label: '📋 Copy Relative Path', action: 'copy-relative-path' },
        { id: 'copy-filename', label: '📄 Copy Filename', action: 'copy-filename' },
        { type: 'separator' },
        { id: 'file-properties', label: '📊 File Properties', action: 'file-properties' },
        { type: 'separator' },
        { id: 'move-to-trash', label: '🗑️ Move to Trash', action: 'move-to-trash', dangerous: true }
      ];
    } else if (video.webkitRelativePath || video.relativePath) {
      // Web mode with some relative path info
      return [
        { id: 'copy-relative-path', label: '📋 Copy Relative Path', action: 'copy-relative-path' },
        ...baseItems
      ];
    } else {
      return baseItems;
    }
  };

  const menuItems = getMenuItems();

  // Calculate position to keep menu on screen
  const getAdjustedPosition = () => {
    const menuWidth = 250;
    const menuHeight = menuItems.length * 35 + 50; // Approximate height
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let adjustedX = position.x;
    let adjustedY = position.y;

    // Adjust horizontal position
    if (position.x + menuWidth > viewportWidth) {
      adjustedX = viewportWidth - menuWidth - 10;
    }

    // Adjust vertical position
    if (position.y + menuHeight > viewportHeight) {
      adjustedY = viewportHeight - menuHeight - 10;
    }

    return { x: Math.max(10, adjustedX), y: Math.max(10, adjustedY) };
  };

  const adjustedPosition = getAdjustedPosition();

  // Styles
  const menuStyle = {
    position: 'fixed',
    left: `${adjustedPosition.x}px`,
    top: `${adjustedPosition.y}px`,
    backgroundColor: '#2d2d2d',
    border: '1px solid #404040',
    borderRadius: '8px',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
    minWidth: '240px',
    maxWidth: '300px',
    zIndex: 999999,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: '13px',
    userSelect: 'none'
  };

  const headerStyle = {
    backgroundColor: '#1a1a1a',
    padding: '10px 14px',
    borderBottom: '1px solid #404040',
    color: '#fff',
    fontSize: '12px',
    fontWeight: '600',
    borderRadius: '8px 8px 0 0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  };

  const itemStyle = {
    padding: '10px 14px',
    color: '#e0e0e0',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    transition: 'background-color 0.1s ease'
  };

  const separatorStyle = {
    height: '1px',
    backgroundColor: '#404040',
    margin: '4px 0'
  };

  const dangerousItemStyle = {
    ...itemStyle,
    color: '#ff6b6b'
  };

  return (
    <div 
      ref={rootRef}
      data-context-menu
      style={menuStyle}
      onClick={(e) => e.stopPropagation()}   // keep clicks inside from bubbling
    >
      <div style={headerStyle} title={video.name}>
        {video.name}
      </div>
      
      {menuItems.map((item, index) => {
        if (item.type === 'separator') {
          return <div key={`sep-${index}`} style={separatorStyle} />;
        }

        const isLast = index === menuItems.length - 1;
        const isDangerous = item.dangerous;
        
        return (
          <div
            key={item.id}
            style={{
              ...(isDangerous ? dangerousItemStyle : itemStyle),
              ...(isLast ? { borderRadius: '0 0 8px 8px' } : {})
            }}
            onClick={() => handleAction(item.action)}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = isDangerous ? '#ff4444' : '#404040';
              e.currentTarget.style.color = 'white';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
              e.currentTarget.style.color = isDangerous ? '#ff6b6b' : '#e0e0e0';
            }}
          >
            {item.label}
          </div>
        );
      })}
    </div>
  );
};

export default ContextMenu;
