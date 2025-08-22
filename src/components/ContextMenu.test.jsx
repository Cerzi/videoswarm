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
                onClose={() => { }}
                onAction={() => { }}
            />
        );
        expect(screen.getByText('Video a')).toBeInTheDocument();
    });

    test('shows count header and pluralized labels for multi-selection (electron)', () => {
        const electronAPI = {
            openInExternalPlayer: () => { },  // any of these truthy triggers electron branch
            moveToTrash: () => { },
            showItemInFolder: () => { },
        };
        render(
            <ContextMenu
                visible
                position={{ x: 100, y: 100 }}
                contextId="a"
                selectionCount={3}
                getById={getById}
                electronAPI={electronAPI}
                onClose={() => { }}
                onAction={() => { }}
            />
        );
        expect(screen.getByText('3 items selected')).toBeInTheDocument();
        expect(screen.getByText(/Copy 3 Filenames/i)).toBeInTheDocument();
        expect(screen.getByText(/Move 3 items to Trash/i)).toBeInTheDocument();
    });

    test('clicking an item calls onAction and onClose', () => {
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
        const item = screen.getByText('📄 Copy Filename');
        fireEvent.click(item);
        expect(onAction).toHaveBeenCalledWith('copy-filename');
        expect(onClose).toHaveBeenCalled();
    });
});
