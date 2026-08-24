/**
 * Standardized Pane Actions
 *
 * Re-exports all action implementations from the implementations directory.
 * This file maintains backward compatibility while actions are now split into separate files.
 */

// Re-export all actions from their individual files
export {
  viewPane,
  closePane,
  mergePane,
  renamePane,
  copyPath,
  openInEditor,
} from './implementations/index.js';
