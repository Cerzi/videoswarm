# Video Browser - Refactored Architecture

A modern, high-performance video browser application built with vanilla JavaScript following SOLID principles.

## 🏗️ Architecture Overview

This project has been refactored from a monolithic single-file application into a well-structured, modular architecture that follows SOLID principles:

### **S**ingle Responsibility Principle
Each class has a single, well-defined responsibility:
- `FileHandler` - File operations and validation
- `VideoManager` - Video lifecycle management
- `LayoutManager` - Layout modes and zoom
- `SelectionManager` - Video selection state
- `PerformanceManager` - Resource optimization
- `UIController` - User interface interactions

### **O**pen/Closed Principle
Components are open for extension but closed for modification through:
- Event-driven architecture using `EventBus`
- Plugin-like service registration
- Configurable performance limits

### **L**iskov Substitution Principle
Services can be replaced with compatible implementations without breaking the system.

### **I**nterface Segregation Principle
Components only depend on the events they actually use, not monolithic interfaces.

### **D**ependency Inversion Principle
High-level modules depend on abstractions (EventBus) rather than concrete implementations.

## 📁 Project Structure

```
├── index.html                 # Main application entry point
├── browser.html              # Legacy file (redirects to index.html)
├── README.md                 # This file
└── src/
    ├── main.js              # Application bootstrap
    ├── styles/
    │   └── main.css         # All application styles
    ├── core/
    │   └── VideoBrowserApp.js # Main application orchestrator
    ├── controllers/
    │   └── UIController.js   # UI interaction handling
    ├── services/
    │   ├── FileHandler.js    # File operations
    │   ├── VideoManager.js   # Video lifecycle management
    │   ├── LayoutManager.js  # Layout and zoom management
    │   ├── SelectionManager.js # Selection state management
    │   └── PerformanceManager.js # Performance optimization
    ├── components/
    │   ├── VideoItem.js      # Individual video item
    │   └── ContextMenu.js    # Right-click context menu
    └── utils/
        ├── EventBus.js       # Event communication system
        ├── DOMElements.js    # Centralized DOM access
        └── VideoLoader.js    # Video loading operations
```

## 🚀 Features

- **High Performance**: Intelligent video loading and unloading based on viewport visibility
- **Memory Management**: Automatic cleanup and resource optimization
- **Multiple Layouts**: Grid, vertical masonry, and horizontal masonry layouts
- **Responsive Design**: Works on desktop and mobile devices
- **Keyboard Shortcuts**: Full keyboard navigation support
- **Context Menus**: Right-click operations on videos
- **Drag & Drop**: Drop video files or folders directly
- **Codec Detection**: Automatic detection and warnings for unsupported codecs

## 🎯 Key Improvements

### Modularity
- **Before**: 1,200+ line monolithic file
- **After**: 12 focused modules, each under 200 lines

### Maintainability
- Clear separation of concerns
- Event-driven communication
- Centralized configuration
- Comprehensive error handling

### Testability
- Each service can be unit tested independently
- Mock-friendly event bus architecture
- Dependency injection ready

### Performance
- Lazy loading of video content
- Intelligent memory management
- Configurable performance limits
- Background cleanup processes

## 🛠️ Usage

1. Open `index.html` in a modern web browser
2. Click "Open Folder" or drag & drop video files
3. Use keyboard shortcuts:
   - `Ctrl+A` - Select all videos
   - `Delete` - Delete selected videos
   - `Escape` - Clear selection
   - `Space` - Toggle playback
   - `Ctrl+Wheel` - Zoom in/out

## 🔧 Configuration

Performance limits can be adjusted in `PerformanceManager.js`:

```javascript
this.maxConcurrentPlaying = 30;  // Max videos playing simultaneously
this.maxConcurrentLoading = 6;   // Max videos loading simultaneously
this.maxLoadedVideos = 80;       // Max videos kept in memory
```

## 🌐 Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## 📝 Event System

The application uses a custom event bus for loose coupling:

```javascript
// Emit events
this.eventBus.emit('video:load', videoItem);

// Listen for events
this.eventBus.on('video:loaded', (data) => {
    // Handle video loaded
});
```

## 🔄 Migration from Legacy

The original `browser.html` now redirects to the new modular version. All functionality has been preserved while improving:

- Code organization
- Performance
- Maintainability
- Extensibility

## 🤝 Contributing

When adding new features:

1. Follow the single responsibility principle
2. Use the event bus for communication
3. Add appropriate error handling
4. Update this README if needed

## 📄 License

This project is open source and available under the MIT License.
