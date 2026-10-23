import { createContext } from "react";

// The saved smart views and how to apply one, for the details pane's
// "Smart views" section wherever the pane is shown (floating, docked or
// fullscreen). Null outside the app: the section then shows nothing.
// `{ savedViews: [{ id, name, ... }], onApply(view) }`
const SmartViewsContext = createContext(null);

export default SmartViewsContext;
