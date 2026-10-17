import React from "react";

// The last line of defence for the renderer: an error while rendering would
// otherwise unmount the whole app and leave a blank window that looks like a
// crash. This says what went wrong and offers a reload, which restarts the
// window with the library and settings as they were saved.
export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Video Swarm hit an error while drawing the window:", error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app-error" role="alert">
        <h1>Video Swarm hit a problem</h1>
        <p>The window could not be drawn. Your tags, ratings and settings are saved.</p>
        <pre className="app-error__detail">{String(error?.message || error)}</pre>
        <button type="button" onClick={() => window.location.reload()}>
          Reload the window
        </button>
      </div>
    );
  }
}
