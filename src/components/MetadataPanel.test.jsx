import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import MetadataPanel from './MetadataPanel';

const renderPanel = (props = {}) =>
  render(
    <MetadataPanel
      isOpen
      onToggle={() => {}}
      selectionCount={props.selectionCount ?? props.selectedVideos?.length ?? 0}
      selectedVideos={props.selectedVideos ?? []}
      availableTags={[]}
      {...props}
    />
  );

describe('MetadataPanel single-selection info', () => {
  const formatExpectedDate = (value) =>
    new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(value);

  it('shows filename, creation date with seconds, and resolution for a single video', () => {
    const createdDate = new Date('2023-04-05T14:03:02Z');

    renderPanel({
      selectedVideos: [
        {
          name: 'clip-one.mp4',
          metadata: { dateCreated: createdDate.toISOString() },
          dimensions: { width: 1920, height: 1080 },
        },
      ],
    });

    expect(screen.getByText('Filename')).toBeInTheDocument();
    expect(screen.getByText('clip-one.mp4')).toBeInTheDocument();
    expect(screen.getByText('Date created')).toBeInTheDocument();
    expect(screen.getByText(formatExpectedDate(createdDate))).toBeInTheDocument();
    expect(screen.getByText('Resolution')).toBeInTheDocument();
    expect(screen.getByText('1920×1080')).toBeInTheDocument();
  });

  it('omits the info section when no identifying details are available', () => {
    renderPanel({
      selectedVideos: [
        {
          metadata: {},
          dimensions: { width: 0, height: 0 },
        },
      ],
    });

    expect(screen.queryByText('Filename')).not.toBeInTheDocument();
    expect(screen.queryByText('Date created')).not.toBeInTheDocument();
    expect(screen.queryByText('Resolution')).not.toBeInTheDocument();
  });

  it('hides the info section when multiple items are selected', () => {
    renderPanel({
      selectionCount: 2,
      selectedVideos: [
        {
          name: 'clip-one.mp4',
          metadata: { dateCreatedFormatted: 'April 5, 2023' },
          dimensions: { width: 1920, height: 1080 },
        },
        {
          name: 'clip-two.mp4',
          metadata: { dateCreatedFormatted: 'June 1, 2023' },
          dimensions: { width: 1280, height: 720 },
        },
      ],
    });

    expect(screen.queryByText('Filename')).not.toBeInTheDocument();
    expect(screen.queryByText('Date created')).not.toBeInTheDocument();
    expect(screen.queryByText('Resolution')).not.toBeInTheDocument();
  });
});

describe('MetadataPanel context menu handling', () => {
  it('suppresses the custom menu when right-clicking the panel surface', () => {
    const { container } = renderPanel({
      selectedVideos: [
        {
          name: 'clip-one.mp4',
          metadata: { dateCreated: '2023-01-01T00:00:00Z' },
          dimensions: { width: 1920, height: 1080 },
        },
      ],
    });

    const panel = container.querySelector('.metadata-panel');
    expect(panel).toBeTruthy();
    const event = new MouseEvent('contextmenu', { bubbles: true });
    const stopPropagation = vi.spyOn(event, 'stopPropagation');
    const preventDefault = vi.spyOn(event, 'preventDefault');

    panel.dispatchEvent(event);

    expect(stopPropagation).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
  });

  it('allows native context menu inside the tag input', () => {
    renderPanel({
      selectedVideos: [
        {
          name: 'clip-one.mp4',
          metadata: { dateCreated: '2023-01-01T00:00:00Z' },
          dimensions: { width: 1920, height: 1080 },
        },
      ],
    });

    const input = screen.getByPlaceholderText('Add tag and press Enter');
    const event = new MouseEvent('contextmenu', { bubbles: true });
    const stopPropagation = vi.spyOn(event, 'stopPropagation');
    const preventDefault = vi.spyOn(event, 'preventDefault');

    input.dispatchEvent(event);

    expect(stopPropagation).toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
