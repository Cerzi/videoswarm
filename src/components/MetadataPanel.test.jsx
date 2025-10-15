import React from 'react';
import { describe, it, expect } from 'vitest';
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
  it('shows creation date and resolution for a single video when provided', () => {
    renderPanel({
      selectedVideos: [
        {
          metadata: { dateCreatedFormatted: 'April 5, 2023' },
          dimensions: { width: 1920, height: 1080 },
        },
      ],
    });

    expect(screen.getByText('Date created')).toBeInTheDocument();
    expect(screen.getByText('April 5, 2023')).toBeInTheDocument();
    expect(screen.getByText('Resolution')).toBeInTheDocument();
    expect(screen.getByText('1920×1080')).toBeInTheDocument();
  });

  it('omits the info section when no metadata is available', () => {
    renderPanel({
      selectedVideos: [
        {
          metadata: {},
          dimensions: { width: 0, height: 0 },
        },
      ],
    });

    expect(screen.queryByText('Date created')).not.toBeInTheDocument();
    expect(screen.queryByText('Resolution')).not.toBeInTheDocument();
  });

  it('hides the info section when multiple items are selected', () => {
    renderPanel({
      selectionCount: 2,
      selectedVideos: [
        {
          metadata: { dateCreatedFormatted: 'April 5, 2023' },
          dimensions: { width: 1920, height: 1080 },
        },
        {
          metadata: { dateCreatedFormatted: 'June 1, 2023' },
          dimensions: { width: 1280, height: 720 },
        },
      ],
    });

    expect(screen.queryByText('Date created')).not.toBeInTheDocument();
    expect(screen.queryByText('Resolution')).not.toBeInTheDocument();
  });
});
