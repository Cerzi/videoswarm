# 🐝 Video Swarm

A desktop Electron application for viewing hundreds of videos simultaneously in an intelligent masonry layout. Perfect for managing large video collections with real-time playback and instant file system monitoring.

> **See your entire video collection in motion** - when static thumbnails aren't enough, Video Swarm shows you everything at once.

![Video Swarm Demo](docs/images/demo.gif)

## 🎯 Perfect For Video Workflows

### 🤖 **AI Video Generation Tools**
- **Load your entire ComfyUI output folder recursively and browse all of your Wan/Hunyuan/etc generations in motion**
- **Hundreds of I2V generations from the same starting image? Image thumbnails are useless - Video Swarm is the answer**

### 📁 **Large Video Collections**
- **Content libraries**: Browse B-roll, stock footage, and asset collections
- **Archive management**: Navigate thousands of videos with ease
- **Batch processing**: Review video outputs from any bulk generation tool
- **Research datasets**: Analyze large video collections for patterns and content

### 🔍 **Why Video Swarm?**
Traditional file browsers show only static thumbnails, making it impossible to understand the content and motion of your videos. Video Swarm solves this by:
- Playing all videos simultaneously so you can see motion and content at a glance
- Smart batch organization for large video generation sessions
- Instant visual comparison between different outputs and variations
- Efficient workflow for selecting the best videos from hundreds of files

## ✨ Features

### 🚀 **Mass Video Playback**
- Simultaneous playback of multiple videos (configurable limit: 10-100)
- Smart autoplay management with visibility-based loading
- Optimized performance for large collections (tested with 1000+ videos)
- Memory-efficient lazy loading and automatic cleanup

### 📐 **Intelligent Masonry Layout**
- **Vertical Masonry**: Fixed width, variable height layout optimized for all aspect ratios
- Perfect for mixed content: portrait, square, and landscape videos
- Real-time layout updates with preserved scroll position
- Responsive column count based on window size

### 🎯 **Smart Navigation & Interaction**
- Full-screen modal with keyboard navigation (←/→ arrow keys, Space, Esc)
- Double-click to open any video in full-screen
- Context menu integration (right-click for file operations)
- Multi-select support with Ctrl+Click
- Zoom controls (75%, 100%, 150%, 200%)

### 📁 **File System Integration**
- Real-time file watching with automatic UI updates
- Recursive folder scanning with configurable depth
- Rich file metadata (size, dates, aspect ratios)
- Native file operations: Show in Explorer, Open externally, Copy paths
- Safe file deletion (moves to system trash)

### ⚙️ **Customization & Settings**
- Persistent settings stored in user data directory
- Show/hide filenames toggle
- Adjustable concurrent playback limits (10-100 videos)
- Zoom levels for different viewing preferences
- Window state preservation (size, position)

### 🖥️ **Desktop-Only Application**
- Native desktop app built with Electron for full file system access
- No web version available - requires local file system integration
- Cross-platform support: Windows, macOS, and Linux
- Direct file operations

## 🎮 Usage

### Getting Started
1. Launch the application
2. Toggle "📂 Recursive" to include subdirectories
3. Click "📁 Select Folder" to choose your video directory
4. Adjust settings using the top control bar

### Navigation Controls
- Single-click: Select video
- Ctrl+Click: Multi-select videos
- Double-click: Open in full-screen mode
- Right-click: Context menu with file operations
- Space/Enter in full-screen: Play/pause
- ←/→ in full-screen: Navigate between videos

### Settings Panel
- 📂 **Recursive**: Include subdirectories in scan
- 📝 **Filenames**: Show/hide video filenames
- 📹 **Slider**: Control max concurrent playing videos (10-100)
- 🔍 **Slider**: Adjust thumbnail zoom level (75%-200%)

## 🛠️ Technical Details

### Architecture
- Frontend: React 18 with modern hooks and context
- Backend: Electron with IPC communication
- File Watching: Chokidar with polling fallback
- Layout Engine: Custom vertical masonry implementation
- Performance: Intersection Observer for visibility detection, debounced updates

### Supported Formats
- Video containers: MP4, MOV, AVI, MKV, WebM, M4V, FLV, WMV, 3GP, OGV
- Codecs: H.264, H.265/HEVC*, VP8, VP9, and others supported by Chromium
- Performance optimized for H.264 content

*H.265/HEVC support depends on system codecs

### File Operations
- Show in File Explorer: Native OS integration
- Open in External Player: Uses system default video player
- Copy File Paths: Full path, relative path, or filename to clipboard
- Move to Trash: Safe deletion using system trash/recycle bin
- File Properties: Detailed metadata display

### Performance Optimizations
- Lazy loading: Videos load only when scrolled into view
- Intelligent playback: Respects concurrent video limits
- Memory management: Automatic cleanup of video elements
- Debounced updates: Smooth scrolling and resizing
- Native file watching: Real-time updates without polling

## 🔧 Development

### Prerequisites
- Node.js 16+
- npm or yarn

### Installation
```bash
# Clone the repository
git clone https://github.com/yourusername/video-swarm.git
cd video-swarm

# Install dependencies
npm install

# Start development with React hot reload
npm run electron:dev
```

### Building for Distribution
```bash
# Build for current platform
npm run electron:build

# Build for specific platforms
npm run electron:build -- --win
npm run electron:build -- --mac
npm run electron:build -- --linux

# Create portable version (Windows)
npm run electron:pack
```

### Project Structure
```
src/
├── components/
│   ├── VideoCard.js       # Individual video thumbnail component
│   ├── ContextMenu.js     # Right-click context menu
│   └── FullScreenModal.js # Full-screen video viewer
├── hooks/
│   ├── useFullScreenModal.js  # Full-screen navigation logic
│   └── useContextMenu.js      # Context menu state and actions
├── App.js                 # Main application component with masonry layout
└── main.js               # Electron main process
```

## 🎯 Use Cases

### 🤖 **AI Content Creators**
- Batch review AI-generated video outputs from multiple sessions
- Quick comparison of different prompts and parameter variations
- Efficient curation of best results from large generation batches
- Motion preview without opening each file individually

### 🎬 **Traditional Video Work**
- Video Editors: Quick preview of footage libraries
- Content Creators: Browse B-roll and asset collections
- Archivists: Navigate large video archives efficiently
- Developers: Preview video assets for projects
- Media Managers: Organize and review video collections
- Researchers: Analyze video datasets

## 🐛 Known Limitations

- Desktop Only: No web version due to file system requirements
- H.265/HEVC: Limited browser support, shows placeholder with codec info
- Very Large Collections: Performance may degrade with 5000+ videos
- Mobile: Not designed for touch interfaces (desktop application)
- Internet Required: Only for downloading the app, runs fully offline afterward

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

### Development Guidelines
- Use modern React patterns (hooks, functional components)
- Maintain Electron security best practices
- Write descriptive commit messages
- Test across platforms when possible

---

**Video Swarm v1.0.0** - Built with ❤️ for video professionals and content creators

---

## 🚀 Download

**[Download Latest Release](https://github.com/yourusername/video-swarm/releases/latest)**

- Windows: `.exe` installer or portable `.zip`
- macOS: `.dmg` disk image (Intel + Apple Silicon)
- Linux: `.AppImage` or `.deb` package