// hooks/video-collection/index.js

// Export the 3-layer video collection management system
export { useProgressiveList } from './useProgressiveList';
export { default as useVideoResourceManager } from './useVideoResourceManager';  
export { default as usePlayOrchestrator } from './usePlayOrchestrator';

// Optional: Export a composite hook that uses all 3 together
export { default as useVideoCollection } from './useVideoCollection';