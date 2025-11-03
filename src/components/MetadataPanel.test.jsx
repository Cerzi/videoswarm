import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

describe('MetadataPanel empty state', () => {
  it('shows guidance when nothing is selected', () => {
    renderPanel({ selectedVideos: [], selectionCount: 0 });

    expect(screen.getByText('No clips selected')).toBeInTheDocument();
    expect(
      screen.getByText('Pick videos from the grid to see quick stats and tags here.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Tip: Use Shift or Ctrl/Cmd to build multi-select batches.')
    ).toBeInTheDocument();
  });
});

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

describe('MetadataPanel tag input', () => {
  it('autocompletes to the closest existing tag on Tab', async () => {
    const handleAddTag = vi.fn();

    renderPanel({
      selectedVideos: [{ name: 'clip-one.mp4', metadata: {}, dimensions: null }],
      availableTags: [
        { name: 'dog', usageCount: 5 },
        { name: 'doughnut', usageCount: 2 },
      ],
      onAddTag: handleAddTag,
    });

    const input = screen.getByPlaceholderText('Add tag and press Enter');
    fireEvent.change(input, { target: { value: 'do' } });
    fireEvent.keyDown(input, { key: 'Tab', code: 'Tab' });

    expect(handleAddTag).toHaveBeenCalledWith(['dog']);
    expect(input).toHaveValue('');
  });

  it('does not create a new tag when Tab has no match', async () => {
    const handleAddTag = vi.fn();

    renderPanel({
      selectedVideos: [{ name: 'clip-one.mp4', metadata: {}, dimensions: null }],
      availableTags: [{ name: 'cat', usageCount: 1 }],
      onAddTag: handleAddTag,
    });

    const input = screen.getByPlaceholderText('Add tag and press Enter');
    fireEvent.change(input, { target: { value: 'do' } });
    fireEvent.keyDown(input, { key: 'Tab', code: 'Tab' });

    expect(handleAddTag).not.toHaveBeenCalled();
    expect(input).toHaveValue('do');
  });
});
