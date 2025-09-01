import React from 'react';
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ContextMenu from './ContextMenu';

const getById = (id) => ({ id, name: `Video ${id}`, fullPath: `/path/${id}.mp4`, isElectronFile: true });

describe('ContextMenu', () => {
  test('shows filename header for single-item context', () => {
    render(
      <ContextMenu
        visible
        position={{ x: 100, y: 100 }}
        contextId="a"
        selectionCount={1}
        getById={getById}
        onClose={() => {}}
        onAction={() => {}}
      />
    );
    expect(screen.getByText('Video a')).toBeInTheDocument();
  });

  test('shows count header and policy labels for multi-selection (electron)', () => {
    const electronAPI = {
      openInExternalPlayer: () => {},
      moveToTrash: () => {},
      showItemInFolder: () => {},
    };

    render(
      <ContextMenu
        visible
        position={{ x: 100, y: 100 }}
        contextId="a"
        selectionCount={3}
        getById={getById}
        electronAPI={electronAPI}
        onClose={() => {}}
        onAction={() => {}}
      />
    );

    // Header reflects multi-select
    expect(screen.getByText('3 items selected')).toBeInTheDocument();

    // Single-item verbs are annotated as "(this item)"
    expect(screen.getByText(/Open.*this item/i)).toBeInTheDocument();
    expect(screen.getByText(/Show.*this item/i)).toBeInTheDocument();

    // Multi-item verbs annotated as "(3 selected)"
    expect(screen.getByText(/Copy Path.*3 selected/i)).toBeInTheDocument();
    expect(screen.getByText(/Copy Relative Path.*3 selected/i)).toBeInTheDocument();
    expect(screen.getByText(/Copy Filename.*3 selected/i)).toBeInTheDocument();
    expect(screen.getByText(/Move to Recycle Bin.*3 selected/i)).toBeInTheDocument();
  });

  test('clicking a menu item calls onAction and onClose', () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        visible
        position={{ x: 50, y: 50 }}
        contextId="a"
        selectionCount={1}
        getById={getById}
        onClose={onClose}
        onAction={onAction}
      />
    );
    // Use a label that always exists in single-select
    const item = screen.getByText(/Copy Filename/i);
    fireEvent.click(item);
    expect(onAction).toHaveBeenCalledWith('copy-filename');
    expect(onClose).toHaveBeenCalled();
  });
});
