# 🐝 Video Swarm

I got tired of manually opening tens or hundreds of ComfyUI video outputs to try and find an old workflow or get a quick overview of the quality of a large batch run. **Video Swarm** was born because I couldn't find any existing software that does this: tile a large number of videos, all playing at once, with seamless scrolling through subdirectories and quick file operations. I figured I'm not the only one who would find this useful, so I've open-sourced it.

![Video Swarm Demo](docs/images/demo.gif)

https://github.com/user-attachments/assets/9fed71dd-fe4e-4bdf-8326-ab775979e2d5
<p><em>demo video</em></p>

---

## TL;DR
- Download [latest release](https://github.com/Cerzi/videoswarm/releases)  
- Open a folder with clips (optionally enable recursive scan)  
- Browse videos in a live-playing masonry grid  
- Double-click → fullscreen, ←/→ to navigate, Space to pause/play  
- Right click for context menu. Opening in file explorer will highlight the video file for easy drag and drop into ComfyUI to find old workflows

---

## Purpose

Traditional file browsers show static thumbnails and provide limited ways to compare videos at scale. Video Swarm is designed for use cases where *motion* matters and where collections may contain hundreds or thousands of files, such as:

- Reviewing outputs from AI video generation workflows (e.g. ComfyUI)
- Seeing a clear overview of video training datasets for AI training
- Inspecting stock footage, B-roll, or archival datasets
- Comparing multiple generations or versions of the same source
- Research or analysis of large video corpora

---

## Features

### Playback and Layout
- Configurable concurrent playback (default 50; adjustable up to 500 depending on system resources)
- Lazy loading: videos only play when visible in the viewport
- Automatic cleanup of off-screen elements to reduce memory usage
- Vertical masonry layout: fixed width, variable height; handles portrait, square, and landscape videos without wasted space
- Responsive column count, scroll-position preserved on resize

### Navigation and Interaction
- Double-click video → full-screen modal
- Keyboard navigation in full-screen (←/→, Space, Esc)
- Context menu for file operations (open in system player, show in folder, copy path, move to trash)
- Multi-select via Ctrl+Click
- Adjustable zoom levels (75%, 100%, 150%, 200%)
- Toggle display of filenames

### File System Integration
- Recursive directory scanning (configurable)
- Real-time folder monitoring with [Chokidar](https://github.com/paulmillr/chokidar); fallback to polling if too many files
- Recent Folders list: automatically tracks and persists recently opened folders
- Rich metadata: size, modification time, creation time
- Native file operations (show, open, delete, copy) - show in folder is particularly useful for ComfyUI users for quickly accessing the video in order to re-use workflows

### Settings
- Persistent settings stored in Electron’s userData directory (JSON)
- Saved window size/position
- Saved playback and zoom preferences
- Automatic zoom adjustment for high-DPI displays

---

## Technical Overview

- **Frontend:** React 18 + hooks, Vite for bundling
- **Backend:** Electron main process with IPC for filesystem access
- **Layout:** Custom vertical masonry renderer
- **Performance:** Intersection Observer for visibility detection; debounced updates; GC enabled via Electron flags
- **File formats:** Supports any codec/container playable by Chromium (tested with MP4/H.264; partial HEVC support depends on system codecs)
- **Rough edges:** Early release; expect some quirks and ongoing polish

---

## Known Limitations

- Designed primarily for folders of short videoclips (~5 seconds) - loading large directories of long videos may have issues
- Desktop-only: no web version (requires unrestricted filesystem access)
- HEVC/H.265: limited browser support; may not decode on all systems
- Very large directories (3000+ files): performance may degrade despite lazy loading, can be some glitchiness during load
- No mobile/touch support

---

## Roadmap

Planned for upcoming versions:

- **Tagging and database system** – persist metadata, ratings, and custom tags across sessions
- Enhanced search and filtering
- Further performance improvements

---

## Installation & Development

### Prerequisites
- Node.js 16 or later
- npm

### Setup
```bash
git clone https://github.com/Cerzi/videoswarm.git
cd videoswarm
npm install
```

### Development
Run Vite + Electron together with hot reload:
```bash
npm run electron:dev
```

### Production Build
```bash
npm run electron:build   # packaged app for current platform
```

### Other build targets:
- `electron:dist` – build without publishing
- `electron:pack` – portable package

### Project Structure
```css
src/
  components/          React components (VideoCard, ContextMenu, FullScreenModal, RecentFolders)
  hooks/               React hooks (fullscreen logic, context menu, playback manager)
  App.jsx              Main React entry point
main.js                Electron main process
preload.js             IPC bridge
```

### Usage
1. Start the application
2. Select a folder (optionally enable recursive scan to load all videos in subdirs)
3. Videos will be scanned and loaded into the masonry grid
4. Adjust zoom via the top control bar
5. Ctrl+R to clear all videos
6. Access recently opened folders from the Recent Folders menu

## License

Video Swarm is licensed under the [GNU General Public License v3.0](LICENSE).

This ensures the project remains free and open-source for everyone, and that any improvements or modifications made by others are also shared with the community. You are free to use, modify, and redistribute the software, but if you distribute a modified version you must also make the source code available under the same license.

## Contributing

Contributions are welcome! By submitting a pull request, you agree that your code will be licensed under the same GPLv3 license as the rest of the project.
