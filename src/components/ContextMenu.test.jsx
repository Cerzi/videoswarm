import React from 'react';
import { afterEach, describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ContextMenu from './ContextMenu';

const getById = (id) => ({
  id,
  name: `Video ${id}`,
  fullPath: `/path/${id}.mp4`,
  isElectronFile: true,
});

const electronAPI = {
  openInExternalPlayer: vi.fn(),
  moveToTrash: vi.fn(),
  showItemInFolder: vi.fn(),
};

const openSubmenu = (name) => {
  const trigger = screen.getByRole('menuitem', { name });
  fireEvent.mouseEnter(trigger);
  return screen.getByRole('menu', { name });
};

describe('ContextMenu', () => {
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalWidth,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: originalHeight,
    });
  });

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

  test('retains every pre-library action and adds review actions in dense groups', () => {
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

    expect(screen.getByText('3 items selected')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Open.*this item/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Show in Explorer.*this item/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Properties.*this item/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Move to Recycle Bin.*3 selected/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Open details/i })).toBeInTheDocument();

    openSubmenu(/Copy$/i);
    expect(screen.getByRole('menuitem', { name: /Copy Path.*3 selected/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Copy Relative Path.*3 selected/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Copy Filename.*3 selected/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Copy Last Frame.*this item/i })).toBeInTheDocument();

    openSubmenu(/Rating.*3 selected/i);
    expect(screen.getAllByRole('menuitem', { name: /Rate [★☆]{5}/i })).toHaveLength(5);
    expect(screen.getByRole('menuitem', { name: /Clear rating/i })).toBeInTheDocument();

    openSubmenu(/Review status.*3 selected/i);
    expect(screen.getByRole('menuitem', { name: /Mark as accepted/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Mark reviewed/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Mark as reject/i })).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: /Reset to unreviewed \(clears rating\)/i })
    ).toBeInTheDocument();
  });

  test('clicking a submenu item calls onAction and onClose', () => {
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

    openSubmenu(/Copy$/i);
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy Filename/i }));
    expect(onAction).toHaveBeenCalledWith('copy-filename');
    expect(onClose).toHaveBeenCalled();
  });

  test('offers quick review states for batch review', () => {
    const onAction = vi.fn();
    render(
      <ContextMenu
        visible
        position={{ x: 50, y: 50 }}
        contextId="a"
        selectionCount={1}
        getById={getById}
        onClose={vi.fn()}
        onAction={onAction}
      />
    );

    openSubmenu(/Review status/i);
    fireEvent.click(screen.getByRole('menuitem', { name: /Mark as accepted/i }));
    expect(onAction).toHaveBeenCalledWith('metadata:review:pick');
  });

  test('hides review status but keeps rating when review mode is disabled', () => {
    render(
      <ContextMenu
        visible
        position={{ x: 50, y: 50 }}
        contextId="a"
        selectionCount={1}
        getById={getById}
        reviewModeEnabled={false}
        onClose={vi.fn()}
        onAction={vi.fn()}
      />
    );

    expect(screen.queryByRole('menuitem', { name: /Review status/i })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Rating/i })).toBeVisible();
  });

  test('keeps desktop actions visible but disabled when the preload bridge is unavailable', () => {
    render(
      <ContextMenu
        visible
        position={{ x: 50, y: 50 }}
        contextId="a"
        selectionCount={1}
        getById={getById}
        electronAPI={null}
        onClose={vi.fn()}
        onAction={vi.fn()}
      />
    );

    for (const name of [/^.*Open$/i, /Show in Explorer/i, /Move to Recycle Bin/i]) {
      expect(screen.getByRole('menuitem', { name })).toHaveAttribute(
        'aria-disabled',
        'true'
      );
    }
    expect(screen.getByRole('menuitem', { name: /Show in Explorer/i })).toHaveAttribute(
      'title',
      'Desktop integration is unavailable'
    );
  });

  test('fits the root and submenus to the viewport edges', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 500,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 400,
    });

    render(
      <ContextMenu
        visible
        position={{ x: 490, y: 390 }}
        contextId="a"
        selectionCount={1}
        getById={getById}
        electronAPI={electronAPI}
        onClose={vi.fn()}
        onAction={vi.fn()}
      />
    );

    const rootMenu = screen.getByRole('menu', { name: /Actions for Video a/i });
    expect(rootMenu).toHaveStyle({ left: '212px', top: '40px' });

    const copyMenu = openSubmenu(/Copy$/i);
    expect(copyMenu).toHaveStyle({ left: '8px' });
  });

  test('reports the final root geometry on the pointer side without duplicate reports', async () => {
    const onPlacementChange = vi.fn();
    const props = {
      visible: true,
      position: { x: 40, y: 50 },
      contextId: 'a',
      selectionCount: 1,
      getById,
      electronAPI,
      onClose: vi.fn(),
      onAction: vi.fn(),
      onPlacementChange,
    };
    const { rerender } = render(<ContextMenu {...props} />);

    await waitFor(() => expect(onPlacementChange).toHaveBeenCalledTimes(1));
    expect(onPlacementChange).toHaveBeenLastCalledWith({
      contextId: 'a',
      side: 'right',
      rect: expect.objectContaining({
        x: 40,
        y: 50,
        left: 40,
        top: 50,
        right: 320,
        width: 280,
      }),
    });

    rerender(<ContextMenu {...props} position={{ x: 40, y: 50 }} />);
    expect(onPlacementChange).toHaveBeenCalledTimes(1);
  });

  test('reports a right-edge-clamped menu on the left of the raw request', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 500,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 400,
    });
    const onPlacementChange = vi.fn();

    render(
      <ContextMenu
        visible
        position={{ x: 490, y: 390 }}
        contextId="edge"
        selectionCount={1}
        getById={getById}
        electronAPI={electronAPI}
        onClose={vi.fn()}
        onAction={vi.fn()}
        onPlacementChange={onPlacementChange}
      />
    );

    await waitFor(() => expect(onPlacementChange).toHaveBeenCalledTimes(1));
    expect(onPlacementChange).toHaveBeenCalledWith({
      contextId: 'edge',
      side: 'left',
      rect: expect.objectContaining({
        x: 212,
        y: 40,
        left: 212,
        top: 40,
        right: 492,
        width: 280,
      }),
    });
  });

  test('waits for a changed request to reach its final clamped position before reporting', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 500,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 400,
    });
    const onPlacementChange = vi.fn();
    const sharedProps = {
      visible: true,
      contextId: 'a',
      selectionCount: 1,
      getById,
      electronAPI,
      onClose: vi.fn(),
      onAction: vi.fn(),
      onPlacementChange,
    };
    const { rerender } = render(
      <ContextMenu {...sharedProps} position={{ x: 490, y: 390 }} />
    );
    await waitFor(() => expect(onPlacementChange).toHaveBeenCalledTimes(1));
    onPlacementChange.mockClear();

    rerender(<ContextMenu {...sharedProps} position={{ x: 20, y: 20 }} />);

    await waitFor(() => expect(onPlacementChange).toHaveBeenCalledTimes(1));
    expect(onPlacementChange).toHaveBeenCalledWith({
      contextId: 'a',
      side: 'right',
      rect: expect.objectContaining({ left: 20, top: 20, right: 300 }),
    });
  });

  test('scrolling a constrained menu does not dismiss it', () => {
    const onClose = vi.fn();
    render(
      <ContextMenu
        visible
        position={{ x: 10, y: 10 }}
        contextId="a"
        selectionCount={1}
        getById={getById}
        electronAPI={electronAPI}
        onClose={onClose}
        onAction={vi.fn()}
      />
    );
    fireEvent.scroll(screen.getByRole('menu', { name: /Actions for Video a/i }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
