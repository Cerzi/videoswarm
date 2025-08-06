import { FileHandler } from '../services/FileHandler.js';
import { VideoManager } from '../services/VideoManager.js';
import { LayoutManager } from '../services/LayoutManager.js';
import { SelectionManager } from '../services/SelectionManager.js';
import { PerformanceManager } from '../services/PerformanceManager.js';
import { UIController } from '../controllers/UIController.js';
import { EventBus } from '../utils/EventBus.js';

/**
 * Main application class that orchestrates all components
 * Follows the Single Responsibility Principle by delegating specific tasks to specialized services
 */
export class VideoBrowserApp {
    constructor() {
        this.eventBus = new EventBus();
        this.initializeServices();
        this.initializeControllers();
        this.setupEventListeners();
    }

    initializeServices() {
        // Initialize core services
        this.fileHandler = new FileHandler(this.eventBus);
        this.videoManager = new VideoManager(this.eventBus);
        this.layoutManager = new LayoutManager(this.eventBus);
        this.selectionManager = new SelectionManager(this.eventBus);
        this.performanceManager = new PerformanceManager(this.eventBus);
    }

    initializeControllers() {
        // Initialize UI controller
        this.uiController = new UIController(this.eventBus);
    }

    setupEventListeners() {
        // Listen for application-level events
        this.eventBus.on('app:shutdown', () => {
            this.cleanup();
        });

        // Handle browser events
        window.addEventListener('beforeunload', () => {
            this.cleanup();
        });
    }

    cleanup() {
        // Clean up resources
        this.videoManager.cleanup();
        this.performanceManager.cleanup();
        this.eventBus.removeAllListeners();
    }
}
