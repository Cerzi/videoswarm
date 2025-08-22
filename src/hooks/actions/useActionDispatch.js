import { useCallback } from 'react';
import { actionRegistry } from './actions';

/**
 * Converts (actionId, selection, optional contextId) into a final target list and executes.
 * Inject external deps (electronAPI, notify, etc.) for testability and portability.
 *
 * @param {{ electronAPI?: any, notify: Function, showProperties?: Function, confirm?: Function }} deps
 * @param {(id: string) => any} getById  // id -> video
 */
export default function useActionDispatch(deps, getById) {
    const runAction = useCallback(
        async (actionId, selectedIds, contextId) => {
            const exec = actionRegistry[actionId];
            if (!exec) return;

            const targetIds =
                contextId && !selectedIds.has(contextId)
                    ? new Set([contextId])
                    : selectedIds;

            const targets = Array.from(targetIds)
                .map((id) => getById(id))
                .filter(Boolean);

            if (targets.length === 0) return;
            await exec(targets, deps);
        },
        [deps, getById]
    );

    return { runAction };
}
