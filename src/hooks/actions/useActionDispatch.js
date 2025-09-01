// src/hooks/actions/useActionDispatch.js
import { useCallback } from 'react';
import { actionRegistry } from './actions';
import { getContextPolicy, TargetPolicy } from './actionPolicies';

/**
 * Converts (actionId, selection, optional contextId) into final target list and executes.
 * deps: { electronAPI?, notify, ... } (injected)
 * getById: (id) => video
 */
export default function useActionDispatch(deps, getById) {
  const resolveTargetIds = useCallback((actionId, selectedIds, contextId) => {
    const size = selectedIds?.size ?? 0;

    // No contextId case (toolbar/hotkeys): just respect toolbar enablement upstream.
    if (!contextId) return selectedIds;

    // Context menu path:
    // If multiple are selected, choose policy based on the action.
    if (size > 1) {
      const policy = getContextPolicy(actionId);
      if (policy === TargetPolicy.CONTEXT_ONLY) {
        return new Set([contextId]);
      }
      // ALL_SELECTED (default for multi actions)
      return selectedIds;
    }

    // If only one is selected:
    // - If that one isn't the context (rare), prefer the context.
    // - Otherwise just use the single selection.
    if (size === 1) {
      if (!selectedIds.has(contextId)) return new Set([contextId]);
      return selectedIds;
    }

    // Nothing selected but context exists (right-click on unselected item)
    return new Set([contextId]);
  }, []);

  const runAction = useCallback(
    async (actionId, selectedIds, contextId) => {
      const exec = actionRegistry[actionId];
      if (!exec) return;

      const targetIds = resolveTargetIds(actionId, selectedIds, contextId);
      const targets = Array.from(targetIds || [])
        .map((id) => getById(id))
        .filter(Boolean);

      if (targets.length === 0) return;
      await exec(targets, deps);
    },
    [deps, getById, resolveTargetIds]
  );

  return { runAction };
}
